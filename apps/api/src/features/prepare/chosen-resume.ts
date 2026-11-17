import type { PrepareResumeMode } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { bestResumes } from '../applications/resume-choice';
import { readAutofillProfile } from '../autofill/profile/repository';
import { defaultResumeId } from '../resumes/repository';

// Which resume a Prepare uses (DECISIONS A29, the resume mode):
// - `default`: the person's default resume as it is: the autofill profile's documents.resumeId (the resume the
//   extension attaches), else the account's default resume (users.default_resume_id). No AI, no new resume.
// - `similar`: the person's existing resume (any kind: uploaded, edited, tailored) that best matches the job, by the
//   rule-based resume match (applications/resume-choice.ts bestResumes: no AI, writes nothing); the default resume when
//   it chose none in time, and the most recently updated resume when there is no default either.
// - `tailor`: a new resume tailored from the default resume (features/tailor chooses the source the same way).
// The cover letter and every drafted answer are written from the resume chosen here (or the tailored one).

/** How long `similar` waits for the resume match of one job (bestResumes' budget; past it, the default resume). */
export const SIMILAR_MATCH_BUDGET_MS = 2_000;

async function isOwnResume(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<boolean> {
  return (await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [id, userId])) !== undefined;
}

/** The person's default resume: the profile's choice, else the account's default; null when neither exists. */
export async function defaultResumeOf(deps: Pick<AppDeps, 'db'>, userId: string): Promise<string | null> {
  const chosen = (await readAutofillProfile(deps, userId)).value.documents.resumeId;
  if (chosen && await isOwnResume(deps, userId, chosen)) return chosen;
  const id = await defaultResumeId(deps, userId);
  return id && await isOwnResume(deps, userId, id) ? id : null;
}

/** The person's most recently updated resume, or null with none. */
async function newestResumeOf(deps: Pick<AppDeps, 'db'>, userId: string): Promise<string | null> {
  const row = await deps.db.one<{ id: string }>(
    'SELECT id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT 1',
    [userId],
  );
  return row?.id ?? null;
}

/**
 * Whether the mode has a resume to use (else Prepare & Queue is refused with MSG_PREPARE_NO_RESUME): `similar` any
 * resume of the person's; `default` and `tailor` (which tailors from it) the default resume.
 */
export async function resumeAvailable(deps: Pick<AppDeps, 'db'>, userId: string, mode: PrepareResumeMode): Promise<boolean> {
  return mode === 'similar' ? await newestResumeOf(deps, userId) !== null : await defaultResumeOf(deps, userId) !== null;
}

/** The resume `default` or `similar` uses for the job, or null when the person has none. Never AI. */
export async function chooseResume(
  deps: Pick<AppDeps, 'db' | 'services' | 'log'>,
  userId: string,
  mode: 'default' | 'similar',
  jobId: number,
): Promise<string | null> {
  if (mode === 'default') return defaultResumeOf(deps, userId);
  const { choices } = await bestResumes(deps, userId, [jobId], SIMILAR_MATCH_BUDGET_MS);
  const best = choices.get(jobId)?.resumeId ?? null;
  if (best && await isOwnResume(deps, userId, best)) return best;
  return await defaultResumeOf(deps, userId) ?? await newestResumeOf(deps, userId);
}
