import type { ResumeEditTarget } from '@tailorit/shared/resume';
import { ApiError } from '@/lib/api';

/*
 * v1.5 W (decision 3): /resumes/<id>/edit, free of React. The page asks the API what Edit opens (POST
 * /api/resumes/:id/edit): a built resume opens itself; an upload opens its editable copy, which the API starts when
 * there is none (or follows, when one is already being made), and the page follows that task until the copy is ready,
 * then opens the editor. Every way it can stop is said plainly.
 */

export type EditRoutePhase =
  /** Asking the API. */
  | { kind: 'starting' }
  /** The copy is being made. */
  | { kind: 'making'; message: string | null }
  /** The resume to open is known: the editor opens. */
  | { kind: 'opening'; resumeId: string }
  /** The resume is not the person's, or was deleted. */
  | { kind: 'missing' }
  /** It stopped: the reason, and whether trying again can help. */
  | { kind: 'failed'; message: string; retry: boolean };

export interface EditRouteInput {
  /** The API's answer, while it is awaited (undefined) or once it came. */
  target: ResumeEditTarget | undefined;
  /** The API refused (or could not be reached). */
  error: unknown;
  /** The copy's task, as useAiTask reads it. */
  task: {
    status: string | undefined;
    isRunning: boolean;
    isFailed: boolean;
    errorMessage: string | null;
    message: string | null;
  };
  /** The copy the finished task names (readImportResult), null until then. */
  copyId: string | null;
}

export const COPY_STOPPED = 'The editable copy was stopped before it was ready. Try again to make it.';
export const COPY_NOT_NAMED = 'The AI finished, but no editable copy was saved. Please try again.';

/** Refusals no second try can change: a file whose text cannot be read, an account with no room, AI turned off. */
const FINAL_CODES = new Set(['validation_failed', 'conflict', 'ai_unavailable', 'forbidden']);

export function editRoutePhase({ target, error, task, copyId }: EditRouteInput): EditRoutePhase {
  if (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'missing' };
    const message = error instanceof Error && error.message ? error.message : 'Could not open this resume. Please try again.';
    const code = error instanceof ApiError ? error.code : null;
    return { kind: 'failed', message, retry: !code || !FINAL_CODES.has(code) };
  }
  if (!target) return { kind: 'starting' };
  if (target.resumeId) return { kind: 'opening', resumeId: target.resumeId };
  if (!target.taskId) return { kind: 'failed', message: COPY_NOT_NAMED, retry: true };
  if (copyId) return { kind: 'opening', resumeId: copyId };
  if (task.status === 'cancelled') return { kind: 'failed', message: COPY_STOPPED, retry: true };
  if (task.isFailed) return { kind: 'failed', message: task.errorMessage ?? 'The editable copy could not be made.', retry: true };
  if (task.status === 'succeeded') return { kind: 'failed', message: COPY_NOT_NAMED, retry: true };
  return { kind: 'making', message: task.message };
}
