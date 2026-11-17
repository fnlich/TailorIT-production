import { randomUUID } from 'node:crypto';
import type { ResumeCopiesPause, ResumeCopiesResponse, ResumeCopyState } from '@tailorit/shared';
import { AI_UNAVAILABLE_TEXT } from '../../../ai/errors';
import { nowIso, type AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { assertRoomForResumes, requireResume, toSummary } from '../repository';
import { readableForImport, UNREADABLE_TEXT } from '../upload';
import type { CopyLineWait } from './backlog';

// The editable copies asked for with several uploads at once (resume_copy_backlog, migration 0102): one row per
// upload, written in the upload's own transaction, and the view the Resumes tab follows (GET /api/resumes/copies).
// The copy line (./backlog.ts) starts and settles the copies; the buttons of the tab's copy notices (Stop the rest,
// Try again, Dismiss) act here. A row only points at its upload: the upload is never changed, and deleting it takes
// its row with it (a copy already made stays a resume). Every statement is scoped by the account.

/**
 * Why a copy was not made: 'unreadable' and 'gone' (the upload was deleted) cannot be tried again; the others can.
 * 'no_room' is the resume limit (the plan's, or the safety cap). v2.0: 'usage' is never a failure: it marks the copies
 * still waiting because the person's AI usage and extra credit are used up, until the daily reset (the copy line).
 */
export type CopyErrorCode = 'unreadable' | 'no_room' | 'ai_off' | 'ai' | 'gone' | 'usage';

/** v2.0: a refusal of the resume limit, the plan's (403 resume_limit_reached) or the safety cap (409 conflict). */
export function isNoRoom(error: unknown): boolean {
  return error instanceof AppError && (error.code === 'resume_limit_reached' || error.code === 'conflict');
}
const NOT_RETRYABLE: ReadonlySet<string> = new Set(['unreadable', 'gone']);

/**
 * When this server makes no copies (AI off, or no AI service), the sentence a person is shown; null when it makes them.
 * v2.0: MSG_AI_UNAVAILABLE either way (a person is never told the server's state; the log says which).
 */
export function copiesOffMessage(deps: Pick<AppDeps, 'config' | 'services'>): string | null {
  if (deps.config.ai.enabled && deps.services.ai) return null;
  return deps.services.constants?.message('MSG_AI_UNAVAILABLE') ?? AI_UNAVAILABLE_TEXT;
}

/**
 * What a person is told of the copy line's wait (v2.0): their own AI usage used up, with the daily reset; for any other
 * wait (AI off, an AI pause, the seat's usage limit or warning, the capacity block) only that AI is unavailable, with
 * no time, which would tell the server's state. The detail (CopyLineWait) stays for the log and admin views.
 */
export function personPause(wait: CopyLineWait | null): ResumeCopiesPause | null {
  if (!wait) return null;
  return wait.reason === 'usage' ? { reason: 'usage', until: wait.until } : { reason: 'unavailable', until: null };
}

/** Why a copy asked for now cannot be made, checked in the order a copy asked for alone is; null when it can. */
async function refusalOf(
  deps: AppDeps,
  userId: string,
  text: string | null,
): Promise<{ code: CopyErrorCode; message: string } | null> {
  if (!readableForImport(text)) return { code: 'unreadable', message: UNREADABLE_TEXT };
  try {
    // The new upload is counted already: this is the room for its copy.
    await assertRoomForResumes(deps, userId, 1);
  } catch (error) {
    if (error instanceof AppError && isNoRoom(error)) return { code: 'no_room', message: error.message };
    throw error;
  }
  const off = copiesOffMessage(deps);
  return off ? { code: 'ai_off', message: off } : null;
}

/**
 * Puts the editable copy of a new upload in line (one of several files of an Upload dialog), inside the upload's own
 * transaction: 'waiting', or 'failed' at once when it cannot be made (text that cannot be read, no room left, AI off).
 * Runs in a savepoint: a row that cannot be written is logged and leaves the upload stored. Returns whether it was
 * written.
 */
export async function requestBatchCopy(
  deps: AppDeps,
  userId: string,
  uploadId: string,
  choice: { batchId: string; templateId: string | null },
): Promise<boolean> {
  try {
    await deps.db.atomic(
      async (t) => {
        const upload = await requireResume(deps, userId, uploadId);
        const refusal = await refusalOf(deps, userId, upload.extracted_text);
        const now = nowIso(deps);
        await t.run(
          `INSERT INTO resume_copy_backlog(id, user_id, source_resume_id, batch_id, label, template_id, state,
             next_attempt_at, error_code, error_message, created_at, finished_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            userId,
            uploadId,
            choice.batchId,
            toSummary(deps, upload, null).label,
            choice.templateId,
            refusal ? 'failed' : 'waiting',
            now,
            refusal?.code ?? null,
            refusal?.message ?? null,
            now,
            refusal ? now : null,
            now,
          ],
        );
      },
      { label: 'requestBatchCopy' },
    );
    return true;
  } catch (error) {
    deps.log.error('[resumes] could not put an editable copy in line', error);
    return false;
  }
}

/**
 * The template of the upload's copy in line that a copy asked for alone would take over (it waits, failed or was
 * stopped; see adoptCopyTask), so that copy starts on its batch's template too; null when there is none.
 */
export async function adoptableCopyTemplate(deps: Pick<AppDeps, 'db'>, userId: string, uploadId: string): Promise<string | null> {
  const row = await deps.db.one<{ template_id: string | null }>(
    `SELECT template_id FROM resume_copy_backlog
       WHERE user_id = ? AND source_resume_id = ? AND state IN ('waiting', 'failed', 'stopped')`,
    [userId, uploadId],
  );
  return row?.template_id ?? null;
}

/**
 * A copy asked for alone ("Make editable copy", POST /:id/parse) of an upload whose copy in line waits, failed or was
 * stopped: that row follows the task just started, so no second copy is made and a later Try again does not repeat
 * it. A no-op for an upload without such a row.
 */
export async function adoptCopyTask(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  uploadId: string,
  taskId: string,
): Promise<void> {
  const now = nowIso(deps);
  await deps.db.run(
    `UPDATE resume_copy_backlog SET state = 'making', task_id = ?, started_at = ?, retries = 0, error_code = NULL,
         error_message = NULL, finished_at = NULL, updated_at = ?
       WHERE user_id = ? AND source_resume_id = ? AND state IN ('waiting', 'failed', 'stopped')`,
    [taskId, now, now, userId, uploadId],
  );
}

interface CopyRow {
  id: string;
  batch_id: string;
  label: string;
  state: ResumeCopyState;
  resume_id: string | null;
  error_code: string | null;
  error_message: string | null;
}

/**
 * GET /api/resumes/copies: the account's copies in the order they were asked for (one per upload, so at most the
 * resume limit's), and why those in line wait (v2.0: the person's own pause, `usage`, among them).
 */
export async function listCopies(deps: AppDeps, userId: string): Promise<ResumeCopiesResponse> {
  // The insert order (`seq`, v3.0 PG-E: SQLite's rowid) breaks a tie of created_at, the order they were asked in.
  const rows = await deps.db.all<CopyRow>(
    `SELECT id, batch_id, label, state, resume_id, error_code, error_message FROM resume_copy_backlog
       WHERE user_id = ? ORDER BY created_at, ${deps.db.dialect.seq()}`,
    [userId],
  );
  const line = deps.services.resumeCopies;
  return {
    items: rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      label: row.label,
      state: row.state,
      resumeId: row.resume_id,
      error: row.state === 'failed' ? row.error_message : null,
      retryable: row.state === 'stopped' || (row.state === 'failed' && !NOT_RETRYABLE.has(row.error_code ?? '')),
    })),
    // No line at all is AI off; the line's own null means the copies do not wait. A person sees personPause of it.
    paused: personPause(line ? await line.waitReason(userId) : { reason: 'off', until: null }),
  };
}

/** Stop the rest: the batch's copies still waiting are stopped (one being made finishes). Returns how many. */
export async function stopCopies(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, batchId: string): Promise<number> {
  const now = nowIso(deps);
  const result = await deps.db.run(
    `UPDATE resume_copy_backlog SET state = 'stopped', finished_at = ?, updated_at = ?
       WHERE user_id = ? AND batch_id = ? AND state = 'waiting'`,
    [now, now, userId, batchId],
  );
  return result.changes;
}

/**
 * Try again: the batch's stopped copies, and those that failed for a reason that can pass (NOT_RETRYABLE aside), wait
 * in line again from the start. Returns how many.
 */
export async function retryCopies(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, batchId: string): Promise<number> {
  const now = nowIso(deps);
  const result = await deps.db.run(
    `UPDATE resume_copy_backlog SET state = 'waiting', task_id = NULL, retries = 0, error_code = NULL,
         error_message = NULL, finished_at = NULL, next_attempt_at = ?, updated_at = ?
       WHERE user_id = ? AND batch_id = ?
         AND (state = 'stopped' OR (state = 'failed' AND coalesce(error_code, '') NOT IN ('unreadable', 'gone')))`,
    [now, now, userId, batchId],
  );
  return result.changes;
}

/** Dismiss: the batch's finished rows go (ready, failed, stopped); the copies made stay resumes. Returns how many. */
export async function dismissCopies(deps: Pick<AppDeps, 'db'>, userId: string, batchId: string): Promise<number> {
  const result = await deps.db.run(
    "DELETE FROM resume_copy_backlog WHERE user_id = ? AND batch_id = ? AND state IN ('ready', 'failed', 'stopped')",
    [userId, batchId],
  );
  return result.changes;
}
