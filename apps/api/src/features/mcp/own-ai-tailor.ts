import { normalizeResumeDocument, HOUR_MS, UNLIMITED } from '@tailorit/shared';
import { AUTOFILL_TAILOR_LIMITS } from '@tailorit/shared/autofill';
import { hourlyLimitOf } from '../../core/accounts/entitlements';
import type { PersonPayer } from '../../core/accounts/payer'; // v33 SHARE-8
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
import { builtProfile, heldAnalysis, personFitOf, type McpJob, type SourceProfile } from './job';
import { jobFamilyOf } from '../roles/index'; // v33 PROMPTS
import { referenceFor } from '../tailor/skills/reference';
import { assertRoomForResumes } from './limits';
import { normalizeAnalysis } from './normalize/analysis';
import { isRecord } from './normalize/refuse';
import { ownerWrap } from './profiles'; // v33 SHARE-8
import { atsSummary, draftOfResume, FACTS_CHANGED, NO_KEYWORDS_KEPT, refuseContent, refuseGrantTripwire, sourceAsTailored, tripwiresOf, type SaveContext } from './save';
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
// Limits: the resume limit (room for one, before the context and again at the save), and the plan's new resumes an hour
// (FREE_/PAID_TAILOR_PER_HOUR, v32 FIX-PLAN: Paid's unlimited by default), the server Tailor's cap and message
// (MSG_TAILOR_PER_HOUR), counted over this feature's saves. That count is kept in memory, as the MCP endpoint's request
// limits are: a restart starts the hour afresh. Nothing here runs or charges TailorIT's AI.
// v33 SHARE-8 (SHARE-3's edit 7): the hourly cap is the PAYER's (the caller's plan, hourlyLimitOf by the payer, the
// count keyed by the payer: tailoring on several profiles never multiplies it); the resume room keeps the owner's last
// places on another person's profile (the caller's payer); the owner's resume in the context is in the profile's
// wrapper, and a save holding a tripwire of the caller's grants is refused.

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
  const title = facts.jobTitle.trim().slice(0, AUTOFILL_TAILOR_LIMITS.title);
  return {
    applicationId: facts.applicationId ?? '',
    jobId: facts.jobId,
    company: facts.companyName.trim().slice(0, AUTOFILL_TAILOR_LIMITS.company),
    title,
    postingUrl: '',
    posting,
    // v33 PROMPTS (F5): the job's family (jobFamilyOf reads its stored and AI categories).
    categoryId: null,
    family: await jobFamilyOf(deps, { jobId: facts.jobId, title }),
  };
}

/** The resume tailored from: the one named, else the profile's, else the default (an upload: its editable copy). */
const tailorSource = async (deps: AppDeps, userId: string, resumeId?: string): Promise<SourceProfile> =>
  builtProfile(deps, userId, (await resolveSource(deps, userId, resumeId)).resumeId);

// ------------------------------------------------------------------------------------------- the hourly cap

/** When each payer's own-AI tailorings were saved within the hour, per app (its database), oldest first. */
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

/**
 * 429 at the plan's tailorings an hour (v32 FIX-PLAN, E12: FREE_/PAID_TAILOR_PER_HOUR by the plan at this call, so a
 * Paid term that ended is held to Free's) of saves within the hour, with the minutes until one leaves it (the server
 * Tailor's refusal). UNLIMITED (Paid's default): never refused. Every save is noted, whatever the plan.
 */
async function assertUnderHourlyCap(deps: AppDeps, payer: PersonPayer): Promise<void> {
  const max = await hourlyLimitOf(deps, payer, 'tailorsPerHour');
  if (max === UNLIMITED) return;
  const saves = savesWithinHour(deps, payer.id);
  if (saves.length < max) return;
  const freesAt = saves[saves.length - max]! + HOUR_MS;
  const seconds = Math.max(1, Math.ceil((freesAt - deps.now().getTime()) / 1000));
  throw tailorRateLimited(deps, seconds, max);
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

/** v33 SHARE-8: the call's profile and payer (SaveContext's parts the tailoring reads). */
type TailorCtx = Pick<SaveContext, 'deps' | 'userId' | 'profile' | 'canaries'>;

export async function tailorContext(ctx: TailorCtx, ids: TailorIds) {
  const { deps, userId } = ctx;
  const payer = ctx.profile.payer;
  const job = await tailorJob(deps, userId, ids);
  // Refused before the person's AI does any work, and again at the save.
  await assertRoomForResumes(deps, userId, 1, payer);
  await assertUnderHourlyCap(deps, payer);
  const source = await tailorSource(deps, userId, ids.resumeId);
  const work = await workFor(deps, userId, job.jobId);
  const held = await heldAnalysis(deps, userId, job, work);
  const named = namedIds(ids, job, source);
  if (!held) {
    return {
      feature: 'tailor',
      step: 'analysis',
      ...ownAnalyzeParts(job.posting, tripwireLine(work.canary), job.family),
      output: saveLine(named, '{"analysis": <the JSON object>}'),
      next: 'After that save, call own_ai_context again with the same ids: it answers the resume prompt.',
    };
  }
  // v33 SHARE-8: another person's resume in the profile's wrapper (review: the resume's slot alone, so the posting's own
  // wrappers in the input stay TailorIT's).
  const parts = ownTailorParts(source.profile, held.analysis, personFitOf(source, job), ownerWrap(ctx.profile));
  return {
    feature: 'tailor',
    step: 'resume',
    ...parts,
    output: saveLine(named, '{"resume": <the JSON object>}'),
  };
}

export async function tailorSave(ctx: TailorCtx, ids: TailorIds, output: unknown) {
  const { deps, userId } = ctx;
  const payer = ctx.profile.payer;
  const job = await tailorJob(deps, userId, ids);
  if (!isRecord(output) || (output.analysis === undefined) === (output.resume === undefined)) {
    throw validationFailed(OUTPUT_SHAPE);
  }
  refuseGrantTripwire(ctx, output); // v33 SHARE-8
  const work = await workFor(deps, userId, job.jobId);
  const held = await heldAnalysis(deps, userId, job, work);

  if (output.analysis !== undefined) {
    // A held analysis is kept as it is: one of a Prepare of the same job is never replaced from here.
    if (held) throw new AppError('conflict', ANALYSIS_HELD);
    const raw = normalizeAnalysis(output.analysis);
    const keywords = toJobAnalysis(raw, job.posting, referenceFor(job.family)).atsKeywords ?? [];
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
  await assertRoomForResumes(deps, userId, 1, payer);
  await assertUnderHourlyCap(deps, payer);
  const source = await tailorSource(deps, userId, ids.resumeId);
  const { profile } = source;
  const { analysis } = held;
  // v33 PROMPTS (F5): written for the person's field (else the job's): its numbers and its skill library.
  const fit = personFitOf(source, job);
  const canaries = tripwiresOf(ctx, work.canary); // v33 SHARE-8
  const { draft, dropped } = draftOfResume(output.resume, 'resume', profile, analysis, canaries, fit);
  const problem = contentProblem(stringsOf(draft), canaries);
  if (problem) throw refuseContent(problem);
  const finished = withProfileFiguresKept(finishedDraft(draft, analysis, profile, fit), profile);
  const document = tailoredDocument(source.editor, finished, { templateId: source.templateId, profile, skills: fit.skills });
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
    payer, // v33 SHARE-8: the owner's last resume places kept (insertResume, behind the person's lock)
  });
  noteSave(deps, payer.id);
  const scoreBefore = buildAtsReport(sourceAsTailored(source), analysis, profile, fit.numbers).score;
  return {
    feature: 'tailor',
    step: 'resume',
    resumeId: saved.resumeId,
    name: title,
    applicationId: saved.applicationId,
    ats: atsSummary(buildAtsReport(finished, analysis, profile, fit.numbers), scoreBefore),
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}
