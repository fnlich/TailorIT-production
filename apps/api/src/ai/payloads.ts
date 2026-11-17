import type { AiTaskKind } from '@tailorit/shared';
import type { Dialect } from '../core/db/dialect';
import { AI_TASK_PAYLOADS, dayOf, ensureDayPartition } from '../core/db/pg/maintenance/partitions';
import type { DbClient, DbQueries } from '../core/db/types';

// v30 D5L (11-database.md §5.7, §8.2): an AI task's input and result live in `ai_task_payloads`, a table partitioned
// by the task's created_at day (UTC), and the daily housekeeping drops a day's partition after
// AI_TASK_PAYLOAD_KEEP_DAYS (core/db/pg/maintenance); `ai_tasks` keeps the task's state and metering for
// AI_TASK_KEEP_DAYS. Migration 0005 dropped ai_tasks.input and ai_tasks.result, and its trigger deletes a task's
// payload with the task's row (the autofill tasks' hour, an account's deletion).
//
// The queue (ai/queue.ts) writes and reads payloads only through this module. Another reader of a task's input or
// result writes `taskInputSql(d)` / `taskResultSql(d)` where it wrote `input` / `result` (in jsonText too).

/** The payload partition's day of a task: its created_at's UTC date (`YYYY-MM-DD`). */
export const payloadDayOf = (createdAt: string): string => dayOf(createdAt);

/** The payload alias inside the expressions below (unlikely to clash with a caller's own aliases). */
const P = 'ai_tp';
/** The payload row of the task row `alias`: its id and its day. */
const payloadOf = (alias: string) =>
  `${P}.task_id = ${alias}.id AND ${P}.created_on = (${alias}.created_at AT TIME ZONE 'UTC')::date`;

/**
 * The task's input (JSON text, null once its partition was dropped) as an SQL expression over the `ai_tasks` row
 * named `alias`: `SELECT id, ${taskInputSql(d)} AS input FROM ai_tasks WHERE ${d.jsonText(taskInputSql(d), '$.x')} = ?`.
 */
export function taskInputSql(_d: Dialect, alias = 'ai_tasks'): string {
  return `(SELECT ${P}.input FROM ai_task_payloads ${P} WHERE ${payloadOf(alias)})`;
}

/** The task's result (JSON text or null), as taskInputSql. */
export function taskResultSql(_d: Dialect, alias = 'ai_tasks'): string {
  return `(SELECT ${P}.result FROM ai_task_payloads ${P} WHERE ${payloadOf(alias)})`;
}

/** `SELECT` of whole task rows with their input and result (null once dropped): `${taskRowSql(d)} WHERE t.id = ?`. */
export function taskRowSql(_d: Dialect): string {
  return `SELECT t.*, ${P}.input, ${P}.result FROM ai_tasks t LEFT JOIN ai_task_payloads ${P} ON ${payloadOf('t')}`;
}

/**
 * Makes sure the payload partition of a task made at `createdAt` exists (housekeeping keeps two days ahead made; a
 * clock past them, a test's, gets its day here). Outside any transaction; remembered per client, so it reads nothing
 * once the day is known.
 */
export async function ensureTaskPartition(db: DbClient, createdAt: string): Promise<void> {
  await ensureDayPartition(db, AI_TASK_PAYLOADS, payloadDayOf(createdAt));
}

export interface NewTask {
  id: string;
  userId: string | null;
  kind: AiTaskKind;
  priority: number;
  /** The input as JSON text. */
  input: string;
  chargeUserId: string | null;
  dedupeKey: string | null;
  createdAt: string;
}

const INSERT_TASK =
  'INSERT INTO ai_tasks(id, user_id, kind, status, priority, charge_user_id, dedupe_key, created_at) ' +
  "VALUES (?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT DO NOTHING";
const INSERT_PAYLOAD = 'INSERT INTO ai_task_payloads(task_id, created_on, input) VALUES (?, ?, ?)';

/**
 * Inserts a queued task and its input, in the caller's transaction (the enqueue's). False when the task's dedupe key
 * is taken by a live task (ON CONFLICT DO NOTHING: no payload is written then). Call ensureTaskPartition first.
 */
export async function insertTask(t: DbQueries, task: NewTask): Promise<boolean> {
  const { changes } = await t.run(INSERT_TASK, [
    task.id, task.userId, task.kind, task.priority, task.chargeUserId, task.dedupeKey, task.createdAt,
  ]);
  if (changes !== 1) return false;
  await t.run(INSERT_PAYLOAD, [task.id, payloadDayOf(task.createdAt), task.input]);
  return true;
}

/**
 * A running task's success: its result first, then its status, so a reader never sees it succeeded without its result.
 * A task cancelled meanwhile stays cancelled (its result is kept, unread). Answers whether it was marked succeeded.
 */
export async function succeedTask(db: DbQueries, task: { id: string; createdAt: string }, result: string, finishedAt: string): Promise<boolean> {
  await db.run('UPDATE ai_task_payloads SET result = ? WHERE task_id = ? AND created_on = ?', [
    result, task.id, payloadDayOf(task.createdAt),
  ]);
  const { changes } = await db.run(
    "UPDATE ai_tasks SET status = 'succeeded', finished_at = ? WHERE id = ? AND status = 'running'",
    [finishedAt, task.id],
  );
  return changes === 1;
}
