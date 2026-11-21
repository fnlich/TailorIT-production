import type { AutofillDraftProvenance, AutofillSubmittedAnswerValue } from '@tailorit/shared/autofill';
import type {
  CoverLetterMode,
  PrepareJobState,
  PrepareMode,
  PreparePartStatus,
  PrepareResumeMode,
} from '@tailorit/shared';
import type { DbQueries } from '../../core/db/index';

// Prepare & Queue's tables (v2.0, docs/design/v2.0/01-data-model.md: 0822's prepare_jobs and the rebuilt drafts, 0827's
// resume mode, and the person's columns of 0824's user_settings): the only module that reads or writes them. One
// prepare_jobs row is one Prepare of one saved job; the application's draft (application_drafts, one per application)
// is its kit, `prepare_id` naming the Prepare that last worked on it. Every read takes its account or its own id;
// nothing here logs a value.
// v3.0 D2-F: on the async client (a DbQueries: deps.db, or a transaction's `t`).
// v3.0 PG-F: the flags (letter_wanted, rebuild, skip_prepare_confirm) are booleans (decision K): written as JS booleans,
// read through `dialect.isTrue`; the insertion-order
// tiebreaks are prepare_jobs.seq (`dialect.seq`).

/** A prepare_jobs row. */
export interface PrepareRow {
  id: string;
  user_id: string;
  application_id: string;
  job_id: number | null;
  mode: PrepareMode;
  letter_mode: CoverLetterMode;
  /** True a letter is made, false none; null until decided. Read it through `dialect.isTrue`. */
  letter_wanted: boolean | null;
  /** Read it through `dialect.isTrue`. */
  rebuild: boolean;
  state: PrepareJobState;
  reason_code: string | null;
  error: string | null;
  queue_id: string | null;
  cost_micros: number;
  resume_mode: PrepareResumeMode;
  resume_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  // v33 SHARE-5 (PLAN F9; migration 0049): who started the Prepare (its payer: B on a profile A shared with them; the
  // owner for their own) and the grant it runs under (null for the owner's own). Read rows always hold them; a row
  // written without them is the owner's own (insertPrepare, and 0049's trigger).
  started_by?: string;
  grant_id?: string | null;
  /**
   * v33 SHARE-5 (the review's decision 7; migration 0051): the payer's own refusal in its own words, on a Prepare of a
   * share their own limit stopped (reason `payer_limit`); shown to the payer alone (prepareErrorFor).
   */
  payer_error?: string | null;
}

/** v33 SHARE-5: who started a Prepare (its payer): `started_by`, else (a row built without it) its owner. */
export const startedByOf = (row: Pick<PrepareRow, 'user_id' | 'started_by'>): string => row.started_by ?? row.user_id;

/** v33 SHARE-5: whether someone the profile is shared with started this Prepare (not its owner). */
export const isGranteeRow = (row: Pick<PrepareRow, 'user_id' | 'started_by'>): boolean => startedByOf(row) !== row.user_id;

/** An application_drafts row: the kit. */
export interface DraftRow {
  id: string;
  user_id: string;
  application_id: string;
  resume_status: PreparePartStatus;
  letter_status: PreparePartStatus;
  answers_status: PreparePartStatus;
  resume_id: string | null;
  cover_letter_id: string | null;
  built_by: PrepareMode;
  prepare_id: string | null;
  questions_seen: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  built_at: string | null;
}

export interface DraftAnswerRow {
  id: number;
  draft_id: string;
  question_id: number;
  answer: string | null;
  status: 'ready' | 'not_ready';
  provenance: AutofillDraftProvenance;
  created_at: string;
  updated_at: string;
}

/** The SQL list of the active states (idx_prepare_jobs_active, idx_prepare_jobs_runner). */
export const ACTIVE_STATES_SQL = "('waiting','filtering','analyzing','building')";
/** The active states a Prepare is in once it was taken up (the runner's steps, or an MCP save). */
const UNDER_WAY: ReadonlySet<PrepareJobState> = new Set(['filtering', 'analyzing', 'building']);
const MAX_ERROR = 2000;

// ----------------------------------------------------------------------------------------------------- prepare_jobs

export async function prepareById(db: DbQueries, id: string): Promise<PrepareRow | null> {
  return (await db.one<PrepareRow>('SELECT * FROM prepare_jobs WHERE id = ?', [id])) ?? null;
}

/** The account's Prepare, or null (another account's reads as none). */
export async function getPrepare(db: DbQueries, userId: string, id: string): Promise<PrepareRow | null> {
  return (await db.one<PrepareRow>('SELECT * FROM prepare_jobs WHERE id = ? AND user_id = ?', [id, userId])) ?? null;
}

/** The application's active Prepare (at most one, idx_prepare_jobs_active), or null. */
export async function activePrepareOf(db: DbQueries, applicationId: string): Promise<PrepareRow | null> {
  return (await db.one<PrepareRow>(`SELECT * FROM prepare_jobs WHERE application_id = ? AND state IN ${ACTIVE_STATES_SQL}`, [applicationId])) ?? null;
}

/**
 * The newest Prepare of the application that chose `resumeId` (how that resume came to be the kit's), or null. The
 * insertion-order tiebreak is SQLite's rowid, the baseline's prepare_jobs.seq (dialect.seq; v30 PG-0).
 */
export async function prepareThatChose(db: DbQueries, applicationId: string, resumeId: string): Promise<PrepareRow | null> {
  return (
    (await db.one<PrepareRow>(
      `SELECT * FROM prepare_jobs WHERE application_id = ? AND resume_id = ?
          ORDER BY created_at DESC, ${db.dialect.seq()} DESC LIMIT 1`,
      [applicationId, resumeId],
    )) ?? null
  );
}

/** Of `applicationIds`, those with an active Prepare. */
export async function withActivePrepare(db: DbQueries, applicationIds: readonly string[]): Promise<Set<string>> {
  if (applicationIds.length === 0) return new Set();
  const rows = await db.all<{ application_id: string }>(
    `SELECT application_id FROM prepare_jobs WHERE state IN ${ACTIVE_STATES_SQL}
         AND application_id IN (${db.dialect.list(applicationIds.length)})`,
    applicationIds,
  );
  return new Set(rows.map((row) => row.application_id));
}

/**
 * Inserts a Prepare. False when idx_prepare_jobs_active refuses it: the application has an active Prepare already (a
 * concurrent request made it between its check and this insert), so the caller answers `active`. v3.0 D2-F (11 §9.3,
 * the concurrency audit): `ON CONFLICT DO NOTHING ... RETURNING id`, so the guard is the unique index on both engines
 * (no engine's error code read), and a refused row writes nothing.
 */
export async function insertPrepare(db: DbQueries, row: PrepareRow): Promise<boolean> {
  const inserted = await db.one<{ id: string }>(
    db.dialect.insertOrIgnore(
      `prepare_jobs(id, user_id, application_id, job_id, mode, letter_mode, letter_wanted, rebuild, state,
         reason_code, error, queue_id, cost_micros, resume_mode, resume_id, created_at, started_at, finished_at, updated_at,
         started_by, grant_id)
       VALUES (@id, @user_id, @application_id, @job_id, @mode, @letter_mode, @letter_wanted, @rebuild, @state,
         @reason_code, @error, @queue_id, @cost_micros, @resume_mode, @resume_id, @created_at, @started_at, @finished_at,
         @updated_at, @started_by, @grant_id)`,
    ) + ' RETURNING id',
    // v33 SHARE-5: the payer columns written out (an own Prepare names its owner and no grant).
    { ...row, started_by: startedByOf(row), grant_id: row.grant_id ?? null },
  );
  return inserted !== undefined;
}

export type PrepareChanges = Partial<
  Pick<
    PrepareRow,
    | 'letter_wanted'
    | 'state'
    | 'reason_code'
    | 'error'
    | 'queue_id'
    | 'resume_id'
    | 'started_at'
    | 'finished_at'
    | 'payer_error' // v33 SHARE-5
  >
>;

export async function updatePrepare(db: DbQueries, id: string, changes: PrepareChanges, now: string): Promise<void> {
  const columns = { ...changes };
  if (typeof columns.error === 'string') columns.error = columns.error.slice(0, MAX_ERROR);
  const keys = Object.keys(columns) as Array<keyof PrepareChanges>;
  if (typeof columns.payer_error === 'string') columns.payer_error = columns.payer_error.slice(0, MAX_ERROR); // v33 SHARE-5
  const sets = [...keys.map((key) => `${key} = @${key}`), 'updated_at = @now'];
  await db.run(`UPDATE prepare_jobs SET ${sets.join(', ')} WHERE id = @id`, { ...columns, id, now });
}

/**
 * The server runner's candidates, oldest first (idx_prepare_jobs_runner): every active `server` row with its account.
 * Rows under way come first, so after a restart an account's half-done Prepare is taken up before its next.
 */
export async function serverActiveRows(db: DbQueries): Promise<PrepareRow[]> {
  return db.all<PrepareRow>(
    `SELECT * FROM prepare_jobs WHERE mode = 'server' AND state IN ${ACTIVE_STATES_SQL}
        ORDER BY CASE WHEN state = 'waiting' THEN 1 ELSE 0 END, created_at, ${db.dialect.seq()}`,
  );
}

/** The account's waiting `server` rows, oldest first (the Custom filter batches them). */
export async function waitingServerRows(db: DbQueries, userId: string): Promise<PrepareRow[]> {
  return db.all<PrepareRow>(
    `SELECT * FROM prepare_jobs WHERE user_id = ? AND mode = 'server' AND state = 'waiting' ORDER BY created_at, ${db.dialect.seq()}`,
    [userId],
  );
}

/**
 * FREE_/PAID_PREPARE_PER_HOUR's count: the `server` Prepares `startedBy` started since `since`, and the oldest. v33
 * SHARE-5: counted by who started them (started_by, idx_prepare_jobs_started_by), on every profile they work on (their
 * own and the ones shared with them): the person is paced once, never once per profile.
 */
export async function serverStartsSince(db: DbQueries, startedBy: string, since: string): Promise<{ n: number; first: string | null }> {
  return (
    (await db.one<{ n: number; first: string | null }>(
      `SELECT count(*) AS n, min(started_at) AS first FROM prepare_jobs
        WHERE started_by = ? AND mode = 'server' AND started_at IS NOT NULL AND started_at >= ?`,
      [startedBy, since],
    )) ?? { n: 0, first: null }
  );
}

/** Whether the row was taken up (under way). */
export const isUnderWay = (row: Pick<PrepareRow, 'state'>) => UNDER_WAY.has(row.state);

/**
 * The account's `mcp` Prepares waiting for an own AI (waiting or building), oldest first. v33 SHARE-5: those `startedBy`
 * started (the owner's own unless named): each person's AI finishes its own Prepares only.
 */
export async function mcpActiveRows(db: DbQueries, userId: string, startedBy: string = userId): Promise<PrepareRow[]> {
  return db.all<PrepareRow>(
    `SELECT * FROM prepare_jobs WHERE user_id = ? AND started_by = ? AND mode = 'mcp' AND state IN ${ACTIVE_STATES_SQL}
        ORDER BY created_at, ${db.dialect.seq()}`,
    [userId, startedBy],
  );
}

/**
 * v2.0 FIX-B (BEH-10): the active `mcp` Prepares in mode `similar` whose kit's resume is still being chosen (the choice
 * runs in memory right after prepare_start, so a restart may have cut it): the service's start() chooses them again.
 */
export async function mcpChoosingRows(db: DbQueries): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT p.id FROM prepare_jobs p
         JOIN application_drafts d ON d.application_id = p.application_id AND d.user_id = p.user_id AND d.prepare_id = p.id
        WHERE p.mode = 'mcp' AND p.resume_mode = 'similar' AND p.state IN ${ACTIVE_STATES_SQL}
          AND d.resume_status = 'building'
        ORDER BY p.created_at, ${db.dialect.seq('p')}`,
  );
  return rows.map((row) => row.id);
}

/** Every `mcp` Prepare still waiting that was made before `before` (the daily housekeeping cancels them). */
export async function staleMcpRows(db: DbQueries, before: string): Promise<PrepareRow[]> {
  return db.all<PrepareRow>(`SELECT * FROM prepare_jobs WHERE mode = 'mcp' AND state IN ${ACTIVE_STATES_SQL} AND created_at < ?`, [before]);
}

// v33 SHARE-5 (PLAN F9; SP v33 PLAN-sharing.md §6): the Prepares someone a profile is shared with started there.

/**
 * The `mcp` Prepares someone a profile is shared with started there (grant_id set) that their own AI never took up
 * (still `waiting`, no start time) and that were made before `before`: they expire after SHARING_MCP_STALE_HOURS.
 */
export async function staleGranteeMcpRows(db: DbQueries, before: string): Promise<PrepareRow[]> {
  return db.all<PrepareRow>(
    `SELECT * FROM prepare_jobs WHERE mode = 'mcp' AND grant_id IS NOT NULL AND state = 'waiting' AND started_at IS NULL
        AND created_at < ?`,
    [before],
  );
}

/** How many Prepares of the grant are not over yet (SHARING_WAITING_PER_GRANT's count; idx_prepare_jobs_grant). */
export async function activeGrantCount(db: DbQueries, grantId: string): Promise<number> {
  const row = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM prepare_jobs WHERE grant_id = ? AND state IN ${ACTIVE_STATES_SQL}`,
    [grantId],
  );
  return row?.n ?? 0;
}

/** The grant's Prepares that are not over (`mode` given: of that mode only), oldest first: ending the grant cancels them. */
export async function activeGrantRows(db: DbQueries, grantId: string, mode?: PrepareMode): Promise<PrepareRow[]> {
  return db.all<PrepareRow>(
    `SELECT * FROM prepare_jobs WHERE grant_id = ? AND state IN ${ACTIVE_STATES_SQL}${mode ? ' AND mode = ?' : ''}
        ORDER BY created_at, ${db.dialect.seq()}`,
    mode ? [grantId, mode] : [grantId],
  );
}

/**
 * Of the owner's `applicationIds`, the active Prepares someone the profile is shared with started that nothing took up
 * yet (still `waiting`, no start time): the owner's own start cancels them (`owner_started`).
 */
export async function waitingGranteePrepares(db: DbQueries, userId: string, applicationIds: readonly string[]): Promise<PrepareRow[]> {
  if (applicationIds.length === 0) return [];
  return db.all<PrepareRow>(
    `SELECT * FROM prepare_jobs WHERE user_id = ? AND state = 'waiting' AND started_at IS NULL AND started_by <> user_id
        AND application_id IN (${db.dialect.list(applicationIds.length)})`,
    [userId, ...applicationIds],
  );
}

/**
 * Ends a Prepare `cancelled` with `reason` only while it is still waiting and nothing took it up (the runner may take it
 * at the same moment); answers the row as it was before, or null when something took it first. Run it in a transaction.
 */
export async function cancelIfWaiting(db: DbQueries, id: string, reason: string | null, now: string): Promise<PrepareRow | null> {
  return (
    (await db.one<PrepareRow>(
      `UPDATE prepare_jobs SET state = 'cancelled', reason_code = @reason, finished_at = @now, updated_at = @now
        WHERE id = @id AND state = 'waiting' AND started_at IS NULL RETURNING *`,
      { id, reason, now },
    )) ?? null
  );
}
// end v33 SHARE-5

// ----------------------------------------------------------------------------------------------------------- drafts

export async function draftOf(db: DbQueries, userId: string, applicationId: string): Promise<DraftRow | null> {
  return (await db.one<DraftRow>('SELECT * FROM application_drafts WHERE application_id = ? AND user_id = ?', [applicationId, userId])) ?? null;
}

export async function draftById(db: DbQueries, id: string): Promise<DraftRow | null> {
  return (await db.one<DraftRow>('SELECT * FROM application_drafts WHERE id = ?', [id])) ?? null;
}

/** The account's drafts of `applicationIds`, by application. */
export async function draftsOf(db: DbQueries, userId: string, applicationIds: readonly string[]): Promise<Map<string, DraftRow>> {
  if (applicationIds.length === 0) return new Map();
  const rows = await db.all<DraftRow>(
    `SELECT * FROM application_drafts WHERE user_id = ?
         AND application_id IN (${db.dialect.list(applicationIds.length)})`,
    [userId, ...applicationIds],
  );
  return new Map(rows.map((row) => [row.application_id, row]));
}

export async function insertDraft(db: DbQueries, row: DraftRow): Promise<void> {
  await db.run(
    `INSERT INTO application_drafts(id, user_id, application_id, resume_status, letter_status, answers_status, resume_id,
       cover_letter_id, built_by, prepare_id, questions_seen, error, created_at, updated_at, built_at)
     VALUES (@id, @user_id, @application_id, @resume_status, @letter_status, @answers_status, @resume_id,
       @cover_letter_id, @built_by, @prepare_id, @questions_seen, @error, @created_at, @updated_at, @built_at)`,
    { ...row },
  );
}

export type DraftChanges = Partial<
  Pick<
    DraftRow,
    | 'resume_status'
    | 'letter_status'
    | 'answers_status'
    | 'resume_id'
    | 'cover_letter_id'
    | 'built_by'
    | 'prepare_id'
    | 'questions_seen'
    | 'error'
    | 'built_at'
  >
>;

export async function updateDraft(db: DbQueries, id: string, changes: DraftChanges, now: string): Promise<void> {
  const columns = { ...changes };
  if (typeof columns.error === 'string') columns.error = columns.error.slice(0, MAX_ERROR);
  const keys = Object.keys(columns) as Array<keyof DraftChanges>;
  const sets = [...keys.map((key) => `${key} = @${key}`), 'updated_at = @now'];
  await db.run(`UPDATE application_drafts SET ${sets.join(', ')} WHERE id = @id`, { ...columns, id, now });
}

export async function answerRows(db: DbQueries, draftId: string): Promise<DraftAnswerRow[]> {
  return db.all<DraftAnswerRow>('SELECT * FROM application_draft_answers WHERE draft_id = ? ORDER BY question_id', [draftId]);
}

/** One draft answer to keep: its answer (null: not ready). */
export interface DraftAnswerInput {
  questionId: number;
  answer: AutofillSubmittedAnswerValue | null;
}

/**
 * Writes the draft's answers: each one given replaces the row of its question (ready with an answer, else not ready);
 * `replace` first deletes every other row of the draft (a whole new set: the server's Prepare). Run it inside the
 * caller's transaction.
 */
export async function writeAnswers(
  db: DbQueries,
  draftId: string,
  answers: readonly DraftAnswerInput[],
  provenance: AutofillDraftProvenance,
  now: string,
  options: { replace: boolean },
): Promise<void> {
  if (options.replace) await db.run('DELETE FROM application_draft_answers WHERE draft_id = ?', [draftId]);
  for (const item of answers) {
    const answer = item.answer === null ? null : JSON.stringify(item.answer);
    await db.run(
      `INSERT INTO application_draft_answers(draft_id, question_id, answer, status, provenance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id, question_id) DO UPDATE SET answer = excluded.answer, status = excluded.status,
         provenance = excluded.provenance, updated_at = excluded.updated_at`,
      [draftId, item.questionId, answer, answer === null ? 'not_ready' : 'ready', provenance, now, now],
    );
  }
}

// ------------------------------------------------------------------------------------- user_settings (Prepare's part)

/** Prepare's columns of the person's user_settings row (0824, 0827), or null with no row yet. */
export async function prepareUserSettings(
  db: DbQueries,
  userId: string,
): Promise<{ skip_prepare_confirm: boolean; prepare_resume_mode: PrepareResumeMode } | null> {
  return (
    (await db.one<{ skip_prepare_confirm: boolean; prepare_resume_mode: PrepareResumeMode }>(
      'SELECT skip_prepare_confirm, prepare_resume_mode FROM user_settings WHERE user_id = ?',
      [userId],
    )) ?? null
  );
}

/**
 * Writes Prepare's columns of the person's user_settings, the others (the prepare filters, features/prepare-filters)
 * untouched. A row made here holds `newRowMode` as its resume mode unless `resumeMode` is given: the constant
 * PREPARE_RESUME_MODE_DEFAULT's value, which the column's own DEFAULT ('tailor') would not follow.
 */
export async function writePrepareUserSettings(
  db: DbQueries,
  userId: string,
  changes: { skipConfirm?: boolean; resumeMode?: PrepareResumeMode },
  newRowMode: PrepareResumeMode,
  now: string,
): Promise<void> {
  await db.run(
    `INSERT INTO user_settings(user_id, skip_prepare_confirm, prepare_resume_mode, updated_at)
     VALUES (@userId, coalesce(@skip, ${db.dialect.false}), coalesce(@mode, @newRowMode), @now)
     ON CONFLICT(user_id) DO UPDATE SET
       skip_prepare_confirm = coalesce(@skip, user_settings.skip_prepare_confirm),
       prepare_resume_mode = coalesce(@mode, user_settings.prepare_resume_mode),
       updated_at = @now`,
    {
      userId,
      skip: changes.skipConfirm ?? null,
      mode: changes.resumeMode ?? null,
      newRowMode,
      now,
    },
  );
}
