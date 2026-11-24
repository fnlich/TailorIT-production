import {
  APPLICATION_STATUSES,
  STATUS,
  currentStatus,
  normalizeEvents,
  type ApplicationDetail,
  type ApplicationQuestion,
  type ApplicationStatus,
  type ApplicationSummary,
  type EmploymentType,
  type ResumeOrigin,
  type StatusEvent,
  type TrackerPayPeriod,
} from '@tailorit/shared';
import { agentCanApply, queueCanOpen } from '@tailorit/shared/autofill';
import type { DbQueries } from '../../core/db/types';
import { notFound } from '../../core/http/errors';
import { creditFieldOf, jobCreditOfJobSql } from '../jobs/credit'; // v30 FIX-B
import { verificationOfJson, verificationRowSql } from '../jobs/add/verification'; // v31 LINK
import { descriptionHtmlOf } from './description';

// Rows of the tracker tables and their DTOs. Every read is scoped by user_id: another account's application is
// "not found", never "forbidden".
//
// The resume match flag (migration 0301). `resume_match_due` set asks the match worker to choose the application's
// resume. TailorIT chooses only for an application of a job that is Saved, not archived, and whose resume TailorIT
// chose or nobody chose yet (origin 'auto' or NULL). The writers here keep the flag to that: moving past Saved or
// archiving clears it; moving back to Saved or restoring such an application sets it, so the choice is made again.
//
// v3.0 D2: every helper takes a DbQueries (`deps.db`, or a transaction's `t`) and answers a promise. Flags are written
// as the dialect's literals and read with Boolean() (0/1 on SQLite, true/false on PostgreSQL).

export interface ApplicationRow {
  id: string;
  user_id: string;
  job_id: number | null;
  company_id: number | null;
  title: string;
  company_name: string;
  location: string;
  employment_type: EmploymentType;
  posting_url: string;
  /** The entry's own description; NULL: its job's text (v30 DB-JOBS, D1c: read with descriptionHtmlOf). */
  description_html: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: TrackerPayPeriod | null;
  current_status: ApplicationStatus;
  /** A flag: 0/1 on SQLite, a boolean on PostgreSQL (read it with Boolean()). */
  favorite: number | boolean;
  archived_at: string | null;
  resume_id: string | null;
  /** Who chose resume_id: 'auto' (TailorIT's best match), 'user' (the person, a resume or none), NULL (nobody yet). */
  resume_origin: ResumeOrigin | null;
  /** When resume_id was chosen. */
  resume_matched_at: string | null;
  /** Set while TailorIT is still to choose the resume (the match worker links it); a flag, read with Boolean(). */
  resume_match_due: number | boolean;
  cover_letter_id: string | null;
  notes_html: string;
  tracked_on: string;
  created_at: string;
  updated_at: string;
  /** The company's logo (company_profiles.logo_path, v30 E0-API). */
  logo_path: string | null;
  /** v30 INT-3: the entry's job is held for review (jobs.held_since is set). */
  job_held?: boolean | null;
  /** v30 FIX-B (UX-10): the entry's job is closed (jobs.active is false); null without a job. */
  job_closed?: boolean | null;
  /** v30 FIX-B (REQ-1): the job's source's credit line as JSON text (jobs/credit.ts), or null. */
  job_credit?: string | null;
  /** v31 LINK: the job's verification as one JSON value (jobs/add/verification.ts verificationRowSql), or null. */
  job_verification?: unknown;
  /** The job's address (jobs.apply_url), when the entry is of a job. */
  job_apply_url?: string | null;
  // v20 P3 (A30)
  /**
   * The created_at of the job's live queue row (queued or running): a Saved entry carries the Draft mark (v33 F1: a
   * badge on its Saved card).
   */
  queued_at?: string | null;
  // end v20 P3
}

/**
 * The SELECT list every application read uses (alias `a`, companies joined as `c`), with the job's address for the
 * auto-apply agent's `autoApply`, and (v20 A30) the created_at of the job's live queue row (DRAFT_QUEUE_STATES), the
 * Draft mark's date (v33 F1: a badge on its Saved card). The queue keeps one row per account and job
 * (UNIQUE(user_id, job_id)), so the read is one index lookup, and it finds rows queued before v2.0 too.
 */
export const LIVE_QUEUE_ROW_AT_SQL =
  "(SELECT q.created_at FROM autofill_agent_queue q WHERE q.user_id = a.user_id AND q.job_id = a.job_id AND q.state IN ('queued', 'running'))";
export const APPLICATION_COLUMNS =
  `a.*, (SELECT cp.logo_path FROM company_profiles cp WHERE cp.company_id = c.id) AS logo_path, (SELECT j.apply_url FROM jobs j WHERE j.id = a.job_id) AS job_apply_url, ${LIVE_QUEUE_ROW_AT_SQL} AS queued_at, ` +
  '(SELECT j.held_since IS NOT NULL FROM jobs j WHERE j.id = a.job_id) AS job_held, ' +
  // v30 FIX-B (UX-10, REQ-1): the job's closed mark and its source's credit line.
  `(SELECT NOT j.active FROM jobs j WHERE j.id = a.job_id) AS job_closed, ${jobCreditOfJobSql('a.job_id')} AS job_credit, ` +
  // v31 LINK: the job's verification (a job of the account's own: why TailorIT could not read it).
  `(SELECT ${verificationRowSql('j')} FROM jobs j WHERE j.id = a.job_id) AS job_verification`;
export const APPLICATION_FROM = 'applications a LEFT JOIN companies c ON c.id = a.company_id';

interface EventRow {
  application_id: string;
  status: ApplicationStatus;
  occurred_on: string;
}

interface QuestionRow {
  id: string;
  application_id: string;
  position: number;
  question: string;
  answer: string;
  created_at: string | null;
  updated_at: string | null;
}

/** One of the account's applications, or 404. */
export async function loadOwnedRow(db: DbQueries, userId: string, id: string): Promise<ApplicationRow> {
  const row = await db.one<ApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS} FROM ${APPLICATION_FROM} WHERE a.id = ? AND a.user_id = ?`,
    [id, userId],
  );
  if (!row) throw notFound('That application');
  return row;
}

export async function loadEvents(db: DbQueries, applicationId: string): Promise<StatusEvent[]> {
  const rows = await db.all<Pick<EventRow, 'status' | 'occurred_on'>>(
    'SELECT status, occurred_on FROM application_status_events WHERE application_id = ? ORDER BY status',
    [applicationId],
  );
  return normalizeEvents(rows.map((row) => ({ status: row.status, occurredOn: row.occurred_on })));
}

const ID_CHUNK = 500;

/** The events of many applications at once, keyed by application id (in status order). */
export async function loadEventsFor(db: DbQueries, ids: readonly string[]): Promise<Map<string, StatusEvent[]>> {
  const out = new Map<string, StatusEvent[]>();
  for (const id of ids) out.set(id, []);
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const rows = await db.all<EventRow>(
      `SELECT application_id, status, occurred_on FROM application_status_events
       WHERE application_id IN (${db.dialect.list(chunk.length)}) ORDER BY application_id, status`,
      chunk,
    );
    for (const row of rows) out.get(row.application_id)?.push({ status: row.status, occurredOn: row.occurred_on });
  }
  for (const [id, events] of out) out.set(id, normalizeEvents(events));
  return out;
}

/** TailorIT may choose the row's resume once it is Saved again (SQL over the row; `archived_at` as written). */
const CHOOSABLE_WHEN_SAVED = `job_id IS NOT NULL AND (resume_origin IS NULL OR resume_origin = 'auto')`;

/**
 * Writes an application's new event list: removed statuses are deleted, new ones inserted, changed dates updated;
 * the denormalized `current_status` follows. Past Saved, TailorIT no longer chooses the resume (the due flag is
 * cleared; the resume linked stays). Moved back to Saved, an active application of a job whose resume TailorIT chose
 * (or nobody chose) is marked due, so its best match is chosen again. Call inside a transaction.
 */
export async function writeEvents(
  db: DbQueries,
  userId: string,
  applicationId: string,
  before: readonly StatusEvent[],
  after: readonly StatusEvent[],
  now: string,
): Promise<ApplicationStatus> {
  const held = new Map(before.map((event) => [event.status, event.occurredOn] as const));
  const next = new Map(after.map((event) => [event.status, event.occurredOn] as const));
  for (const status of held.keys()) {
    if (next.has(status)) continue;
    await db.run('DELETE FROM application_status_events WHERE application_id = ? AND status = ?', [applicationId, status]);
  }
  for (const [status, occurredOn] of next) {
    if (!held.has(status)) {
      await db.run(
        'INSERT INTO application_status_events(application_id, status, occurred_on, created_at) VALUES (?, ?, ?, ?)',
        [applicationId, status, occurredOn, now],
      );
    } else if (held.get(status) !== occurredOn) {
      await db.run('UPDATE application_status_events SET occurred_on = ? WHERE application_id = ? AND status = ?', [
        occurredOn,
        applicationId,
        status,
      ]);
    }
  }
  const current = currentStatus(after);
  const lowered = current === STATUS.saved && currentStatus(before) !== STATUS.saved;
  const d = db.dialect;
  // The flag's new value, chosen here rather than by comparing bound numbers in SQL (a boolean column on PostgreSQL).
  const due =
    current !== STATUS.saved
      ? d.false
      : lowered
        ? `CASE WHEN archived_at IS NULL AND ${CHOOSABLE_WHEN_SAVED} THEN ${d.true} ELSE resume_match_due END`
        : 'resume_match_due';
  await db.run(
    `UPDATE applications SET current_status = @current, updated_at = @now, resume_match_due = ${due}
     WHERE id = @id AND user_id = @userId`,
    { current, now, id: applicationId, userId },
  );
  return current;
}

/**
 * Archives an application (archiving twice keeps the first time). An archived application is not TailorIT's to
 * choose a resume for, so it is no longer due.
 */
export async function archiveRow(db: DbQueries, userId: string, id: string, now: string): Promise<void> {
  await db.run(
    `UPDATE applications SET archived_at = COALESCE(archived_at, @now), updated_at = @now,
       resume_match_due = ${db.dialect.false}
     WHERE id = @id AND user_id = @userId`,
    { now, id, userId },
  );
}

/**
 * v36 FIX-API (sec L3): archives an entry only while it is still at Saved and not archived, in the same statement (an
 * entry the extension moved to Applied, or another request archived, since it was read is left as it is). Answers
 * whether it archived it.
 */
export async function archiveSavedRow(db: DbQueries, userId: string, id: string, now: string): Promise<boolean> {
  const row = await db.one<{ id: string }>(
    `UPDATE applications SET archived_at = @now, updated_at = @now, resume_match_due = ${db.dialect.false}
     WHERE id = @id AND user_id = @userId AND current_status = ${STATUS.saved} AND archived_at IS NULL RETURNING id`,
    { now, id, userId },
  );
  return row !== undefined;
}

/**
 * Restores an application. One that comes back Saved, of a job, with a resume TailorIT chose (or nobody chose), is
 * marked due: what its choice depends on may have changed while it was archived. (SET reads the row as it was.)
 */
export async function restoreRow(db: DbQueries, userId: string, id: string, now: string): Promise<void> {
  const d = db.dialect;
  await db.run(
    `UPDATE applications
     SET archived_at = NULL, updated_at = @now,
         resume_match_due = CASE
           WHEN archived_at IS NOT NULL AND current_status = ${STATUS.saved} AND ${CHOOSABLE_WHEN_SAVED} THEN ${d.true}
           ELSE resume_match_due END
     WHERE id = @id AND user_id = @userId`,
    { now, id, userId },
  );
}

/**
 * A logo the browser can load as it is: an absolute http(s) URL or a same-origin path. Anything else (a file path
 * on the server) has no public address here, so the card falls back to the letter avatar.
 */
export function logoUrlOf(path: string | null): string | null {
  if (!path) return null;
  const value = path.trim();
  if (/^https?:\/\//i.test(value)) return value;
  // A same-origin path: "//host" and "/\host" would load from another site.
  if (/^\/(?![/\\])/.test(value)) return value;
  return null;
}

export function toSummary(row: ApplicationRow, events: readonly StatusEvent[]): ApplicationSummary {
  return {
    id: row.id,
    title: row.title,
    companyName: row.company_name,
    companyId: row.company_id,
    logoUrl: logoUrlOf(row.logo_path),
    location: row.location,
    employmentType: row.employment_type,
    currentStatus: row.current_status,
    events: [...events],
    favorite: Boolean(row.favorite),
    archivedAt: row.archived_at,
    trackedOn: row.tracked_on,
    jobId: row.job_id,
    postingUrl: row.posting_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    autoApply: row.job_id !== null && agentCanApply(row.job_apply_url ?? ''),
    // jr7 7a: the Queue tab opens it.
    queueApply: row.job_id !== null && queueCanOpen(row.job_apply_url ?? ''),
    // v20 A30: its job has a live queue row, so a Saved entry carries the Draft mark (v33 F1: a badge on its Saved card),
    // dated by the row's created_at.
    queued: row.queued_at != null,
    queuedAt: row.queued_at ?? null,
    // v30 INT-3: its job is held for review: "Waiting for approval" on the card and the row (14 §4.3).
    ...(row.job_held === true ? { held: true } : {}),
    // v30 FIX-B: the job's closed mark (UX-10) and its source's credit line (REQ-1).
    ...(row.job_closed === true ? { closed: true as const } : {}),
    ...creditFieldOf(row.job_credit),
    // v31 LINK: a job others do not see says why (absent: everyone sees it).
    ...verificationOfJson(row.job_verification),
  };
}

export function toQuestion(row: QuestionRow): ApplicationQuestion {
  return {
    id: row.id,
    position: row.position,
    question: row.question,
    answer: row.answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadQuestions(db: DbQueries, applicationId: string): Promise<ApplicationQuestion[]> {
  const rows = await db.all<QuestionRow>(
    'SELECT * FROM application_questions WHERE application_id = ? ORDER BY position, created_at, id',
    [applicationId],
  );
  return rows.map(toQuestion);
}

export async function loadQuestionRow(db: DbQueries, applicationId: string, questionId: string): Promise<QuestionRow> {
  const row = await db.one<QuestionRow>('SELECT * FROM application_questions WHERE id = ? AND application_id = ?', [
    questionId,
    applicationId,
  ]);
  if (!row) throw notFound('That question');
  return row;
}

export async function toDetail(db: DbQueries, row: ApplicationRow): Promise<ApplicationDetail> {
  const events = await loadEvents(db, row.id);
  const questions = await loadQuestions(db, row.id);
  return {
    ...toSummary(row, events),
    // v30 DB-JOBS (D1c): its own description, else its job's text as it is now.
    descriptionHtml: await descriptionHtmlOf(db, row),
    salary: {
      min: row.salary_min,
      max: row.salary_max,
      currency: row.salary_currency,
      period: row.salary_period,
    },
    resumeId: row.resume_id,
    resumeOrigin: row.resume_origin ?? null,
    resumeMatchedAt: row.resume_matched_at ?? null,
    resumeMatchPending: Boolean(row.resume_match_due),
    coverLetterId: row.cover_letter_id,
    notesHtml: row.notes_html,
    questions,
  };
}

/** The account's application as the detail sheet reads it (404 for anyone else's). */
export async function getDetail(db: DbQueries, userId: string, id: string): Promise<ApplicationDetail> {
  return toDetail(db, await loadOwnedRow(db, userId, id));
}

/** Counts of the account's applications by status, active ones only, every status present. */
export function emptyStatusCounts(): Record<string, number> {
  return Object.fromEntries(APPLICATION_STATUSES.map((status) => [String(status), 0]));
}
