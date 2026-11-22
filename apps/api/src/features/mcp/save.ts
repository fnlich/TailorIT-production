import { documentPlainText, normalizeResumeDocument, printedDocument } from '@tailorit/shared';
import type { AutofillKnownQuestion, AutofillSubmittedAnswerValue } from '@tailorit/shared/autofill';
import type { McpPromptMode } from '@tailorit/shared/mcp';
import { nowIso, type AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { holdsPostalAddress, namesForeignContact, NO_CONTACTS } from '../autofill/ai/contacts';
import { textIsSensitive } from '../autofill/ai/statements';
import { stringsOf } from '../autofill/ai/tasks';
import { screenAnswer } from '../autofill/answers/screen';
import { createLetterRepository } from '../cover-letters/repository';
import { readableForAi } from '../job-analysis/service';
import { updateResumeDocument } from '../resumes/repository';
import { buildAtsReport, type AtsReport } from '../tailor/ats';
import { fillCompanyName, findStyleIssues, humanizeText, withoutNightCliches } from '../tailor/humanize';
import { asText, parseKeywords, toJobAnalysis, withMissedKeywords, type RawAnalysis } from '../tailor/keywords';
import { keptFacts, tailoredDocument } from '../tailor/mapping';
import { letterHtml, tailoredTitle } from '../tailor/output';
import {
  describeProfile,
  draftFromAnswer,
  draftWithRevision,
  finishedDraft,
  isUsableDraft,
  letterParagraphs,
  letterText,
  revisionRound,
  tailorFitOf,
  withProfileFiguresKept,
  type RevisionIssues,
  type TailorFit,
} from '../tailor/pipeline';
import { postingHashOf } from '../tailor/store';
import type { Profile, TailoredContent } from '../tailor/types';
import { chosenContent, chosenResume } from './chosen';
import { heldAnalysis, mcpJobOf, personFitOf, sourceProfile, type McpJob, type SourceProfile } from './job';
import { referenceFor } from '../tailor/skills/reference';
import { assertResumeEditable, assertRoomForResumes } from './limits';
import {
  finishedView,
  finishIfDone,
  mcpPrepareOf,
  nextAfterAnalysis,
  nextAfterSave,
  nextJob,
  nextRevision,
  nextTailor,
} from './next';
import { normalizeAnalysis, normalizeMissing, type KeywordRow } from './normalize/analysis';
import { normalizeAnswer, type AnswerShapeRefusal } from './normalize/answers';
import { normalizeLetter } from './normalize/letter';
import { isRecord, refuse } from './normalize/refuse';
import { isWholeResume, normalizeResume, normalizeRevisionEdits, REVISION_SHAPE, type DroppedRole } from './normalize/resume';
import type { McpPrepare, PrepareAdapter } from './prepare';
import { profilesPreparing, type McpCallerInfo, type McpProfile } from './profiles'; // v33 SHARE-8
import type { SetScope } from './result-sets'; // v33 SHARE-8
import { answerShape, openQuestions } from './questions';
import { contentProblem, CONTENT_REFUSALS, holdsFencedData, type ContentProblem } from './screen';
import { mcpSettings } from './settings';
import { answerNamesOtherProfile, refuseWrittenLeaks } from './written'; // v34 MCPDIR
import { keepAnalysis, keepLetter, keepResume, workFor } from './work';

// What the MCP save tools do with what the person's own AI wrote (v1.5 M): v1.4's code steps, never its model calls.
// v1.5 Q1: every save first normalizes what it is sent, strictly, to the structure TailorIT's own prompts answer
// (normalize/: keywords as rows, the resume's roles matched to the source's, the letter's 2 to 4 paragraphs, answers in
// the question's shape with option labels matched), whether it came from TailorIT's prompt (prepare_prompt) or the
// person's own; what cannot be normalized is refused with the field and the shape expected. Every answer names the
// exact next call (next.ts), and a resume save's "revise" honours the account's revision rounds (settings.ts).
// - An analysis: tailor_builder0's keyword filtering (toJobAnalysis: only terms the posting holds, in its words, the
//   library's skills backfilled), kept for the account alone (work.ts).
// - A resume: read as tailorResume reads its model's answer (normalizeResume: employers, titles, dates and places from
//   the profile, bullets capped, figure bullets kept), humanized, checked for what a revision should fix (the round's
//   issues), finished (clauses cut, night mentions out, skill lists filled, sized and grouped), its profile figures
//   brought back (withProfileFiguresKept), laid over the source document (the protected facts by construction,
//   keptFacts checked) and stored in the job's draft (P's saveDraftResume: a tailored resume linked to the Tracker
//   entry). A later save replaces the resume the last one stored, in place, while the draft still holds it and the
//   person has not edited it; otherwise it stores a new one.
// - A letter: humanized as v1.4 keeps one, its company filled in, placed on the profile's letter template and stored
//   in the draft (P's saveDraftLetter), replaced in place as the resume is.
// - Answers: each checked against the job's open questions (questions.ts) and refused when it is to any other
//   question, does not fit its question, or states something sensitive or a contact detail; the rest go to the draft
//   (P's saveDraftAnswers, which screens them again). A question left out is not ready.
// Every text the AI wrote is screened first (screen.ts: copied data labels and tripwires, AI talk, prompt markup): a
// resume or a letter that fails keeps nothing, an answer that fails is refused alone.
// v3.0 D2: async. A save's writes (the resume or letter, the draft's link to it, this file's work row) land in one
// transaction (deps.db.tx). The resume, letter and draft helpers it calls there (features/resumes, cover-letters,
// prepare) must join it: they use deps.db.atomic or the open tx, never a tx of their own, and no outside I/O.

export const NO_ANALYSIS =
  'There is no keyword analysis of this posting yet. Get the step "analyze" (prepare_prompt), write it, and save it ' +
  'with prepare_save_analysis first.';
export const NO_KEYWORDS_KEPT =
  'None of these keywords is in the posting in its own words, so TailorIT kept none. Copy each term exactly as the ' +
  'posting writes it, and save the analysis again.';
export const NO_FIRST_PASS =
  'Save the analyze step\'s answer (prepare_save_analysis with "analysis") before the review\'s missing keywords.';
export const TOO_LITTLE_POSTING =
  'This posting has too little text to tailor a resume to. Skip the resume with prepare_mark ("part": "resume", ' +
  '"skipped"); a cover letter can still be written from the step "write_cover_letter".';
export const NOT_A_RESUME =
  'That is not a resume: it needs a summary and, for a candidate with experience, bullets under at least one role. ' +
  'Write the whole tailor-resume JSON object and save it again.';
export const NO_DRAFT_TO_REVISE =
  'There is no saved resume of this job to revise. Save the tailor step\'s resume with prepare_save_resume first.';
// v34 MCPDIR (the directory review, finding 3): the save keeps the facts itself, so a failed check is TailorIT's own
// failure (an internal error): what helps is one more save, then marking the resume failed.
export const FACTS_CHANGED =
  "TailorIT could not keep this resume's facts as the person's resume has them (logged for the operator). Save it once " +
  'more; if it is refused again, mark the resume failed with prepare_mark and go on.';
/** v2.0 P5: a save for a job no Prepare of the person's AI covers. */
export const NOT_STARTED =
  'This job is not being prepared for your AI, so TailorIT keeps nothing for it. Prepare exactly the jobs that pass: ' +
  'filter_jobs, then prepare_start with its runId; prepare_queue lists the jobs waiting for you.';
/** v2.0 P5 (A29): a resume save for a job whose resume mode keeps an existing resume. */
export const RESUME_CHOSEN =
  "This job keeps the resume TailorIT chose by the person's resume mode (default or similar), so no tailored resume " +
  'is saved for it. Write the cover letter and the answers from that resume (prepare_job_context names it).';

export interface SaveContext {
  deps: AppDeps;
  /**
   * v33 SHARE-8: whose data the call reads and writes: the profile's owner (= profile.userId; the caller on "me"). The
   * caller's own (settings, custom instructions, the read mark, own-AI saves' limits, reports) is `caller.id`.
   */
  userId: string;
  prepare: PrepareAdapter;
  /** v2.0 P5: the token the request came with (the instructions' read pointer); null in a direct call. */
  tokenId?: string | null;
  // v33 SHARE-8 (PLAN-sharing.md §7: SaveContext split into the caller and the profile; features/mcp/profiles.ts)
  caller: McpCallerInfo;
  profile: McpProfile;
  /** The profile the answers' next calls name ("me" or its key) once the caller has another profile; null: none. */
  hint: string | null;
  /** The result sets' owner: the caller on this profile (result-sets.ts). */
  sets: SetScope;
  /**
   * Every tripwire of the caller's grants (live or ended), handed out before v3.4: a save holding one is refused, on any
   * profile (v34 MCPDIR: as is one holding a data label or its id, screen.ts holdsFencedData).
   */
  canaries: readonly string[];
  // end v33 SHARE-8
}

/** v33 SHARE-8: the job's tripwire and the caller's grants' (every save's content screen; words handed out before v3.4). */
export const tripwiresOf = (ctx: Pick<SaveContext, 'canaries'>, ...more: readonly string[]): string[] => [...new Set([...more, ...ctx.canaries])];

/**
 * v33 SHARE-8: refused as `canary` when `value` holds a tripwire of the caller's grants (a save on any profile). v34
 * MCPDIR: or a data label or its id (fenced text copied into a save). The fence's markers (<untrusted> tags, the JSON
 * sentinels) are refused in the written saves (contentProblem: a resume, a letter, answers, own-AI documents) and
 * defused in the short fields these guard (a report, a reason: untrustedText), as before.
 */
export function refuseFencedData(ctx: Pick<SaveContext, 'canaries'>, value: unknown): void {
  if (holdsFencedData(stringsOf(value), ctx.canaries)) throw refuseContent('canary');
}

/** v2.0 P5: the job's active Prepare of the person's AI; refused (conflict) when there is none. */
export async function requireMcpPrepare(ctx: SaveContext, job: McpJob): Promise<McpPrepare> {
  const prepare = await mcpPrepareOf(ctx, job.applicationId);
  if (!prepare) throw new AppError('conflict', NOT_STARTED);
  return prepare;
}

/** The mode a call's next steps are worded for: the call's own, else the account's setting. v33 SHARE-8: the caller's. */
export const modeOf = async (ctx: SaveContext, mode?: McpPromptMode): Promise<McpPromptMode> =>
  mode ?? (await mcpSettings(ctx.deps, ctx.caller.id)).promptMode;

/** The ATS report as the save answers it: the scores and what is missing, never the resume's words. */
export function atsSummary(report: AtsReport, scoreBefore: number) {
  return {
    score: report.score,
    scoreBefore,
    hardSkills: { score: report.hardSkills.score, matched: report.hardSkills.matched, total: report.hardSkills.total },
    softSkills: { score: report.softSkills.score, matched: report.softSkills.matched, total: report.softSkills.total },
    jobTitleFound: report.jobTitle.found,
    searchability: report.searchability.score,
    missingHardSkills: report.missingHardSkills,
    missingSoftSkills: report.missingSoftSkills,
  };
}

const issuesView = (issues: RevisionIssues) => ({
  missingKeywords: issues.missing,
  underusedKeywords: issues.underused,
  styleIssues: issues.style.map(({ where, problem }) => ({ where, problem })),
});

/** The source resume's own words, scored against the job: the "from 54" of "from 54 to 91". */
export function sourceAsTailored(source: SourceProfile): TailoredContent {
  const { profile } = source;
  return {
    title: profile.title,
    summary: profile.summary,
    experience: profile.experience,
    skills: profile.skills,
    hardSkills: profile.skills,
    softSkills: documentPlainText(printedDocument(source.editor)).softSkills ?? [],
    strengths: profile.strengths,
  };
}

export const refuseContent = (problem: ContentProblem) => new AppError('validation_failed', CONTENT_REFUSALS[problem]);

/** v34 MCPDIR: the texts whose contacts are the person's own for a text written from a resume (written.ts). */
export const evidenceSources = (evidence: { text: string; profile: unknown } | null | undefined): string[] =>
  evidence ? [evidence.text, JSON.stringify(evidence.profile)] : [];
/** v34 MCPDIR: evidenceSources of a tailoring's source, with its document. */
export const resumeSources = (source: Pick<SourceProfile, 'editor' | 'evidence'>): string[] => [
  JSON.stringify(source.editor),
  ...evidenceSources(source.evidence),
];

/** A list cut short for an answer. */
const MAX_LISTED = 50;

// ------------------------------------------------------------------------------------------------------- analysis

/** The rows of `rows` that today's filtering keeps none of (not in the posting, excluded, the job title...). */
function droppedTerms(rows: readonly KeywordRow[], posting: string, title: string): string[] {
  return rows.filter((row) => parseKeywords([row], posting, false, title).length === 0).map((row) => row[0]);
}

export async function saveAnalysis(
  ctx: SaveContext,
  jobId: number,
  input: { analysis?: unknown; missing?: unknown },
  mode?: McpPromptMode,
) {
  const { deps, userId } = ctx;
  const job = await mcpJobOf(deps, userId, jobId);
  await requireMcpPrepare(ctx, job);
  if (!readableForAi(job.posting)) throw new AppError('validation_failed', TOO_LITTLE_POSTING);
  refuseFencedData(ctx, [input.analysis, input.missing]); // v33 SHARE-8, v34 MCPDIR
  const work = await workFor(deps, userId, jobId);
  const postingHash = postingHashOf(job.posting);
  let raw: RawAnalysis;
  let sent: KeywordRow[];
  if (input.analysis !== undefined) {
    const normalized = normalizeAnalysis(input.analysis);
    raw = normalized;
    sent = normalized.keywords;
  } else {
    sent = normalizeMissing(input.missing);
    const first = work.postingHash === postingHash ? (work.analysisRaw as RawAnalysis | null) : null;
    if (!first) throw new AppError('validation_failed', NO_FIRST_PASS);
    raw = withMissedKeywords(first, sent);
  }
  const analysis = toJobAnalysis(raw, job.posting, referenceFor(job.family)); // v33 PROMPTS: the job family's library
  const keywords = analysis.atsKeywords ?? [];
  if (keywords.length === 0) throw new AppError('validation_failed', NO_KEYWORDS_KEPT);
  await keepAnalysis(deps, userId, jobId, postingHash, raw);
  const how = await modeOf(ctx, mode);
  return {
    jobId,
    kept: keywords.length,
    sent: sent.length,
    dropped: droppedTerms(sent, job.posting, asText(raw.title)).slice(0, MAX_LISTED),
    // The plan as rows: your own prompt needs it for the resume; TailorIT's tailor prompt carries it.
    ...(how === 'own-prompt'
      ? { keywords: keywords.map((k) => [k.term, k.type, k.kind, k.priority ?? 'strong']) }
      : {}),
    next: input.analysis !== undefined ? nextAfterAnalysis(jobId, how, ctx.hint) : nextTailor(jobId, how, ctx.hint),
  };
}

// --------------------------------------------------------------------------------------------------------- resume

/**
 * The resume the last save stored, when a later save may replace it in place: the job's draft still holds it as its
 * ready resume, and the person has not edited it since (its revision is the one the save left).
 */
async function replaceableResume(
  ctx: SaveContext,
  applicationId: string,
  work: { resumeId: string | null; resumeRevision: number | null },
): Promise<string | null> {
  const { deps, userId } = ctx;
  if (!work.resumeId || work.resumeRevision === null) return null;
  const draft = await ctx.prepare.draft(deps, userId, applicationId);
  if (!draft || draft.resumeStatus !== 'ready' || draft.resumeId !== work.resumeId) return null;
  const row = await deps.db.one<{ document_revision: number }>(
    "SELECT document_revision FROM resumes WHERE id = ? AND user_id = ? AND kind = 'built'",
    [work.resumeId, userId],
  );
  return row?.document_revision === work.resumeRevision ? work.resumeId : null;
}

/** A whole resume, normalized and read as tailorResume reads its model's answer (refused when it is none). */
export function draftOfResume(
  value: unknown,
  field: 'resume' | 'revision',
  profile: Profile,
  analysis: Parameters<typeof draftFromAnswer>[2],
  canary: string | readonly string[], // v33 SHARE-8: the job's tripwire and the caller's grants'
  fit: TailorFit = tailorFitOf(),
): { draft: TailoredContent; dropped: DroppedRole[] } {
  const problem = contentProblem(stringsOf(value), canary);
  if (problem) throw refuseContent(problem);
  const { resume, dropped } = normalizeResume(value, profile, field);
  if (!isUsableDraft(resume, profile)) throw new AppError('validation_failed', NOT_A_RESUME);
  return { draft: draftFromAnswer(resume, profile, analysis, fit), dropped };
}

export async function saveResume(
  ctx: SaveContext,
  jobId: number,
  input: { resume?: unknown; revision?: unknown },
  mode?: McpPromptMode,
) {
  const { deps, userId } = ctx;
  const job = await mcpJobOf(deps, userId, jobId);
  const prepare = await requireMcpPrepare(ctx, job);
  if (prepare.resumeMode !== 'tailor') throw new AppError('conflict', RESUME_CHOSEN);
  if (!readableForAi(job.posting)) throw new AppError('validation_failed', TOO_LITTLE_POSTING);
  const work = await workFor(deps, userId, jobId);
  const held = await heldAnalysis(deps, userId, job, work);
  if (!held) throw new AppError('validation_failed', NO_ANALYSIS);
  // v2.0 P5: the resume limit: room for the first resume; a later save re-saves that one's document in place, which is
  // an edit (refused at or over the limit, as the editor's save is). v2.0 INT: except this Prepare's own revision round
  // of the resume it made (the save that made it may have brought the count to the limit; the job must still queue).
  const replaceable = await replaceableResume(ctx, job.applicationId, work);
  if (replaceable) await assertResumeEditable(deps, userId, { prepareId: prepare.id, resumeId: replaceable });
  else await assertRoomForResumes(deps, userId, 1, ctx.profile.payer); // v33 SHARE-8: B never takes A's last places
  const { analysis } = held;
  const source = await sourceProfile(deps, userId);
  const { profile } = source;
  const settings = await mcpSettings(deps, ctx.caller.id); // v33 SHARE-8: the caller's revision rounds
  const canaries = tripwiresOf(ctx, work.canary); // v33 SHARE-8
  // v34 MCPFAN (the MCPFAN security review's runs; the coordinator's decision 9): fenced data first, so a copied label
  // or tripwire is refused as such (a legacy tripwire's digit run would otherwise read as a phone number below).
  if (holdsFencedData(stringsOf(input.resume ?? input.revision), canaries)) throw refuseContent('canary');
  // v34 MCPDIR (the security review, finding 1): no contact that is not the person's own, no other profile's details.
  await refuseWrittenLeaks(ctx, input.resume ?? input.revision, resumeSources(source));
  // v33 PROMPTS (F5): written for the person's field (else the job's): its numbers and its skill library.
  const fit = personFitOf(source, job);

  let draft: TailoredContent;
  let round: number;
  let dropped: DroppedRole[] = [];
  if (input.revision !== undefined) {
    if (!work.draft) throw new AppError('validation_failed', NO_DRAFT_TO_REVISE);
    if (!isRecord(input.revision)) throw refuse('revision', REVISION_SHAPE, input.revision);
    if (isWholeResume(input.revision)) {
      ({ draft, dropped } = draftOfResume(input.revision, 'revision', profile, analysis, canaries, fit));
    } else {
      const problem = contentProblem(stringsOf(input.revision), canaries);
      if (problem) throw refuseContent(problem);
      const edits = normalizeRevisionEdits(input.revision, work.draft);
      draft = draftWithRevision(work.draft, { ...edits.revision }, fit);
      dropped = edits.dropped;
    }
    round = work.saves + 1;
  } else {
    ({ draft, dropped } = draftOfResume(input.resume, 'resume', profile, analysis, canaries, fit));
    round = 1;
  }
  const problem = contentProblem(stringsOf(draft), canaries);
  if (problem) throw refuseContent(problem);

  const check = revisionRound(draft, analysis, profile, round, settings.reviseRounds, fit);
  const finished = withProfileFiguresKept(finishedDraft(draft, analysis, profile, fit), profile);
  const document = tailoredDocument(source.editor, finished, { templateId: source.templateId, profile, skills: fit.skills });
  if (!keptFacts(normalizeResumeDocument({ ...source.editor, templateId: source.templateId }), document)) {
    throw new AppError('internal', FACTS_CHANGED);
  }

  const title = tailoredTitle(job.company, job.title);
  const saved = await deps.db.tx(
    async (t) => {
      const previous = await replaceableResume(ctx, job.applicationId, work);
      let resumeId: string;
      if (previous) {
        await updateResumeDocument(deps, userId, previous, document, title);
        resumeId = previous;
      } else {
        resumeId = (
          await ctx.prepare.saveResume(deps, userId, job.applicationId, { document, sourceResumeId: source.resumeId, title }, ctx.caller.id)
        ).resumeId;
      }
      const stored = await t.one<{ document_revision: number }>('SELECT document_revision FROM resumes WHERE id = ?', [resumeId]);
      await keepResume(deps, userId, jobId, { draft, saves: round, resumeId, revision: stored!.document_revision });
      return { resumeId, replaced: previous !== null };
    },
    { label: 'mcp saveResume' },
  );

  const report = buildAtsReport(finished, analysis, profile, fit.numbers);
  const scoreBefore = buildAtsReport(sourceAsTailored(source), analysis, profile, fit.numbers).score;
  const how = await modeOf(ctx, mode);
  // While a revision is required the kit is not done: a later save queues the job.
  const finishedNow = check.revise ? { queued: false, queueFull: false } : await finishIfDone(ctx, job);
  return {
    jobId,
    resumeId: saved.resumeId,
    title,
    replaced: saved.replaced,
    round,
    revisions: { done: round - 1, max: settings.reviseRounds },
    ats: atsSummary(report, scoreBefore),
    revise: check.revise,
    issues: issuesView(check.issues),
    ...(dropped.length > 0 ? { dropped } : {}),
    ...finishedView(finishedNow),
    next: check.revise ? nextRevision(jobId, round, settings.reviseRounds, how, ctx.hint) : await nextAfterSave(ctx, job, how, finishedNow),
  };
}

// --------------------------------------------------------------------------------------------------------- letter

/** The letter as v1.4 keeps one: humanized, the small-hours cliché out, the company filled in. */
export function finishedLetter(paragraphs: readonly string[], profile: Profile, company: string): string[] {
  const text = withoutNightCliches(humanizeText(letterText(paragraphs)), describeProfile(profile));
  return letterParagraphs(fillCompanyName(text, company));
}

/** The letter's style issues, as tailor_builder0's check names them (its "cover letter" lines). */
function letterIssues(paragraphs: readonly string[], profile: Profile, keywordTerms: string[]): string[] {
  const empty: TailoredContent = {
    title: '',
    summary: '',
    experience: [],
    skills: [],
    hardSkills: [],
    softSkills: [],
    strengths: [],
    coverLetter: paragraphs.join('\n\n'),
  };
  return findStyleIssues(empty, keywordTerms, describeProfile(profile))
    .filter((issue) => issue.where === 'cover letter' && !issue.fixedByCode)
    .map(({ problem }) => problem);
}

export async function saveCoverLetter(
  ctx: SaveContext,
  jobId: number,
  input: { paragraphs?: unknown; letter?: unknown },
  mode?: McpPromptMode,
) {
  const { deps, userId } = ctx;
  const job = await mcpJobOf(deps, userId, jobId);
  const prepare = await requireMcpPrepare(ctx, job);
  const work = await workFor(deps, userId, jobId);
  const sentProblem = contentProblem(stringsOf([input.paragraphs, input.letter]), tripwiresOf(ctx, work.canary)); // v33 SHARE-8
  if (sentProblem) throw refuseContent(sentProblem);
  const normalized = normalizeLetter(input);
  // v2.0 P5, A29: the letter is the chosen resume's (the tailored one, the default or the most similar).
  const source = await chosenContent(deps, userId, await chosenResume(ctx, job, prepare));
  // v34 MCPDIR (the security review, findings 1 and 5): a letter names only the person's own links and contacts.
  await refuseWrittenLeaks(ctx, [input.paragraphs, input.letter], evidenceSources(source.evidence));
  const paragraphs = finishedLetter(normalized, source.profile, job.company);
  if (paragraphs.length === 0) throw new AppError('validation_failed', 'The letter has no text. Write it again.');
  const held = readableForAi(job.posting) ? await heldAnalysis(deps, userId, job, work) : null;
  const letters = createLetterRepository(deps);

  const saved = await deps.db.tx(
    async () => {
      const draft = await ctx.prepare.draft(deps, userId, job.applicationId);
      const previous =
        work.coverLetterId && draft?.letterStatus === 'ready' && draft.coverLetterId === work.coverLetterId
          ? await letters.getRow(work.coverLetterId, userId)
          : undefined;
      let letterId: string;
      if (previous && previous.updated_at === work.letterUpdatedAt) {
        // In place: the letter composed as the draft's own was (the profile's template, else TailorIT's layout).
        const html = letterHtml({
          paragraphs,
          profile: source.person,
          company: job.company,
          jobTitle: job.title,
          today: deps.now(),
          template: source.coverLetterTemplate,
        });
        await letters.update(previous.id, userId, {
          contentHtml: html.html,
          templateId: html.templateId,
          ...(html.fontFamily ? { fontFamily: html.fontFamily } : {}),
        });
        letterId = previous.id;
      } else {
        letterId = (await ctx.prepare.saveLetter(deps, userId, job.applicationId, { paragraphs }, ctx.caller.id)).coverLetterId;
      }
      const row = await letters.getRow(letterId, userId);
      await keepLetter(deps, userId, jobId, { id: letterId, updatedAt: row?.updated_at ?? nowIso(deps) });
      return { coverLetterId: letterId, replaced: previous !== undefined && previous.id === letterId };
    },
    { label: 'mcp saveCoverLetter' },
  );
  const finishedNow = await finishIfDone(ctx, job);
  return {
    jobId,
    coverLetterId: saved.coverLetterId,
    replaced: saved.replaced,
    paragraphs: paragraphs.length,
    styleIssues: letterIssues(paragraphs, source.profile, (held?.analysis.atsKeywords ?? []).map((k) => k.term)),
    ...finishedView(finishedNow),
    next: await nextAfterSave(ctx, job, await modeOf(ctx, mode), finishedNow),
  };
}

// -------------------------------------------------------------------------------------------------------- answers

/** Why one answer was not kept. */
export type AnswerRefusal =
  | 'not_an_open_question'
  | 'twice'
  | 'does_not_fit'
  | 'not_an_option'
  | 'ambiguous_option'
  | 'sensitive'
  | 'contact'
  | 'other_profile' // v34 MCPDIR
  | ContentProblem;

/** What each refusal reason asks of the AI (P's own reasons too), sent once per reason a save met. */
export const ANSWER_REFUSALS: Record<AnswerRefusal | 'not_this_job' | 'never_drafted', string> = {
  not_an_open_question: 'Answer only the questions prepare_job_context lists for this job, by their questionId.',
  twice: 'Answer each question once in a call.',
  does_not_fit:
    'The answer is not in its question\'s shape (answerAs): text -> a string; one_option -> one label from its ' +
    'options; options -> labels from its options; checked -> true or false.',
  not_an_option: "A label is none of the question's options: copy one exactly as the options list it.",
  ambiguous_option: "A label is as close to two of the question's options: copy the one you mean exactly.",
  sensitive: 'The answer states something sensitive (pay, work authorization, self-identification...): leave it out.',
  contact: 'The answer holds a contact detail or an address: leave those out; the profile fills them.',
  other_profile: "The answer holds another profile's name or contact details: answer from this profile's facts only.",
  canary: CONTENT_REFUSALS.canary,
  ai_talk: CONTENT_REFUSALS.ai_talk,
  prompt_markup: CONTENT_REFUSALS.prompt_markup,
  not_this_job: 'The question is not one of this job\'s.',
  never_drafted: 'Your profile answers this question on the form; it is never drafted.',
};

const MAX_TEXT_ANSWER = 10_000;

/** The refusal of one answer to an open `question`, or null when it may go to the draft. */
export function answerRefusal(
  question: AutofillKnownQuestion,
  answer: AutofillSubmittedAnswerValue,
  canary: string | readonly string[],
): AnswerRefusal | null {
  const shape = answerShape(question);
  if (answer.kind === 'text') {
    if (shape !== 'text' || [...answer.text].length > MAX_TEXT_ANSWER) return 'does_not_fit';
  } else if (answer.kind === 'checked') {
    if (shape !== 'checked') return 'does_not_fit';
  } else if (answer.kind === 'options') {
    if (shape !== 'one_option' && shape !== 'options') return 'does_not_fit';
    if (shape === 'one_option' && answer.labels.length !== 1) return 'does_not_fit';
    if (answer.labels.some((label) => !question.options.includes(label))) return 'not_an_option';
  } else {
    return 'does_not_fit';
  }
  // v2.0 FIX-C (REQ-8): the tripwire first. An answer holding copied fenced data is refused as that, whatever else it
  // holds: a data id of digits reads as a phone number to the contact screen.
  if (answer.kind === 'text' && holdsFencedData([answer.text], canary)) return 'canary';
  const screened = screenAnswer({ category: null, questionKey: question.questionKey, questionLabel: question.label, answer });
  if (screened !== null) return 'sensitive';
  if (answer.kind === 'text') {
    if (textIsSensitive(answer.text)) return 'sensitive';
    if (namesForeignContact(answer.text, NO_CONTACTS) || holdsPostalAddress(answer.text)) return 'contact';
    // An option's label is the page's own text: only what the AI wrote is screened for its own words.
    const problem = contentProblem([answer.text], canary);
    if (problem) return problem;
  }
  return null;
}

/** One answer as sent: the question's id and the answer in any of the shapes normalize/answers.ts reads. */
export interface SentAnswer {
  questionId: number;
  answer: unknown;
}

/**
 * The answers of one job. `canaries`: every tripwire of the jobs the call saves for (a batched prompt quotes them all),
 * else this job's.
 */
export async function saveAnswers(
  ctx: SaveContext,
  jobId: number,
  input: { answers: readonly SentAnswer[] },
  options: { mode?: McpPromptMode; canaries?: readonly string[] } = {},
) {
  const { deps, userId } = ctx;
  const job = await mcpJobOf(deps, userId, jobId);
  await requireMcpPrepare(ctx, job);
  const work = await workFor(deps, userId, jobId);
  const canaries = tripwiresOf(ctx, work.canary, ...(options.canaries ?? [])); // v33 SHARE-8: and the caller's grants'
  const open = openQuestions(await ctx.prepare.questions(deps, userId, job.applicationId));
  const byId = new Map(open.map((question) => [question.id, question]));
  const kept: Array<{ questionId: number; answer: AutofillSubmittedAnswerValue }> = [];
  const refused: Array<{ questionId: number; reason: string }> = [];
  const seen = new Set<number>();
  for (const { questionId, answer: given } of input.answers) {
    const question = byId.get(questionId);
    let reason: AnswerRefusal | AnswerShapeRefusal | null = !question ? 'not_an_open_question' : seen.has(questionId) ? 'twice' : null;
    let answer: AutofillSubmittedAnswerValue | null = null;
    if (!reason && question) {
      const normalized = normalizeAnswer(question, given);
      if ('refusal' in normalized) reason = normalized.refusal;
      else {
        answer = normalized.answer;
        reason = answerRefusal(question, answer, canaries);
        // v34 MCPDIR: another reachable profile's name or contact details (the contact screen refuses any contact).
        if (!reason && answer.kind === 'text' && (await answerNamesOtherProfile(ctx, answer.text))) reason = 'other_profile';
      }
    }
    seen.add(questionId);
    if (reason || !answer) refused.push({ questionId, reason: reason ?? 'does_not_fit' });
    else kept.push({ questionId, answer });
  }
  const result = await ctx.prepare.saveAnswers(deps, userId, job.applicationId, kept, ctx.caller.id);
  const refusedThere = new Set(result.refused.map((item) => item.questionId));
  const ready = new Set(kept.filter((item) => !refusedThere.has(item.questionId)).map((item) => item.questionId));
  const allRefused = [...refused, ...result.refused];
  const reasons = [...new Set(allRefused.map((item) => item.reason))] as Array<keyof typeof ANSWER_REFUSALS>;
  const finishedNow = await finishIfDone(ctx, job);
  return {
    jobId,
    saved: ready.size,
    refused: allRefused,
    ...(reasons.length > 0 ? { why: Object.fromEntries(reasons.map((reason) => [reason, ANSWER_REFUSALS[reason]])) } : {}),
    notReady: open.filter((question) => !ready.has(question.id)).map((question) => question.id),
    ...finishedView(finishedNow),
    next: await nextAfterSave(ctx, job, await modeOf(ctx, options.mode), finishedNow),
  };
}

/**
 * v1.5 Q1: the answers of several jobs in one call (a batched write_answers prompt's). Each job is saved on its own; a
 * job refused (not one of the account's Saved jobs...) answers its error and the others are kept. Every text answer is
 * screened for every job's tripwire, since one prompt quoted them all.
 */
export async function saveAnswersForJobs(
  ctx: SaveContext,
  jobs: ReadonlyArray<{ jobId: number; answers: readonly SentAnswer[] }>,
  mode?: McpPromptMode,
) {
  // v33 SHARE-8 (PLAN-sharing.md §7): one batch covers one profile. A job the caller's AI prepares on another profile
  // (and not on this one) refuses the whole call before anything is kept.
  const elsewhere = await profilesPreparing(ctx.deps, ctx.caller.id, jobs.map((job) => job.jobId));
  for (const { jobId } of jobs) {
    const owners = elsewhere.get(jobId);
    if (owners && owners.size > 0 && !owners.has(ctx.userId)) throw new AppError('validation_failed', batchOtherProfile(jobId));
  }
  const canaries: string[] = [];
  for (const { jobId } of jobs) {
    try {
      await mcpJobOf(ctx.deps, ctx.userId, jobId);
      canaries.push((await workFor(ctx.deps, ctx.userId, jobId)).canary);
    } catch (error) {
      if (!(error instanceof AppError && error.status < 500)) throw error;
    }
  }
  const results: Array<Awaited<ReturnType<typeof saveAnswers>> | { jobId: number; error: { code: string; message: string } }> = [];
  for (const { jobId, answers } of jobs) {
    try {
      results.push(await saveAnswers(ctx, jobId, { answers }, { mode, canaries }));
    } catch (error) {
      if (!(error instanceof AppError && error.status < 500)) throw error;
      results.push({ jobId, error: { code: error.code, message: error.message } });
    }
  }
  // One next for the call: the first job still waiting for a part, else the queue's next job.
  return {
    jobs: results.map((result) => {
      if (!('next' in result)) return result;
      const { next: _next, ...rest } = result;
      return rest;
    }),
    ...(results.length > 0 ? { next: await nextJobAfter(ctx, results) } : {}),
  };
}

/** After several jobs' answers: the first job still waiting for something, else the next job of the queue. */
async function nextJobAfter(ctx: SaveContext, results: ReadonlyArray<{ jobId: number; next?: string }>): Promise<string> {
  const open = results.find((result) => result.next && !result.next.startsWith('This job is done'));
  return open?.next ?? (await nextJob(ctx, results.at(-1)!.jobId));
}

/** v33 SHARE-8: a prepare_save_answers batch holding a job of another profile. */
export const batchOtherProfile = (jobId: number) =>
  `A prepare_save_answers call covers one profile: job ${jobId} is prepared on another profile. Nothing was saved: save ` +
  'each profile\'s answers in a call of its own, with its "profile".';
