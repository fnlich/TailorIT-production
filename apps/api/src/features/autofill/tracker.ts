import { STATUS } from '@tailorit/shared';
import {
  addablePosting,
  AUTOFILL_JOB_SEARCH_MAX,
  type AtsKind,
  type AutofillAppliedRequest,
  type AutofillJobSearchItem,
  type AutofillLookupResponse,
  type AutofillSubmissionJobState,
  type AutofillSubmissionPosting,
} from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import { AppError, forbidden, notFound } from '../../core/http/errors';
import type { ApplyContext } from '../applications/apply-records';
import { changeStatus, patchApplication, setArchived } from '../applications/service';
import { jobMarksOf } from '../jobs/credit'; // v30 FIX-B
import { searchByWords } from '../jobs/search';
import { NOT_IN_SCOPE } from './auth';
import { aliasValueHash } from './alias-key';
import { shareOwnJob } from './forms/share';
import { addFromPage } from './from-page';
import { linkHandAddedEntry, readShared, saveToTracker, upgradeOwnPageJobsFor, type InFlight } from './jobs';
import {
  currentJobId,
  findApplication,
  findPageJob,
  lookupPosting,
  pageKeys,
  readingsOf,
  readPage,
  type PageReading,
} from './lookup';

// The person's tracker from the extension (work package AF, autofill API version 3): the jobs it can fill a form for
// when the page is not the one TailorIT matched (GET /api/autofill/jobs/search, the side panel's "Autofill for another
// job"), and marking a job Applied once its form was sent (POST /api/autofill/applied: the panel's "Submit
// application", the person's own submit, the auto-apply agent's). Applied goes through the tracker's own service, as
// the Tracker page's status menu moves an entry (changeStatus), after Add job's Save (saveToTracker) has made or
// restored a Saved entry; an entry at Applied or further is never touched (never moved back, never restored from the
// archive: a Rejected entry stays as the person left it), so asking twice changes nothing. The page's address is used
// here only: never stored, logged or answered back.
//
// v3.0 D2: on the async client. The Tracker's own moves (applications/service.ts: changeStatus, setArchived,
// patchApplication) and Add job's steps (jobs.ts, from-page.ts) run inside this file's transactions: they join them
// (deps.db.atomic, or plain statements in the transaction's async context), never open their own.

/** Tracked jobs read for one search, the most recently updated first. */
export const SEARCH_SCAN = 5000;

/** A text as a search compares it: compatibility forms folded, in lower case, every run of spaces one space. */
const searchKey = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

export interface SearchRow {
  id: number;
  title: string;
  company: string;
  primary_location: string;
  locations_text: string;
}

const itemOf = (row: SearchRow): AutofillJobSearchItem => ({
  jobId: row.id,
  title: row.title,
  company: row.company,
  location: row.primary_location || row.locations_text,
});

/**
 * GET /jobs/search: the account's tracked jobs (tracker entries of a TailorIT job, archived ones included) whose title
 * or company holds every word of `q`, in any case, most recently updated first; then, with words, TailorIT's other open
 * jobs the job search finds for them (v3.0 PG-SEARCH: jobs/search.ts searchByWords over job_search's title, company and
 * places, best first), not hidden by the person. With `q` blank, the most recently updated tracked jobs alone. At most
 * AUTOFILL_JOB_SEARCH_MAX.
 */
export async function searchJobs(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  userId: string,
  q: string,
): Promise<AutofillJobSearchItem[]> {
  const found = trackedMatches(q, await deps.db.all<SearchRow>(SEARCH_TRACKED_SQL, [userId, SEARCH_SCAN]));
  if (found.items.length === AUTOFILL_JOB_SEARCH_MAX) return withCredits(deps, found.items);
  const limit = AUTOFILL_JOB_SEARCH_MAX + found.tracked.size;
  return withCredits(deps, withMore(found, await searchByWords(deps, userId, q, limit)));
}

/** v30 FIX-B (REQ-1): each answered job with its source's credit line (the card shows it), in one read. */
async function withCredits(deps: Pick<AppDeps, 'db'>, items: AutofillJobSearchItem[]): Promise<AutofillJobSearchItem[]> {
  const marks = await jobMarksOf(deps.db, items.map((item) => item.jobId));
  return items.map((item) => {
    const credit = marks.get(item.jobId)?.credit;
    return credit ? { ...item, credit } : item;
  });
}

/** searchJobs' statement: the account's tracked jobs (the account, SEARCH_SCAN). */
export const SEARCH_TRACKED_SQL = `SELECT j.id, j.title, c.name AS company, j.primary_location, j.locations_text
       FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
       WHERE a.user_id = ? ORDER BY a.updated_at DESC, a.id LIMIT ?`;

/** The tracked jobs whose title or company holds every word of `q` (at most AUTOFILL_JOB_SEARCH_MAX), and every tracked id. */
export function trackedMatches(q: string, rows: readonly SearchRow[]): { items: AutofillJobSearchItem[]; tracked: Set<number> } {
  const words = searchKey(q).split(' ').filter(Boolean);
  const items: AutofillJobSearchItem[] = [];
  const tracked = new Set<number>();
  for (const row of rows) {
    tracked.add(row.id);
    if (items.length === AUTOFILL_JOB_SEARCH_MAX) continue;
    const text = searchKey(`${row.title} ${row.company}`);
    if (words.every((word) => text.includes(word))) items.push(itemOf(row));
  }
  return { items, tracked };
}

/** The tracked matches, then the search's other jobs that are not tracked, up to AUTOFILL_JOB_SEARCH_MAX. */
export function withMore(
  found: { items: AutofillJobSearchItem[]; tracked: ReadonlySet<number> },
  more: readonly SearchRow[],
): AutofillJobSearchItem[] {
  const items = [...found.items];
  for (const row of more) {
    if (items.length === AUTOFILL_JOB_SEARCH_MAX) break;
    if (!found.tracked.has(row.id)) items.push(itemOf(row));
  }
  return items;
}

/** How POST /applied found what it marked, for the debug line. */
export type AppliedVia = 'job' | 'address' | 'added' | 'by_hand';

export interface Applied {
  answer: AutofillLookupResponse;
  via: AppliedVia;
  /** The entry moved to Applied now (false: it was at Applied or further already). */
  moved: boolean;
  /** The page's ATS, for the debug line; null without an address TailorIT reads. */
  kind: AtsKind | null;
  // v1.3 A
  /** What happened to the job (a submission's answer): shared already, shared now, added now, or no job. */
  job: AutofillSubmissionJobState;
  // end v1.3 A
}

/** Who asks: whether they may add a posting TailorIT lacks (the session, or a token with jobs:add). */
export interface AppliedOptions {
  mayAdd: boolean;
}

// v1.3 A
/**
 * What a confirmed submission (POST /api/autofill/submissions, autofill/forms/) adds to Applied's steps: the employer's
 * link the page showed (the job found as the lookup finds it); the posting's text, from which a job TailorIT has no
 * job of, and no ATS API gives, is made as POST /api/autofill/jobs/from-page makes one (then shared); `share`, which
 * puts the person's own page job in TailorIT's shared jobs (forms/share.ts); and `within`, run in the transaction that
 * moves the entry to Applied (or would have, for an entry at Applied or further), with the entry, its job (null for an
 * entry added by hand) and the page as it was read (null when the job was named by its id).
 */
export interface AppliedExtra {
  employerUrl?: string;
  posting?: AutofillSubmissionPosting;
  share?: boolean;
  within?: (t: DbTx, entryId: string, jobId: number | null, page: PageReading | null) => Promise<void>;
  // v20 P3
  /**
   * How the job became Applied, for its apply record (applications/apply-records.ts): an auto-apply run's result (its
   * queue row and the resume it attached), Mark as applied; absent: the person's own submission from a page (`page`,
   * with the resume the form was sent with).
   */
  apply?: ApplyContext;
  // end v20 P3
}
// end v1.3 A

/**
 * The account's entry `id` at Applied, today, when it is Saved (restored if archived); false otherwise, untouched.
 * v2.0: its apply record says how (`apply`, the person's own page by default).
 */
export async function moveToApplied(
  deps: AppDeps,
  userId: string,
  id: string,
  apply: ApplyContext = { via: 'page' },
): Promise<boolean> {
  const row = await deps.db.one<{ current_status: number; archived_at: string | null }>(
    'SELECT current_status, archived_at FROM applications WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  if (!row) throw notFound('That application');
  if (row.current_status !== STATUS.saved) return false;
  if (row.archived_at !== null) await setArchived(deps, userId, id, false);
  await changeStatus(deps, userId, id, STATUS.applied, undefined, apply);
  return true;
}

/** `resumeId` when it is one of the account's resumes, else undefined (passed over, as the lookup passes it over). */
async function ownResume(deps: Pick<AppDeps, 'db'>, userId: string, resumeId: string | undefined): Promise<string | undefined> {
  if (resumeId === undefined) return undefined;
  return (await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId])) ? resumeId : undefined;
}

/** The form's answers first (`within`), so the apply record moving the entry to Applied reads them; then the move. */
function withinThenMove(
  deps: AppDeps,
  userId: string,
  entryId: string,
  apply: ApplyContext,
  within: (t: DbTx) => Promise<void>,
): Promise<boolean> {
  return deps.db.tx(
    async (t) => {
      await within(t);
      return moveToApplied(deps, userId, entryId, apply);
    },
    { label: 'markApplied' },
  );
}

/**
 * POST /applied: the job is `jobId` (404 when TailorIT has no such job), else the one the lookup finds at `url`, else,
 * for a posting Add job can read and a caller who may add one (`jobs:add`; 403 otherwise, unless the entry below
 * exists), the one added now as Add job adds it. When that read fails (the board no longer has it, or cannot be
 * reached), and when there is no job, an entry the person added by hand with the posting's link is the one moved;
 * with neither, the read's refusal or 404 `not_found`. A job's entry is made or restored at Saved as Add job's Save
 * makes it, with `resumeId` (one of the account's) as the person's choice of resume when it is made or restored now,
 * or when it was Saved with a resume TailorIT chose or none (audit D5: the form went with `resumeId`), then moved to
 * Applied; an entry already further along, or whose resume the person chose, keeps its resume. With `jobId`, the page's address never links
 * an entry to the job. Answers the lookup for the same address, job and resume.
 */
export async function markApplied(
  deps: AppDeps,
  userId: string,
  request: AutofillAppliedRequest,
  inFlight: InFlight,
  options: AppliedOptions,
  extra: AppliedExtra = {},
): Promise<Applied> {
  const url = request.url ?? '';
  const page = readPage(url, extra.employerUrl, aliasValueHash(deps));
  const parsed = page.ats;
  const keys = pageKeys(page);
  const resumeId = await ownResume(deps, userId, request.resumeId);
  const chosen = request.jobId !== undefined;
  const answerFor = async () =>
    lookupPosting(deps, userId, {
      url,
      includePostingText: false,
      ...(extra.employerUrl !== undefined ? { employerUrl: extra.employerUrl } : {}),
      ...(request.jobId !== undefined ? { jobId: request.jobId } : {}),
      ...(request.resumeId !== undefined ? { resumeId: request.resumeId } : {}),
    });
  const kind = parsed?.kind ?? page.employer?.ats?.kind ?? null;
  // v20 P3: how the apply record names this application's way to Applied.
  const apply: ApplyContext = extra.apply ?? { via: 'page', resumeId: resumeId ?? null };
  /** The entry the person added by hand for the posting's link, moved; or null when there is none. */
  const byHand = async (): Promise<Applied | null> => {
    const entry = await findApplication(deps, userId, null, keys, readingsOf(page), undefined, aliasValueHash(deps));
    if (!entry) return null;
    // v20 P3: the form's answers first, so the apply record moving the entry to Applied reads them.
    const moved = await withinThenMove(deps, userId, entry.row.id, apply, async (t) => extra.within?.(t, entry.row.id, null, page));
    return { answer: await answerFor(), via: 'by_hand', moved, kind, job: 'none' };
  };

  let jobId: number | null = null;
  let via: AppliedVia = 'job';
  // v1.3 A: whether the job is new to TailorIT now (read from its ATS, or made from the posting's text).
  let created = false;
  if (request.jobId !== undefined) {
    // Another account's job made from a page is as good as none. A page job an upgrade closed stands for the shared
    // job it gave way to (a stale id: the agent's, the panel's).
    jobId = await currentJobId(deps, userId, request.jobId);
    if (jobId === null) throw notFound('That job');
  } else {
    const found = await findPageJob(deps, userId, page);
    const posting = addablePosting(parsed);
    if (found) {
      jobId = found.id;
      via = 'address';
    } else if (extra.posting) {
      // v1.3 A: the posting as the page showed it: its job is found, read from its ATS or made from the text as adding
      // from the page does it (from-page.ts), then shared below.
      if (!options.mayAdd) {
        const done = await byHand();
        if (done) return done;
        throw forbidden(NOT_IN_SCOPE);
      }
      try {
        const added = await addFromPage(
          deps,
          userId,
          {
            url,
            ...(extra.employerUrl !== undefined ? { employerUrl: extra.employerUrl } : {}),
            ...extra.posting,
            ...(request.resumeId !== undefined ? { resumeId: request.resumeId } : {}),
          },
          inFlight,
        );
        jobId = added.answer.lookup.job?.id ?? null;
        created = added.answer.created;
        via = added.via === 'existing' ? 'address' : 'added';
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const done = await byHand();
        if (done) return done;
        throw error;
      }
    } else if (posting) {
      if (!options.mayAdd) {
        const done = await byHand();
        if (done) return done;
        throw forbidden(NOT_IN_SCOPE);
      }
      try {
        const read = await readShared(deps, posting, inFlight);
        jobId = read.jobId;
        created = read.created;
        via = 'added';
      } catch (error) {
        // The board no longer has it, or failed: the entry the person added by hand, if any, is still theirs to move.
        if (!(error instanceof AppError)) throw error;
        const done = await byHand();
        if (done) return done;
        throw error;
      }
    }
  }

  if (jobId === null) {
    const done = await byHand();
    if (!done) throw notFound('A job or a tracker entry for this page');
    return done;
  }
  // v1.3 A: the person's own page job they applied to is offered to TailorIT's shared jobs (the job lake). v30 INT-3:
  // through its page review in Admin › Review (forms/share.ts); it stays theirs until approved.
  const offered = extra.share === true && (await shareOwnJob(deps, userId, jobId, page));
  // v30 FIX-B (INT-3 open item 12): `offered`, not shared yet: it waits for an admin's approval in Admin › Review.
  const job: AutofillSubmissionJobState = created ? 'added' : offered ? 'offered' : 'shared';
  // The posting's shared job takes the place of the person's own page jobs of it (U1).
  await upgradeOwnPageJobsFor(deps, userId, jobId);

  // A job named by its id is the person's choice: the page's address links no entry to it.
  await linkHandAddedEntry(deps, userId, jobId, chosen ? [] : keys, chosen ? null : page);
  const target = jobId;
  const existing = await deps.db.one<{ id: string; current_status: number }>(
    'SELECT id, current_status FROM applications WHERE user_id = ? AND job_id = ?',
    [userId, jobId],
  );
  if (existing && existing.current_status !== STATUS.saved) {
    const within = extra.within;
    if (within) await deps.db.tx((t) => within(t, existing.id, target, chosen ? null : page), { label: 'markApplied' });
    return { answer: await answerFor(), via, moved: false, kind, job };
  }
  await saveToTracker(deps, userId, jobId, resumeId);
  const entry = await deps.db.one<{ id: string; resume_origin: string | null }>(
    'SELECT id, resume_origin FROM applications WHERE user_id = ? AND job_id = ?',
    [userId, jobId],
  );
  if (!entry) throw notFound('That application');
  // The resume the form was sent with is the entry's, as the person's choice, unless they had chosen one (audit D5):
  // an entry Saved with TailorIT's pick, or still waiting for one, would otherwise keep another resume, or none.
  if (resumeId !== undefined && entry.resume_origin !== 'user') await patchApplication(deps, userId, entry.id, { resumeId });
  // v20 P3: the form's answers first, so the apply record moving the entry to Applied reads them.
  const moved = await withinThenMove(deps, userId, entry.id, apply, async (t) => extra.within?.(t, entry.id, target, chosen ? null : page));
  return { answer: await answerFor(), via, moved, kind, job };
}
