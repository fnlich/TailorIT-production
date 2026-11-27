import { canonicalJobUrl, normalizeCompanyName, normalizeJobTitle, STATUS, type CreateApplicationBody } from '@tailorit/shared';
import { BOARD_DESCRIPTORS } from '@tailorit/shared/sourcing'; // v38 FRAME
import {
  addablePosting,
  AUTOFILL_ADDABLE_ATS,
  type AddablePosting,
  type AtsKind,
  type AutofillAddJobRequest,
  type AutofillAddJobResponse,
} from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { constantsOf } from '../../core/constants/index'; // v37 FIX-37B (E8)
import { AppError } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse'; // v31 LINK
import { bestResumes, SINGLE_SAVE_MATCH_BUDGET_MS } from '../applications/resume-choice';
import { createApplication, wantsResumeMatch, type CreateOptions } from '../applications/service';
import { IngestHttpError } from '../ingest/http';
import { workdayLinkPosting } from '../ingest/adapters/workday'; // v37 CLOSED (C4)
import { ADDED_BY_AUTOFILL } from '../ingest/liveness';
import { sourceHashOf } from '../ingest/normalize';
import { fetchPosting, type AshbyBoardReads, type PostingAnswer } from '../ingest/postings';
import { RobotsRefusal } from '../ingest/robots';
import { requireIngest } from '../ingest/service';
import { termsRefusalOfPosting, TermsRefusalError } from '../ingest/terms'; // v37 FIX-37B (E2)
import { IngestError, PostingUnreadableError, type SourceRecord } from '../ingest/types';
import { holdNewJob, noteHeldAdd, type HeldAdder } from '../job-reviews/new-jobs'; // v30 X1-API; v33 SHARE-6: HeldAdder
import { isRefusedPageHost } from '../job-reviews/hosts'; // v31 LINK
import { readPageToSharedJob, type ImportRead } from '../jobs/add/page'; // v31 LINK; v35 INT-A: ImportRead
import { readWaitsForAdmin, settleHeldAfterRead } from '../jobs/add/held'; // v31 FIX-LINK
import { dateImported } from '../jobs/add/import-time'; // v36 IMPORTTIME
import { REVIEW_HELD_SQL } from '../jobs/add/review-held'; // v31 FIX-LINK (a leaf: the SQL below is built at load)
import { offerBoardOfClosedLink } from '../jobs/add/closed-link'; // v37 CLOSED (C7)
import { pauseMessage, pauseOf, TRY_LATER_REASONS } from '../jobs/add/verdict'; // v37 CLOSED (C1, C3); v38 FRAME: TRY_LATER_REASONS
import { aliasValueHash } from './alias-key';
import { jobPlaces, placesMeet } from './places';
import { insertSourceIfNameFree, sourcesOfKind } from './sources';
import {
  findApplication,
  findPageJob,
  lookupPosting,
  namesPosting,
  postingIdentityOf,
  pageKeys,
  readingsOf,
  readPage,
  SOURCE_BOARD,
  sourceLinkMatch,
  type EntryFacts,
  type JobMatch,
  type PageReading,
  type SourceLinkRow,
} from './lookup';
import { moveAdminEdits } from '../job-reviews/edit/apply'; // v38 REVEDIT (PLAN E4)

// Adding the posting an application page shows (POST /api/autofill/jobs, the extension's "Add this job to TailorIT"
// and "Save to tracker"): to TailorIT's jobs when it has not got it, and to the person's tracker as Saved either way.
// A job TailorIT has is found as the lookup finds it, from any page the lookup reads (a company page's ?gh_jid=, a
// Workday page found by its link); only a posting TailorIT lacks must be one it can read (Greenhouse, Lever and, since
// autofill API version 3, Ashby, since 4, Workable, and since 5, Workday). That posting is read from its board's public
// API, one posting (ingest/postings.ts: Ashby's from its board's listing, read once; Workable's from its own address,
// which needs the account the page names; Workday's from the read its posting page makes, once the tenant's robots.txt
// allows it), never from the page (POST /jobs/from-page, from-page.ts, is the one route that keeps a page's text, for
// the postings no ATS API reads), and stored through the ingest pipeline
// (store.upsertBatch): the same normalising, dedupe, company, places and rule-based analysis as a run, so its
// keywords and the match exist at once. It goes under the board's existing source, else a new disabled one marked as
// Add job's (the whole board is read only once an admin enables it; until then the daily liveness check asks for the
// posting by its id, Add job's sources first). A job TailorIT closed is read again the same way, so a posting its
// board lists again reopens. No AI work is queued here: Claude's analysis follows the add-time backlog
// (AI_JOB_ANALYSIS), as for any new job. The tracker entry is made by the tracker's own service, as the Jobs page's
// Save makes it: a new one at Saved with TailorIT's best resume linked, an existing one restored and never moved back;
// an entry the person added by hand for this posting (no job, its link) is linked to the job first, never doubled.
// The page's address is used here only: never stored on the job (the board's own link is), logged or answered back.
//
// v30 X1-API (docs/design/part2/14-extension-reports.md §4.1): a posting new to TailorIT from a board no ENABLED source
// runs is held for review (job-reviews/new-jobs.ts holdNewJob, in the store's transaction): in its adders' Saved jobs,
// Tracker, Queue and Prepare, out of everyone's search until Admin › Review approves it. Each adder's review report row
// is written before their tracker entry (saveToTracker → noteHeldAdd). Another account's add of a held posting lands on
// it without reading the board again (heldJobOf, openHeldJobOf). The disabled source marked as Add job's still keeps the
// posting's link; it is no discovery candidate until the job is approved (v36 SOURCES: discovery's link sweep skips held
// jobs, and a board validation adopts stays off, waiting for an admin: nothing but an admin turns a source on).

/** How long the board has to answer, the client's turn-taking and retries included (the extension waits 25 s). */
export const ADD_JOB_FETCH_TIMEOUT_MS = 15_000;

/**
 * The ATSs Add job reads one posting of, in their words (v38 FRAME: each board kind's descriptor's whose atsKind the
 * extension's contract adds: AUTOFILL_ADDABLE_ATS, pinned).
 */
export const ATS_NAMES: Readonly<Record<AddablePosting['kind'], string>> = Object.fromEntries(
  AUTOFILL_ADDABLE_ATS.map((kind) => {
    const board = BOARD_DESCRIPTORS.find((descriptor) => descriptor.atsKind === kind)!;
    return [kind, board.runLabel ?? board.label];
  }),
) as Record<AddablePosting['kind'], string>;

const UNLISTED =
  'This Ashby posting is not on its board\'s public list (it is reached by its own link only), so TailorIT cannot add ' +
  'it. Save it from the Tracker with "+ Add application" instead.';

const UNSUPPORTED =
  'TailorIT can add jobs from Greenhouse, Lever, Ashby, Workable and Workday postings only (on Greenhouse, from a page ' +
  'that names the job board; on Workable, from a page that names the company\'s account). Save this one from the ' +
  'Tracker with "+ Add application" instead.';

const ROBOTS_DISALLOW =
  "This Workday site's robots.txt asks automated readers not to read its postings, so TailorIT does not read this one " +
  'from Workday. Add it from the page instead, or save it from the Tracker with "+ Add application".';

export interface AddedJob {
  answer: AutofillAddJobResponse;
  /** The page's ATS, for the debug line; null when the address is none TailorIT reads (a job found by its link). */
  kind: AtsKind | null;
}

/** The source the board's postings are stored under: an enabled one first, else the oldest; null when there is none. */
async function boardSource(db: DbQueries, posting: AddablePosting): Promise<SourceRecord | null> {
  const boardOf = SOURCE_BOARD[posting.kind]!;
  const board = posting.board.toLowerCase();
  const sources = (await sourcesOfKind(db, posting.kind)).filter(
    (source) =>
      boardOf(source.config).toLowerCase() === board &&
      (posting.kind !== 'lever' || (String(source.config.region).toLowerCase() === 'eu' ? 'eu' : 'global') === posting.region),
  );
  return sources.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id - b.id)[0] ?? null;
}

/**
 * The board's source (boardSource), else a new disabled one, named as the admin console names one (the board), made
 * unique ("acme (2)"), and marked as Add job's (`addedBy`), which the admin console keeps when it changes the source.
 * A Workable account's keeps the company name Workable gives it (`listedCompany`, read with the posting) as its
 * companyName, so a later run, the daily check and other adds name the company the same way without reading the
 * account's list again. v3.0 D2-B (the concurrency audit): a name is taken with the unique key job_sources(kind, name)
 * and ON CONFLICT DO NOTHING (sources.ts), never looked for first; a name taken (by another board's source, or by an
 * add of this board's at the same moment) has the board's source looked for again before the next name is tried, so
 * two adds of one new board make one source.
 */
async function boardSourceOrNew(
  t: DbQueries,
  posting: AddablePosting,
  now: string,
  listedCompany: string | undefined,
): Promise<SourceRecord> {
  const named = listedCompany ? { companyName: listedCompany } : {};
  const board =
    posting.kind === 'greenhouse'
      ? { token: posting.board }
      : posting.kind === 'ashby'
        ? { board: posting.board }
        : posting.kind === 'workable'
          ? { account: posting.board, ...named }
          : posting.kind === 'workday'
            ? { tenant: posting.board, ...named }
            : { site: posting.board, region: posting.region };
  const config = { ...board, addedBy: ADDED_BY_AUTOFILL };
  for (let n = 1; ; n += 1) {
    const found = await boardSource(t, posting);
    if (found) return found;
    const name = n === 1 ? posting.board : `${posting.board} (${n})`;
    const made = await insertSourceIfNameFree(t, { kind: posting.kind, name, config }, now);
    if (made) return made;
  }
}

/**
 * The board's failure as the extension shows it: 503 when it could not be reached in time, else 502. v37 CLOSED (C3):
 * a host held (Workday's paused lane, a site that asked TailorIT to slow down) is 503 at once with the time to try again
 * ("Workday asked us to slow down. Try again after 3:42 PM Pacific Time."), the hold riding along (`cause`).
 */
function boardFailure(deps: AppDeps, error: unknown, kind: AddablePosting['kind'], signal: AbortSignal, timeoutMs: number): AppError {
  const ats = ATS_NAMES[kind];
  const later = 'Try again in a minute.';
  const pause = pauseOf(error, ats);
  if (pause) return new AppError('ats_unavailable', pauseMessage(deps, pause), { cause: error });
  if (error instanceof RobotsRefusal && !signal.aborted) {
    // The refusal rides along (`cause`): adding from the page then keeps the page's text instead (from-page.ts).
    return error.reason === 'disallowed'
      ? new AppError('unsupported', ROBOTS_DISALLOW, { cause: error })
      : new AppError('ats_unavailable', `${ats}'s robots.txt could not be read, so TailorIT did not read the posting. ${later}`, {
          cause: error,
        });
  }
  if (signal.aborted) {
    return new AppError('ats_unavailable', `${ats} did not answer within ${Math.round(timeoutMs / 1000)} seconds. ${later}`);
  }
  if (error instanceof IngestHttpError) {
    if (error.status === 0 || error.status === 429 || error.status >= 500) {
      return new AppError('ats_unavailable', `${ats} could not be reached. ${later}`);
    }
    // The client stopped reading an answer over its cap.
    if (error.status === 413) return new AppError('ats_failed', `${ats}'s answer is too large for TailorIT to read.`);
    // v37 CLOSED (C1): a 404 or a 410 a reader did not expect (a Workable posting's 410, a board's) is a closed posting.
    if (error.status === 404 || error.status === 410) return new AppError('not_found', `${ats} no longer has this posting: it has closed.`);
    return new AppError('ats_failed', `${ats} refused to send this posting (HTTP ${error.status}).`);
  }
  // v38 FRAME (SP v38 PLAN A3): the platform's own word that the posting can't be read now (try later) or at all, its
  // reason riding along (`cause`: verdict.ts atsFailure reads it).
  if (error instanceof PostingUnreadableError) {
    return TRY_LATER_REASONS.has(error.reason)
      ? new AppError('ats_unavailable', `${ats} could not be reached. ${later}`, { cause: error })
      : new AppError('ats_failed', `${ats}'s answer is not a posting TailorIT can read.`, { cause: error });
  }
  // An answer that is not a posting TailorIT can read is the ATS's lasting word (`cause`): adding from the page then
  // keeps the page's text (from-page.ts).
  if (error instanceof IngestError) {
    return new AppError('ats_failed', `${ats}'s answer is not a posting TailorIT can read.`, { cause: error });
  }
  return new AppError('ats_failed', `TailorIT could not read this posting from ${ats}. ${later}`);
}

/**
 * Reads the posting from its board and stores it (see above), answering its job and whether it is new to TailorIT
 * (dedupe may find it under another source's job). 404 `not_found` when the board no longer has it; 502 or 503 when the
 * board fails. Nothing is written until the posting has been read. v35 INT-A: `importRead`, an admin import's read: its
 * row fills what the posting lacks, and a new job it holds is the import's (jobs/add/page.ts ImportRead).
 */
async function readAndStore(
  deps: AppDeps,
  posting: AddablePosting,
  boards: AshbyBoardReads,
  importRead?: ImportRead,
  timeoutMs: number = ADD_JOB_FETCH_TIMEOUT_MS, // v37 CLOSED (C3): the link queue's reads wait longer for their turn
): Promise<{ jobId: number; created: boolean }> {
  const ingest = requireIngest(deps);
  // v37 FIX-37B (SP v37 FIXES-37 E2, E8): a board whose source's terms an admin recorded as not allowing automated access is
  // never read (nothing sent): `unsupported` in the person's words (MSG_JOB_VERIFY_TERMS), the refusal along (a link's
  // read answers the reason `terms`: verdict.ts atsFailure).
  const refusal = await termsRefusalOfPosting(deps.db, posting);
  if (refusal) throw new AppError('unsupported', constantsOf(deps).message('MSG_JOB_VERIFY_TERMS'), { cause: new TermsRefusalError(refusal) });
  const signal = AbortSignal.timeout(timeoutMs);
  let answer: PostingAnswer;
  try {
    const config = (await boardSource(deps.db, posting))?.config;
    answer = await fetchPosting(ingest.http, posting, { config, signal, boards, shareWhileReading: true });
  } catch (error) {
    // Never the error's own text: it holds the board's API address.
    if (!(error instanceof IngestHttpError || error instanceof IngestError || error instanceof RobotsRefusal) && !signal.aborted) {
      deps.log.warn(`[autofill] add job: reading the ${posting.kind} posting failed`, error instanceof Error ? error.name : 'unknown');
    }
    throw boardFailure(deps, error, posting.kind, signal, timeoutMs);
  }
  if (!answer.found) {
    if (answer.unlisted) throw new AppError('unsupported', UNLISTED);
    throw new AppError('not_found', `${ATS_NAMES[posting.kind]} no longer has this posting: it has closed.`);
  }
  const raw = importRead ? importRead.fill(answer.raw) : answer.raw; // v35 INT-A: the row fills what the read lacks
  const listedCompany = answer.listedCompany;
  return deps.db.tx(async (t) => {
    const now = nowIso(deps);
    const source = await boardSourceOrNew(t, posting, now, listedCompany);
    // The ingest pipeline's store (ingest/store.ts) writes on the raw handle inside this transaction.
    const outcome = await ingest.store.upsertBatch(source, [{ raw, sourceHash: sourceHashOf(raw) }], now);
    const link = await t.one<{ job_id: number }>('SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ?', [
      source.id,
      raw.sourceJobId,
    ]);
    if (outcome.failures.length > 0 || !link) {
      // Rolled back with the source, if it was new. The failure's message is not logged: it can quote the posting.
      throw new AppError('internal', 'TailorIT could not save this posting. Please try again.');
    }
    const created = outcome.counts.created > 0;
    // v31 LINK (D1): TailorIT read the posting itself, so it is published at once; only while an admin approves new
    // jobs by hand (NEW_JOBS_ADMIN_APPROVAL) is a posting new to TailorIT from a board no enabled source runs held for
    // review (out of every search, its review opened), in this transaction; an enabled source's posting is public at
    // once (its next run lists it anyway). v3.0 held every such posting.
    // v35 INT-A: held by an admin import's read: the import's (its run), in this transaction.
    if (created && readWaitsForAdmin(deps, { page: false, sourceEnabled: source.enabled })) {
      await holdNewJob(t, link.job_id, now, importRead ? 'import' : 'ats', importRead?.runId ?? null);
    }
    // v31 FIX-LINK (BEH-4): a read that landed on a job the legacy pass holds settles it (jobs/add/held.ts).
    else if (!created) await settleHeldAfterRead(deps, t, link.job_id, { page: false, sourceEnabled: source.enabled, at: now });
    // v36 IMPORTTIME (SP v36 PLAN.md I1): a job an admin's import read made is dated the import's (jobs/add/import-time.ts).
    if (created && importRead) await dateImported(t, link.job_id, now);
    return { jobId: link.job_id, created };
  }, { label: 'autofill add job' });
}

/**
 * The account's tracker entry for the job at Saved, as the Jobs page's Save makes it (POST /api/applications with the
 * job and status Saved): TailorIT's best resume chosen first, read-only, within the single save's budget; a choice not
 * ready leaves the entry due and wakes the match worker. With `resumeId` (one of the account's: the resume the person
 * chose in the extension, or the one an auto-apply run attached) that resume is the person's choice instead, for a new
 * entry and for one the save brings back from the archive. An entry that exists is restored if archived and keeps its
 * status (Saved never moves one back) and, unless brought back, its resume. v33 SHARE-6: `adder`, who adds a held job
 * (noteHeldAdd: B on the person's profile hears its approval there).
 */
export async function saveToTracker(deps: AppDeps, userId: string, jobId: number, resumeId?: string, adder?: HeldAdder): Promise<void> {
  // v30 X1-API (14 §4.1): the account's report row on a held job comes before its tracker entry (the held rule shows a
  // held job to its adders alone; createApplication reads the job through it). Nothing for a job that is not held.
  await noteHeldAdd(deps, userId, jobId, adder);
  const body: CreateApplicationBody = { jobId, status: STATUS.saved, ...(resumeId ? { resumeId } : {}) };
  const options: CreateOptions = {};
  if (await wantsResumeMatch(deps.db, userId, body)) {
    // Quiet: a failure is logged without the job (the debug line's promise).
    const { choices, unfinished } = await bestResumes(deps, userId, [jobId], SINGLE_SAVE_MATCH_BUDGET_MS, { quiet: true });
    options.matchedResume = choices.get(jobId) ?? null;
    options.matchPending = unfinished.includes(jobId);
  }
  const { detail } = await createApplication(deps, userId, body, options);
  if (detail.resumeMatchPending) deps.services.resumeMatch?.nudge();
}

/**
 * The account's tracker entry for this posting that has no job (added by hand with the posting's link, as the lookup
 * finds it: `matchedBy` 'posting_url') is linked to the job, so the save that follows finds it instead of adding a
 * second entry beside it; that save then restores it if archived and never moves its status back. An entry of the job
 * itself, or none, changes nothing. From a page (version 5) the entry is found in one of two ways: `identity`, by the
 * keys and the job's own link only where they name the posting itself (an ATS posting, a LinkedIn job); or
 * `agreeing`, by any of the keys or the job's link, but linked only when the entry's title and company are those
 * (normalised as the dedupe normalises them): for an address two postings may share (a careers page). v3.0 D2-B: the
 * look for the entry and its move hold the person's lock, so two links at once never give the job two entries.
 */
export async function linkHandAddedEntry(
  deps: AppDeps,
  userId: string,
  jobId: number,
  keys: readonly string[],
  page: PageReading | null = null,
  options: { identity?: boolean; agreeing?: { title: string; company: string } } = {},
): Promise<void> {
  const { agreeing } = options;
  await deps.db.atomic(async (t) => {
    await t.lockPerson(userId);
    // v3.0 DB-INGEST: the job's own link is one of its `link` keys (job_keys) where v2.0 read jobs.link_key.
    const job = await t.one<{ id: number; link_key: string | null; apply_url: string }>(
      `SELECT id, (SELECT k.key FROM job_keys k WHERE k.job_id = jobs.id AND k.key_kind = 'link' ORDER BY k.key LIMIT 1) AS link_key,
         apply_url FROM jobs WHERE id = ?`,
      [jobId],
    );
    if (!job) return;
    // The page's postings and the job's own link, however the entry spells them (version 5).
    const ownLink = job.link_key && (!options.identity || namesPosting(job.link_key)) ? job.link_key : null;
    // An address two postings may share finds an entry with no job whose title and company are the page's, alone.
    const accept = agreeing
      ? (entry: EntryFacts) =>
          entry.job_id === null &&
          normalizeJobTitle(entry.title) === normalizeJobTitle(agreeing.title) &&
          normalizeCompanyName(entry.company_name) === normalizeCompanyName(agreeing.company)
      : undefined;
    const entry = await findApplication(
      deps,
      userId,
      { id: job.id, link_key: ownLink },
      keys,
      readingsOf(page, [job.apply_url]),
      accept,
      aliasValueHash(deps),
    );
    if (entry?.matchedBy !== 'posting_url') return;
    await t.run('UPDATE applications SET job_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND job_id IS NULL', [
      jobId,
      nowIso(deps),
      entry.row.id,
      userId,
    ]);
  }, { label: 'linkHandAddedEntry' });
}

/**
 * v30 X1-API (14 §4.1): a held job of the page's ATS posting, which the lookup does not show this account (the held rule:
 * another account's add made it, and only its adders see it). Add job lands on it as the store's dedupe would, without
 * reading the board again; the account's report row and tracker entry then follow (saveToTracker).
 *
 * v31 FIX-LINK (REV-BEH BEH-2): only a job a review holds (another account's add made it: its `new_job` review), by a
 * live link of its board: never one the legacy pass holds (it is settled only by a real read: jobs/add/legacy.ts), never
 * by a link its board no longer lists (the posting may have closed).
 */
export const HELD_SOURCE_LINK_SQL = `SELECT l.job_id, s.config
       FROM job_source_links l JOIN job_sources s ON s.id = l.source_id JOIN jobs j ON j.id = l.job_id
       WHERE s.kind = ? AND l.source_job_id = ? AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL
         AND l.missing_since IS NULL AND ${REVIEW_HELD_SQL}
       ORDER BY j.active DESC, l.last_seen_at DESC LIMIT 20`;

export async function heldJobOf(deps: Pick<AppDeps, 'db'>, page: PageReading): Promise<JobMatch | null> {
  const ats = page.ats;
  if (!ats || !SOURCE_BOARD[ats.kind]) return null;
  return sourceLinkMatch(ats, await deps.db.all<SourceLinkRow>(HELD_SOURCE_LINK_SQL, [ats.kind, ats.externalId]));
}

/** Whether TailorIT has closed the job (no live link: its board no longer lists it). */
async function isClosed(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<boolean> {
  const row = await deps.db.one<{ active: unknown }>('SELECT active FROM jobs WHERE id = ?', [jobId]);
  return row !== undefined && !deps.db.dialect.isTrue(row.active);
}

/** Whether the resume is one of `userId`'s. */
export async function ownsResume(deps: Pick<AppDeps, 'db'>, userId: string, resumeId: string): Promise<boolean> {
  return (await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId])) !== undefined;
}

/** Whether the job is `userId`'s own, made from a page's text (jobs.owner_user_id). */
export async function isOwnPageJob(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number): Promise<boolean> {
  return (await deps.db.one('SELECT 1 FROM jobs WHERE id = ? AND owner_user_id = ?', [jobId, userId])) !== undefined;
}

interface UpgradeFacts {
  id: number;
  owner_user_id: string | null;
  superseded_by: number | null;
  /** The ATS posting a page job was made from (its employer's link, even a dead one): read here alone. */
  made_from: string | null;
  apply_url: string;
  link_key: string | null;
  title: string;
  company: string;
}

async function upgradeFacts(db: DbQueries, jobId: number): Promise<UpgradeFacts | undefined> {
  return db.one<UpgradeFacts>(
    `SELECT j.id, j.owner_user_id, j.superseded_by, j.made_from, j.apply_url,
       (SELECT k.key FROM job_keys k WHERE k.job_id = j.id AND k.key_kind = 'link' ORDER BY k.key LIMIT 1) AS link_key,
       j.title, c.name AS company
     FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`,
    [jobId],
  );
}

/** The ATS posting a shared job is (its link's, or its link key's). */
function sharedIdentity(shared: UpgradeFacts): string | null {
  return postingIdentityOf(shared.apply_url) ?? postingIdentityOf(shared.link_key);
}

/**
 * Whether a page job is the shared job's posting: its Apply link (the employer's posting it was saved with) names the
 * same ATS posting, or the employer's link it was made from does (jobs.made_from: kept even when that posting was
 * gone and is no Apply link, so another requisition of the same title is never taken for it); or, when it has no ATS
 * posting at all (a LinkedIn job's, a careers page's), its title and company are the shared job's (normalised as the
 * dedupe normalises them) and their places meet (placesMeet: both have places and some are one, or one has none).
 * Never a posting of another id, tenant or board.
 */
async function isSamePosting(deps: Pick<AppDeps, 'db'>, owned: UpgradeFacts, shared: UpgradeFacts): Promise<boolean> {
  const own = owned.made_from ?? postingIdentityOf(owned.apply_url);
  if (own) return own === sharedIdentity(shared);
  return (
    normalizeJobTitle(owned.title) === normalizeJobTitle(shared.title) &&
    normalizeCompanyName(owned.company) === normalizeCompanyName(shared.company) &&
    placesMeet(await jobPlaces(deps, owned.id), await jobPlaces(deps, shared.id))
  );
}

interface EntryRank {
  id: string;
  current_status: number;
  archived_at: string | null;
  notes_html: string;
}

/** Whether entry `a` is further along than `b`: a later status, then notes where the other has none. */
function furtherAlong(a: EntryRank, b: EntryRank): boolean {
  if (a.current_status !== b.current_status) return a.current_status > b.current_status;
  return a.notes_html.trim() !== '' && b.notes_html.trim() === '';
}

/**
 * The person's own job made from a page's text (kept while the ATS would not give the posting: robots.txt kept TailorIT
 * out, the posting was off its board's list, the answer was no posting) gives way to the shared job of that same
 * posting (`sharedJobId`, isSamePosting), in one transaction, never across accounts, and once:
 * - their aliases of it move to the shared job: a LinkedIn job's and the page's, and an employer's posting's only when
 *   it is the shared job's posting;
 * - their tracker entry moves to it when they have none of it; when their entry of the shared job is archived, the two
 *   swap (the archived one stays archived, on the page job); when it is active, the one further along (a later status,
 *   then notes) ends on the shared job, the other stays on the page job. No entry is restored, merged or deleted; an
 *   entry moved while Saved and active, its resume TailorIT's (or none), has it chosen again for its new job;
 * - their auto-apply queue row, its removed rows and dismissals, and their hidden and viewed marks move with it (a row
 *   the shared job already has stays where it is);
 * - the page job is closed, never deleted, marked superseded by the shared job (jobs.superseded_by: a stale id of it
 *   acts on the shared job), and its page link is retired (missing, its id renamed), so no later add from the page
 *   reuses or reopens it.
 * Answers whether the page job gave way (or already had, to this job). Nothing changes for another account's job, a
 * shared job, or another posting. v3.0 D2-B: it holds the person's lock (the page job's link and entries are theirs),
 * so two upgrades at once never move the same rows twice.
 */
export async function upgradeOwnPageJob(
  deps: AppDeps,
  userId: string,
  ownedJobId: number,
  sharedJobId: number,
  // v31 LINK: the shared job was read now from the page job's own link (a retried read, a review approved): it is the
  // same posting by that link, whatever titles the person's browser captured.
  options: { sameLink?: boolean } = {},
): Promise<boolean> {
  if (ownedJobId === sharedJobId) return false;
  let chosenAgain = 0;
  const upgraded = await deps.db.atomic(async (t) => {
    await t.lockPerson(userId);
    const owned = await upgradeFacts(t, ownedJobId);
    const shared = await upgradeFacts(t, sharedJobId);
    if (!owned || owned.owner_user_id !== userId || !shared || shared.owner_user_id !== null) return false;
    if (owned.superseded_by !== null) return owned.superseded_by === sharedJobId;
    if (!options.sameLink && !(await isSamePosting(deps, owned, shared))) return false;
    // v31 LINK: the page job's "Couldn't verify" row goes with it (it is read now).
    await t.run('DELETE FROM job_verifications WHERE job_id = ?', [ownedJobId]);
    const now = nowIso(deps);
    // v38 REVEDIT (SP v38 PLAN.md E3, E4): what an admin edited on the page job stays over the posting's text.
    await moveAdminEdits(t, ownedJobId, sharedJobId, now);
    const d = t.dialect;
    const posting = sharedIdentity(shared);
    const aliases = await t.all<{ id: number; alias: string; kind: string }>(
      'SELECT id, alias, kind FROM job_link_aliases WHERE user_id = ? AND job_id = ?',
      [userId, ownedJobId],
    );
    for (const alias of aliases) {
      if (alias.kind !== 'employer' || (posting !== null && postingIdentityOf(alias.alias) === posting)) {
        await t.run('UPDATE job_link_aliases SET job_id = ? WHERE id = ?', [sharedJobId, alias.id]);
      }
    }

    const entryOf = (jobId: number) =>
      t.one<EntryRank>('SELECT id, current_status, archived_at, notes_html FROM applications WHERE user_id = ? AND job_id = ?', [
        userId,
        jobId,
      ]);
    const pageEntry = await entryOf(ownedJobId);
    const sharedEntry = await entryOf(sharedJobId);
    const setJob = (jobId: number | null, id: string) =>
      t.run('UPDATE applications SET job_id = ?, updated_at = ? WHERE id = ?', [jobId, now, id]);
    const moved: string[] = [];
    if (pageEntry && !sharedEntry) {
      await setJob(sharedJobId, pageEntry.id);
      moved.push(pageEntry.id);
    } else if (pageEntry && sharedEntry) {
      const swap = sharedEntry.archived_at !== null ? true : pageEntry.archived_at === null && furtherAlong(pageEntry, sharedEntry);
      if (swap) {
        // Through no job, as the (account, job) index allows one entry a job.
        await setJob(null, sharedEntry.id);
        await setJob(sharedJobId, pageEntry.id);
        await setJob(ownedJobId, sharedEntry.id);
        moved.push(pageEntry.id, sharedEntry.id);
      }
    }
    // An entry that moves to another job, Saved, active and with a resume TailorIT chose (or none), has its resume chosen
    // again for that job: the choice it has was made for the other text (audit D7). The person's choice stays.
    for (const id of moved) {
      const { changes } = await t.run(
        `UPDATE applications SET resume_match_due = ${d.true} WHERE id = ? AND current_status = ${STATUS.saved}
           AND archived_at IS NULL AND job_id IS NOT NULL AND (resume_origin IS NULL OR resume_origin = 'auto')`,
        [id],
      );
      chosenAgain += changes;
    }

    // A row the shared job already has stays where it is (each table keeps one row per account and job). v3.0 D2: NOT
    // EXISTS rather than SQLite's UPDATE OR IGNORE, which PostgreSQL does not have; the same rows move.
    await t.run(
      `UPDATE autofill_agent_queue SET job_id = ?, updated_at = ? WHERE user_id = ? AND job_id = ?
         AND NOT EXISTS (SELECT 1 FROM autofill_agent_queue o WHERE o.user_id = ? AND o.job_id = ?)`,
      [sharedJobId, now, userId, ownedJobId, userId, sharedJobId],
    );
    await t.run('UPDATE autofill_agent_tombstones SET job_id = ? WHERE user_id = ? AND job_id = ?', [sharedJobId, userId, ownedJobId]);
    await t.run(
      `UPDATE autofill_agent_dismissed SET job_id = ? WHERE user_id = ? AND job_id = ?
         AND NOT EXISTS (SELECT 1 FROM autofill_agent_dismissed o WHERE o.user_id = ? AND o.job_id = ?)`,
      [sharedJobId, userId, ownedJobId, userId, sharedJobId],
    );
    await t.run(
      `UPDATE user_job_state SET job_id = ? WHERE user_id = ? AND job_id = ?
         AND NOT EXISTS (SELECT 1 FROM user_job_state o WHERE o.user_id = ? AND o.job_id = ?)`,
      [sharedJobId, userId, ownedJobId, userId, sharedJobId],
    );

    await t.run(
      "UPDATE job_source_links SET missing_since = COALESCE(missing_since, ?), source_job_id = source_job_id || ' superseded:' || ? WHERE job_id = ?",
      [now, String(sharedJobId), ownedJobId],
    );
    await t.run(
      `UPDATE jobs SET active = ${d.false}, closed_at = COALESCE(closed_at, ?), superseded_by = ?, updated_at = ? WHERE id = ?`,
      [now, sharedJobId, now, ownedJobId],
    );
    return true;
  }, { label: 'upgradeOwnPageJob' });
  if (chosenAgain > 0) deps.services.resumeMatch?.nudge();
  return upgraded;
}

/**
 * Once a shared job is resolved by its posting (found by it, or read now), the person's own page jobs of that same
 * posting give way to it (upgradeOwnPageJob): the ones made from it (jobs.made_from), or whose Apply link, or an
 * alias of an employer's or a page's address, names the shared job's ATS posting. Nothing to do for a job of no ATS posting, or one the person owns.
 */
export async function upgradeOwnPageJobsFor(deps: AppDeps, userId: string, sharedJobId: number): Promise<void> {
  const shared = await upgradeFacts(deps.db, sharedJobId);
  if (!shared || shared.owner_user_id !== null) return;
  const posting = sharedIdentity(shared);
  if (!posting) return;
  const id = posting.slice(posting.lastIndexOf('|') + 1);
  // v3.0 PG-B: "contains" through the dialect (SQLite's instr, PostgreSQL's strpos).
  const { contains } = deps.db.dialect;
  const candidates = await deps.db.all<{ id: number; apply_url: string; made_from: string | null }>(
    `SELECT j.id, j.apply_url, j.made_from FROM jobs j
     WHERE j.owner_user_id = ? AND j.superseded_by IS NULL
       AND (j.made_from = ? OR ${contains('lower(j.apply_url)', '?')} OR EXISTS (SELECT 1 FROM job_link_aliases a
         WHERE a.job_id = j.id AND a.user_id = ? AND a.kind <> 'linkedin' AND ${contains('lower(a.alias)', '?')}))
     ORDER BY j.id LIMIT 50`,
    [userId, posting, id, userId, id],
  );
  const aliasesOf = (jobId: number) =>
    deps.db.all<{ alias: string }>("SELECT alias FROM job_link_aliases WHERE user_id = ? AND job_id = ? AND kind <> 'linkedin'", [
      userId,
      jobId,
    ]);
  for (const candidate of candidates) {
    const names =
      candidate.made_from === posting ||
      postingIdentityOf(candidate.apply_url) === posting ||
      (await aliasesOf(candidate.id)).some((row) => postingIdentityOf(row.alias) === posting);
    if (names) await upgradeOwnPageJob(deps, userId, candidate.id, sharedJobId);
  }
}

/**
 * Whether an ATS's answer says the posting is gone for good: closed (404, 410, unposted) or off its board's public list
 * (Ashby's unlisted). A robots.txt refusal is not: the posting is there, only not for TailorIT to read.
 */
export function isGonePosting(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  // v37 FIX-37B (E2): nor a board whose terms say no: the posting is there, only not for TailorIT to read.
  return error.code === 'not_found' || (error.code === 'unsupported' && !(error.cause instanceof RobotsRefusal) && !(error.cause instanceof TermsRefusalError));
}

/**
 * The reads under way, shared: one read of a posting at a time (a second add of the same posting waits for the first's
 * outcome), and one read of an Ashby board's listing at a time (two adds from one board read it once).
 */
export interface InFlight {
  postings: Map<string, Promise<{ jobId: number; created: boolean }>>;
  boards: AshbyBoardReads;
}

/** A router's reads under way. */
export function newInFlight(): InFlight {
  return { postings: new Map(), boards: new Map() };
}

/**
 * v30 X1-API (14 §4.1): the open held job of `posting` (its board's link), which another account's add made: Add job,
 * From page and Applied land on it as the store's dedupe would, without reading the board again (the lookup does not
 * show it to this account until it adds it). Null when there is none.
 */
async function openHeldJobOf(deps: Pick<AppDeps, 'db'>, posting: AddablePosting): Promise<number | null> {
  const rows = await deps.db.all<SourceLinkRow>(HELD_SOURCE_LINK_SQL, [posting.kind, posting.externalId]);
  const boardOf = SOURCE_BOARD[posting.kind];
  if (!boardOf) return null;
  for (const row of rows) {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      config = {};
    }
    if (boardOf(config).toLowerCase() !== posting.board.toLowerCase()) continue;
    const open = await deps.db.one('SELECT 1 FROM jobs WHERE id = ? AND active AND held_since IS NOT NULL', [row.job_id]);
    if (open) return row.job_id;
  }
  return null;
}

/**
 * The read of `posting`, shared with an add of the same posting already under way (an open held job is not read again).
 * v31 FIX-LINK (BEH-2): `fresh` reads the board whatever job holds the posting (the legacy pass's reads, Retry read).
 * v35 INT-A: `importRead`, an admin import's read (jobs/add/page.ts ImportRead), never shared with another read.
 * v37 CLOSED (C3): `timeoutMs`, the read's budget (the link queue's LINK_QUEUE_READ_TIMEOUT_MS; people's 15 s).
 */
export function readShared(
  deps: AppDeps,
  posting: AddablePosting,
  inFlight: InFlight,
  options: { fresh?: boolean; importRead?: ImportRead; timeoutMs?: number } = {},
): Promise<{ jobId: number; created: boolean }> {
  const key =
    `${posting.kind}:${posting.region}:${posting.board.toLowerCase()}:${posting.externalId.toLowerCase()}` +
    `${options.fresh ? ':fresh' : ''}${options.importRead ? ':import' : ''}`;
  let reading = inFlight.postings.get(key);
  if (!reading) {
    const held = options.fresh ? Promise.resolve(null) : openHeldJobOf(deps, posting);
    reading = held
      .then((found) =>
        found !== null ? { jobId: found, created: false } : readAndStore(deps, posting, inFlight.boards, options.importRead, options.timeoutMs),
      )
      .finally(() => inFlight.postings.delete(key));
    inFlight.postings.set(key, reading);
  }
  return reading;
}

/**
 * POST /jobs: the job TailorIT has (`created` false), found as the lookup finds it from any address; else the one read
 * from its board now, or 400 `unsupported` for an address `addablePosting` does not read. A closed job is read again
 * when its address can be (a posting its board lists again reopens; a failed read leaves it closed, and it is saved
 * as it is). Then the person's tracker entry at Saved, a hand-added entry of the posting linked to the job first, and
 * the lookup's answer for the address, with the same `resumeId`.
 */
export async function addJob(
  deps: AppDeps,
  userId: string,
  request: AutofillAddJobRequest,
  inFlight: InFlight,
): Promise<AddedJob> {
  const page = readPage(request.url, undefined, aliasValueHash(deps));
  const parsed = page.ats;
  // v37 CLOSED (C4): a Workday link without a location reads the posting's JSON too (never the page).
  const posting = addablePosting(parsed) ?? workdayLinkPosting(request.url);
  const keys = pageKeys(page);
  // v30 X1-API: a held job of the posting another account added is found too (heldJobOf).
  let job = (await findPageJob(deps, userId, page)) ?? (await heldJobOf(deps, page));
  let created = false;
  if (!job) {
    if (posting) {
      let stored: { jobId: number; created: boolean };
      try {
        stored = await readShared(deps, posting, inFlight);
      } catch (error) {
        // v37 CLOSED (C7): a closed posting's board is offered to discovery (a candidate waiting for an admin).
        if (error instanceof AppError && error.code === 'not_found') await offerBoardOfClosedLink(deps, request.url, 'extension');
        throw error;
      }
      job = { id: stored.jobId, matchedBy: 'source_link' };
      created = stored.created;
    } else {
      // v31 LINK (D3): a page no ATS API reads is read for its own schema.org JobPosting (jobs/add/page.ts); a page
      // TailorIT cannot read is refused as before (the extension then adds it from the page's text: From page).
      const link = canonicalJobUrl(request.url);
      const readable = link !== null && !page.linkedIn && !isRefusedPageHost(new URL(link).hostname);
      const read = readable ? await readPageToSharedJob(deps, link) : null;
      // The page TailorIT read says its posting has closed (404, 410, or a past validThrough).
      if (read?.kind === 'closed') {
        if (link) await offerBoardOfClosedLink(deps, link, 'extension'); // v37 CLOSED (C7)
        throw refuse(deps, 'not_found', 'MSG_JOB_ADD_REFUSED_CLOSED');
      }
      if (read?.kind !== 'shared') throw new AppError('unsupported', UNSUPPORTED);
      job = { id: read.jobId, matchedBy: 'source_link' };
      created = read.created;
    }
  } else if (posting && ((await isClosed(deps, job.id)) || (await isOwnPageJob(deps, userId, job.id)))) {
    // A closed job is read again (a posting listed again reopens), and so is the person's own job made from the page's
    // text while the ATS would not give the posting: read now, the posting takes its place when it is the page job's own
    // (upgradeOwnPageJob).
    try {
      const stored = await readShared(deps, posting, inFlight);
      if (!(await isOwnPageJob(deps, userId, job.id)) || (await upgradeOwnPageJob(deps, userId, job.id, stored.jobId))) {
        job = { id: stored.jobId, matchedBy: 'source_link' };
        created = stored.created;
      }
    } catch (error) {
      // The board no longer has it, or failed: the job stays as it is and is saved as it is.
      if (!(error instanceof AppError)) throw error;
    }
  }
  // The posting's shared job takes the place of the person's own page jobs of it (U1).
  await upgradeOwnPageJobsFor(deps, userId, job.id);
  await linkHandAddedEntry(deps, userId, job.id, keys, page);
  // The resume the person chose in the extension, when it is theirs, is the entry's as it is made or brought back.
  const own = request.resumeId !== undefined && (await ownsResume(deps, userId, request.resumeId));
  await saveToTracker(deps, userId, job.id, own ? request.resumeId : undefined);
  const lookup = await lookupPosting(deps, userId, {
    url: request.url,
    includePostingText: false,
    ...(request.resumeId !== undefined ? { resumeId: request.resumeId } : {}),
  });
  return { answer: { created, lookup }, kind: parsed?.kind ?? null };
}
