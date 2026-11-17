import { TAILOR_STEPS, type TailorAtsReport, type TailorStep, type TailorTaskView } from '@tailorit/shared';

// v1.4 E (decision 16): what the "Tailor my resume" dialog shows, worked out from the task and the refusals. Pure, so
// the dialog only draws it.

/** Each step of a tailoring, in the person's words, in order. */
export const STEP_LABELS: Record<TailorStep, string> = {
  waiting: 'Waiting for a turn',
  analyzing: 'Reading the job',
  writing: 'Writing your resume and letter',
  revising: 'Checking the ATS score',
  saving: 'Saving your documents',
};

export interface StepRow {
  step: TailorStep;
  label: string;
  state: 'done' | 'current' | 'upcoming';
}

/** The steps as a list, the current one marked; a task that has not said its step yet is waiting. */
export function stepRows(step: TailorStep | null): StepRow[] {
  const at = TAILOR_STEPS.indexOf(step ?? 'waiting');
  return TAILOR_STEPS.map((id, index) => ({
    step: id,
    label: STEP_LABELS[id],
    state: index < at ? 'done' : index === at ? 'current' : 'upcoming',
  }));
}

/** How far along a running task is, 0-100: each step a fifth, the current one half done. */
export function progressPercent(step: TailorStep | null): number {
  const at = TAILOR_STEPS.indexOf(step ?? 'waiting');
  return Math.round(((at + 0.5) / TAILOR_STEPS.length) * 100);
}

/** What went wrong, as the dialog explains it. */
export type TailorProblem =
  /** The source is an upload with no editable copy: offer to make one (the existing flow). */
  | { kind: 'needs_editable_copy' }
  /** v2.0 fix (REQ-3, REQ-10): the server's words (MSG_TAILOR_PER_HOUR with the admin's TAILOR_PER_HOUR). */
  | { kind: 'rate_limited'; retryAfterSeconds: number | null; message: string }
  /** The server's words (MSG_AI_UNAVAILABLE), when it sent them. */
  | { kind: 'ai_unavailable'; message?: string }
  | { kind: 'ai_busy' }
  | { kind: 'not_found' }
  | { kind: 'failed'; message: string };

const NOT_FOUND = 'The job, the resume or a template is no longer there. Choose again and try once more.';

/** A refused POST /api/tailor (an ApiError's code, status and message), as the dialog explains it. */
export function problemOfError(error: { code?: string; message?: string; retryAfterSeconds?: number } | null | undefined): TailorProblem {
  switch (error?.code) {
    case 'needs_editable_copy':
      return { kind: 'needs_editable_copy' };
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds ?? null, message: error.message ?? '' };
    case 'ai_unavailable':
      return error.message ? { kind: 'ai_unavailable', message: error.message } : { kind: 'ai_unavailable' };
    case 'ai_busy':
      return { kind: 'ai_busy' };
    case 'not_found':
      return { kind: 'not_found' };
    default:
      return { kind: 'failed', message: error?.message || 'Tailoring could not start. Please try again.' };
  }
}

/** A task that ended without a result, as the dialog explains it; null while it runs or once it succeeded. */
export function problemOfTask(task: Pick<TailorTaskView, 'status' | 'error'>): TailorProblem | null {
  if (task.status === 'cancelled') return { kind: 'failed', message: 'This tailoring was cancelled.' };
  if (task.status !== 'failed') return null;
  if (task.error?.code === 'ai_unavailable') {
    return task.error.message ? { kind: 'ai_unavailable', message: task.error.message } : { kind: 'ai_unavailable' };
  }
  if (task.error?.code === 'interrupted') {
    return { kind: 'failed', message: 'TailorIT restarted while it was tailoring. Please try again.' };
  }
  return { kind: 'failed', message: task.error?.message || 'Tailoring did not work this time. Please try again.' };
}

/** The title and sentence of a problem. */
export function problemText(problem: TailorProblem): { title: string; body: string } {
  switch (problem.kind) {
    case 'needs_editable_copy':
      return {
        title: 'This resume is an uploaded file',
        body: 'Tailoring writes a new resume from one you can edit. Make an editable copy of the upload first (an AI reads the file into a resume), then tailor from it.',
      };
    case 'rate_limited': {
      // The limit and its wait are the server's to say (MSG_TAILOR_PER_HOUR); with no words, only when to try again.
      const wait = problem.retryAfterSeconds ? `Try again in about ${Math.max(1, Math.ceil(problem.retryAfterSeconds / 60))} min.` : 'Try again later.';
      return { title: 'That is enough tailoring for now', body: problem.message || wait };
    }
    case 'ai_unavailable':
      return {
        title: 'The AI is not available',
        body: problem.message || "TailorIT's AI is off, signed out or paused right now. Try again once it is back.",
      };
    case 'ai_busy':
      return { title: 'Two tailorings are running', body: 'Wait for one of them to finish, then try again.' };
    case 'not_found':
      return { title: 'Something is missing', body: NOT_FOUND };
    case 'failed':
      return { title: 'Tailoring did not work', body: problem.message };
  }
}

/** The ATS score's colour band. */
export function scoreBand(score: number): 'high' | 'medium' | 'low' {
  return score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low';
}

/** "From 54 to 91" when the source resume's score is known. */
export function scoreChange(ats: Pick<TailorAtsReport, 'score' | 'scoreBefore'>): string | null {
  if (ats.scoreBefore === null) return null;
  if (ats.scoreBefore === ats.score) return `Same as your resume's ${ats.score}`;
  return `${ats.score > ats.scoreBefore ? 'Up' : 'Down'} from ${ats.scoreBefore}`;
}

/** The keywords the tailored resume still lacks: the hard skills first, each once. */
export function missingKeywords(ats: Pick<TailorAtsReport, 'missingHardSkills' | 'missingSoftSkills'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const keyword of [...ats.missingHardSkills, ...ats.missingSoftSkills]) {
    const key = keyword.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword.trim());
  }
  return out;
}

/** What the tailoring is for: a job of TailorIT's, or a tracker entry (with or without a job). */
export interface TailorTarget {
  jobId?: number;
  applicationId?: string;
  company: string;
  title: string;
}

/** The dialog's choices, before they are sent. */
export interface TailorChoices {
  resumeId: string | null;
  /** null: the source resume's own template. */
  resumeTemplateId: string | null;
  coverLetter: boolean;
  /** null: no template. */
  coverLetterTemplateId: string | null;
}

/**
 * Where the choices start: the profile's chosen resume (when it is still there), else the default one, else the
 * first; the profile's templates.
 */
export function initialChoices(input: {
  profileDocuments: { resumeId: string | null; resumeTemplateId: string | null; coverLetterTemplateId: string | null } | null;
  resumes: ReadonlyArray<{ id: string; isDefault: boolean }>;
}): TailorChoices {
  const { profileDocuments, resumes } = input;
  const chosen = profileDocuments?.resumeId;
  const resumeId =
    (chosen && resumes.some((resume) => resume.id === chosen) ? chosen : null) ??
    resumes.find((resume) => resume.isDefault)?.id ??
    resumes[0]?.id ??
    null;
  return {
    resumeId,
    resumeTemplateId: profileDocuments?.resumeTemplateId ?? null,
    coverLetter: true,
    coverLetterTemplateId: profileDocuments?.coverLetterTemplateId ?? null,
  };
}

/** POST /api/tailor's body: the job (or the tracker entry), the source and the templates (null says "none"). */
export function tailorBody(target: TailorTarget, choices: TailorChoices, force = false) {
  return {
    ...(target.applicationId ? { applicationId: target.applicationId } : {}),
    ...(target.jobId !== undefined ? { jobId: target.jobId } : {}),
    ...(choices.resumeId ? { resumeId: choices.resumeId } : {}),
    resumeTemplateId: choices.resumeTemplateId,
    coverLetter: choices.coverLetter,
    ...(choices.coverLetter ? { coverLetterTemplateId: choices.coverLetterTemplateId } : {}),
    ...(force ? { force: true } : {}),
  };
}

/** The tracker entry's page. */
export function trackerEntryHref(applicationId: string): string {
  return `/tracker?app=${encodeURIComponent(applicationId)}`;
}
