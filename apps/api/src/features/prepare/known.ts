import {
  AutofillDraftAnswerSchema,
  type AutofillDraftAnswer,
  type AutofillKnownQuestion,
} from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { parsedValue, planQuestion } from './questions';
import { answerRows, type DraftRow } from './store';

// What the extension reads of a person's prepared kit (v1.5 P, additive within autofill API 6; v2.0's kit): POST
// /api/autofill/forms/known's `drafts` (match 'draft') and the lookup's `draftReady`. Only ever the caller's own draft,
// for the application of the job the request found; nothing is written and nothing is logged.
// v3.0 D2-F: on the async client.

/** The caller's draft for the job (the draft of their Tracker entry of it), or null. */
async function draftForJob(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number): Promise<DraftRow | null> {
  const row = await deps.db.one<DraftRow>(
    `SELECT d.* FROM application_drafts d JOIN applications a ON a.id = d.application_id
          WHERE d.user_id = ? AND a.user_id = ? AND a.job_id = ?`,
    [userId, userId, jobId],
  );
  return row ?? null;
}

/**
 * The caller's draft answers to the job's `questions` (the form forms/known found), in form order: ready ones with
 * their answer, not-ready ones with none. A question the screens now find never drafted is left out, and so is an
 * answer that no longer reads or fits (it is then not ready).
 */
export async function draftAnswersFor(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  jobId: number | null,
  questions: readonly AutofillKnownQuestion[],
): Promise<AutofillDraftAnswer[]> {
  if (jobId === null || questions.length === 0) return [];
  const draft = await draftForJob(deps, userId, jobId);
  if (!draft) return [];
  const rows = new Map((await answerRows(deps.db, draft.id)).map((row) => [row.question_id, row]));
  const out: AutofillDraftAnswer[] = [];
  for (const question of questions) {
    const row = rows.get(question.id);
    if (!row) continue;
    // The words' screens alone here (no read of the person's sensitive answers on a lookup path); the save screened all.
    const planned = planQuestion(question, () => false);
    if (planned.state === 'profile') continue;
    const value = row.status === 'ready' ? parsedValue(row.answer) : null;
    const parsed = AutofillDraftAnswerSchema.safeParse({
      match: 'draft',
      questionId: question.id,
      questionKey: question.questionKey,
      optionSetHash: question.optionSetHash,
      questionLabel: question.label,
      fieldKind: question.kind,
      status: value ? 'ready' : 'not_ready',
      answer: value,
      provenance: row.provenance,
      preparedAt: row.updated_at,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * The lookup's `draftReady`: true when the caller's draft for the job is made (its resume ready, its letter ready or
 * off, its answers ready or not ready), false while a part is still to make or failed; undefined with no draft.
 */
export async function draftReadyFor(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number | null): Promise<boolean | undefined> {
  if (jobId === null) return undefined;
  const draft = await draftForJob(deps, userId, jobId);
  if (!draft) return undefined;
  const letter = draft.letter_status === 'ready' || draft.letter_status === 'off';
  const answers = draft.answers_status === 'ready' || draft.answers_status === 'not_ready';
  return draft.resume_status === 'ready' && letter && answers;
}
