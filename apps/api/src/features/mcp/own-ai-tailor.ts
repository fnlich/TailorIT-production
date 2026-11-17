import { normalizeResumeDocument, HOUR_MS } from '@tailorit/shared';
import { AUTOFILL_TAILOR_LIMITS } from '@tailorit/shared/autofill';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError, validationFailed } from '../../core/http/errors';
import { stringsOf } from '../autofill/ai/tasks';
import { untrustedLines } from '../autofill/ai/untrusted';
import { applicationFacts, jobFacts } from '../cover-letters/context';
import { readableForAi } from '../job-analysis/service';
import { buildAtsReport } from '../tailor/ats';
import { toJobAnalysis } from '../tailor/keywords';
import { keptFacts, tailoredDocument } from '../tailor/mapping';
import { storeTailored } from '../tailor/output';
import { resolveSource } from '../tailor/source';
import { tailoredTitle } from '../tailor/output';
import { finishedDraft, withProfileFiguresKept } from '../tailor/pipeline';
import { tailorRateLimited } from '../tailor/service';
import { postingHashOf } from '../tailor/store';
import { builtProfile, heldAnalysis, type McpJob, type SourceProfile } from './job';
import { assertRoomForResumes } from './limits';
import { normalizeAnalysis } from './normalize/analysis';
import { isRecord } from './normalize/refuse';
import { atsSummary, draftOfResume, FACTS_CHANGED, NO_KEYWORDS_KEPT, refuseContent, sourceAsTailored } from './save';
import { contentProblem, tripwireLine } from './screen';
import { ownAnalyzeParts, ownTailorParts } from './step-text';
import { keepAnalysis, workFor } from './work';

// v2.0 FIX-C (REQ-6, the coordinator's decision: A17 extended): the web's "Tailor my resume" for one job, with the
// person's own AI. It does not queue the job: it makes a tailored resume, as POST /api/tailor does, and nothing else.
// own_ai_context {feature: "tailor", jobId | applicationId, resumeId?} answers TailorIT's own tailoring prompts in two
// steps, as the server's tailoring runs them: first the keyword analysis of the posting (the posting in its <untrusted>
// wrapper, with the job's tripwire), unless TailorIT already holds one for it (the person's AI's, saved by a Prepare
// or by this feature, or TailorIT's own); then the resume, from the source resume's profile and the posting's keyword
// plan. own_ai_save {feature: "tailor", ..., output: {analysis} | {resume}} keeps the analysis (filtered in code to
// the posting's own words, as a Prepare's is), or checks the resume as a Prepare's resume save does (the tripwire, AI
// talk and prompt markup; the profile's employers, titles, dates and figures kept; the protected facts checked) and
// stores it as a new tailored resume, linked to the job's Tracker entry as the server's tailoring links it
// (tailor/output.ts storeTailored, no letter: the letter is own_ai "cover_letter").
// Limits: the resume limit (room for one, before the context and again at the save), and TAILOR_PER_HOUR new
// resumes an hour, the server Tailor's cap and message (MSG_TAILOR_PER_HOUR), counted over this feature's saves. That
// count is kept in memory, as the MCP endpoint's request limits are: a restart starts the hour afresh. Nothing here
// runs or charges TailorIT's AI.

export const NO_JOB_TO_TAILOR =
  'This Tracker entry has no job TailorIT holds, so your AI cannot tailor to it here. Tailor it on its page with ' +
  "TailorIT's AI, or name a job (jobId).";
export const POSTING_TOO_SHORT = "This job's posting has too little text to tailor a resume to.";
export const ANALYSIS_HELD =
  "TailorIT already holds this posting's keyword analysis. Call own_ai_context again, with the same ids, for the " +
  'resume prompt.';
export const NO_TAILOR_ANALYSIS =
  "There is no keyword analysis of this posting yet. Call own_ai_context for the analysis prompt and save its answer " +
  '(output.analysis) first.';
const OUTPUT_SHAPE = 'output: expected {"analysis": {...}} or {"resume": {...}}, as own_ai_context\'s output line says.';

/** The ids a tailoring names: the job (or the Tracker entry of one), and the resume to tailor from. */
export interface TailorIds {
  jobId?: number;
  applicationId?: string;
  resumeId?: string;
}

/** The job as the MCP tools read one: its posting cleaned as page text is. Any job the person may see, not only Saved. */
async function tailorJob(deps: AppDeps, userId: string, ids: TailorIds): Promise<McpJob> {
  let facts;
  if (ids.applicationId) facts = await applicationFacts(deps, userId, ids.applicationId);
  else if (ids.jobId !== undefined) facts = await jobFacts(deps, ids.jobId, userId);
  else throw validationFailed('jobId: tailor needs it (or applicationId, a Tracker entry).');
  if (facts.jobId === null) throw new AppError('validation_failed', NO_JOB_TO_TAILOR);
  const posting = untrustedLines(facts.jobDescription ?? '', AUTOFILL_TAILOR_LIMITS.jobDescription);
  if (!readableForAi(posting)) throw new AppError('validation_failed', POSTING_TOO_SHORT);
  return {
    applicationId: facts.applicationId ?? '',
    jobId: facts.jobId,
    company: facts.companyName.trim().slice(0, AUTOFILL_TAILOR_LIMITS.company),
    title: facts.jobTitle.trim().slice(0, AUTOFILL_TAILOR_LIMITS.title),
    postingUrl: '',
    posting,
  };
}

/** The resume tailored from: the one named, else the profile's, else the default (an upload: its editable copy). */
const tailorSource = async (deps: AppDeps, userId: string, resumeId?: string): Promise<SourceProfile> =>
  builtProfile(deps, userId, (await resolveSource(deps, userId, resumeId)).resumeId);

// ------------------------------------------------------------------------------------------- the hourly cap

/** When each account's own-AI tailorings were saved within the hour, per app (its database), oldest first. */
const savedAt = new WeakMap<object, Map<string, number[]>>();

function savesWithinHour(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): number[] {
  let byAccount = savedAt.get(deps.db);
  if (!byAccount) {
    byAccount = new Map();
    savedAt.set(deps.db, byAccount);
  }
  const since = deps.now().getTime() - HOUR_MS;
  const kept = (byAccount.get(userId) ?? []).filter((at) => at > since);
  if (kept.length > 0) byAccount.set(userId, kept);
  else byAccount.delete(userId);
  return kept;
}

/** 429 at TAILOR_PER_HOUR saves within the hour, with the minutes until one leaves it (the server Tailor's refusal). */
function assertUnderHourlyCap(deps: AppDeps, userId: string): void {
  const max = constantsOf(deps).get('TAILOR_PER_HOUR');
  const saves = savesWithinHour(deps, userId);
  if (saves.length < max) return;
  const freesAt = saves[saves.length - max]! + HOUR_MS;
  const seconds = Math.max(1, Math.ceil((freesAt - deps.now().getTime()) / 1000));
  throw tailorRateLimited(deps, seconds);
}

function noteSave(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): void {
  savesWithinHour(deps, userId);
  const byAccount = savedAt.get(deps.db)!;
  byAccount.set(userId, [...(byAccount.get(userId) ?? []), deps.now().getTime()]);
}

// ------------------------------------------------------------------------------------------- context and save

/** The ids the output line names, so the save reads the same job and source. */
function namedIds(ids: TailorIds, job: McpJob, source: SourceProfile): string {
  const target = ids.applicationId ? `"applicationId": "${job.applicationId}"` : `"jobId": ${job.jobId}`;
  return `${target}, "resumeId": "${source.resumeId}"`;
}

const saveLine = (ids: string, output: string) => `own_ai_save {"feature": "tailor", ${ids}, "output": ${output}}`;

export async function tailorContext(deps: AppDeps, userId: string, ids: TailorIds) {
  const job = await tailorJob(deps, userId, ids);
  // Refused before the person's AI does any work, and again at the save.
  await assertRoomForResumes(deps, userId, 1);
  assertUnderHourlyCap(deps, userId);
  const source = await tailorSource(deps, userId, ids.resumeId);
  const work = await workFor(deps, userId, job.jobId);
  const held = await heldAnalysis(deps, userId, job, work);
  const named = namedIds(ids, job, source);
  if (!held) {
    return {
      feature: 'tailor',
      step: 'analysis',
      ...ownAnalyzeParts(job.posting, tripwireLine(work.canary)),
      output: saveLine(named, '{"analysis": <the JSON object>}'),
      next: 'After that save, call own_ai_context again with the same ids: it answers the resume prompt.',
    };
  }
  return {
    feature: 'tailor',
    step: 'resume',
    ...ownTailorParts(source.profile, held.analysis),
    output: saveLine(named, '{"resume": <the JSON object>}'),
  };
}

export async function tailorSave(deps: AppDeps, userId: string, ids: TailorIds, output: unknown) {
  const job = await tailorJob(deps, userId, ids);
  if (!isRecord(output) || (output.analysis === undefined) === (output.resume === undefined)) {
    throw validationFailed(OUTPUT_SHAPE);
  }
  const work = await workFor(deps, userId, job.jobId);
  const held = await heldAnalysis(deps, userId, job, work);

  if (output.analysis !== undefined) {
    // A held analysis is kept as it is: one of a Prepare of the same job is never replaced from here.
    if (held) throw new AppError('conflict', ANALYSIS_HELD);
    const raw = normalizeAnalysis(output.analysis);
    const keywords = toJobAnalysis(raw, job.posting).atsKeywords ?? [];
    if (keywords.length === 0) throw new AppError('validation_failed', NO_KEYWORDS_KEPT);
    await keepAnalysis(deps, userId, job.jobId, postingHashOf(job.posting), raw);
    return {
      feature: 'tailor',
      step: 'analysis',
      jobId: job.jobId,
      kept: keywords.length,
      next: 'Call own_ai_context again with the same ids: it answers the resume prompt.',
    };
  }

  if (!held) throw new AppError('validation_failed', NO_TAILOR_ANALYSIS);
  // No resume is made past the plan's limit or the hourly cap, whatever the person's AI wrote.
  await assertRoomForResumes(deps, userId, 1);
  assertUnderHourlyCap(deps, userId);
  const source = await tailorSource(deps, userId, ids.resumeId);
  const { profile } = source;
  const { analysis } = held;
  const { draft, dropped } = draftOfResume(output.resume, 'resume', profile, analysis, work.canary);
  const problem = contentProblem(stringsOf(draft), work.canary);
  if (problem) throw refuseContent(problem);
  const finished = withProfileFiguresKept(finishedDraft(draft, analysis, profile), profile);
  const document = tailoredDocument(source.editor, finished, { templateId: source.templateId, profile });
  if (!keptFacts(normalizeResumeDocument({ ...source.editor, templateId: source.templateId }), document)) {
    throw new AppError('internal', FACTS_CHANGED);
  }
  const title = tailoredTitle(job.company, job.title);
  const saved = await storeTailored(deps, userId, {
    title,
    document,
    sourceResumeId: source.resumeId,
    letter: null,
    target: {
      jobId: job.jobId,
      applicationId: ids.applicationId ? job.applicationId : null,
      company: job.company,
      jobTitle: job.title,
      postingUrl: '',
    },
    postingText: job.posting,
  });
  noteSave(deps, userId);
  const scoreBefore = buildAtsReport(sourceAsTailored(source), analysis, profile).score;
  return {
    feature: 'tailor',
    step: 'resume',
    resumeId: saved.resumeId,
    name: title,
    applicationId: saved.applicationId,
    ats: atsSummary(buildAtsReport(finished, analysis, profile), scoreBefore),
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}
