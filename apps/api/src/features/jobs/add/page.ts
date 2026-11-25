import { linkKey, type JobVerifyReason } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { AppError } from '../../../core/http/errors';
import { siteReader } from '../../../core/seams';
import { insertSourceIfNameFree } from '../../autofill/sources';
import { isCompanyDomain, registrableDomain } from '../../companies/domain';
import { linkedinCompanyUrl } from '../../companies/profile';
import { careerKeysOf, organizationDomainOf } from '../../ingest/career/keys';
import { expiredAt, pageJobPosting, type JobPostingData } from '../../ingest/career/jsonld';
import { careerPostingIdOf, rawPostingOf } from '../../ingest/career/run';
import { sourceHashOf, storedSourceJobId } from '../../ingest/normalize';
import { requireIngest } from '../../ingest/service';
import { toSourceRecord, type SourceRow } from '../../ingest/sources';
import { ADDED_BY_AUTOFILL, isAddedPageSource, type RawPosting, type SourceRecord } from '../../ingest/types';
import { holdNewJob } from '../../job-reviews/new-jobs';
import { sharedAddress } from './address';
import { readWaitsForAdmin, settleHeldAfterRead } from './held';
import { dateImported } from './import-time'; // v36 IMPORTTIME
import { linkRejected } from './verification';
import { isWorkdayPageHost, pauseOfHold, type LinkRead, type ReadPause } from './verdict'; // v37 CLOSED (C1, C3, C4); v37 INT-A pauseOfHold
import { readBoardLinkToSharedJob } from './board-link'; // v37 BOARDS
import { termsRefusalOfLink } from '../../ingest/terms'; // v37 FIX-37B (E2)

// v31 LINK (D3, docs/design/v3.1/21-jobs-from-links.md §4): an added job's own page, read once by TailorIT for its
// schema.org JobPosting, when no ATS API reads the posting. The read goes through the shared reader (core/seams
// siteReader, purpose `add_page`): its switch ADD_JOB_PAGE_READ, the identity guard (`add_page`: nothing is sent while
// BOT_USER_AGENT is the placeholder), the opt-out list, the host's hold, robots.txt, the host's pace, https and a public
// address at connect time, the size and time caps, at most a few redirects on the same registrable domain, and the
// walls a read never crosses (a sign-in page, a bot check). Only the page's own JobPosting is read (career/jsonld.ts).
//
// A posting read is stored through the ingest pipeline under the host's career-site source (made disabled, marked as
// Add job's, as Add job makes an ATS board's): the same normalising, dedupe, company and analysis as a career site's run.
//
// v31 FIX-LINK (REV-SEC SEC-1, SEC-2, SEC-3, SEC-8; decision D12): the page is whatever its owner wrote, so under Add
// job's source (an admin's career site of the host is the admin's word for it) the read is held to its own site:
//   - SEC-2: the page is read at the link given (a person's own), but every address kept is its shared form
//     (address.ts: no ?email=, ?token=, ?session_id=, ...): the Apply link, the source's id, the keys;
//   - SEC-1: its keys are its own site's only (career/keys.ts ownSiteOnly: no ATS posting, no other domain's id), and
//     the store never rewrites a job another source read nor finds one by its text (store.ts isAddedPageSource);
//   - SEC-3: its hiringOrganization counts for a company only when the domain it claims is the page's own registrable
//     domain (then only its links on that domain, and LinkedIn's, are kept); otherwise the company is named by the name
//     alone, never one with a board or a domain of its own, and nothing is written about it (store.ts, companies/
//     resolve.ts resolveCompanyByName); a company that opted out (do_not_fetch), or any company of its name that did,
//     gets no job from a page (`opted_out`);
//   - SEC-8: the page a redirect led to is refused when an admin rejected it, as the link given is (pipeline.ts);
//   - D12: a job new to TailorIT waits in Admin › Review (held, its review opened) unless PAGE_JOBS_AUTO_PUBLISH is on
//     (or the read is an admin's approval: `approved`); a read that lands on a job the legacy pass holds settles it
//     (held.ts: BEH-4).

/** What reading an added job's page came to (v37 CLOSED: a LinkRead, a held host's read with its pause). */
export type PageJobRead = LinkRead;

const unreadable = (reason: JobVerifyReason): PageJobRead => ({ kind: 'unreadable', reason });

/** A reason the page's job is not stored, found inside the store's transaction (the transaction rolls back). */
class PageRefusal extends Error {
  constructor(readonly reason: JobVerifyReason) {
    super(reason);
    this.name = 'PageRefusal';
  }
}

/**
 * The reader's answer for the page: its JobPosting, or why there is none. Outside any transaction. v37 CLOSED (C1, C3,
 * C4): a robots.txt that could not be read is a failure for now (`unavailable`), only its disallow is lasting (`robots`);
 * a held host's refusal, and a 429's, carry the pause (until when, the host); a Workday host is never read as a page
 * (its posting is read from its JSON: workday.ts), so its link that names no posting is `no_posting` with no request.
 */
export async function readJobPage(
  deps: AppDeps,
  url: string,
): Promise<{ kind: 'posting'; posting: JobPostingData; finalUrl: string } | { kind: 'closed' } | { kind: 'unreadable'; reason: JobVerifyReason; pause?: ReadPause }> {
  const host = new URL(url).hostname.toLowerCase();
  if (isWorkdayPageHost(host)) return { kind: 'unreadable', reason: 'no_posting' }; // v37 CLOSED (C4)
  const result = await siteReader.read(deps, { url, purpose: 'add_page', accept: 'html' });
  if (!result.ok) {
    // v37 CLOSED (C3): a host held, or a 429, says until when. v37 INT-A: a held host's pause is the one helper's
    // (verdict.ts pauseOfHold): a host held after its 429 (`retry_after`) asked TailorIT to slow down.
    const pause = (slowDown: boolean): { pause?: ReadPause } => (result.retryAt ? { pause: { until: result.retryAt, site: host, slowDown } } : {});
    const heldPause = (): { pause?: ReadPause } =>
      result.retryAt ? { pause: pauseOfHold({ until: result.retryAt, reason: result.holdReason ?? 'admin' }, host) } : {};
    switch (result.refusal) {
      case 'switch_off':
      case 'identity_placeholder':
        return { kind: 'unreadable', reason: 'not_set_up' };
      case 'opted_out':
        return { kind: 'unreadable', reason: 'opted_out' };
      case 'robots':
        // v37 CLOSED (C1): an unreachable robots.txt (the reader answers it with a time to ask again) is a failure for now.
        return result.retryAt ? { kind: 'unreadable', reason: 'unavailable' } : { kind: 'unreadable', reason: 'robots' };
      case 'blocked':
        return { kind: 'unreadable', reason: 'blocked', ...(result.status === 429 ? pause(true) : {}) };
      case 'failed':
        if (result.status === 404 || result.status === 410) return { kind: 'closed' };
        return { kind: 'unreadable', reason: 'unavailable' };
      case 'held':
        return { kind: 'unreadable', reason: 'unavailable', ...heldPause() };
      default:
        return { kind: 'unreadable', reason: 'unavailable' };
    }
  }
  if (result.status === 404 || result.status === 410) return { kind: 'closed' };
  if (result.notModified || result.status < 200 || result.status >= 300) return { kind: 'unreadable', reason: 'unavailable' };
  const posting = pageJobPosting(result.body.toString('utf8'), result.finalUrl);
  if (!posting) return { kind: 'unreadable', reason: 'no_posting' };
  // 12 §8.1: a past validThrough is a closed posting.
  if (expiredAt(posting, deps.now())) return { kind: 'closed' };
  return { kind: 'posting', posting, finalUrl: result.finalUrl };
}

/**
 * The host's career-site source (an enabled one first, else the oldest), else a new one: disabled, named as the admin
 * console names one (the host, made unique), marked as Add job's. Made with the unique key job_sources(kind, name) and
 * ON CONFLICT DO NOTHING (autofill/sources.ts), looked for again before the next name is tried, as Add job's boards are.
 */
async function siteSourceOrNew(t: DbQueries, host: string, now: string): Promise<SourceRecord> {
  for (let n = 1; ; n += 1) {
    const found = await t.one<SourceRow>(
      "SELECT * FROM job_sources WHERE kind = 'career_site' AND host = ? ORDER BY enabled DESC, id LIMIT 1",
      [host],
    );
    if (found) return toSourceRecord(found);
    const name = n === 1 ? host : `${host} (${n})`;
    const made = await insertSourceIfNameFree(
      t,
      { kind: 'career_site', name, config: { host, addedBy: ADDED_BY_AUTOFILL } },
      now,
    );
    if (made) return made;
  }
}

/**
 * v31 FIX-LINK (SEC-3): what a page under Add job's source may say of its employer (see the top): the organisation's
 * domain only when it is the page's own registrable domain (its links on that domain and its LinkedIn page kept, its
 * logo with them), else its name alone (no website, no hiringOrganization hand-off).
 */
export function pageOwnOrganization(raw: RawPosting, pageAddress: string): RawPosting {
  const org = raw.hiringOrganization;
  const pageDomain = registrableDomain(pageAddress);
  const claimed = organizationDomainOf(org ?? null);
  if (!org || !claimed || claimed !== pageDomain || !isCompanyDomain(pageDomain)) {
    const { hiringOrganization: _dropped, ...rest } = raw;
    return { ...rest, company: { ...raw.company, website: null } };
  }
  const own = (link: string | null | undefined): link is string => typeof link === 'string' && registrableDomain(link) === pageDomain;
  const sameAs = org.sameAs.filter((link) => own(link) || linkedinCompanyUrl(link) !== null);
  return { ...raw, hiringOrganization: { ...org, sameAs, url: own(org.url) ? org.url : null } };
}

/** Whether the job's company, or a shared company of its name, opted out (companies.do_not_fetch). */
async function optedOutCompany(t: DbQueries, jobId: number): Promise<boolean> {
  const row = await t.one<{ found: number }>(
    `SELECT 1 AS found FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.id = ? AND (c.do_not_fetch OR EXISTS (SELECT 1 FROM companies o WHERE o.name_key = c.name_key AND o.do_not_fetch
       AND o.owner_user_id IS NULL AND o.merged_into_id IS NULL))`,
    [jobId],
  );
  return row !== undefined;
}

/**
 * v35 INT-A (SP v35 PLAN.md H2, H3): TailorIT's read of an admin import's link (import-pipeline.ts). Its row fills what
 * the read lacks (`fill`, on the read's raw posting before the store; a page whose JobPosting names no employer takes the
 * row's `company`), and a job the read makes and holds for Admin › Review › New jobs is the import's from the start
 * (holdNewJob origin `import`, with the import's run, in the store's transaction): the New jobs From filter lists it,
 * and the AI job analysis leaves it until it is approved (job-analysis/backlog.ts).
 * v36 IMPORTTIME (SP v36 PLAN.md I1): a job the read makes, published or held, is dated the import's (import-time.ts
 * dateImported: jobs.reposted_at now), in the store's transaction: it is under "Past 24 hours" whatever its board's date.
 * Only an admin's import reads with an ImportRead (a person's import never does: their board's date counts).
 */
export interface ImportRead {
  /** The import's run (Admin › Runs), or null. */
  runId: number | null;
  /** The row's company, or null. */
  company: string | null;
  /** The read's raw posting with the row's fields where it has none. */
  fill: (raw: RawPosting) => RawPosting;
}

export interface PageReadOptions {
  /** The read is an admin's approval of the posting at this link (job-reviews/page-read.ts): published, never held (D12). */
  approved?: boolean;
  /** v35 INT-A: an admin import's read (ImportRead). */
  importRead?: ImportRead;
  /**
   * v37 FIX-37A (REVIEW37-beh F9): a queued read's budget (LINK_QUEUE_READ_TIMEOUT_MS) for a BambooHR or iCIMS link
   * (jobs/add/board-link.ts); a person's read keeps ADD_JOB_FETCH_TIMEOUT_MS.
   */
  timeoutMs?: number;
}

/**
 * Reads the job's page (readJobPage) at `url` (the link as given, in its canonical form) and stores its JobPosting as a
 * shared job (see the top), answering the job, or why there is none. The job's Apply link is the page that answered
 * (its shared form, after the reader's redirects on the same domain), and the link added is one of its keys too.
 */
export async function readPageToSharedJob(deps: AppDeps, url: string, options: PageReadOptions = {}): Promise<PageJobRead> {
  // v37 FIX-37B (SP v37 FIXES-37 E2): a board (or a career site's host) whose source's terms an admin recorded as not
  // allowing automated access is never read, whoever asks: nothing is sent (ingest/terms.ts).
  if (await termsRefusalOfLink(deps.db, url)) return unreadable('terms');
  // v37 BOARDS (SP v37 PLAN B4, I4): a BambooHR opening or an iCIMS posting is read as its board's run reads it (the
  // opening's detail JSON; the posting's ?in_iframe=1 page, which holds its JobPosting) and kept under the board's
  // source, made off: never as a career page (jobs/add/board-link.ts).
  const board = await readBoardLinkToSharedJob(deps, url, options);
  if (board) return board;
  const read = await readJobPage(deps, url);
  if (read.kind !== 'posting') return read;
  const address = sharedAddress(read.finalUrl) ?? sharedAddress(url);
  if (!address) return unreadable('invalid_link');
  // SEC-8: a redirect may lead to a page an admin rejected.
  if (await linkRejected(deps.db, address)) return unreadable('rejected');
  const host = new URL(address).hostname;
  const sourceJobId = careerPostingIdOf(address);
  if (!sourceJobId) return unreadable('no_posting');
  // The link added names the job too (a redirect may have moved it): its `link` key beside the page's own.
  const added = linkKey(sharedAddress(url));
  const ingest = requireIngest(deps);
  try {
    return await deps.db.tx(
      async (t): Promise<PageJobRead> => {
        const now = nowIso(deps);
        const source = await siteSourceOrNew(t, host, now);
        const untrusted = isAddedPageSource(source);
        const { keys } = await careerKeysOf(t, address, read.posting, { ownSiteOnly: untrusted });
        const allKeys = added && added !== linkKey(address) ? [...keys, { kind: 'link' as const, key: added }] : keys;
        // v35 INT-A: an admin import's row names the employer of a page that names none.
        const made = rawPostingOf(read.posting, { address, sourceJobId }, { companyName: options.importRead?.company ?? null }, allKeys);
        // A JobPosting that names no employer is no posting TailorIT can list.
        if (!made) throw new PageRefusal('no_posting');
        const filled = options.importRead ? options.importRead.fill(made) : made; // v35 INT-A: the row fills what the page lacks
        const raw = untrusted ? pageOwnOrganization(filled, address) : filled;
        const outcome = await ingest.store.upsertBatch(source, [{ raw, sourceHash: sourceHashOf(raw) }], now);
        const link = await t.one<{ job_id: number }>('SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ?', [
          source.id,
          storedSourceJobId(raw.sourceJobId),
        ]);
        // Rolled back with the source, if it was new. The failure's message is not logged: it can quote the posting.
        if (outcome.failures.length > 0 || !link) throw new AppError('internal', 'TailorIT could not save this posting. Please try again.');
        // SEC-3: a company that asked TailorIT not to read about it gets no job from a page (everything rolls back).
        if (await optedOutCompany(t, link.job_id)) throw new PageRefusal('opted_out');
        const created = outcome.counts.created > 0;
        const why = { page: true, sourceEnabled: source.enabled, approved: options.approved === true };
        // D1 + D12: a page's new job waits for an admin unless PAGE_JOBS_AUTO_PUBLISH is on.
        // v35 INT-A: held by an admin import's read: the import's (its run), in this transaction.
        if (created && readWaitsForAdmin(deps, why)) {
          await holdNewJob(t, link.job_id, now, options.importRead ? 'import' : 'ats', options.importRead?.runId ?? null);
        }
        else if (!created) await settleHeldAfterRead(deps, t, link.job_id, { ...why, at: now });
        if (created && options.importRead) await dateImported(t, link.job_id, now); // v36 IMPORTTIME (I1)
        const job = await t.one<{ held: boolean }>('SELECT held_since IS NOT NULL AS held FROM jobs WHERE id = ?', [link.job_id]);
        return { kind: 'shared', jobId: link.job_id, created, held: job?.held === true };
      },
      { label: 'add job from its page' },
    );
  } catch (error) {
    if (error instanceof PageRefusal) return unreadable(error.reason);
    throw error;
  }
}
