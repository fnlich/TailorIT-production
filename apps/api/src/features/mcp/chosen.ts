import { normalizeResumeDocument, type LetterProfile } from '@tailorit/shared';
import type { PrepareResumeMode } from '@tailorit/shared/prepare';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { readAutofillProfile } from '../autofill/profile/repository';
import { letterProfile, type TemplateRecord } from '../cover-letters/context';
import { getResumeEvidence, type ResumeEvidence } from '../resumes/evidence';
import { defaultResumeId } from '../resumes/repository';
import { profileFromDocument } from '../tailor/mapping';
import { chooseTemplates, resolveSource } from '../tailor/source';
import type { Profile } from '../tailor/types';
import { builtProfile, letterPerson, type McpJob, type SourceProfile } from './job';
import type { McpPrepare } from './prepare';
import type { SaveContext } from './save';

// v2.0 P5, DECISIONS A29: the resume a job's application uses, chosen by the person's resume mode, never by their AI.
// - `tailor`: the tailored resume the Prepare saved (prepare_jobs.resume_id, else the kit's ready resume); before it is
//   saved, the source it is tailored from (the profile's resume, else the default; an upload's editable copy).
// - `default`: the Prepare's chosen resume, else the profile's resume, else the account's default, as it is.
// - `similar`: the Prepare's chosen resume (P2 picks it with the rule-based resume match when the Prepare starts), else
//   the default.
// The cover letter and every answer are written from this resume's content (its document, or an upload's extracted
// text), so they agree with the resume the application sends; the profile supplies only what the resume lacks.

export interface ChosenResume {
  mode: PrepareResumeMode;
  /** The resume the letter and the answers are written from; null when the account has none to choose. */
  id: string | null;
  kind: 'built' | 'uploaded' | null;
  /** `tailor`: the resume the tailored one is made from (null when there is none to tailor). */
  sourceId?: string | null;
  /** `tailor`: whether the tailored resume is saved, so `id` is it. */
  tailored?: boolean;
}

async function kindOf(deps: Pick<AppDeps, 'db'>, userId: string, id: string | null): Promise<'built' | 'uploaded' | null> {
  if (!id) return null;
  const row = await deps.db.one<{ kind: 'built' | 'uploaded' }>('SELECT kind FROM resumes WHERE id = ? AND user_id = ?', [id, userId]);
  return row?.kind ?? null;
}

/** The default resume as Prepare reads it: the profile's choice while it exists, else the account's default. */
export async function defaultResumeOf(deps: Pick<AppDeps, 'db'>, userId: string): Promise<string | null> {
  const chosen = (await readAutofillProfile(deps, userId)).value.documents.resumeId;
  if (chosen && (await kindOf(deps, userId, chosen))) return chosen;
  return await defaultResumeId(deps, userId);
}

/** The job's resume under the Prepare's mode (the person's setting when no Prepare is active). */
export async function chosenResume(ctx: SaveContext, job: McpJob, prepare: McpPrepare | null): Promise<ChosenResume> {
  const { deps, userId } = ctx;
  const mode = prepare?.resumeMode ?? (await ctx.prepare.resumeMode(deps, userId));
  /** The Prepare's own resume while it still exists. */
  const preparesOwn = prepare?.resumeId && (await kindOf(deps, userId, prepare.resumeId)) ? prepare.resumeId : null;
  if (mode !== 'tailor') {
    const id = preparesOwn ?? (await defaultResumeOf(deps, userId));
    return { mode, id, kind: await kindOf(deps, userId, id) };
  }
  const parts = await ctx.prepare.draft(deps, userId, job.applicationId);
  const tailored =
    preparesOwn ??
    (parts?.resumeStatus === 'ready' && parts.resumeId && (await kindOf(deps, userId, parts.resumeId)) ? parts.resumeId : null);
  let sourceId: string | null = null;
  try {
    sourceId = (await resolveSource(deps, userId)).resumeId;
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
  }
  const id = tailored ?? sourceId;
  return { mode, id, kind: await kindOf(deps, userId, id), sourceId, tailored: tailored !== null };
}

/** What the letter prompts and the letter's save read of the chosen resume. */
export interface ChosenContent {
  resumeId: string;
  /** A built resume, read as tailoring reads it; null for an upload. */
  built: SourceProfile | null;
  /** The resume's evidence (an upload's extracted text, the person's details). */
  evidence: ResumeEvidence;
  /** The profile the letter's humanizing reads (an upload's: its person's details alone). */
  profile: Profile;
  person: LetterProfile;
  coverLetterTemplate: TemplateRecord | null;
}

export const NO_CHOSEN_RESUME =
  'TailorIT has no resume to write this application from. Add a resume in Documents (or set your default resume), ' +
  'then prepare the job again.';

/** The chosen resume's content; refused when there is none. */
export async function chosenContent(deps: AppDeps, userId: string, chosen: ChosenResume): Promise<ChosenContent> {
  const evidence = chosen.id ? await getResumeEvidence(deps, userId, chosen.id) : null;
  if (!chosen.id || !evidence) throw new AppError('validation_failed', NO_CHOSEN_RESUME);
  if (evidence.kind === 'built') {
    const built = await builtProfile(deps, userId, chosen.id);
    return {
      resumeId: chosen.id,
      built,
      evidence,
      profile: built.profile,
      person: letterPerson(built),
      coverLetterTemplate: built.coverLetterTemplate,
    };
  }
  return {
    resumeId: chosen.id,
    built: null,
    evidence,
    profile: profileFromDocument(normalizeResumeDocument({}), evidence.profile),
    person: letterProfile(evidence),
    coverLetterTemplate: (await chooseTemplates(deps, userId, {})).coverLetterTemplate,
  };
}
