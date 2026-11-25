import type { JobVerifyReason } from '@tailorit/shared';
import { parseAtsUrl } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { AppError } from '../../../core/http/errors';
import { newReadsAllowed } from '../../../core/http/identity';
import { OutboundRefusedError } from '../../../core/http/outbound';
import { ADD_JOB_FETCH_TIMEOUT_MS } from '../../autofill/jobs';
import { insertSourceIfNameFree } from '../../autofill/sources';
import { bamboohrCompany, keepBamboohrCompanyName, readBamboohrCompanyName } from '../../ingest/adapters/bamboohr'; // v37 FIX-37A (E6): names
import { str } from '../../ingest/adapters/common'; // v37 FIX-37A (E6)
import { careerPostingIdOf } from '../../ingest/career/run'; // v37 FIX-37A (F10)
import { icimsPostingRef } from '../../ingest/adapters/icims';
import { icimsBoardOf, icimsHostOf } from '../../ingest/career/platforms';
import { sourcesOfBoard } from '../../ingest/discovery/offer';
import { HostHeldError, IngestHttpError } from '../../ingest/http';
import { sourceHashOf, storedSourceJobId } from '../../ingest/normalize';
import { fetchPosting, type PostingAnswer, type PostingRef } from '../../ingest/postings';
import { RobotsRefusal } from '../../ingest/robots';
import { requireIngest } from '../../ingest/service';
import { getSourceRecord, termsForbidReads } from '../../ingest/sources'; // v37 INT-B; v37 INT-2b termsForbidReads
import { ADDED_BY_AUTOFILL, IngestError, SOURCE_KIND_LABEL, type SourceRecord } from '../../ingest/types';
import { holdNewJob } from '../../job-reviews/new-jobs';
import { readWaitsForAdmin, settleHeldAfterRead } from './held';
import { sharedAddress } from './address';
import { dateImported } from './import-time';
import { linkRejected } from './verification';
import { pauseOf, type LinkRead } from './verdict'; // v37 INT-B (CLOSED C1)
import type { PageJobRead, PageReadOptions } from './page';

// v37 BOARDS (SP v37 PLAN B4, I4): a link to a BambooHR opening (https://<company>.bamboohr.com/careers/<id>) or to an
// iCIMS posting (https://<board>.icims.com/jobs/<id>/[<slug>/]job, or any of its pages) is read as its board's run
// reads it, never as a career page: the opening's detail JSON (adapters/bamboohr.ts), the posting's content page
// (…/job?in_iframe=1, adapters/icims.ts: the page itself is a frame with no JobPosting). Both are new kinds of read: only
// once BOT_USER_AGENT is set (else `not_set_up`, nothing sent), with it (the ingest service's botHttp: robots.txt, the
// host's pace and holds), within Add job's budget (ADD_JOB_FETCH_TIMEOUT_MS).
//
// The posting is stored through the ingest pipeline under its board's source (an enabled one first, else the oldest of
// that kind), else a new one made off and marked as Add job's (`addedBy`), as Add job makes a Greenhouse board's: the
// board waits in Admin › Sources for an admin, and discovery may adopt it. Its job is published, or held for Admin ›
// Review while NEW_JOBS_ADMIN_APPROVAL holds new jobs (an admin import's read: the import's hold, dated the import's),
// exactly as an ATS posting's read is (autofill/jobs.ts readAndStore). jobs/add/page.ts readPageToSharedJob hands these
// links here first, so every path that reads a job's link (Add job, Add by link, the extension, MCP, imports, Retry
// read, the admin's approval) reads them the same way.
//
// v37 FIX-37A (SP v37 FIXES-37):
//   - E6: a BambooHR opening names no employer. Its company is an admin import row's company, else the source's
//     companyName, else the name the company's careers page gives (adapters/bamboohr.ts readBamboohrCompanyName: one
//     request, once the opening was read), else the company's name in its address made readable. The source keeps the
//     name the read used when it has none (a source made here, or one with no company name).
//   - F9: a queued read (the link queue, an admin import) waits up to its own budget (PageReadOptions.timeoutMs,
//     LINK_QUEUE_READ_TIMEOUT_MS); a person's keeps Add job's ADD_JOB_FETCH_TIMEOUT_MS.
//   - F10: an iCIMS host whose source is a career site an admin turned on (a server updated in place keeps one: migration
//     0063 and Add source keep one source per host) has no second source made for it: the posting is kept under that
//     career site, by the career site's own key for a page, and the site's terms decide whether it is read at all.

/** A link to one posting of a BambooHR company or an iCIMS site. */
export interface BoardLink {
  kind: 'bamboohr' | 'icims';
  /** The BambooHR company, or the iCIMS board (its host's first label). */
  board: string;
  externalId: string;
  /** An iCIMS posting's page (no query), when the link is it. */
  page?: string;
}

/** The BambooHR opening or iCIMS posting a link names, or null for any other link. */
export function boardLinkOf(url: string): BoardLink | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const parsed = parseAtsUrl(url);
  if (!parsed?.externalId) return null;
  if (parsed.kind === 'bamboohr') {
    const company = bamboohrCompany(host);
    return company && /^\d{1,20}$/.test(parsed.externalId) ? { kind: 'bamboohr', board: company, externalId: parsed.externalId } : null;
  }
  if (parsed.kind === 'icims') {
    const board = icimsBoardOf(host);
    if (!board || !/^\d{1,12}$/.test(parsed.externalId)) return null;
    const own = icimsPostingRef(url, icimsHostOf(board));
    return { kind: 'icims', board, externalId: parsed.externalId, ...(own && own.id === parsed.externalId ? { page: own.page } : {}) };
  }
  return null;
}

/**
 * The board's source of its own kind (an enabled one first, else the oldest), or null. v37 FIX-37A (F10): for an iCIMS
 * board with no enabled source of its kind, a career site an admin turned on for its host comes before an off one.
 */
async function boardSource(t: DbQueries, link: BoardLink): Promise<SourceRecord | null> {
  const found = await sourcesOfBoard(t, link.kind, link.board);
  const sources = found.filter((source) => (source.kind ?? link.kind) === link.kind);
  const site = link.kind === 'icims' ? found.find((source) => source.kind === 'career_site' && (source.enabled || Boolean(source.enabledAt))) : undefined;
  const chosen = sources.find((source) => source.enabled) ?? site ?? sources[0];
  return chosen ? getSourceRecord(t, chosen.id) : null;
}

/**
 * The board's source (boardSource), else a new one made off, named by the board ("acme (2)" when another source holds
 * the name), marked as Add job's: made with the unique key job_sources(kind, name), looked for again before the next
 * name is tried, so two adds of one new board make one source.
 */
async function boardSourceOrNew(t: DbQueries, link: BoardLink, now: string, companyName: string | null = null): Promise<SourceRecord> {
  const config = {
    ...(link.kind === 'bamboohr' ? { company: link.board } : { board: link.board }),
    ...(companyName ? { companyName } : {}), // v37 FIX-37A (E6): the name the read used
    addedBy: ADDED_BY_AUTOFILL,
  };
  for (let n = 1; ; n += 1) {
    const found = await boardSource(t, link);
    if (found) return found;
    const name = n === 1 ? link.board : `${link.board} (${n})`;
    const made = await insertSourceIfNameFree(t, { kind: link.kind, name, config }, now);
    if (made) return made;
  }
}

/** Why a read failed, as a link's verdict: never the error's own text (it holds the board's address). */
function reasonOf(error: unknown, signal: AbortSignal): JobVerifyReason {
  if (error instanceof RobotsRefusal) return error.reason === 'disallowed' ? 'robots' : 'unavailable';
  if (signal.aborted || error instanceof HostHeldError) return 'unavailable';
  if (error instanceof IngestHttpError) return error.status === 401 || error.status === 403 ? 'blocked' : 'unavailable';
  if (error instanceof IngestError) return 'no_posting';
  if (error instanceof OutboundRefusedError) return 'not_set_up';
  return 'unavailable';
}

/**
 * v37 INT-B (CLOSED C1, C3): a failed read's verdict through jobs/add/verdict.ts, as every other link read's: a held
 * host (the site asked TailorIT to slow down, or TailorIT waits before it reads it again) is try later with its pause
 * (pauseOf: the link queue reads it again at the pause's end without using a try; a person's read says when); a 404 or
 * a 410 a read threw is closed; the rest by reasonOf (robots.txt disallows: can't read; a 429 or a 5xx past the
 * request's retries, a timeout, robots.txt unreadable: try later; no posting: can't read).
 */
export function boardLinkFailure(error: unknown, signal: AbortSignal, kind: BoardLink['kind']): LinkRead {
  const pause = pauseOf(error, SOURCE_KIND_LABEL[kind]);
  if (pause) return { kind: 'unreadable', reason: 'unavailable', pause };
  if (error instanceof IngestHttpError && (error.status === 404 || error.status === 410)) return { kind: 'closed' };
  return { kind: 'unreadable', reason: reasonOf(error, signal) };
}

/**
 * Reads a BambooHR or iCIMS link (see the top) and stores its posting as a shared job: the job, closed (a 404 or 410, a
 * status no longer Open, a past validThrough), or why it could not be read. Null for any other link (the caller reads
 * its page). Outside any transaction.
 */
export async function readBoardLinkToSharedJob(deps: AppDeps, url: string, options: PageReadOptions = {}): Promise<PageJobRead | null> {
  const link = boardLinkOf(url);
  if (!link) return null;
  // SEC-8: a link an admin rejected stays rejected (page.ts checks the page a redirect led to; here the link is the read).
  if (await linkRejected(deps.db, sharedAddress(url) ?? url)) return { kind: 'unreadable', reason: 'rejected' };
  if (!newReadsAllowed(deps)) return { kind: 'unreadable', reason: 'not_set_up' };
  const ingest = requireIngest(deps);
  const signal = AbortSignal.timeout(options.timeoutMs ?? ADD_JOB_FETCH_TIMEOUT_MS); // v37 FIX-37A (F9): a queued read's own budget
  const ref: PostingRef = { kind: link.kind, board: link.board, externalId: link.externalId, region: 'global', ...(link.page ? { page: link.page } : {}) };
  // v37 INT-B (the terms gate): a board whose source's recorded terms an admin set to not allow automated access (as
  // the scheduler and Run now read them) is never read by a link either: Add job, the extension, MCP, imports, the link
  // queue and Retry read all come here. No request is sent; the verdict is can't read (TailorIT doesn't read the site).
  const known = await boardSource(deps.db, link);
  // v37 INT-2b (the coordinator's ruling): only the terms that say no (Forbidden, Needs a contract) stop a link's read.
  if (known && termsForbidReads(known.termsStatus)) {
    return { kind: 'unreadable', reason: 'terms' }; // v37 FIX-37B (E8): its own reason (page.ts checks every board first)
  }
  // v37 FIX-37A (E6): a BambooHR opening's company: the import row's, else the source's (see the top).
  const named = link.kind === 'bamboohr' ? options.importRead?.company?.trim() || str(known?.config.companyName) || null : null;
  const config = named ? { ...(known?.config ?? {}), companyName: named } : known?.config;
  let answer: PostingAnswer;
  try {
    answer = await fetchPosting(ingest.botHttp, ref, { config, signal, now: deps.now });
  } catch (error) {
    // Never the error's own text: it holds the board's address.
    const known = [RobotsRefusal, HostHeldError, IngestHttpError, IngestError, OutboundRefusedError].some((type) => error instanceof type);
    if (!known && !signal.aborted) deps.log.warn(`[jobs] add by link: reading the ${link.kind} posting failed`, error instanceof Error ? error.name : 'unknown');
    return boardLinkFailure(error, signal, link.kind); // v37 INT-B (CLOSED C1)
  }
  if (!answer.found) return { kind: 'closed' };
  // v37 FIX-37A (E6): no name yet: the careers page's (best effort, once the opening was read).
  const fromPage = link.kind === 'bamboohr' && !named ? await readBamboohrCompanyName(ingest.botHttp, link.board, signal).catch(() => null) : null;
  const read = fromPage ? { ...answer.raw, company: { ...answer.raw.company, name: fromPage } } : answer.raw;
  const filled = options.importRead ? options.importRead.fill(read) : read;
  const usedName = named ?? fromPage;
  return deps.db.tx(
    async (t): Promise<PageJobRead> => {
      const now = nowIso(deps);
      const source = await boardSourceOrNew(t, link, now, link.kind === 'bamboohr' ? usedName : null);
      // v37 FIX-37A (E6): a BambooHR source with no company name keeps the one this read used.
      if (link.kind === 'bamboohr' && usedName && !str(source.config.companyName)) await keepBamboohrCompanyName(t, source.id, usedName);
      // v37 FIX-37A (F10): kept under an iCIMS host's career site, the posting is that site's page, by its own key.
      const careerKey = source.kind === 'career_site' ? careerPostingIdOf(filled.url) : null;
      const raw = careerKey ? { ...filled, sourceJobId: careerKey } : filled;
      const outcome = await ingest.store.upsertBatch(source, [{ raw, sourceHash: sourceHashOf(raw) }], now);
      const stored = await t.one<{ job_id: number }>('SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ?', [
        source.id,
        storedSourceJobId(raw.sourceJobId),
      ]);
      // Rolled back with the source, if it was new. The failure's message is not logged: it can quote the posting.
      if (outcome.failures.length > 0 || !stored) throw new AppError('internal', 'TailorIT could not save this posting. Please try again.');
      const created = outcome.counts.created > 0;
      const why = { page: false, sourceEnabled: source.enabled, approved: options.approved === true };
      if (created && readWaitsForAdmin(deps, why)) {
        await holdNewJob(t, stored.job_id, now, options.importRead ? 'import' : 'ats', options.importRead?.runId ?? null);
      } else if (!created) await settleHeldAfterRead(deps, t, stored.job_id, { ...why, at: now });
      if (created && options.importRead) await dateImported(t, stored.job_id, now);
      const job = await t.one<{ held: boolean }>('SELECT held_since IS NOT NULL AS held FROM jobs WHERE id = ?', [stored.job_id]);
      return { kind: 'shared', jobId: stored.job_id, created, held: job?.held === true };
    },
    { label: 'add job from its board' },
  );
}
