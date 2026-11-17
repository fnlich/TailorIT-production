import { STATUS, DAY_MS } from '@tailorit/shared';
import {
  AUTOFILL_AGENT_DEFAULT_MIN_MATCH,
  AUTOFILL_AGENT_FINISHED_STATES,
  AUTOFILL_AGENT_QUEUE_PAGE_DEFAULT,
  AUTOFILL_AGENT_RUN_TIMEOUT_MS,
  AUTOFILL_AGENT_STATES,
  agentApplicationUrl,
  queueApplicationUrl,
  queueCanOpen,
  type AutofillAgentNext,
  type AutofillAgentQueueItem,
  type AutofillAgentQueueList,
  type AutofillAgentOpened,
  type AutofillAgentQueueQuery,
  type AutofillAgentReason,
  type AutofillAgentResultBody,
  type AutofillAgentRun,
  type AutofillAgentRunKind,
  type AutofillAgentSettings,
  type AutofillAgentSource,
  type AutofillAgentState,
  type AutofillAgentTask,
} from '@tailorit/shared/autofill';
import { extensionTokenLive } from '../../../core/auth/extension-tokens';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import type { Dialect } from '../../../core/db/dialect';
import { notFound } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import {
  allowanceOf,
  dailyLimitOf,
  reserve,
  resultSettleReason,
  settleFinishedRows,
  settleReservation,
  settlementOfResult,
  type FinishedRow,
} from './reservations';

// The auto-apply queue's rows (autofill_agent_queue), the jobs the person took out of it (autofill_agent_dismissed)
// and the rule's settings (autofill_agent_settings), work package AF, autofill API version 3, Phase 5. Only this
// folder touches the three tables. Every write is one statement or one transaction, so a claim is atomic: two browsers
// asking at once take two different jobs, never one twice. A running row belongs to the browser (connection) that took
// it: that browser alone gets it again from GET /agent/next (an extension worker restarts at will), and alone reports
// how it went while that connection works (once it is revoked, expired or deleted, any of the account's browsers may:
// one that connected again during the run), but for a submission, which is never refused. States and reason codes
// only: nothing the form was filled with is ever stored here.
//
// v3.0 D2 (11-database.md §9.3): on the async client. The two claims (claimNext, openForTab) count the account's live
// reservations, then reserve one: each starts its transaction with lockPerson. The helpers others call inside their
// own transactions (releaseStaleRuns, leaveRunsOf, clearFinished, removeQueued) join them through deps.db.atomic.
// v3.0 PG-A: the insertion order that breaks a tie of times, and a row's place in the list (the Queue tab's cursor),
// is `dialect.seq()`: SQLite's rowid, the PostgreSQL baseline's `seq` identity column.

type Deps = Pick<AppDeps, 'db' | 'now'>;
/** v2.0: a claim reads the account's entitlements and the constants (the daily auto-apply allowance). */
type ClaimDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

interface QueueRow {
  id: string;
  job_id: number;
  state: AutofillAgentState;
  reason: AutofillAgentReason | null;
  source: AutofillAgentSource;
  attempts: number;
  ai_guesses: number | null;
  claimed_by: string | null;
  resume_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /**
   * v1.5 Q2: which run took the row (migration 0818): the background agent, or the Queue tab's sequential run. v2.0:
   * `manual`, a row Prepare & Queue inserted for the person to apply to by hand (never taken by a run).
   */
  run?: AutofillAgentRunKind | null;
  // v20 P3
  /** The Tracker entry and the Prepare that queued it (0823); null for a row queued before v2.0. */
  application_id?: string | null;
  prepare_id?: string | null;
  /** Whether Submit was pressed in its run (API 8's result), the reservation's give-back rule; null: not said. */
  submit_pressed?: number | boolean | null;
  // end v20 P3
}

/** The rule's stored settings, with where it stands. */
export interface StoredAgentSettings extends AutofillAgentSettings {
  /** When the rule was last turned on: its "new jobs" are those posted from then on. */
  enabledAt: string | null;
  /** The last job the rule weighed (by first_seen_at, then id); null before it weighed any since it last started. */
  cursor: { at: string; jobId: number } | null;
}

// v30 ST3: the queue's refusals are the MSG_QUEUE_JOB_* constants, and a tombstone's life QUEUE_TOMBSTONE_KEEP_DAYS.

/**
 * The source kinds whose jobs come from a file the person or an admin imported, or (autofill API version 5) from the
 * text a person saw on a page (POST /api/autofill/jobs/from-page), not from a board TailorIT reads: the rule never
 * weighs a job that only they list. The person may still queue such a job by hand when its link is a form the agent
 * fills (a LinkedIn job never is: the agent opens the employer's link, never LinkedIn).
 */
export const IMPORT_SOURCE_KINDS = ['csv', 'json', 'seed', 'page'] as const;

/** The account's rule: off, at AUTOFILL_AGENT_DEFAULT_MIN_MATCH, before it is first saved. */
export async function readAgentSettings(deps: Pick<AppDeps, 'db'>, userId: string): Promise<StoredAgentSettings> {
  const row = await deps.db.one<{
    rule_enabled: number | boolean;
    min_match: number;
    rule_enabled_at: string | null;
    rule_cursor_at: string | null;
    rule_cursor_job: number;
  }>(
    `SELECT rule_enabled, min_match, rule_enabled_at, rule_cursor_at, rule_cursor_job FROM autofill_agent_settings
     WHERE user_id = ?`,
    [userId],
  );
  if (!row) return { ruleEnabled: false, minMatch: AUTOFILL_AGENT_DEFAULT_MIN_MATCH, enabledAt: null, cursor: null };
  return {
    ruleEnabled: deps.db.dialect.isTrue(row.rule_enabled),
    minMatch: row.min_match,
    enabledAt: row.rule_enabled_at,
    cursor: row.rule_cursor_at === null ? null : { at: row.rule_cursor_at, jobId: row.rule_cursor_job },
  };
}

/**
 * PUT /agent/settings: turning the rule on starts its "new jobs" now; changing its threshold while it is on weighs the
 * jobs since then again (a lower one may take a job it passed over; never one the person took out of the queue).
 */
export async function saveAgentSettings(
  deps: Deps,
  userId: string,
  settings: AutofillAgentSettings,
): Promise<AutofillAgentSettings> {
  const now = nowIso(deps);
  return deps.db.tx(
    async (t) => {
      const before = await readAgentSettings(deps, userId);
      const turnedOn = settings.ruleEnabled && !before.ruleEnabled;
      const enabledAt = turnedOn ? now : before.enabledAt;
      const restart = turnedOn || (settings.ruleEnabled && settings.minMatch !== before.minMatch);
      const cursor = restart ? null : before.cursor;
      await t.run(
        `INSERT INTO autofill_agent_settings(user_id, rule_enabled, min_match, rule_enabled_at, rule_cursor_at,
           rule_cursor_job, updated_at)
         VALUES (@userId, @enabled, @minMatch, @enabledAt, @cursorAt, @cursorJob, @now)
         ON CONFLICT(user_id) DO UPDATE SET rule_enabled = excluded.rule_enabled, min_match = excluded.min_match,
           rule_enabled_at = excluded.rule_enabled_at, rule_cursor_at = excluded.rule_cursor_at,
           rule_cursor_job = excluded.rule_cursor_job, updated_at = excluded.updated_at`,
        {
          userId,
          enabled: t.dialect.bool(settings.ruleEnabled),
          minMatch: settings.minMatch,
          enabledAt,
          cursorAt: cursor?.at ?? null,
          cursorJob: cursor?.jobId ?? 0,
          now,
        },
      );
      return { ruleEnabled: settings.ruleEnabled, minMatch: settings.minMatch };
    },
    { label: 'saveAgentSettings' },
  );
}

/** releaseStaleRuns' statement: now, now, the account, the oldest start kept running. */
export const RELEASE_STALE_SQL = `UPDATE autofill_agent_queue SET state = 'needs-you', reason = 'timed_out', finished_at = ?, updated_at = ?
         WHERE user_id = ? AND state = 'running' AND started_at <= ? RETURNING id, submit_pressed`;

/** The start before which a run is stale. */
export const staleBefore = (deps: Pick<AppDeps, 'now'>): string =>
  new Date(deps.now().getTime() - AUTOFILL_AGENT_RUN_TIMEOUT_MS).toISOString();

/**
 * Runs not reported within AUTOFILL_AGENT_RUN_TIMEOUT_MS are left for the person: `needs-you`, `timed_out` (the form
 * may have been sent; they look, and queue it again if not). Never back to the queue by themselves, so a form is
 * never sent twice. Answers how many changed.
 */
export async function releaseStaleRuns(deps: Deps, userId: string): Promise<number> {
  const now = nowIso(deps);
  const before = staleBefore(deps);
  return deps.db.atomic(
    async (t) => {
      const rows = await t.all<FinishedRow>(RELEASE_STALE_SQL, [now, now, userId, before]);
      // v2.0: a timed-out run keeps its daily use (the form may have been sent), unless Submit is known unpressed.
      await settleFinishedRows(deps, rows, 'stale');
      return rows.length;
    },
    { label: 'releaseStaleRuns' },
  );
}

interface JobFacts {
  title: string;
  company: string;
  apply_url: string;
  active: number | boolean;
}

async function jobFacts(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<JobFacts | undefined> {
  return deps.db.one<JobFacts>(
    `SELECT j.title, c.name AS company, j.apply_url, j.active FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.id = ?`,
    [jobId],
  );
}

/** Whether a job's facts say it is open. */
const isOpen = (d: Dialect, job: JobFacts | undefined): job is JobFacts => job !== undefined && d.isTrue(job.active);

/** The account's tracker entry for the job: its status and resume, if any. */
async function entryOf(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number) {
  return deps.db.one<{ current_status: number; resume_id: string | null }>(
    'SELECT current_status, resume_id FROM applications WHERE user_id = ? AND job_id = ?',
    [userId, jobId],
  );
}

function taskOf(row: Pick<QueueRow, 'id' | 'job_id' | 'resume_id'>, job: JobFacts, url: string): AutofillAgentTask {
  return { id: row.id, jobId: row.job_id, url, company: job.company, title: job.title, resumeId: row.resume_id };
}

/** The statement that finishes a row (state, reason, finished_at, updated_at, id). */
const FINISH_SQL = 'UPDATE autofill_agent_queue SET state = ?, reason = ?, finished_at = ?, updated_at = ? WHERE id = ?';

/** Finishes a row the agent can no longer apply to, as a claim finds it: its job closed, gone or no longer fillable. */
async function finishUnfillable(deps: Deps, id: string, state: AutofillAgentState, reason: AutofillAgentReason): Promise<void> {
  const now = nowIso(deps);
  await deps.db.run(FINISH_SQL, [state, reason, now, now, id]);
  // v2.0: a run that ends without its form sent gives its daily use back (a queued row holds none).
  await settleReservation(deps, id, 'released', reason);
}

/**
 * ownRun's work, inside the caller's transaction: every running row of this browser, oldest first; one whose job is
 * gone or closed is `failed` (`posting_closed`), one whose posting the agent no longer fills `failed`
 * (`unsupported_site`), as a claim finishes them; the first left is the answer.
 */
async function ownRunIn(deps: Deps, userId: string, tokenId: string): Promise<AutofillAgentTask | null> {
  const rows = await deps.db.all<Pick<QueueRow, 'id' | 'job_id' | 'resume_id'>>(
    `SELECT id, job_id, resume_id FROM autofill_agent_queue
     WHERE user_id = ? AND state = 'running' AND claimed_by = ? AND run IS DISTINCT FROM 'tab'
     ORDER BY started_at, ${deps.db.dialect.seq()}`,
    [userId, tokenId],
  );
  for (const row of rows) {
    const job = await jobFacts(deps, row.job_id);
    const url = job ? agentApplicationUrl(job.apply_url) : null;
    if (!isOpen(deps.db.dialect, job)) await finishUnfillable(deps, row.id, 'failed', 'posting_closed');
    else if (!url) await finishUnfillable(deps, row.id, 'failed', 'unsupported_site');
    else return taskOf(row, job, url);
  }
  return null;
}

/**
 * The browser's own running job, handed to it again (a worker that restarted asks anew), or null. The run keeps its
 * start and its attempts. A run the agent can no longer apply to (its job closed, gone, or its posting no longer one
 * the agent fills) is finished as a claim would finish it, so it never stays running beside the browser's next job and
 * the person may remove it (audit A5).
 */
export async function ownRun(deps: Deps, userId: string, tokenId: string): Promise<AutofillAgentTask | null> {
  return deps.db.tx(() => ownRunIn(deps, userId, tokenId), { label: 'ownRun' });
}

/**
 * Takes the account's oldest queued job for this browser (it is `running` from now, its attempts counted, the resume
 * of the tracker entry the one to attach), or null when none is queued. Each is checked again as it is taken: one the
 * tracker has past Saved by now is `skipped` (`already_applied`), one closed since is `failed` (`posting_closed`), one
 * whose posting the agent no longer fills is `failed` (`unsupported_site`), and the next is taken. A browser that has a
 * run already gets that run instead, so it never holds two (audit A5). jr7 7a: a queued job whose posting only the
 * Queue tab opens (queueCanOpen, not agentApplicationUrl) is the Queue tab's: it is left queued, untouched (the Queue
 * tab checks it as it takes it), and the next is looked at; `unsupported_site` is a job neither run opens.
 */
export async function claimQueued(deps: ClaimDeps, userId: string, tokenId: string): Promise<AutofillAgentTask | null> {
  return (await claimNext(deps, userId, tokenId)).item;
}

/**
 * v2.0 (API 8): GET /agent/next's claim with the daily auto-apply allowance (04-accounts-limits.md §1), in one
 * transaction: the browser's own run again (no new use), else, when the account's live reservations in the window are
 * under its limit, the oldest queued row the agent opens (claimQueued's checks), now running, with one use reserved;
 * at the limit nothing is taken and the rows stay queued. A `manual` row (Prepare & Queue's unsupported job) is never
 * taken. The task's resume is the queued kit's (the row's resume, frozen when Prepare & Queue queued it); a row queued
 * before v2.0 takes the Tracker entry's, as before. `dailyLimit`: the counts after the claim. v3.0 D2 (11 §9.3): it
 * counts, then reserves, so the transaction starts with the person's lock.
 */
export async function claimNext(deps: ClaimDeps, userId: string, tokenId: string): Promise<AutofillAgentNext> {
  return deps.db.tx(
    async (t): Promise<AutofillAgentNext> => {
      await t.lockPerson(userId);
      const own = await ownRunIn(deps, userId, tokenId);
      const allowance = await allowanceOf(deps, userId);
      if (own) return { item: own, dailyLimit: dailyLimitOf(deps, allowance, allowance.used) };
      if (allowance.reached) return { item: null, dailyLimit: dailyLimitOf(deps, allowance, allowance.used) };
      const rows = await t.all<Pick<QueueRow, 'id' | 'job_id' | 'resume_id' | 'prepare_id'>>(
        `SELECT id, job_id, resume_id, prepare_id FROM autofill_agent_queue
         WHERE user_id = ? AND state = 'queued' AND run IS DISTINCT FROM 'manual'
         ORDER BY created_at, ${t.dialect.seq()}`,
        [userId],
      );
      for (const row of rows) {
        const now = nowIso(deps);
        const finish = (state: AutofillAgentState, reason: AutofillAgentReason) =>
          t.run(FINISH_SQL, [state, reason, now, now, row.id]);
        const job = await jobFacts(deps, row.job_id);
        const url = job ? agentApplicationUrl(job.apply_url) : null;
        // jr7 7a: the Queue tab's alone, left as it is.
        if (job && url === null && queueCanOpen(job.apply_url)) continue;
        const entry = await entryOf(deps, userId, row.job_id);
        if (entry && entry.current_status !== STATUS.saved) await finish('skipped', 'already_applied');
        else if (!isOpen(t.dialect, job)) await finish('failed', 'posting_closed');
        else if (!url) await finish('failed', 'unsupported_site');
        else {
          const resumeId = kitResumeOf(row, entry);
          await t.run(
            `UPDATE autofill_agent_queue SET state = 'running', attempts = attempts + 1, started_at = ?, claimed_by = ?,
               resume_id = ?, updated_at = ?, run = 'agent'
             WHERE id = ? AND state = 'queued' AND run IS DISTINCT FROM 'manual'`,
            [now, tokenId, resumeId, now, row.id],
          );
          await reserve(deps, { userId, queueId: row.id, jobId: row.job_id, run: 'agent', tokenId, dayKey: allowance.window.dayKey });
          return {
            item: taskOf({ ...row, resume_id: resumeId }, job, url),
            dailyLimit: dailyLimitOf(deps, allowance, allowance.used + 1),
          };
        }
      }
      return { item: null, dailyLimit: dailyLimitOf(deps, allowance, allowance.used) };
    },
    { label: 'claimNext' },
  );
}

/**
 * The resume a run attaches: the queued kit's (the row's resume, frozen when Prepare & Queue queued it, A30) for a row
 * a Prepare queued, unless it was deleted since; else the Tracker entry's, as before v2.0.
 */
function kitResumeOf(
  row: Pick<QueueRow, 'resume_id' | 'prepare_id'>,
  entry: { resume_id: string | null } | undefined,
): string | null {
  return (row.prepare_id ? row.resume_id : null) ?? entry?.resume_id ?? null;
}

/** A job the rule may weigh: open, first seen since the rule's cursor, and neither tracked, queued, let go nor hidden. */
export interface RuleCandidate {
  id: number;
  first_seen_at: string;
  apply_url: string;
}

/**
 * The next `limit` jobs the rule may weigh, in the order TailorIT first saw them: open, new (posted, else updated, else
 * first seen since the rule was turned on), on a board TailorIT reads (a link of a source other than an import), and
 * not tracked, queued, taken out of the queue by the person, hidden or of a hidden company.
 */
export async function ruleCandidates(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  settings: { enabledAt: string; from: { at: string; jobId: number } },
  limit: number,
): Promise<RuleCandidate[]> {
  return deps.db.all<RuleCandidate>(
    `SELECT j.id, j.first_seen_at, j.apply_url FROM jobs j
     WHERE j.active = ${deps.db.dialect.true} AND (j.first_seen_at > @at OR (j.first_seen_at = @at AND j.id > @jobId))
       AND coalesce(j.posted_at, j.source_updated_at, j.first_seen_at) >= @enabledAt
       AND EXISTS (SELECT 1 FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
                   WHERE l.job_id = j.id AND s.kind NOT IN (${IMPORT_SOURCE_KINDS.map((kind) => `'${kind}'`).join(', ')}))
       AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = @userId AND a.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM autofill_agent_queue q WHERE q.user_id = @userId AND q.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM autofill_agent_dismissed d WHERE d.user_id = @userId AND d.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM user_job_state s WHERE s.user_id = @userId AND s.job_id = j.id
                       AND s.hidden_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM user_hidden_companies h WHERE h.user_id = @userId AND h.company_id = j.company_id)
     ORDER BY j.first_seen_at, j.id LIMIT @limit`,
    { userId, at: settings.from.at, jobId: settings.from.jobId, enabledAt: settings.enabledAt, limit },
  );
}

/** Moves the rule's cursor on to `job` (never back). */
export async function advanceRuleCursor(
  deps: Deps,
  userId: string,
  job: Pick<RuleCandidate, 'id' | 'first_seen_at'>,
): Promise<void> {
  await deps.db.run(
    `UPDATE autofill_agent_settings SET rule_cursor_at = ?, rule_cursor_job = ?
     WHERE user_id = ? AND (rule_cursor_at IS NULL OR rule_cursor_at < ? OR (rule_cursor_at = ? AND rule_cursor_job < ?))`,
    [job.first_seen_at, job.id, userId, job.first_seen_at, job.first_seen_at, job.id],
  );
}

/** One of the account's rows, or 404. */
export async function queueRow(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<QueueRow> {
  const row = await deps.db.one<QueueRow>(
    `SELECT id, job_id, state, reason, source, attempts, ai_guesses, claimed_by, resume_id, created_at, started_at,
       finished_at, run, application_id, prepare_id, submit_pressed
     FROM autofill_agent_queue WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  if (!row) throw notFound('That auto-apply job');
  return row;
}

/**
 * What a result does to a row: 'finish' it, leave it 'unchanged' (the same result again, a retried request), or
 * refuse it (409). A submission is taken whatever the row's state, from any of the account's browsers, unless the row
 * is submitted already: a form that was sent is never lost. Any other result needs the row running, and reported by
 * the browser that took it, or by any of the account's once that connection no longer works (revoked, expired, or
 * deleted and so null): a browser that connected again during the run reports it with its new token.
 */
export async function resultEffect(
  deps: ClaimDeps,
  row: QueueRow,
  body: AutofillAgentResultBody,
  tokenId: string,
): Promise<'finish' | 'unchanged'> {
  if (body.state === 'submitted') return row.state === 'submitted' ? 'unchanged' : 'finish';
  if (row.state === 'running') {
    const claimant = row.claimed_by;
    if (claimant !== null && claimant !== tokenId && (await extensionTokenLive(deps, claimant))) {
      throw refuse(deps, 'conflict', 'MSG_QUEUE_JOB_NOT_YOURS');
    }
    return 'finish';
  }
  if (row.state === body.state && row.reason === body.reason) return 'unchanged';
  throw refuse(deps, 'conflict', 'MSG_QUEUE_JOB_NOT_RUNNING');
}

/** leaveRunsOf's statement: now, now, the account, the browser's token. */
export const LEAVE_RUNS_SQL = `UPDATE autofill_agent_queue SET state = 'needs-you', reason = 'cancelled', finished_at = ?, updated_at = ?
         WHERE user_id = ? AND state = 'running' AND claimed_by = ? RETURNING id, submit_pressed`;

/**
 * The person disconnected this browser from Settings (DELETE /tokens/:id): its running rows are left for them,
 * `needs-you` (`cancelled`: the person stopped the run; the form may have been sent, so never queued again by itself),
 * so no run stays stuck behind a browser that can no longer report it and the person may remove it at once (audit A6).
 * A submission the browser reports later, connected again, is still taken. Answers how many changed. Runs in the
 * caller's transaction (the token's revoke) when there is one.
 */
export async function leaveRunsOf(deps: Deps, userId: string, tokenId: string): Promise<number> {
  const now = nowIso(deps);
  return deps.db.atomic(
    async (t) => {
      const rows = await t.all<FinishedRow>(LEAVE_RUNS_SQL, [now, now, userId, tokenId]);
      // v2.0: the daily use is given back, unless Submit was pressed in the run.
      await settleFinishedRows(deps, rows, 'disconnected');
      return rows.length;
    },
    { label: 'leaveRunsOf' },
  );
}

/**
 * POST /agent/:id/result: finishes the row as the agent reports it (resultEffect decided it may). v2.0: keeps whether
 * Submit was pressed (API 8's `submitPressed`) and settles the run's daily use in the same transaction (reservations.ts:
 * a sent form, or Submit pressed without the confirmation seen, keeps it; anything else gives it back).
 */
export async function finishRun(deps: Deps, userId: string, id: string, body: AutofillAgentResultBody): Promise<void> {
  const now = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      await t.run(
        `UPDATE autofill_agent_queue SET state = ?, reason = ?, ai_guesses = ?, finished_at = ?, updated_at = ?,
           submit_pressed = coalesce(?, submit_pressed)
         WHERE id = ? AND user_id = ?`,
        [
          body.state,
          body.reason,
          body.aiGuesses ?? null,
          now,
          now,
          body.submitPressed === undefined ? null : t.dialect.bool(body.submitPressed),
          id,
          userId,
        ],
      );
      await settleReservation(deps, id, settlementOfResult(body), resultSettleReason(body));
    },
    { label: 'finishRun' },
  );
}

/** GET /agent/queue: running first, then queued (oldest first, as the agent takes them), then finished (latest first). */
/**
 * v2.0: who reads the list. A token (the extension's Queue tab) never sees a `manual` row (no run takes one, A14) and
 * gets the account's auto-apply usage (`autoApply`, API 8); the Auto-apply page sees every row.
 */
export interface QueueReadOptions {
  omitManual?: boolean;
  autoApply?: { used: number; limit: number | null; resetsAt: string };
}

/** v2.0 FIX-B (REQ-9): the list's `limit`, the resolved QUEUE_SIZE_MAX (an admin's value), not the contract's cap. */
type ListDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

export async function listQueue(deps: ListDeps, userId: string, options: QueueReadOptions = {}): Promise<AutofillAgentQueueList> {
  const items = (await orderedQueue(deps, userId, options)).map(({ item }) => item);
  return {
    items,
    total: items.length,
    limit: constantsOf(deps).get('QUEUE_SIZE_MAX'),
    ...(options.autoApply ? { autoApply: options.autoApply } : {}),
  };
}

/** One row of the list with where it sorts (v1.5 Q2: a page's cursor names the last row's place). */
export interface PlacedItem {
  item: AutofillAgentQueueItem;
  rank: number;
  key: string;
  position: number;
  /** v2.0: what the Auto-apply page's Queue pane reads besides (features/auto-apply). */
  extra: {
    applicationId: string | null;
    prepareId: string | null;
    resumeId: string | null;
    resumeMode: 'default' | 'similar' | 'tailor' | null;
    logoPath: string | null;
    applyUrl: string;
  };
}

/** A row of orderedQueue's statement. */
export type OrderedRow = QueueRow & {
  position: number;
  resume_mode: 'default' | 'similar' | 'tailor' | null;
  title: string;
  company: string;
  logo_path: string | null;
  primary_location: string;
  locations_text: string;
  apply_url: string;
  active: number | boolean;
};

/**
 * orderedQueue's statement, with the account's id bound. A row's place (`position`: the tie-break of the list's order
 * and part of the Queue tab's page cursor) is its insertion order, `d.seq('q')`: it never changes while the row lives.
 */
export function orderedQueueSql(d: Dialect, options: Pick<QueueReadOptions, 'omitManual'>): string {
  return orderedRowsSql(d, `q.user_id = ?${options.omitManual ? " AND q.run IS DISTINCT FROM 'manual'" : ''}`);
}

/** The list's rows (OrderedRow) of the queue rows `where` names (over `q`). */
function orderedRowsSql(d: Dialect, where: string): string {
  return `SELECT ${d.seq('q')} AS position, q.id, q.job_id, q.state, q.reason, q.source, q.attempts, q.ai_guesses, q.created_at,
         q.started_at, q.finished_at, q.run, q.application_id, q.prepare_id, q.resume_id, p.resume_mode,
         j.title, c.name AS company, (SELECT cp.logo_path FROM company_profiles cp WHERE cp.company_id = c.id) AS logo_path, j.primary_location, j.locations_text, j.apply_url, j.active
       FROM autofill_agent_queue q JOIN jobs j ON j.id = q.job_id JOIN companies c ON c.id = j.company_id
         LEFT JOIN prepare_jobs p ON p.id = q.prepare_id
       WHERE ${where}`;
}

/** orderedQueue's rows in the list's order, each with its place. */
export function placedRows(d: Dialect, rows: readonly OrderedRow[]): PlacedItem[] {
  const placed = rows.map((row) => ({ row, ...placeOf(row) }));
  placed.sort(comparePlaces);
  return placed.map(({ row, rank, key, position }) => ({
    rank,
    key,
    position,
    extra: {
      applicationId: row.application_id ?? null,
      prepareId: row.prepare_id ?? null,
      resumeId: row.resume_id,
      resumeMode: row.resume_mode ?? null,
      logoPath: row.logo_path,
      applyUrl: row.apply_url,
    },
    item: {
      id: row.id,
      jobId: row.job_id,
      title: row.title,
      company: row.company,
      location: row.primary_location || row.locations_text,
      url: row.apply_url,
      active: d.isTrue(row.active),
      state: row.state,
      reason: row.reason,
      source: row.source,
      attempts: row.attempts,
      aiGuesses: row.ai_guesses,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      // v1.5 Q2; jr7 7a: the Queue tab's address (the agent's on the agent's platforms), and the runs that take it.
      applyUrl: queueApplicationUrl(row.apply_url),
      run: row.run ?? null,
      runs: runsOf(row.apply_url),
    },
  }));
}

/**
 * The account's rows in the list's order (at most QUEUE_SIZE_MAX), each with its place.
 */
export async function orderedQueue(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  options: Pick<QueueReadOptions, 'omitManual'> = {},
): Promise<PlacedItem[]> {
  return placedRows(deps.db.dialect, await deps.db.all<OrderedRow>(orderedQueueSql(deps.db.dialect, options), [userId]));
}

/** jr7 7a: the runs that can take a job at `url` (AutofillAgentQueueItem.runs), in AUTOFILL_AGENT_RUNS' order. */
function runsOf(url: string): AutofillAgentRun[] {
  const runs: AutofillAgentRun[] = [];
  if (agentApplicationUrl(url) !== null) runs.push('agent');
  if (queueCanOpen(url)) runs.push('tab');
  return runs;
}

// v1.5 Q2: the list's order as a place (rank, key, position), so a page's cursor resumes right after its last row.
const rankOf = (state: AutofillAgentState) => (state === 'running' ? 0 : state === 'queued' ? 1 : 2);

function placeOf(row: Pick<QueueRow, 'state' | 'created_at' | 'finished_at'> & { position: number }) {
  const rank = rankOf(row.state);
  return { rank, key: rank === 2 ? (row.finished_at ?? '') : row.created_at, position: row.position };
}

type Place = Pick<PlacedItem, 'rank' | 'key' | 'position'>;

/** Running, then queued (oldest first), then finished (latest first); rows that tie by time in insertion order. */
function comparePlaces(a: Place, b: Place): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank === 2) return b.key.localeCompare(a.key) || b.position - a.position;
  return a.key.localeCompare(b.key) || a.position - b.position;
}

const CURSOR_VERSION = 1;

function encodePlace(states: string, place: Place): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, states, place.rank, place.key, place.position]), 'utf8').toString(
    'base64url',
  );
}

/** A cursor's place, or null when it is unreadable or was cut under another `state` (the list starts again). */
function decodePlace(cursor: string | undefined, states: string): Place | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(value) || value.length !== 5) return null;
    const [version, under, rank, key, position] = value as unknown[];
    if (version !== CURSOR_VERSION || under !== states) return null;
    if (typeof rank !== 'number' || ![0, 1, 2].includes(rank) || typeof key !== 'string' || key.length > 40) return null;
    if (typeof position !== 'number' || !Number.isSafeInteger(position)) return null;
    return { rank, key, position };
  } catch {
    return null;
  }
}

/**
 * GET /agent/queue with a query (the extension's Queue tab, v1.5 Q2): one page of the list in its order, of the rows in
 * `state` (one or several, comma-joined) when given. `total` counts every row the query names; `nextCursor` is set
 * while more follow.
 */
export async function pageQueue(
  deps: ListDeps,
  userId: string,
  query: AutofillAgentQueueQuery,
  options: QueueReadOptions = {},
): Promise<AutofillAgentQueueList> {
  const wanted = query.state ? new Set(query.state.split(',')) : null;
  const states = wanted ? AUTOFILL_AGENT_STATES.filter((state) => wanted.has(state)).join(',') : '';
  // v30 FIX-PERF (PGL-12): the page in SQL (orderedQueuePage), and the rows the query names counted.
  const scope = { states: wanted ? [...wanted] : null, omitManual: options.omitManual };
  const { page, nextCursor } = await orderedQueuePage(deps, userId, scope, query.cursor, query.limit ?? AUTOFILL_AGENT_QUEUE_PAGE_DEFAULT, states);
  return {
    items: page.map(({ item }) => item),
    total: await queueCount(deps, userId, scope),
    limit: constantsOf(deps).get('QUEUE_SIZE_MAX'),
    ...(nextCursor ? { nextCursor } : {}),
    ...(options.autoApply ? { autoApply: options.autoApply } : {}),
  };
}

/** One page of rows in the list's order after `cursor` (cut under `scope`), and the next page's cursor. */
export function pageOfPlaced(
  named: readonly PlacedItem[],
  cursor: string | undefined,
  limit: number,
  scope: string,
): { page: PlacedItem[]; nextCursor?: string } {
  const after = decodePlace(cursor, scope);
  const rest = after ? named.filter((placed) => comparePlaces(placed, after) > 0) : named;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { page, ...(rest.length > limit && last ? { nextCursor: encodePlace(scope, last) } : {}) };
}

// v30 FIX-PERF (PG-LOAD PGL-12): a page of the list in SQL. The Queue pane (and the extension's Queue tab) read every
// queue row of the person with its job, company and Prepare, then sorted and cut a page in the app: 5,000 rows for
// the heavy account at mix B's size (123 ms, 70,304 buffers). Now the rows' places are computed and ordered in SQL and
// only the page's rows (and one more) are joined. A place in SQL is placeOf's: the rank, the key as the app reads the
// time (isoFromPg's text: UTC, milliseconds cut, not rounded) compared byte by byte (COLLATE "C", which orders these
// fixed-shape texts as localeCompare does), the position; comparePlaces' order, and its keyset after a cursor.

/** A row's rank (placeOf's rankOf). */
const RANK_SQL = "CASE q.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END";
/** A time as the app's ISO text (core/db/pg/types.ts isoFromPg). */
const isoSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** A row's key (placeOf): its creation for running and queued rows, its finish ('' when none) for the others. */
const KEY_SQL = `CASE WHEN q.state IN ('running', 'queued') THEN ${isoSql('q.created_at')} ELSE COALESCE(${isoSql('q.finished_at')}, '') END`;
/** comparePlaces as an ORDER BY over `p` (rank, key, position). */
const PLACE_ORDER = `p.rank, CASE WHEN p.rank < 2 THEN p.key END COLLATE "C", CASE WHEN p.rank = 2 THEN p.key END COLLATE "C" DESC,
  CASE WHEN p.rank < 2 THEN p.position END, CASE WHEN p.rank = 2 THEN p.position END DESC`;
/** comparePlaces(p, after) > 0. */
const AFTER_PLACE = `(p.rank > @afterRank OR (p.rank = @afterRank AND (
    (p.rank < 2 AND (p.key COLLATE "C" > @afterKey OR (p.key = @afterKey AND p.position > @afterPosition)))
    OR (p.rank = 2 AND (p.key COLLATE "C" < @afterKey OR (p.key = @afterKey AND p.position < @afterPosition))))))`;

/** Which of the account's rows a page reads: some states only, no `manual` row (a token's read). */
interface PageScope {
  states?: readonly string[] | null;
  omitManual?: boolean;
}

/** The scope's conditions on `q` (bound: @userId, @states). */
function scopeSql(scope: PageScope): string {
  return [
    'q.user_id = @userId',
    ...(scope.omitManual ? ["q.run IS DISTINCT FROM 'manual'"] : []),
    ...(scope.states ? ["q.state = ANY(string_to_array(@states, ','))"] : []),
  ].join(' AND ');
}

/**
 * One page of the account's rows in the list's order, read in SQL: at most `limit` rows after `cursor` (cut under
 * `cursorScope`), and the next page's cursor while more follow. What pageOfPlaced(orderedQueue(...)) answers.
 */
export async function orderedQueuePage(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  scope: PageScope,
  cursor: string | undefined,
  limit: number,
  cursorScope: string,
): Promise<{ page: PlacedItem[]; nextCursor?: string }> {
  const after = decodePlace(cursor, cursorScope);
  const d = deps.db.dialect;
  const rows = await deps.db.all<OrderedRow>(
    `WITH p AS (
       SELECT q.id, ${d.seq('q')} AS position, ${RANK_SQL} AS rank, ${KEY_SQL} AS key
       FROM autofill_agent_queue q WHERE ${scopeSql(scope)}
     ), page AS (
       SELECT p.id FROM p ${after ? `WHERE ${AFTER_PLACE}` : ''} ORDER BY ${PLACE_ORDER} LIMIT @limit
     )
     ${orderedRowsSql(d, 'q.id IN (SELECT id FROM page)')}`,
    {
      userId,
      states: scope.states ? scope.states.join(',') : null,
      afterRank: after?.rank ?? 0,
      afterKey: after?.key ?? '',
      afterPosition: after?.position ?? 0,
      limit: limit + 1,
    },
  );
  const placed = placedRows(d, rows);
  const page = placed.slice(0, limit);
  const last = page[page.length - 1];
  return { page, ...(placed.length > limit && last ? { nextCursor: encodePlace(cursorScope, last) } : {}) };
}

/** How many of the account's rows the scope names (a page's `total`). */
export async function queueCount(deps: Pick<AppDeps, 'db'>, userId: string, scope: PageScope): Promise<number> {
  const row = await deps.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM autofill_agent_queue q WHERE ${scopeSql(scope)}`, {
    userId,
    states: scope.states ? scope.states.join(',') : null,
  });
  return row?.n ?? 0;
}

/**
 * POST /agent/:id/opened (v1.5 Q2): the Queue tab's sequential run takes this queued row for this browser before it
 * opens the job's tab, as claimQueued takes one for the agent (the same checks: tracked past Saved by now, closed, a
 * posting the agent no longer opens), but with `run` 'tab', so GET /agent/next never hands it to the background agent
 * (ownRunIn reads the agent's runs only, claimQueued queued rows only). This browser asking again for its own tab run
 * gets it again. 404 for another account's or a removed row; 409 when another run or browser holds it, or it is
 * finished. jr7 7a: the task's address is the Queue tab's (queueApplicationUrl: every platform of AUTOFILL_QUEUE_ATS),
 * and `unsupported_site` a posting the Queue tab no longer opens.
 *
 * v2.0 (API 8, 04-accounts-limits.md §1): a `manual` row is refused (409, MSG_MANUAL_ONLY: the person applies to it by
 * hand). Taking a queued row reserves one daily use in this transaction; with none left (the account's live
 * reservations in the window at its limit) nothing is taken: `item` null, the row stays `queued` (reason null), and
 * `dailyLimit.reached`. The browser's own tab run again reserves nothing; a finished row is 409 as before. The task's
 * resume is the queued kit's, as GET /agent/next's. v3.0 D2 (11 §9.3): it counts, then reserves, so the transaction
 * starts with the person's lock.
 */
export async function openForTab(deps: ClaimDeps, userId: string, tokenId: string, id: string): Promise<AutofillAgentOpened> {
  return deps.db.tx(
    async (t): Promise<AutofillAgentOpened> => {
      await t.lockPerson(userId);
      const row = await t.one<
        Pick<QueueRow, 'id' | 'job_id' | 'state' | 'claimed_by' | 'resume_id' | 'prepare_id'> & {
          run: AutofillAgentRunKind | null;
        }
      >(
        `SELECT id, job_id, state, run, claimed_by, resume_id, prepare_id FROM autofill_agent_queue
         WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      if (!row) throw notFound('That auto-apply job');
      if (row.run === 'manual') throw refuse(deps, 'conflict', 'MSG_MANUAL_ONLY');
      const now = nowIso(deps);
      const finish = async (state: AutofillAgentState, reason: AutofillAgentReason): Promise<AutofillAgentOpened> => {
        await t.run(FINISH_SQL, [state, reason, now, now, row.id]);
        // A running tab run that ends here gives its daily use back; a queued row has none.
        await settleReservation(deps, row.id, 'released', reason);
        const left = await allowanceOf(deps, userId);
        return { item: null, state, reason, dailyLimit: dailyLimitOf(deps, left, left.used) };
      };
      if (row.state === 'running') {
        if (row.run !== 'tab' || row.claimed_by !== tokenId) throw refuse(deps, 'conflict', 'MSG_QUEUE_JOB_TAKEN');
        const job = await jobFacts(deps, row.job_id);
        const url = job ? queueApplicationUrl(job.apply_url) : null;
        if (!isOpen(t.dialect, job)) return finish('failed', 'posting_closed');
        if (!url) return finish('failed', 'unsupported_site');
        const allowance = await allowanceOf(deps, userId);
        return {
          item: taskOf(row, job, url),
          state: 'running',
          reason: null,
          dailyLimit: dailyLimitOf(deps, allowance, allowance.used),
        };
      }
      if (row.state !== 'queued') throw refuse(deps, 'conflict', 'MSG_QUEUE_JOB_FINISHED');
      const allowance = await allowanceOf(deps, userId);
      // At the limit: nothing is taken, nothing finished; the row waits for the reset.
      if (allowance.reached) {
        return { item: null, state: 'queued', reason: null, dailyLimit: dailyLimitOf(deps, allowance, allowance.used) };
      }
      const job = await jobFacts(deps, row.job_id);
      const entry = await entryOf(deps, userId, row.job_id);
      const url = job ? queueApplicationUrl(job.apply_url) : null;
      if (entry && entry.current_status !== STATUS.saved) return finish('skipped', 'already_applied');
      if (!isOpen(t.dialect, job)) return finish('failed', 'posting_closed');
      if (!url) return finish('failed', 'unsupported_site');
      const resumeId = kitResumeOf(row, entry);
      const taken = await t.run(
        `UPDATE autofill_agent_queue SET state = 'running', attempts = attempts + 1, started_at = ?, claimed_by = ?,
           resume_id = ?, updated_at = ?, run = 'tab'
         WHERE id = ? AND user_id = ? AND state = 'queued' AND run IS DISTINCT FROM 'manual'`,
        [now, tokenId, resumeId, now, row.id, userId],
      );
      if (taken.changes !== 1) throw refuse(deps, 'conflict', 'MSG_QUEUE_JOB_TAKEN');
      await reserve(deps, { userId, queueId: row.id, jobId: row.job_id, run: 'tab', tokenId, dayKey: allowance.window.dayKey });
      return {
        item: taskOf({ ...row, resume_id: resumeId }, job, url),
        state: 'running',
        reason: null,
        dailyLimit: dailyLimitOf(deps, allowance, allowance.used + 1),
      };
    },
    { label: 'openForTab' },
  );
}
// end v1.5 Q2

export type Removed = Pick<QueueRow, 'id' | 'job_id' | 'resume_id'>;

/** tombstone's statements: the prune (the oldest removal kept), then one insert a row. */
export const TOMBSTONE_PRUNE_SQL = 'DELETE FROM autofill_agent_tombstones WHERE removed_at < ?';
export const TOMBSTONE_INSERT_SQL = `INSERT INTO autofill_agent_tombstones(queue_id, user_id, job_id, resume_id, removed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(queue_id) DO NOTHING`;

/** The oldest removal a tombstone is kept from (QUEUE_TOMBSTONE_KEEP_DAYS ago). */
export function tombstoneKeptFrom(deps: ClaimDeps): string {
  const keepMs = constantsOf(deps).get('QUEUE_TOMBSTONE_KEEP_DAYS') * DAY_MS;
  return new Date(deps.now().getTime() - keepMs).toISOString();
}

/**
 * A tombstone of each row taken out of the queue or replaced by a new one (kept QUEUE_TOMBSTONE_KEEP_DAYS), so a run
 * that reports a submission late still marks the job Applied. Older tombstones are pruned first. (v2.0: Prepare &
 * Queue's insert, prepared.ts, replaces a finished row this way too.) Call in the transaction that removes the rows.
 */
export async function tombstone(deps: ClaimDeps, userId: string, rows: readonly Removed[]): Promise<void> {
  if (rows.length === 0) return;
  const now = nowIso(deps);
  await deps.db.run(TOMBSTONE_PRUNE_SQL, [tombstoneKeptFrom(deps)]);
  for (const row of rows) await deps.db.run(TOMBSTONE_INSERT_SQL, [row.id, userId, row.job_id, row.resume_id, now]);
}

/** dismiss's statement: the account, the job, when. */
export const DISMISS_SQL =
  'INSERT INTO autofill_agent_dismissed(user_id, job_id, dismissed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING';

/**
 * Remembers the rows the person took out of the queue: their jobs, which the rule never picks again, and a tombstone of
 * each row.
 */
async function dismiss(deps: ClaimDeps, userId: string, rows: readonly Removed[]): Promise<void> {
  const now = nowIso(deps);
  for (const row of rows) await deps.db.run(DISMISS_SQL, [userId, row.job_id, now]);
  await tombstone(deps, userId, rows);
}

/** A removed or cleared row of the account, by its id, as its tombstone keeps it; null when there is none. */
export async function tombstoneOf(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  id: string,
): Promise<{ jobId: number; resumeId: string | null } | null> {
  const row = await deps.db.one<{ job_id: number; resume_id: string | null }>(
    'SELECT job_id, resume_id FROM autofill_agent_tombstones WHERE queue_id = ? AND user_id = ?',
    [id, userId],
  );
  return row ? { jobId: row.job_id, resumeId: row.resume_id } : null;
}

/** removeQueued's statements: the row as it stands, then its delete (both: id, account). */
export const REMOVE_READ_SQL = `SELECT id, job_id, resume_id, state, claimed_by, submit_pressed FROM autofill_agent_queue
         WHERE id = ? AND user_id = ?`;
export const REMOVE_DELETE_SQL = 'DELETE FROM autofill_agent_queue WHERE id = ? AND user_id = ?';
export type RemovedRow = Removed & Pick<QueueRow, 'state' | 'claimed_by'> & { submit_pressed: number | boolean | null };

/**
 * DELETE /agent/queue/:id: 404 for another account's or none; 409 while a browser is running it, as long as that
 * browser is connected (a run whose connection was revoked, expired or deleted may be removed: audit A6).
 */
export async function removeQueued(deps: ClaimDeps, userId: string, id: string): Promise<void> {
  await deps.db.atomic(
    async (t) => {
      const row = await t.one<RemovedRow>(REMOVE_READ_SQL, [id, userId]);
      if (!row) throw notFound('That auto-apply job');
      if (row.state === 'running' && row.claimed_by !== null && (await extensionTokenLive(deps, row.claimed_by))) {
        throw refuse(deps, 'conflict', 'MSG_QUEUE_JOB_APPLYING');
      }
      await t.run(REMOVE_DELETE_SQL, [id, userId]);
      // v2.0: a running row whose browser no longer works gives its daily use back, unless Submit was pressed.
      if (row.state === 'running') await settleFinishedRows(deps, [{ id: row.id, submit_pressed: row.submit_pressed ?? null }], 'removed');
      await dismiss(deps, userId, [row]);
    },
    { label: 'removeQueued' },
  );
}

/** clearFinished's statement: the account, then each finished state. */
export function clearFinishedSql(d: Dialect): string {
  return `DELETE FROM autofill_agent_queue WHERE user_id = ?
           AND state IN (${d.list(AUTOFILL_AGENT_FINISHED_STATES.length)}) RETURNING id, job_id, resume_id`;
}

/** POST /agent/queue/clear-finished: removes the account's finished rows, answering how many. */
export async function clearFinished(deps: ClaimDeps, userId: string): Promise<number> {
  return deps.db.atomic(
    async (t) => {
      const rows = await t.all<Removed>(clearFinishedSql(t.dialect), [userId, ...AUTOFILL_AGENT_FINISHED_STATES]);
      await dismiss(deps, userId, rows);
      return rows.length;
    },
    { label: 'clearFinished' },
  );
}

// v20 P3
/**
 * Mark as applied (POST /agent/queue/:id/applied, the Auto-apply page's manual flow, A13/A14), before the Tracker is
 * moved: the row as it stands. 409 while a connected browser runs it; a submitted row is answered as it is (nothing to
 * do).
 */
export async function rowForMarkApplied(deps: ClaimDeps, userId: string, id: string): Promise<QueueRow> {
  const row = await queueRow(deps, userId, id);
  if (row.state === 'running' && row.claimed_by !== null && (await extensionTokenLive(deps, row.claimed_by))) {
    throw refuse(deps, 'conflict', 'MSG_QUEUE_JOB_APPLYING');
  }
  return row;
}

/**
 * Mark as applied, after the Tracker entry was moved to Applied: the row is `submitted` by the person (reason none),
 * its run `manual` when no run ever took it. No daily use is reserved; a run whose browser no longer works gives its
 * use back unless Submit was pressed (as removing it would).
 */
export async function finishMarkedApplied(deps: Deps, userId: string, id: string): Promise<void> {
  const now = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      const row = await t.one<FinishedRow & { live: number | null }>(
        `UPDATE autofill_agent_queue SET state = 'submitted', reason = NULL, finished_at = ?, updated_at = ?,
           run = CASE WHEN run IS NULL AND claimed_by IS NULL THEN 'manual' ELSE run END
         WHERE id = ? AND user_id = ? AND state <> 'submitted'
         RETURNING id, submit_pressed, (SELECT 1 FROM auto_apply_reservations r WHERE r.queue_id = autofill_agent_queue.id
           AND r.state = 'reserved') AS live`,
        [now, now, id, userId],
      );
      if (row?.live) await settleFinishedRows(deps, [row], 'removed');
    },
    { label: 'finishMarkedApplied' },
  );
}
// end v20 P3
