import type { JobVerifyReason } from '@tailorit/shared';
import { sourceNameOf, type BoardSourceKind } from '@tailorit/shared/sourcing'; // v38 FIX-APP: sourceNameOf (ux L12)
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { AppError } from '../../../core/http/errors';
import { newReadsAllowed } from '../../../core/http/identity';
import { OutboundRefusedError } from '../../../core/http/outbound';
import { ADD_JOB_FETCH_TIMEOUT_MS } from '../../autofill/jobs';
import { insertSourceIfNameFree } from '../../autofill/sources';
import { str } from '../../ingest/adapters/common'; // v37 FIX-37A (E6)
import { apiBoardOf, boardSourceConfig, type ApiBoardDescriptor } from '../../ingest/boards/index'; // v38 FRAME: the board registry
import { readBoardLink } from '../../ingest/boards/links'; // v38 FRAME (A2): the API's link reader
import { linkFeedReads } from '../../ingest/boards/feed-cache'; // v38 FRAME (A3); v38 FIX-C (beh-M2): linkFeedReads
import { clearGoneSighting, liveLinkOf, settleGoneSighting } from '../../ingest/boards/sightings'; // v38 FIX-C (D2)
import { careerPostingIdOf } from '../../ingest/career/run'; // v37 FIX-37A (F10)
import { sourcesOfBoard } from '../../ingest/discovery/offer';
import { HostHeldError, IngestHttpError } from '../../ingest/http';
import { sourceHashOf, storedSourceJobId } from '../../ingest/normalize';
import { fetchPosting, type PostingAnswer, type PostingRef } from '../../ingest/postings';
import { RobotsRefusal } from '../../ingest/robots';
import { requireIngest } from '../../ingest/service';
import { getSourceRecord, termsForbidReads } from '../../ingest/sources'; // v37 INT-B; v37 INT-2b termsForbidReads
import { ADDED_BY_AUTOFILL, IngestError, PostingUnreadableError, SOURCE_KIND_LABEL, type SourceRecord } from '../../ingest/types';
import { holdNewJob } from '../../job-reviews/new-jobs';
import { readWaitsForAdmin, settleHeldAfterRead } from './held';
import { sharedAddress } from './address';
import { dateImported } from './import-time';
import { linkRejected } from './verification';
import { pauseOf, type LinkRead } from './verdict'; // v37 INT-B (CLOSED C1)
import type { PageJobRead, PageReadOptions } from './page';
import { keepRead, storedCompanyName, takeKeptRead } from './kept-read'; // v38 FIX-APP (D1)

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
//
// v38 FRAME (SP v38 PLAN A2, A3): every board kind whose descriptor reads its links (ingest/boards: `posting.refOfLink`
// and readPosting) is read here the same way: its link read by the API's link reader (parseAtsUrl, else its descriptor's
// parseLink), its posting by its readPosting (a new kind of read only once BOT_USER_AGENT is set, and with it), its
// verdict the platform's own signal (closed; try later or can't read: PostingUnreadableError), kept under its board's
// source. A platform whose posting names no company (BambooHR) reads its name once (`posting.companyName`), as E6 does;
// a kind whose descriptor adopts career sites (iCIMS) keeps F10's rule.
//
// v38 FIX-C (SP v38 FIXES-38; REVIEW38-beh M2, L13, D2): a board feed kept from an earlier link's read never closes a
// posting alone (the feed is read again once; Retry read and Edit job's read use none: `freshFeed`); a link that names
// no board (Paylocity's) takes the board of the posting's stored link first (its terms before any request); a gone sign
// that needs a second sighting (Paycom's empty portal: `confirmTwice`) closes a new link at once and a stored job once
// two reads a day apart see it (ingest/boards/sightings.ts). A link on a board kind's host that names no posting its
// reader reads is page.ts's (can't read, never a page read).

/** A link to one posting of a board whose descriptor reads its links (v37: a BambooHR company, an iCIMS site). */
export interface BoardLink {
  kind: BoardSourceKind;
  /** The board as its kind's reads name it (the BambooHR company, the iCIMS board: its host's first label). */
  board: string;
  externalId: string;
  /** The posting's own page (no query), when its read needs it (an iCIMS posting's). */
  page?: string;
}

/** A link's board, its posting's ref and its kind's descriptor (boardLinkOf's, with what the read needs). */
interface BoardLinkRef {
  link: BoardLink;
  ref: PostingRef;
  board: ApiBoardDescriptor;
}

/** The link's posting on a board whose descriptor reads its links, or null for any other link (see the top). */
function boardLinkRefOf(url: string): BoardLinkRef | null {
  const read = readBoardLink(url);
  if (!read) return null;
  const board = apiBoardOf(read.kind);
  const ref = board?.posting?.refOfLink?.(read) ?? null;
  if (!board || !ref) return null;
  const link: BoardLink = { kind: ref.kind, board: ref.board, externalId: ref.externalId, ...(ref.page ? { page: ref.page } : {}) };
  return { link, ref, board };
}

/** The BambooHR opening or iCIMS posting a link names (v38 FRAME: any board whose descriptor reads its links), or null. */
export function boardLinkOf(url: string): BoardLink | null {
  return boardLinkRefOf(url)?.link ?? null;
}

/**
 * The board's source of its own kind (an enabled one first, else the oldest), or null. v37 FIX-37A (F10): for an iCIMS
 * board with no enabled source of its kind, a career site an admin turned on for its host comes before an off one.
 */
async function boardSource(t: DbQueries, link: BoardLink): Promise<SourceRecord | null> {
  const found = await sourcesOfBoard(t, link.kind, link.board);
  const sources = found.filter((source) => (source.kind ?? link.kind) === link.kind);
  // v38 FRAME: a kind whose descriptor adopts career sites (iCIMS).
  const adopts = apiBoardOf(link.kind)?.board.adoptsCareerSites === true;
  const site = adopts ? found.find((source) => source.kind === 'career_site' && (source.enabled || Boolean(source.enabledAt))) : undefined;
  const chosen = sources.find((source) => source.enabled) ?? site ?? sources[0];
  return chosen ? getSourceRecord(t, chosen.id) : null;
}

/**
 * v38 FIX-C (REVIEW38-beh L13): the source of `kind` a stored link of posting `externalId` is under (a live one first,
 * an enabled source first, else the oldest), or null: the board of a link that names none (Paylocity's /Details/<id>),
 * known before any request.
 */
async function storedSourceOfPosting(t: DbQueries, kind: BoardSourceKind, externalId: string): Promise<SourceRecord | null> {
  const row = await t.one<{ id: number }>(
    `SELECT s.id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
     WHERE s.kind = ? AND l.source_job_id = ?
     ORDER BY (l.missing_since IS NULL) DESC, s.enabled DESC, s.id LIMIT 1`,
    [kind, storedSourceJobId(externalId)],
  );
  return row ? getSourceRecord(t, Number(row.id)) : null;
}

/**
 * The board's source (boardSource), else a new one made off, named by the board ("acme (2)" when another source holds
 * the name), marked as Add job's: made with the unique key job_sources(kind, name), looked for again before the next
 * name is tried, so two adds of one new board make one source.
 */
// v38 FIX-APP (REVIEW38-ux L12): `nameBy`, the company a new source of a kind whose board is an id (ADP, Paycom) is named
// by (sourceNameOf): never the GUID or the client key.
async function boardSourceOrNew(t: DbQueries, link: BoardLink, now: string, companyName: string | null = null, nameBy: string | null = null): Promise<SourceRecord> {
  const board = apiBoardOf(link.kind);
  const config = {
    ...(board ? boardSourceConfig(board, link.board) : {}), // v38 FRAME: its board's config (BambooHR's {company}, iCIMS's {board})
    ...(companyName ? { companyName } : {}), // v37 FIX-37A (E6): the name the read used
    addedBy: ADDED_BY_AUTOFILL,
  };
  for (let n = 1; ; n += 1) {
    const found = await boardSource(t, link);
    if (found) return found;
    const base = sourceNameOf(link.kind, link.board, nameBy); // v38 FIX-APP (ux L12)
    const name = n === 1 ? base : `${base} (${n})`;
    const made = await insertSourceIfNameFree(t, { kind: link.kind, name, config }, now);
    if (made) return made;
  }
}

/** Why a read failed, as a link's verdict: never the error's own text (it holds the board's address). */
function reasonOf(error: unknown, signal: AbortSignal): JobVerifyReason {
  if (error instanceof PostingUnreadableError) return error.reason; // v38 FRAME (A3): the platform's own signal
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
  // v38 FRAME (A3): the platform's own word (a readPosting's signal): try later or can't read, with its reason.
  if (error instanceof PostingUnreadableError) return { kind: 'unreadable', reason: error.reason };
  const pause = pauseOf(error, SOURCE_KIND_LABEL[kind]);
  if (pause) return { kind: 'unreadable', reason: 'unavailable', pause };
  if (error instanceof IngestHttpError && (error.status === 404 || error.status === 410)) return { kind: 'closed' };
  return { kind: 'unreadable', reason: reasonOf(error, signal) };
}

/**
 * v37 FIX-37A (E6): keeps a name the board's own page gave as the source's companyName, unless one was set meanwhile (v38
 * FRAME: any board kind's whose posting names no company; the adapter's keepBamboohrCompanyName writes the same).
 */
async function keepCompanyName(db: DbQueries, sourceId: number, name: string): Promise<void> {
  await db.run(
    `UPDATE job_sources SET config = jsonb_set(config, '{companyName}', to_jsonb(CAST(? AS text)))
     WHERE id = ? AND COALESCE(config->>'companyName', '') = ''`,
    [name, sourceId],
  );
}

/**
 * Reads a BambooHR or iCIMS link (see the top) and stores its posting as a shared job: the job, closed (a 404 or 410, a
 * status no longer Open, a past validThrough), or why it could not be read. Null for any other link (the caller reads
 * its page). Outside any transaction.
 */
export async function readBoardLinkToSharedJob(deps: AppDeps, url: string, options: PageReadOptions = {}): Promise<PageJobRead | null> {
  const found = boardLinkRefOf(url);
  if (!found) return null;
  const { link, ref, board } = found;
  const names = board.posting?.companyName; // v37 FIX-37A (E6): a platform whose posting names no company
  // SEC-8: a link an admin rejected stays rejected (page.ts checks the page a redirect led to; here the link is the read).
  if (await linkRejected(deps.db, sharedAddress(url) ?? url)) return { kind: 'unreadable', reason: 'rejected' };
  // v38 ATS-D (SP v38 PLAN "Final coverage"): a platform TailorIT never reads (its robots.txt disallows every page, a bot
  // check guards every page, its job site needs the employer's own login) is can't read with its reason: nothing is sent,
  // no source is made, and the adder keeps the job as their own.
  if (board.posting?.unreadable) return { kind: 'unreadable', reason: board.posting.unreadable };
  if (board.readKind && !newReadsAllowed(deps)) return { kind: 'unreadable', reason: 'not_set_up' };
  const ingest = requireIngest(deps);
  const http = board.readKind ? ingest.botHttp : ingest.http; // v38 FRAME: a new kind of read, with BOT_USER_AGENT
  const signal = AbortSignal.timeout(options.timeoutMs ?? ADD_JOB_FETCH_TIMEOUT_MS); // v37 FIX-37A (F9): a queued read's own budget
  // v37 INT-B (the terms gate): a board whose source's recorded terms an admin set to not allow automated access (as
  // the scheduler and Run now read them) is never read by a link either: Add job, the extension, MCP, imports, the link
  // queue and Retry read all come here. No request is sent; the verdict is can't read (TailorIT doesn't read the site).
  // v38 ATS-C: a link that names no board (Paylocity's) has its source known once its page names the board (below).
  // v38 FIX-C (REVIEW38-beh L13): such a link's posting TailorIT stored before names its board by its source, so a board
  // whose terms say no costs no request.
  const known = link.board ? await boardSource(deps.db, link) : await storedSourceOfPosting(deps.db, link.kind, ref.externalId);
  // v37 INT-2b (the coordinator's ruling): only the terms that say no (Forbidden, Needs a contract) stop a link's read.
  if (known && termsForbidReads(known.termsStatus)) {
    return { kind: 'unreadable', reason: 'terms' }; // v37 FIX-37B (E8): its own reason (page.ts checks every board first)
  }
  // v37 FIX-37A (E6): a BambooHR opening's company: the import row's, else the source's (see the top).
  const named = names ? options.importRead?.company?.trim() || str(known?.config.companyName) || null : null;
  const config = named ? { ...(known?.config ?? {}), companyName: named } : known?.config;
  let answer: PostingAnswer;
  try {
    // v38 FRAME (A3): a feed-based platform's board feed, read once and reused for a short time (boards/feed-cache.ts).
    // v38 FIX-APP (D1): the read kept when it named no company, for the add that brings the company (./kept-read.ts).
    const kept = options.company ? takeKeptRead(deps, sharedAddress(url) ?? url) : null;
    if (kept) {
      answer = kept;
    } else {
      // v38 FIX-C (REVIEW38-beh M2): never closed from a kept feed alone: a posting missing from a feed kept from an
      // earlier read has the feed read again (fresh) once; Retry read and Edit job's read (`freshFeed`) use none.
      const reads = linkFeedReads(deps, { fresh: options.freshFeed === true });
      answer = await fetchPosting(http, ref, { config, signal, now: deps.now, feeds: reads.feeds });
      if (!answer.found && reads.reused()) {
        answer = await fetchPosting(http, ref, { config, signal, now: deps.now, feeds: linkFeedReads(deps, { fresh: true }).feeds });
      }
    }
  } catch (error) {
    // Never the error's own text: it holds the board's address.
    const known = [RobotsRefusal, HostHeldError, IngestHttpError, IngestError, OutboundRefusedError].some((type) => error instanceof type);
    if (!known && !signal.aborted) deps.log.warn(`[jobs] add by link: reading the ${link.kind} posting failed`, error instanceof Error ? error.name : 'unknown');
    return boardLinkFailure(error, signal, link.kind); // v37 INT-B (CLOSED C1)
  }
  if (!answer.found) {
    // v38 FIX-C (SP v38 FIXES-38 D2): a gone sign that closes a stored job only once two reads a day apart see it (Paycom's
    // empty portal page, boards/sightings.ts): a link no source stores live closes at once; a stored one's first sighting
    // is recorded and the read is tried later (its pause: the link queue reads it again then, using no try).
    if (answer.confirmTwice) {
      const stored = known ? await liveLinkOf(deps.db, known.id, storedSourceJobId(ref.externalId)) : null;
      const sighting = await settleGoneSighting(deps.db, stored, deps.now());
      if (!sighting.close) {
        return { kind: 'unreadable', reason: 'unavailable', pause: { until: sighting.until, site: SOURCE_KIND_LABEL[link.kind], slowDown: false } };
      }
    }
    return { kind: 'closed' };
  }
  // v38 ATS-C: a link that names no board is kept under the board its posting's page names (Paylocity's "View All Jobs"),
  // its source's terms and company name read now (one page was read to learn the board); a page that names none stores
  // nothing (can't read).
  const own = link.board ? null : answer.board ? { ...link, board: answer.board } : null;
  if (!link.board && !own) return { kind: 'unreadable', reason: 'no_posting' };
  const ownSource = own ? await boardSource(deps.db, own) : null;
  if (ownSource && termsForbidReads(ownSource.termsStatus)) return { kind: 'unreadable', reason: 'terms' };
  const ownName = str(ownSource?.config.companyName);
  const keptUnder = own ?? link;
  // v37 FIX-37A (E6): no name yet: the careers page's (best effort, once the opening was read).
  const fromPage = names && !named ? await names(http, link.board, signal).catch(() => null) : null;
  const pageName = fromPage ?? ownName;
  const read = pageName ? { ...answer.raw, company: { ...answer.raw.company, name: pageName } } : answer.raw;
  const filled = options.importRead ? options.importRead.fill(read) : read;
  const usedName = named ?? fromPage;
  // v38 FIX-APP (SP v38 FIXES-38 D1; REVIEW38-ux H1): a posting that names no company (none from the posting, its
  // list, its source or an import row) is named by the company its stored job has (a name given before), else by the
  // company the person typed (Add job's `company`); with neither, Add job asks for it: the read is kept and nothing
  // is stored (no job, no source, no company record). Never a name made up from a host, an id or the platform's name.
  const unnamed = !filled.company.name.trim();
  const given = unnamed ? (await storedCompanyName(deps.db, (ownSource ?? known)?.id, filled.sourceJobId)) ?? (options.company?.trim() || null) : null;
  if (unnamed && !given) {
    keepRead(deps, sharedAddress(url) ?? url, answer);
    return { kind: 'unreadable', reason: 'no_posting', needsCompany: true };
  }
  const posting = given ? { ...filled, company: { ...filled.company, name: given } } : filled;
  // end v38 FIX-APP
  return deps.db.tx(
    async (t): Promise<PageJobRead> => {
      const now = nowIso(deps);
      // v38 FIX-APP (ux L12): a new source of an id-named board takes its company's name (the source's or an import row's;
      // the posting's own employer for a kind whose posting names one), never a person's typed name.
      const source = await boardSourceOrNew(t, keptUnder, now, names ? usedName : null, names ? usedName : filled.company.name || null); // v38 ATS-C: `keptUnder`
      // v37 FIX-37A (E6): a BambooHR source with no company name keeps the one this read used.
      if (names && usedName && !str(source.config.companyName)) await keepCompanyName(t, source.id, usedName);
      // v37 FIX-37A (F10): kept under an iCIMS host's career site, the posting is that site's page, by its own key.
      const careerKey = source.kind === 'career_site' ? careerPostingIdOf(posting.url) : null; // v38 FIX-APP: `posting`
      const raw = careerKey ? { ...posting, sourceJobId: careerKey } : posting;
      const outcome = await ingest.store.upsertBatch(source, [{ raw, sourceHash: sourceHashOf(raw) }], now);
      const stored = await t.one<{ job_id: number }>('SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ?', [
        source.id,
        storedSourceJobId(raw.sourceJobId),
      ]);
      // Rolled back with the source, if it was new. The failure's message is not logged: it can quote the posting.
      if (outcome.failures.length > 0 || !stored) throw new AppError('internal', 'TailorIT could not save this posting. Please try again.');
      // v38 FIX-C (D2): read live: a gone sign seen once before is forgotten.
      await clearGoneSighting(t, { sourceId: source.id, sourceJobId: storedSourceJobId(raw.sourceJobId) });
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
