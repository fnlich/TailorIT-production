import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  FUTURE_DATE_MESSAGE,
  SALARY_ORDER_MESSAGE,
  SALARY_PERIOD_MESSAGE,
  STATUS,
  applyStatusChange,
  clearEventBlocker,
  currentStatus,
  formatLocationLine,
  initialEvents,
  normalizeCompanyName,
  normalizeUrlInput,
  readImportRow,
  removeStatusEvent,
  setEventDate,
  toIsoDate,
  type ApplicationDetail,
  type ApplicationQuestion,
  type ApplicationStatus,
  type BulkApplicationsBody,
  type CreateApplicationBody,
  type EmploymentType,
  type PatchApplicationBody,
  type ResumeOrigin,
  type SavedJobRef,
  type StatusChangeResponse,
  type StatusEvent,
  type TrackerImportBody,
  type TrackerImportResponse,
  type TrackerPayPeriod,
} from '@tailorit/shared';
import { nowIso, todayIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { notFound, validationFailed } from '../../core/http/errors';
import { currentJobId } from '../jobs/store';
import { countJobStat } from '../jobs/stats';
import { jobVisibleTo } from '../jobs/visibility';
import { writeAutoChoice } from '../resume-match/service';
import { recordApplied, type ApplyContext } from './apply-records';
import { JOBS_OWN_TEXT } from './description';
import type { ResumeChoice } from './resume-choice';
import { cleanRichText, textToParagraphs } from './sanitize';
import {
  archiveRow,
  getDetail,
  loadEvents,
  loadOwnedRow,
  loadQuestionRow,
  loadQuestions,
  restoreRow,
  toQuestion,
  writeEvents,
  type ApplicationRow,
} from './store';

// What the tracker's endpoints do, one function per operation. Multi-statement writes run in one transaction; the
// status rules are the shared pure functions, and `current_status` is rewritten with every event change.
//
// The resume of a saved job. Saving a job at Saved with no resume named links TailorIT's best match (origin 'auto').
// The choice is made before the write (`bestResumes`, read-only and never AI) and handed in; the write links it
// through the full guard (`writeAutoChoice`). A job saved without a choice in hand is written due
// (resume_match_due set) and the match worker chooses within seconds. A resume the person names, or "none" (null or
// ''), is theirs (origin 'user') and never changed automatically. Applied and later statuses never get an automatic
// resume.
//
// v30 DB-JOBS (D1c): an entry stores no copy of its posting (./description.ts): NULL is the job's text, read when the
// entry is shown; a value is the person's own description. Each entry made for a job counts one save (job_stats).
//
// v3.0 D2: async on deps.db. The writers other features call inside their own transactions (createApplication,
// changeStatus, createQuestion) run in `deps.db.atomic`: a savepoint of the caller's transaction, or one of their own.
// The concurrency audit (11-database.md §9.3): an account has one application per job (idx_app_user_job). The save
// looks for it first; the insert then says ON CONFLICT DO NOTHING, and when another save of the job committed after
// that look (possible on PostgreSQL), the twin is read and taken as the existing application.

type Deps = Pick<AppDeps, 'db' | 'now'>;
/** v2.0: the writers that may move an entry to Applied record what was used (apply-records.ts), so they read the day. */
type ApplyDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

// v20 P3
const hasApplied = (events: readonly StatusEvent[]) => events.some((event) => event.status === STATUS.applied);

/**
 * Writes an entry's new events (writeEvents), and, when they gain Applied, its apply record (v2.0, A30): one row each
 * time an application becomes Applied, naming how and what was used. Call inside a transaction.
 */
async function writeStatusEvents(
  deps: ApplyDeps,
  userId: string,
  id: string,
  before: readonly StatusEvent[],
  after: StatusEvent[],
  now: string,
  apply: ApplyContext,
): Promise<void> {
  await writeEvents(deps.db, userId, id, before, after, now);
  if (!hasApplied(before) && hasApplied(after)) await recordApplied(deps, userId, id, apply);
}
// end v20 P3

const JOB_PAY_PERIODS: readonly string[] = ['hour', 'day', 'week', 'month', 'year'];

/**
 * The latest calendar day a person can mean by "today": the date at UTC+14, the furthest-ahead time zone. The
 * browser sends its own local date; the server only refuses days that are in the future everywhere.
 */
export function latestAllowedDate(deps: Pick<AppDeps, 'now'>): string {
  return new Date(deps.now().getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const INVALID_DATE_MESSAGE = 'Enter a real date (YYYY-MM-DD).';

/** A real calendar day ("2026-02-30" is not) that is not in the future anywhere. */
export function assertValidDate(deps: Pick<AppDeps, 'now'>, date: string, field = 'occurredOn'): void {
  if (toIsoDate(date) !== date) throw validationFailed(INVALID_DATE_MESSAGE, { [field]: INVALID_DATE_MESSAGE });
  if (date > latestAllowedDate(deps)) throw validationFailed(FUTURE_DATE_MESSAGE, { [field]: FUTURE_DATE_MESSAGE });
}

/**
 * The jobs-table company with this name, so a tracked application shows its logo. v30 INT-3 (E0-API's note): the name
 * key is no longer unique (homonyms, merged rows: 0014), so the oldest shared row of the name that was not merged away.
 */
async function companyIdFor(db: DbQueries, name: string): Promise<number | null> {
  const key = normalizeCompanyName(name);
  if (!key) return null;
  const row = await db.one<{ id: number }>(
    'SELECT id FROM companies WHERE name_key = ? AND owner_user_id IS NULL AND merged_into_id IS NULL ORDER BY id LIMIT 1',
    [key],
  );
  return row?.id ?? null;
}

async function assertOwnedResume(db: DbQueries, userId: string, resumeId: string): Promise<void> {
  const row = await db.one('SELECT 1 AS found FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId]);
  if (!row) throw notFound('That resume');
}

async function assertOwnedLetter(db: DbQueries, userId: string, letterId: string): Promise<void> {
  const row = await db.one('SELECT 1 AS found FROM cover_letters WHERE id = ? AND user_id = ?', [letterId, userId]);
  if (!row) throw notFound('That cover letter');
}

interface InsertInput {
  userId: string;
  jobId: number | null;
  companyId: number | null;
  title: string;
  companyName: string;
  location: string;
  employmentType: EmploymentType;
  postingUrl: string;
  /** The entry's own description; null (JOBS_OWN_TEXT) for none: the job's text is shown (v30 DB-JOBS, D1c). */
  descriptionHtml: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: TrackerPayPeriod | null;
  /** The resume linked at insert: the person's choice, or none. TailorIT's choice is written after, through the guard. */
  resumeId: string | null;
  /** 'user' when the request named the resume (or "none"); null when nobody chose yet. */
  resumeOrigin: ResumeOrigin | null;
  /** True when TailorIT is to choose the resume (right after the insert when a choice is in hand, else the worker). */
  resumeMatchDue: boolean;
  notesHtml: string;
  trackedOn: string;
  events: readonly StatusEvent[];
}

type ResumeFields = Pick<InsertInput, 'resumeId' | 'resumeOrigin' | 'resumeMatchDue'>;

/** Nobody chose the resume, and TailorIT will not (an application added by hand, Applied and later statuses). */
const NOT_CHOSEN: ResumeFields = { resumeId: null, resumeOrigin: null, resumeMatchDue: false };
/** TailorIT chooses: written due, then linked at once when a choice is in hand. */
const TO_CHOOSE: ResumeFields = { resumeId: null, resumeOrigin: null, resumeMatchDue: true };
/** The person named the resume, or none (null or ''): their choice, never changed automatically. */
const chosenByPerson = (resumeId: string | null): ResumeFields => ({ resumeId, resumeOrigin: 'user', resumeMatchDue: false });

/**
 * Inserts an application and its events; answers its id. An application of a job the account already has
 * (idx_app_user_job: one per account and job) is not inserted: the answer is then null, and the caller reads the twin
 * (another save committed it after the caller looked). Run inside the caller's transaction. v30 DB-JOBS: an entry of a
 * job counts one save of it (job_stats.saves), in the same transaction.
 */
async function insertApplication(db: DbQueries, input: InsertInput, now: string): Promise<string | null> {
  const inserted = await db.one<{ id: string }>(
    `INSERT INTO applications(id, user_id, job_id, company_id, title, company_name, location, employment_type, posting_url,
       description_html, salary_min, salary_max, salary_currency, salary_period, current_status, favorite, archived_at,
       resume_id, resume_origin, resume_matched_at, resume_match_due, cover_letter_id, notes_html, tracked_on, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${db.dialect.false}, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (user_id, job_id) WHERE job_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.userId,
      input.jobId,
      input.companyId,
      input.title,
      input.companyName,
      input.location,
      input.employmentType,
      input.postingUrl,
      input.descriptionHtml,
      input.salaryMin,
      input.salaryMax,
      input.salaryCurrency,
      input.salaryPeriod,
      currentStatus(input.events),
      input.resumeId,
      input.resumeOrigin,
      input.resumeOrigin ? now : null,
      input.resumeMatchDue,
      input.notesHtml,
      input.trackedOn,
      now,
      now,
    ],
  );
  if (!inserted) return null;
  if (input.jobId !== null) await countJobStat(db, input.jobId, 'saves', now);
  for (const event of input.events) {
    await db.run(
      'INSERT INTO application_status_events(application_id, status, occurred_on, created_at) VALUES (?, ?, ?, ?)',
      [inserted.id, event.status, event.occurredOn, now],
    );
  }
  return inserted.id;
}

interface JobRow {
  id: number;
  title: string;
  apply_url: string;
  employment_type: EmploymentType | null;
  work_arrangement: string | null;
  primary_location: string;
  location_count: number;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  company_id: number;
  company_name: string;
}

// v30 DB-JOBS (D1c): the posting's text is not read here: the entry stores none (./description.ts).
const JOB_COLUMNS = `j.id, j.title, j.apply_url, j.employment_type, j.work_arrangement, j.primary_location, j.location_count,
  j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.company_id, c.name AS company_name`;
const JOB_FROM = 'jobs j JOIN companies c ON c.id = j.company_id';

/**
 * A job the account may see (every shared job, and its own jobs made from a page: autofill API version 5), or 404. A
 * page job an upgrade closed is the shared job it gave way to (currentJobId), so a stale id saves that job, never a
 * second entry (audit D4).
 */
async function loadJob(deps: Pick<AppDeps, 'db'>, jobId: number, userId: string): Promise<JobRow> {
  const id = await currentJobId(deps, userId, jobId);
  const job = id === null ? undefined : await deps.db.one<JobRow>(`SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE j.id = ?`, [id]);
  if (!job) throw notFound('That job');
  return job;
}

/**
 * The jobs among `ids` that exist and the account may see, by id (one query; `ids` is a chunk, far below SQLite's
 * variable limit).
 */
async function loadJobs(db: DbQueries, ids: readonly number[], userId: string): Promise<Map<number, JobRow>> {
  const jobs = new Map<number, JobRow>();
  if (ids.length === 0) return jobs;
  const rows = await db.all<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM}
     WHERE j.id IN (${db.dialect.list(ids.length)}) AND ${jobVisibleTo('j')}`,
    [...ids, userId],
  );
  for (const row of rows) jobs.set(row.id, row);
  return jobs;
}

function jobLocation(job: JobRow): string {
  const line = formatLocationLine(job.primary_location, job.location_count, null);
  if (line) return line;
  return job.work_arrangement === 'remote' ? 'Remote' : '';
}

/** What a request may override of a posting's prefill (the single save only). */
type PostingOverrides = Pick<CreateApplicationBody, 'title' | 'companyName' | 'location' | 'employmentType' | 'postingUrl'>;

/**
 * A new application from a posting, as the Jobs page saves it: title, company, location line, job type (full-time
 * when the posting does not say), link and pay, with the request's overrides; no description of its own (the job's
 * text is shown: v30 DB-JOBS, D1c). Its resume is not chosen (the caller decides).
 */
function fromPosting(
  userId: string,
  job: JobRow,
  options: { status: ApplicationStatus; date: string; body?: PostingOverrides },
): InsertInput {
  const body = options.body ?? {};
  const period = job.salary_period && JOB_PAY_PERIODS.includes(job.salary_period) ? (job.salary_period as TrackerPayPeriod) : null;
  const hasPay = job.salary_min !== null || job.salary_max !== null;
  return {
    userId,
    jobId: job.id,
    companyId: job.company_id,
    title: body.title || job.title,
    companyName: body.companyName || job.company_name,
    location: body.location ?? jobLocation(job),
    employmentType: body.employmentType ?? job.employment_type ?? 'full_time',
    postingUrl: body.postingUrl ?? normalizeUrlInput(job.apply_url) ?? '',
    descriptionHtml: JOBS_OWN_TEXT,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    salaryCurrency: hasPay ? (job.salary_currency ?? 'USD') : job.salary_currency,
    salaryPeriod: hasPay ? (period ?? 'year') : period,
    ...NOT_CHOSEN,
    notesHtml: '',
    trackedOn: options.date,
    events: initialEvents(options.status, options.date),
  };
}

/** An application of a job as a save reads it. */
type JobApplication = Pick<ApplicationRow, 'id' | 'current_status' | 'archived_at' | 'resume_id' | 'resume_origin'>;

const JOB_APPLICATION_COLUMNS = 'id, current_status, archived_at, resume_id, resume_origin';

/** The account's application of a job, if any. */
function jobApplication(db: DbQueries, userId: string, jobId: number): Promise<JobApplication | undefined> {
  return db.one<JobApplication>(`SELECT ${JOB_APPLICATION_COLUMNS} FROM applications WHERE user_id = ? AND job_id = ?`, [
    userId,
    jobId,
  ]);
}

/**
 * The twin another save of the job committed after this one looked (the insert met idx_app_user_job). It exists:
 * the unique index answered for it, and nothing deletes an application in between inside this transaction.
 */
async function twinApplication(db: DbQueries, userId: string, jobId: number): Promise<JobApplication> {
  const twin = await jobApplication(db, userId, jobId);
  if (!twin) throw new Error(`The account's application of job ${jobId} is neither insertable nor readable.`);
  return twin;
}

/**
 * Whether TailorIT chooses the resume when a job is saved at `status` (undefined: the status it has): for a new
 * application only at Saved; for an existing one only when it was un-saved (archived while only Saved), the save
 * does not move it on, and it has no resume the person chose (a resume TailorIT chose earlier is kept).
 */
function choosesOnSave(status: ApplicationStatus | undefined, existing: JobApplication | null): boolean {
  if (!existing) return status === STATUS.saved;
  if (status !== undefined && status > existing.current_status) return false;
  return (
    existing.archived_at !== null &&
    existing.current_status === STATUS.saved &&
    existing.resume_id === null &&
    existing.resume_origin !== 'user'
  );
}

/** A save names no resume (no `resumeId` key at all; null or '' is the person's "none") and TailorIT may choose. */
function choosesResume(body: CreateApplicationBody, existing: JobApplication | null): boolean {
  return body.jobId !== undefined && body.resumeId === undefined && choosesOnSave(body.status, existing);
}

/**
 * Links TailorIT's choice to a just-saved application through the full guard (`writeAutoChoice`: still the account's
 * Saved, active application of that job, chosen by TailorIT or by nobody, and a resume of the same account), which
 * clears the due flag. Without a choice, or when the guard refuses it (the resume was deleted meanwhile), the
 * application stays due and the match worker chooses. Run inside the caller's transaction.
 */
async function linkChoice(
  deps: Pick<AppDeps, 'db'>,
  target: { id: string; userId: string; jobId: number },
  choice: ResumeChoice | null | undefined,
  now: string,
): Promise<void> {
  if (!choice || choice.jobId !== target.jobId) return;
  await writeAutoChoice(deps.db, target, choice.resumeId, now);
}

/** The person's choice of resume (one of theirs, or none): never changed automatically, so never due. */
async function setPersonsResume(db: DbQueries, userId: string, id: string, resumeId: string | null, now: string): Promise<void> {
  await db.run(
    `UPDATE applications SET resume_id = ?, resume_origin = 'user', resume_matched_at = ?, resume_match_due = ${db.dialect.false}
     WHERE id = ? AND user_id = ?`,
    [resumeId, now, id, userId],
  );
}

export interface CreateResult {
  detail: ApplicationDetail;
  created: boolean;
}

export interface CreateOptions {
  /**
   * TailorIT's best resume for the job (`bestResumes`), chosen before the transaction. It is linked (origin 'auto') only
   * when TailorIT chooses for this save (see `wantsResumeMatch`); a choice whose resume is gone by then is not linked.
   */
  matchedResume?: ResumeChoice | null;
  /** The chooser did not finish for the job: the application is saved due, and the match worker chooses. */
  matchPending?: boolean;
}

/**
 * POST /api/applications. With `jobId` the application is the account's one for that job: created from the posting
 * (title, company, location, job type, link, pay, description) the first time; afterwards the existing one is
 * returned, restored if archived, and moved up to `status` when that is further along.
 *
 * Its resume, for a new application and for one un-saved earlier (archived while only Saved) that the save brings
 * back as it was; an application already tracked keeps its resume. A resume the body names (`resumeId`: an id of the
 * account's, or null / '' for none) is the person's choice. With no `resumeId` key, a job saved at Saved gets
 * TailorIT's best match (`options.matchedResume`, origin 'auto'), a brought-back one only when it has no resume; with
 * no choice in hand it is saved due and the match worker chooses (`detail.resumeMatchPending`). Applied and later
 * statuses, and applications added by hand, never get an automatic resume.
 *
 * Two saves of one job at once make one application (idx_app_user_job): the later one finds the earlier one's, before
 * its insert or (the insert's ON CONFLICT) right after it, and answers it with `created` false.
 */
export async function createApplication(
  deps: ApplyDeps,
  userId: string,
  body: CreateApplicationBody,
  options: CreateOptions = {},
): Promise<CreateResult> {
  const now = nowIso(deps);
  const date = body.occurredOn ?? todayIso(deps);
  assertValidDate(deps, date);
  const status: ApplicationStatus = body.status ?? STATUS.applied;
  const named = body.resumeId !== undefined;
  const resumeId = body.resumeId || null;
  const choice = options.matchPending ? null : (options.matchedResume ?? null);

  return deps.db.atomic(
    async (t): Promise<CreateResult> => {
      if (resumeId) await assertOwnedResume(t, userId, resumeId);
      if (body.jobId !== undefined) {
        const job = await loadJob(deps, body.jobId, userId);
        /** The account's application of the job exists: it is answered, raised, restored and given its resume. */
        const tracked = async (existing: JobApplication): Promise<CreateResult> => {
          const raisedTo = body.status !== undefined && body.status > existing.current_status ? body.status : null;
          // Un-saved earlier and saved again as it was: its resume is chosen as for a new application.
          const bringsBack = existing.archived_at !== null && existing.current_status === STATUS.saved && raisedTo === null;
          const chooses = choosesResume(body, existing);
          if (raisedTo !== null) {
            const before = await loadEvents(t, existing.id);
            await writeStatusEvents(deps, userId, existing.id, before, applyStatusChange(before, raisedTo, date), now, {
              via: 'tracker',
            });
          }
          if (existing.archived_at) await restoreRow(t, userId, existing.id, now);
          if (bringsBack && named) await setPersonsResume(t, userId, existing.id, resumeId, now);
          else if (chooses) await linkChoice(deps, { id: existing.id, userId, jobId: job.id }, choice, now);
          return { detail: await getDetail(t, userId, existing.id), created: false };
        };
        const existing = await jobApplication(t, userId, job.id);
        if (existing) return tracked(existing);
        const chooses = choosesResume(body, null);
        const resume = named ? chosenByPerson(resumeId) : chooses ? TO_CHOOSE : NOT_CHOSEN;
        const id = await insertApplication(t, { ...fromPosting(userId, job, { status, date, body }), ...resume }, now);
        // v3.0 D2 audit: another save of the job committed after the look above; this save is then a save of it.
        if (id === null) return tracked(await twinApplication(t, userId, job.id));
        if (chooses) await linkChoice(deps, { id, userId, jobId: job.id }, choice, now);
        if (hasApplied(await loadEvents(t, id))) await recordApplied(deps, userId, id, { via: 'tracker' }); // v20 P3
        return { detail: await getDetail(t, userId, id), created: true };
      }

      const title = body.title ?? '';
      const companyName = body.companyName ?? '';
      const id = await insertApplication(
        t,
        {
          userId,
          jobId: null,
          companyId: await companyIdFor(t, companyName),
          title,
          companyName,
          location: body.location ?? '',
          employmentType: body.employmentType ?? 'full_time',
          postingUrl: body.postingUrl ?? '',
          descriptionHtml: JOBS_OWN_TEXT,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: null,
          ...(named ? chosenByPerson(resumeId) : NOT_CHOSEN),
          notesHtml: '',
          trackedOn: date,
          events: initialEvents(status, date),
        },
        now,
      );
      // No job: the unique index never applies.
      if (id === null) throw new Error('An application added by hand was not inserted.');
      if (hasApplied(await loadEvents(t, id))) await recordApplied(deps, userId, id, { via: 'tracker' }); // v20 P3
      return { detail: await getDetail(t, userId, id), created: true };
    },
    { label: 'createApplication' },
  );
}

/**
 * Whether this POST /api/applications lets TailorIT choose the resume, so the router asks the chooser before the
 * write (which checks again): a job, no `resumeId` key, and either no application yet with status Saved, or an
 * un-saved one (archived, only Saved, no resume the person chose) that the save does not move on. Read-only.
 */
export async function wantsResumeMatch(db: DbQueries, userId: string, body: CreateApplicationBody): Promise<boolean> {
  if (body.jobId === undefined || body.resumeId !== undefined) return false;
  const row = await db.one<Omit<JobApplication, 'id'> & { job_id: number; id: string | null }>(
    `SELECT j.id AS job_id, a.id, a.current_status, a.archived_at, a.resume_id, a.resume_origin
     FROM jobs j LEFT JOIN applications a ON a.user_id = ? AND a.job_id = j.id
     WHERE j.id = ? AND ${jobVisibleTo('j')}`,
    [userId, body.jobId, userId],
  );
  // An unknown job, or another account's page job: the save answers 404.
  if (!row) return false;
  return choosesResume(body, row.id === null ? null : { ...row, id: row.id });
}

/** PATCH /api/applications/:id: the given fields; the pay is checked as it will be stored. */
export async function patchApplication(
  deps: Deps,
  userId: string,
  id: string,
  body: PatchApplicationBody,
): Promise<ApplicationDetail> {
  const db = deps.db;
  const row = await loadOwnedRow(db, userId, id);
  const sets: string[] = [];
  const params: Array<string | number | boolean | null> = [];
  const set = (column: string, value: string | number | boolean | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (body.title !== undefined) set('title', body.title);
  if (body.companyName !== undefined) {
    set('company_name', body.companyName);
    if (body.companyName !== row.company_name) set('company_id', await companyIdFor(db, body.companyName));
  }
  if (body.location !== undefined) set('location', body.location);
  if (body.employmentType !== undefined) set('employment_type', body.employmentType);
  if (body.postingUrl !== undefined) set('posting_url', body.postingUrl);
  if (body.descriptionHtml !== undefined) set('description_html', cleanRichText(body.descriptionHtml));
  if (body.notesHtml !== undefined) set('notes_html', cleanRichText(body.notesHtml));
  if (body.favorite !== undefined) set('favorite', body.favorite);
  if (body.trackedOn !== undefined) {
    assertValidDate(deps, body.trackedOn, 'trackedOn');
    set('tracked_on', body.trackedOn);
  }
  if (body.resumeId !== undefined) {
    const resumeId = body.resumeId || null;
    if (resumeId) await assertOwnedResume(db, userId, resumeId);
    // The person's choice (a resume, or none): TailorIT never changes it.
    set('resume_id', resumeId);
    set('resume_origin', 'user');
    set('resume_matched_at', nowIso(deps));
    set('resume_match_due', false);
  }
  if (body.coverLetterId !== undefined) {
    const coverLetterId = body.coverLetterId || null;
    if (coverLetterId) await assertOwnedLetter(db, userId, coverLetterId);
    set('cover_letter_id', coverLetterId);
  }

  const touchesPay =
    body.salaryMin !== undefined ||
    body.salaryMax !== undefined ||
    body.salaryCurrency !== undefined ||
    body.salaryPeriod !== undefined;
  if (touchesPay) {
    const min = body.salaryMin !== undefined ? body.salaryMin : row.salary_min;
    const max = body.salaryMax !== undefined ? body.salaryMax : row.salary_max;
    let currency = body.salaryCurrency !== undefined ? body.salaryCurrency : row.salary_currency;
    let period = body.salaryPeriod !== undefined ? body.salaryPeriod : row.salary_period;
    if (min !== null && max !== null && max < min) {
      throw validationFailed(SALARY_ORDER_MESSAGE, { salaryMax: SALARY_ORDER_MESSAGE });
    }
    // Clearing the period of a stored amount is refused, as clearing it beside a new amount is.
    if ((min !== null || max !== null) && body.salaryPeriod === null) {
      throw validationFailed(SALARY_PERIOD_MESSAGE, { salaryPeriod: SALARY_PERIOD_MESSAGE });
    }
    // Simplify's hidden defaults: an amount without a period is yearly, without a currency US dollars.
    if (min !== null || max !== null) {
      period ??= 'year';
      currency ??= 'USD';
    }
    set('salary_min', min);
    set('salary_max', max);
    set('salary_currency', currency);
    set('salary_period', period);
  }

  if (sets.length > 0) {
    set('updated_at', nowIso(deps));
    await db.run(`UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...params, id, userId]);
  }
  return getDetail(db, userId, id);
}

async function statusResponse(db: DbQueries, id: string): Promise<StatusChangeResponse> {
  const row = await db.one<{ current_status: ApplicationStatus; updated_at: string }>(
    'SELECT current_status, updated_at FROM applications WHERE id = ?',
    [id],
  );
  return { id, currentStatus: row!.current_status, events: await loadEvents(db, id), updatedAt: row!.updated_at };
}

/**
 * PUT /api/applications/:id/status: the shared move rule, dated `occurredOn` (default today). v2.0: a move that makes
 * the entry Applied writes its apply record, `apply` saying how (the Tracker's by default).
 */
export async function changeStatus(
  deps: ApplyDeps,
  userId: string,
  id: string,
  status: ApplicationStatus,
  occurredOn?: string,
  apply: ApplyContext = { via: 'tracker' },
): Promise<StatusChangeResponse> {
  const date = occurredOn ?? todayIso(deps);
  assertValidDate(deps, date);
  return deps.db.atomic(
    async (t) => {
      await loadOwnedRow(t, userId, id);
      const before = await loadEvents(t, id);
      await writeStatusEvents(deps, userId, id, before, applyStatusChange(before, status, date), nowIso(deps), apply);
      return statusResponse(t, id);
    },
    { label: 'changeStatus' },
  );
}

/** PUT /api/applications/:id/events/:status: a step's date ("Add date" or the pencil). */
export async function setStatusDate(
  deps: ApplyDeps,
  userId: string,
  id: string,
  status: ApplicationStatus,
  occurredOn: string,
): Promise<StatusChangeResponse> {
  assertValidDate(deps, occurredOn);
  return deps.db.tx(
    async (t) => {
      await loadOwnedRow(t, userId, id);
      const before = await loadEvents(t, id);
      await writeStatusEvents(deps, userId, id, before, setEventDate(before, status, occurredOn), nowIso(deps), {
        via: 'tracker',
      });
      return statusResponse(t, id);
    },
    { label: 'setStatusDate' },
  );
}

/** DELETE /api/applications/:id/events/:status: "Clear" in the date popover. */
export async function clearStatusDate(
  deps: Deps,
  userId: string,
  id: string,
  status: ApplicationStatus,
): Promise<StatusChangeResponse> {
  return deps.db.tx(
    async (t) => {
      await loadOwnedRow(t, userId, id);
      const before = await loadEvents(t, id);
      const blocker = clearEventBlocker(before, status);
      if (blocker) throw validationFailed(blocker, { status: blocker });
      const after = removeStatusEvent(before, status);
      if (after.length !== before.length) await writeEvents(t, userId, id, before, after, nowIso(deps));
      return statusResponse(t, id);
    },
    { label: 'clearStatusDate' },
  );
}

/**
 * Archive (the Jobs page's un-save too) or restore. A Saved application of a job that comes back is due again
 * (`detail.resumeMatchPending`), unless the person chose its resume.
 */
export async function setArchived(deps: Deps, userId: string, id: string, archived: boolean): Promise<ApplicationDetail> {
  await loadOwnedRow(deps.db, userId, id);
  const now = nowIso(deps);
  if (archived) await archiveRow(deps.db, userId, id, now);
  else await restoreRow(deps.db, userId, id, now);
  return getDetail(deps.db, userId, id);
}

export async function deleteApplication(deps: Deps, userId: string, id: string): Promise<void> {
  await loadOwnedRow(deps.db, userId, id);
  await deps.db.run('DELETE FROM applications WHERE id = ? AND user_id = ?', [id, userId]);
}

/**
 * POST /api/applications/bulk ("Manage jobs"). Ids that are not the account's are skipped, not reported. With
 * `onlySaved` (Save all's Undo), archiving leaves alone, and does not count, applications that moved past Saved.
 */
export async function bulkApplications(deps: ApplyDeps, userId: string, body: BulkApplicationsBody): Promise<number> {
  const now = nowIso(deps);
  const date = body.occurredOn ?? todayIso(deps);
  if (body.action === 'status') assertValidDate(deps, date);
  const ids = [...new Set(body.ids)];
  return deps.db.tx(
    async (t) => {
      let affected = 0;
      for (const id of ids) {
        const owned = await t.one<{ current_status: ApplicationStatus }>(
          'SELECT current_status FROM applications WHERE id = ? AND user_id = ?',
          [id, userId],
        );
        if (!owned) continue;
        switch (body.action) {
          case 'archive':
            if (body.onlySaved && owned.current_status !== STATUS.saved) continue;
            await archiveRow(t, userId, id, now);
            break;
          case 'unarchive':
            await restoreRow(t, userId, id, now);
            break;
          case 'delete':
            await t.run('DELETE FROM applications WHERE id = ? AND user_id = ?', [id, userId]);
            break;
          case 'status': {
            const before = await loadEvents(t, id);
            await writeStatusEvents(deps, userId, id, before, applyStatusChange(before, body.status!, date), now, {
              via: 'tracker',
            });
            break;
          }
        }
        affected += 1;
      }
      return affected;
    },
    { label: 'bulkApplications' },
  );
}

export async function archiveAll(deps: Deps, userId: string): Promise<number> {
  const now = nowIso(deps);
  const result = await deps.db.run(
    `UPDATE applications SET archived_at = ?, updated_at = ?, resume_match_due = ${deps.db.dialect.false}
     WHERE user_id = ? AND archived_at IS NULL`,
    [now, now, userId],
  );
  return result.changes;
}

/**
 * POST /api/applications/import: rows the wizard mapped. Each row is read with the shared rules (status map, job type
 * guess, flexible dates); its Application Date dates its events and its tracked day. Bad rows are reported by their
 * 1-based number and skipped; the rest are written in one transaction.
 */
export async function importApplications(deps: Deps, userId: string, body: TrackerImportBody): Promise<TrackerImportResponse> {
  const now = nowIso(deps);
  const today = todayIso(deps);
  const latest = latestAllowedDate(deps);
  const errors: TrackerImportResponse['errors'] = [];
  let imported = 0;
  await deps.db.tx(
    async (t) => {
      const companyIds = new Map<string, number | null>();
      for (const [index, raw] of body.rows.entries()) {
        const row = readImportRow(raw, body.statusMap);
        if (!row.ok) {
          errors.push({ row: index + 1, message: row.message });
          continue;
        }
        if (raw.appliedOn && raw.appliedOn.trim() && !row.appliedOn) {
          errors.push({ row: index + 1, message: `"${raw.appliedOn.trim().slice(0, 40)}" is not a date we can read.` });
          continue;
        }
        if (row.appliedOn && row.appliedOn > latest) {
          errors.push({ row: index + 1, message: FUTURE_DATE_MESSAGE });
          continue;
        }
        const day = row.appliedOn ?? today;
        if (!companyIds.has(row.companyName)) companyIds.set(row.companyName, await companyIdFor(t, row.companyName));
        await insertApplication(
          t,
          {
            userId,
            jobId: null,
            companyId: companyIds.get(row.companyName) ?? null,
            title: row.title,
            companyName: row.companyName,
            location: row.location,
            employmentType: row.employmentType,
            postingUrl: normalizeUrlInput(row.postingUrl.slice(0, 2000)) ?? '',
            descriptionHtml: JOBS_OWN_TEXT,
            salaryMin: null,
            salaryMax: null,
            salaryCurrency: null,
            salaryPeriod: null,
            ...NOT_CHOSEN,
            notesHtml: cleanRichText(textToParagraphs(row.notes)),
            trackedOn: day,
            events: initialEvents(row.status, day),
          },
          now,
        );
        imported += 1;
      }
    },
    { label: 'importApplications' },
  );
  return { imported, skipped: errors.length, errors };
}

// ------------------------------------------------------------------------------------------------- Save all

/** The most jobs `saveJobs` writes in one transaction. */
export const SAVE_JOBS_CHUNK = 25;
/** The longest one chunk of `saveJobs` spends preparing its new applications before it writes. */
export const SAVE_JOBS_CHUNK_MS = 200;

/** Which resume to link to some jobs (`bestResumes`, or `resumeChooser` for one budget over every chunk). */
export type ChooseResumes = (jobIds: readonly number[]) => Promise<{ choices: ReadonlyMap<number, ResumeChoice> }>;

export interface SaveJobsOptions {
  /** The day the jobs are saved ("YYYY-MM-DD", the browser's today): their Saved event and tracked day. */
  occurredOn: string;
  /**
   * Asked once per chunk, outside its transaction, about the jobs it will write with no resume. A job it gives no
   * choice for is saved due (the match worker chooses). Must not throw: a throw is logged and the jobs are left due.
   */
  chooseResumes: ChooseResumes;
  /** The longest one chunk prepares before it writes; default SAVE_JOBS_CHUNK_MS. */
  chunkMs?: number;
}

export interface SaveJobsResult {
  /** The jobs saved, in the order asked (each once), from committed chunks only. */
  items: SavedJobRef[];
  /** Jobs left as they were: tracked already (an active application, or Applied and later even when archived), or gone. */
  skipped: number;
  /** Saved applications whose resume TailorIT is still choosing (resume_match_due set); the worker links it soon. */
  pendingMatches: number;
  /** Set when a chunk after the first failed: `items` is what the chunks before it saved. A failing first chunk throws. */
  error?: unknown;
}

/** Besides the database and the clock: the match worker to wake, and the log for a chooser that throws. */
type SaveJobsDeps = Deps & Partial<Pick<AppDeps, 'services' | 'log'>>;

interface SavedChunk {
  /** How many of the jobs offered the chunk took (the rest go to the next one). */
  taken: number;
  items: SavedJobRef[];
  skipped: number;
  pending: number;
}

const IN_TRANSACTION =
  'saveJobs cannot run inside an open transaction: it waits between its chunks, and other writes would wait for it meanwhile.';

/** The account's applications of these jobs, by job id. */
async function applicationsOfJobs(db: DbQueries, userId: string, jobIds: readonly number[]): Promise<Map<number, JobApplication>> {
  const byJob = new Map<number, JobApplication>();
  if (jobIds.length === 0) return byJob;
  const rows = await db.all<JobApplication & { job_id: number }>(
    `SELECT job_id, ${JOB_APPLICATION_COLUMNS} FROM applications WHERE user_id = ? AND job_id IN (${db.dialect.list(jobIds.length)})`,
    [userId, ...jobIds],
  );
  for (const { job_id: jobId, ...application } of rows) byJob.set(jobId, application);
  return byJob;
}

/** The chooser's answer. One that throws (it must not) is logged, and its jobs are left for the match worker. */
async function choicesFor(
  deps: SaveJobsDeps,
  userId: string,
  chooseResumes: ChooseResumes,
  jobIds: readonly number[],
): Promise<ReadonlyMap<number, ResumeChoice>> {
  try {
    return (await chooseResumes(jobIds)).choices;
  } catch (error) {
    deps.log?.warn(
      `[applications] choosing resumes for ${jobIds.length} saved job(s) of account ${userId} failed; the match worker chooses them`,
      error,
    );
    return new Map();
  }
}

/**
 * One chunk's write, inside its transaction: the applications are read again (anything may have changed while the
 * chunk was prepared and its resumes chosen). Returns the items, which count only once the transaction commits.
 */
async function writeSavedJobs(
  deps: Pick<AppDeps, 'db'>,
  t: DbQueries,
  userId: string,
  chunk: readonly number[],
  prepared: ReadonlyMap<number, InsertInput>,
  choices: ReadonlyMap<number, ResumeChoice>,
  date: string,
  now: string,
): Promise<Omit<SavedChunk, 'taken'>> {
  const current = await applicationsOfJobs(t, userId, chunk);
  const alive = new Set(
    (
      await t.all<{ id: number }>(`SELECT id FROM jobs WHERE id IN (${t.dialect.list(chunk.length)}) AND ${jobVisibleTo('')}`, [
        ...chunk,
        userId,
      ])
    ).map((row) => row.id),
  );
  const saved: Array<{ jobId: number; applicationId: string; created: boolean }> = [];
  let skipped = 0;
  /** A job the account already has: left as it is, or (un-saved earlier) brought back. */
  const tracked = async (jobId: number, existing: JobApplication): Promise<void> => {
    // Tracked already, and it keeps its status: an active application, or one that reached Applied.
    if (existing.archived_at === null || existing.current_status !== STATUS.saved) {
      skipped += 1;
      return;
    }
    // Un-saved earlier: it comes back with its events, notes and favourite; a resume only when it has none.
    await restoreRow(t, userId, existing.id, now);
    if (choosesOnSave(STATUS.saved, existing)) await linkChoice(deps, { id: existing.id, userId, jobId }, choices.get(jobId), now);
    saved.push({ jobId, applicationId: existing.id, created: false });
  };
  for (const jobId of chunk) {
    const existing = current.get(jobId) ?? null;
    if (existing) {
      await tracked(jobId, existing);
      continue;
    }
    if (!alive.has(jobId)) {
      skipped += 1;
      continue;
    }
    // Prepared before the transaction; one whose application disappeared meanwhile is prepared now.
    const input = prepared.get(jobId) ?? fromPosting(userId, await loadJob(deps, jobId, userId), { status: STATUS.saved, date });
    const id = await insertApplication(t, { ...input, ...TO_CHOOSE }, now);
    if (id === null) {
      // v3.0 D2 audit: another save of the job committed after this chunk read its applications.
      await tracked(jobId, await twinApplication(t, userId, jobId));
      continue;
    }
    await linkChoice(deps, { id, userId, jobId }, choices.get(jobId), now);
    saved.push({ jobId, applicationId: id, created: true });
  }

  const ids = saved.map((entry) => entry.applicationId);
  const rows =
    ids.length === 0
      ? []
      : await t.all<{ id: string; resume_id: string | null; resume_match_due: number | boolean }>(
          `SELECT id, resume_id, resume_match_due FROM applications WHERE id IN (${t.dialect.list(ids.length)})`,
          ids,
        );
  const state = new Map(rows.map((row) => [row.id, row]));
  let pending = 0;
  const items = saved.map(({ jobId, applicationId, created }): SavedJobRef => {
    const row = state.get(applicationId);
    if (row && Boolean(row.resume_match_due)) pending += 1;
    return { jobId, applicationId, resumeId: row?.resume_id ?? null, created };
  });
  return { items, skipped, pending };
}

/**
 * One chunk: up to SAVE_JOBS_CHUNK of the jobs offered, fewer once preparing took `chunkMs`. Outside any transaction,
 * the new applications are prepared and TailorIT's resumes chosen (v30 DB-JOBS: no description is cleaned any more);
 * then one transaction writes. The event loop gets a turn in between.
 */
async function saveChunk(
  deps: SaveJobsDeps,
  userId: string,
  offered: readonly number[],
  options: SaveJobsOptions,
): Promise<SavedChunk> {
  const db = deps.db;
  const date = options.occurredOn;
  const limitMs = Math.max(0, options.chunkMs ?? SAVE_JOBS_CHUNK_MS);
  // Read outside any transaction, and again in the write: what each job has; the new applications are prepared.
  const known = await applicationsOfJobs(db, userId, offered);
  const jobs = await loadJobs(
    db,
    offered.filter((jobId) => !known.has(jobId)),
    userId,
  );
  const prepared = new Map<number, InsertInput>();
  const started = performance.now();
  let taken = 0;
  for (const jobId of offered) {
    taken += 1;
    const job = jobs.get(jobId);
    if (job) prepared.set(jobId, fromPosting(userId, job, { status: STATUS.saved, date }));
    if (performance.now() - started >= limitMs) break;
  }
  const chunk = offered.slice(0, taken);
  await yieldToEventLoop();

  // Only the jobs that will be written with no resume are asked about.
  const asked = chunk.filter((jobId) => {
    const existing = known.get(jobId);
    return existing ? choosesOnSave(STATUS.saved, existing) : jobs.has(jobId);
  });
  const choices = asked.length > 0 ? await choicesFor(deps, userId, options.chooseResumes, asked) : new Map<number, ResumeChoice>();

  if (db.inTx()) throw new Error(IN_TRANSACTION);
  const written = await db.tx((t) => writeSavedJobs(deps, t, userId, chunk, prepared, choices, date, nowIso(deps)), {
    label: 'saveJobs',
  });
  return { taken, ...written };
}

/**
 * Save all's writes (work package WP7 selects the jobs): each job is saved at Saved on `occurredOn` with the single
 * Save's prefill. A job with no application gets one, with its Saved event and TailorIT's best resume; one un-saved
 * earlier (archived while only Saved) comes back, its resume filled only when it has none; a job already tracked (an
 * active application, or Applied and later even when archived) or gone is skipped and left untouched. No AI work is
 * queued.
 *
 * Duplicates are saved once. The jobs go in chunks (see `saveChunk`), each committed on its own: items are counted
 * after their chunk commits, so a chunk that rolls back leaves no application ids behind. When the first chunk fails
 * the error is thrown and nothing is saved; when a later one fails, what the earlier chunks saved is returned with
 * `error`. Applications left due wake the match worker once, at the end. It refuses to run inside an open
 * transaction, which every other request would wait for while it waits between its chunks.
 */
export async function saveJobs(
  deps: SaveJobsDeps,
  userId: string,
  jobIds: readonly number[],
  options: SaveJobsOptions,
): Promise<SaveJobsResult> {
  if (deps.db.inTx()) throw new Error(IN_TRANSACTION);
  assertValidDate(deps, options.occurredOn);
  // A page job an upgrade closed is saved as the shared job it gave way to (audit D4); one the account does not see
  // stays as asked, and is skipped as gone.
  const asked = [...new Set(jobIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const ids: number[] = [];
  for (const id of asked) ids.push((await currentJobId(deps, userId, id)) ?? id);
  const unique = [...new Set(ids)];
  const result: SaveJobsResult = { items: [], skipped: 0, pendingMatches: 0 };
  let start = 0;
  while (start < unique.length) {
    let chunk: SavedChunk;
    try {
      chunk = await saveChunk(deps, userId, unique.slice(start, start + SAVE_JOBS_CHUNK), options);
    } catch (error) {
      if (start === 0) throw error;
      result.error = error;
      break;
    }
    result.items.push(...chunk.items);
    result.skipped += chunk.skipped;
    result.pendingMatches += chunk.pending;
    start += chunk.taken;
    if (start < unique.length) await yieldToEventLoop();
  }
  if (result.pendingMatches > 0) deps.services?.resumeMatch?.nudge();
  return result;
}

// ------------------------------------------------------------------------------------------------- questions

export async function createQuestion(
  deps: Deps,
  userId: string,
  applicationId: string,
  input: { question: string; answer: string },
): Promise<ApplicationQuestion> {
  await loadOwnedRow(deps.db, userId, applicationId);
  const now = nowIso(deps);
  const id = randomUUID();
  return deps.db.atomic(
    async (t) => {
      // The next position (read, then insert) is the person's to take one at a time.
      await t.lockPerson(userId);
      const next = await t.one<{ next: number }>(
        'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM application_questions WHERE application_id = ?',
        [applicationId],
      );
      await t.run(
        'INSERT INTO application_questions(id, application_id, position, question, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, applicationId, next!.next, input.question, input.answer, now, now],
      );
      await t.run('UPDATE applications SET updated_at = ? WHERE id = ? AND user_id = ?', [now, applicationId, userId]);
      return toQuestion(await loadQuestionRow(t, applicationId, id));
    },
    { label: 'createQuestion' },
  );
}

/** Rewrites positions 0..n-1 in the given order. */
async function renumber(db: DbQueries, ids: readonly string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await db.run('UPDATE application_questions SET position = ? WHERE id = ?', [index, id]);
  }
}

export async function patchQuestion(
  deps: Deps,
  userId: string,
  applicationId: string,
  questionId: string,
  input: { question?: string; answer?: string; position?: number },
): Promise<ApplicationQuestion> {
  await loadOwnedRow(deps.db, userId, applicationId);
  await loadQuestionRow(deps.db, applicationId, questionId);
  const now = nowIso(deps);
  return deps.db.tx(
    async (t) => {
      if (input.question !== undefined) {
        await t.run('UPDATE application_questions SET question = ? WHERE id = ?', [input.question, questionId]);
      }
      if (input.answer !== undefined) {
        await t.run('UPDATE application_questions SET answer = ? WHERE id = ?', [input.answer, questionId]);
      }
      if (input.position !== undefined) {
        // The order is read, then rewritten: one renumbering of the person's at a time.
        await t.lockPerson(userId);
        const order = (await loadQuestions(t, applicationId)).map((question) => question.id).filter((id) => id !== questionId);
        order.splice(Math.min(input.position, order.length), 0, questionId);
        await renumber(t, order);
      }
      await t.run('UPDATE application_questions SET updated_at = ? WHERE id = ?', [now, questionId]);
      await t.run('UPDATE applications SET updated_at = ? WHERE id = ? AND user_id = ?', [now, applicationId, userId]);
      return toQuestion(await loadQuestionRow(t, applicationId, questionId));
    },
    { label: 'patchQuestion' },
  );
}

export async function deleteQuestion(deps: Deps, userId: string, applicationId: string, questionId: string): Promise<void> {
  await loadOwnedRow(deps.db, userId, applicationId);
  await loadQuestionRow(deps.db, applicationId, questionId);
  await deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      await t.run('DELETE FROM application_questions WHERE id = ?', [questionId]);
      await renumber(
        t,
        (await loadQuestions(t, applicationId)).map((question) => question.id),
      );
      await t.run('UPDATE applications SET updated_at = ? WHERE id = ? AND user_id = ?', [nowIso(deps), applicationId, userId]);
    },
    { label: 'deleteQuestion' },
  );
}
