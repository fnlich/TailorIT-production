import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AUTOFILL_TAILOR_DEDUPE_HOURS,
  AUTOFILL_TAILOR_LIMITS,
  TailorResultSchema,
  type AutofillTailorAccepted,
  type AutofillTailorTask,
  type TailorResult,
  type TailorStep,
} from '@tailorit/shared/autofill';
import {
  documentPlainText,
  effectiveTemplateId,
  isResumeTemplateId,
  normalizeCompanyName,
  normalizeResumeDocument,
  normalizeJobTitle,
  personSideFamily,
  printedDocument,
  RoleFamilyIdSchema,
  HOUR_MS,
  UNLIMITED,
  type ResumeTemplateId,
} from '@tailorit/shared';
import { requireAi, type AiTaskContext } from '../../ai/index';
import { taskInputSql, taskResultSql } from '../../ai/payloads';
import { scopedDedupeKey, taskPayerOf, type TaskViewer } from '../../ai/queue'; // v33 SHARE-3
import { hourlyLimitOf } from '../../core/accounts/entitlements';
import type { PersonPayer } from '../../core/accounts/payer'; // v33 SHARE-3 (INT-1: a person's)
import type { AppDeps } from '../../core/context';
import { AppError, notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { editorDocumentOf } from '../../core/skills/index'; // v33 LEGACY
import { holdsCanary, speaksAsAnAi, stringsOf } from '../autofill/ai/tasks';
import { holdsPromptMarkup, untrustedLines } from '../autofill/ai/untrusted';
import { applicationFacts, jobFacts, letterProfile, visibleTemplate } from '../cover-letters/context';
import { readableForAi } from '../job-analysis/service';
import { assertRoomForResumes } from '../resumes/repository';
import { getResumeEvidence } from '../resumes/evidence';
import { jobFamilyOf, profileFamilyOf } from '../roles/index'; // v33 ROLES's resolvers (PROMPTS)
import { analyzePosting } from './analysis';
import { buildAtsReport } from './ats';
import { keptFacts, profileFromDocument, tailoredDocument } from './mapping';
import { letterHtml, storeTailored, tailoredTitle } from './output';
import { fillCompanyName } from './humanize';
import {
  generateCoverLetter,
  letterParagraphs,
  tailorFitOf,
  tailorResume,
  withProfileFiguresKept,
  type TailorRun,
  type TailorStats,
} from './pipeline';
import { createAnalysisStore, type AnalysisStore } from './store';
import { chooseTemplates, resolveSource, sourceDocument } from './source';
import { tailorTask } from './task';
import type { JobAnalysis, Profile, TailoredContent } from './types';

// Tailoring as a task of the AI queue (kind `tailor`): POST /api/tailor and /api/autofill/tailor check the request,
// choose the source resume and the templates, apply the limits (the plan's tailorings an hour, FREE_/PAID_TAILOR_PER_HOUR
// since v32 FIX-PLAN, and the same tailoring within AUTOFILL_TAILOR_DEDUPE_HOURS answers the earlier task), and queue
// it; the handler runs tailor_builder0's pipeline (analysis.ts, pipeline.ts) on the source's words and stores the result
// (output.ts). The task's input holds the posting's cleaned text; its result is a TailorResult. Its step lives in memory
// while it runs.
// The log names the account, the task and counts; never a word of a resume, a letter or a posting.
// v3.0 D2-F: on the async client.

/** A request after its route's parse: the extension's fields, and a tracker entry for the web pages. */
export interface TailorAsk {
  jobId?: number;
  applicationId?: string;
  jobDescription?: string;
  company?: string;
  title?: string;
  postingUrl?: string;
  resumeId?: string;
  resumeTemplateId?: string | null;
  coverLetterTemplateId?: string | null;
  coverLetter: boolean;
  force?: boolean;
  canaries?: string[];
}

/** What the task reads back when it runs (validated again, as every task's input is). */
export const TailorTaskInputSchema = z.object({
  signature: z.string(),
  jobId: z.number().int().positive().nullable(),
  applicationId: z.string().nullable(),
  company: z.string(),
  title: z.string(),
  postingText: z.string(),
  postingUrl: z.string(),
  sourceResumeId: z.string(),
  resumeTemplateId: z.string().nullable(),
  coverLetterTemplateId: z.string().nullable(),
  coverLetter: z.boolean(),
  page: z.object({ canaries: z.array(z.string()) }).optional(),
  // v2.0: a tailoring a Prepare started (input.$.prepare.id, the Prepare's id): never counted against the interactive
  // hourly limit (FREE_/PAID_PREPARE_PER_HOUR pace Prepares).
  prepare: z.object({ id: z.string() }).optional(),
  // end v2.0
  // v33 PROMPTS (F5): the families the prompts are written for (the person's field, else the job's when the person's is
  // general). Optional, so tasks queued before v3.3 still parse; a missing family reads as technical.
  profileFamily: RoleFamilyIdSchema.optional(),
  jobFamily: RoleFamilyIdSchema.optional(),
});
export type TailorTaskInput = z.infer<typeof TailorTaskInputSchema>;

/**
 * v20 FIX-A (REQ-10, A18): the hourly limit's refusal, MSG_TAILOR_PER_HOUR with the person's own plan's number `max`
 * (v32 FIX-PLAN, E12: FREE_/PAID_TAILOR_PER_HOUR; Free's default is the extension contract's AUTOFILL_TAILOR_PER_HOUR)
 * and the minutes until a start leaves the hour, with Retry-After. v30 ST2: through refuse(), and the own-AI tailor's
 * (mcp/own-ai-tailor.ts) too.
 */
export function tailorRateLimited(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  seconds: number,
  max: number,
): AppError {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return refuse(deps, 'rate_limited', 'MSG_TAILOR_PER_HOUR', { max, minutes }, { retryAfterSeconds: seconds });
}
export const NOT_KEPT =
  'The tailored resume was not kept: what Claude wrote did not pass the checks for text written from a job page.';
const UNREADABLE_INPUT = 'This tailoring request could not be read. Please try again.';
const FACTS_CHANGED = 'TailorIT stopped this tailoring: the tailored resume would have changed facts of your resume.';

/** The line shown for each step while a task runs. */
export const STEP_MESSAGES: Record<TailorStep, string> = {
  waiting: 'Waiting for a free AI slot...',
  analyzing: 'Reading the job description...',
  writing: 'Tailoring your resume and cover letter...',
  revising: 'Checking the ATS score and revising...',
  saving: 'Saving your documents...',
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 40);

/** The job a tailoring is for, as the dedupe sees it: the job, the tracker entry, or the posting's company and title. */
function jobKey(facts: { jobId: number | null; applicationId: string | null }, company: string, title: string, url: string) {
  if (facts.jobId !== null) return `job:${facts.jobId}`;
  if (facts.applicationId !== null) return `application:${facts.applicationId}`;
  return `posting:${sha([normalizeCompanyName(company), normalizeJobTitle(title), url.trim()].join('\u0000'))}`;
}

// v2.0 (docs/design/v2.0/05-prepare-flow.md, step d)
/** How a tailoring was asked for: from a job page (the extension), or by a Prepare (`prepare`, its id). */
export interface TailorStartOptions {
  page?: boolean;
  /**
   * A Prepare's tailoring (features/prepare): queued as background work (when the seat has a background slot), marked
   * `$.prepare.id` in its input, and neither counted against nor held to the plan's tailorings an hour: Prepares
   * are paced by FREE_/PAID_PREPARE_PER_HOUR (prepare_jobs.started_at) instead.
   */
  prepare?: { id: string };
  /**
   * v33 SHARE-3 (PLAN F9 "Who pays"): who pays: the request's payerOf(req) (B on A's profile), a Prepare's
   * payerOfRow(row). B's plan, budget, credit and tailorings an hour apply; B never joins a tailoring A pays for (nor
   * A one of B's). v33 INT-1: required (the owner's own tailoring names the owner).
   */
  payer: PersonPayer;
}
// end v2.0

export interface TailorService {
  /** Checks a request and queues its task, or answers the same tailoring done or running already. */
  start(userId: string, ask: TailorAsk, options: TailorStartOptions): Promise<AutofillTailorAccepted>; // v33 INT-1: options.payer required
  /**
   * One of the account's tailoring tasks, as GET …/tailor/:id answers it; 404 for any other task. v33 SHARE-3: a
   * TaskViewer (the request's owner, payer and grant permissions: the AI queue's getTaskFor) or, the v3.2 form, the
   * owner's id.
   */
  view(viewer: string | TaskViewer, taskId: string): Promise<AutofillTailorTask>;
  /** The queue's handler. */
  handler(input: unknown, ctx: AiTaskContext): Promise<TailorResult>;
}

export function createTailorService(deps: AppDeps, options: { store?: AnalysisStore } = {}): TailorService {
  const store = options.store ?? createAnalysisStore(deps);
  /** The step of each running task (memory only). */
  const steps = new Map<string, TailorStep>();
  const since = (ms: number) => new Date(deps.now().getTime() - ms).toISOString();

  const { db } = deps;
  // v30 D5L: a task's input and result live in ai_task_payloads (ai/payloads.ts).
  const input = taskInputSql(db.dialect);
  const sql = {
    // The insertion order among tasks finished at the same time: ai_tasks.seq (dialect.seq; v3.0 PG-F, SQLite's rowid).
    finished: `SELECT id, ${taskResultSql(db.dialect)} AS result FROM ai_tasks
        WHERE user_id = ? AND kind = 'tailor' AND status = 'succeeded' AND ${db.dialect.jsonText(input, '$.signature')} = ?
          AND finished_at >= ?
        ORDER BY finished_at DESC, ${db.dialect.seq()} DESC LIMIT 1`,
    running: "SELECT id FROM ai_tasks WHERE dedupe_key = ? AND status IN ('queued', 'running')",
    // v2.0: a Prepare's tailorings ($.prepare) are not the person's own: the Prepares an hour pace them instead. A task
    // v1.5's Prebuild started keeps its $.prebuild mark (01-data-model.md, 0822), and is not the person's own either.
    // v33 SHARE-3: counted per payer (coalesce(charge_user_id, user_id)): B's tailorings on every profile, B's alone.
    startedSince: `SELECT count(*) AS n, min(created_at) AS first FROM ai_tasks
        WHERE coalesce(charge_user_id, user_id) = ? AND kind = 'tailor' AND created_at >= ? AND ${db.dialect.jsonText(input, '$.prepare')} IS NULL
          AND ${db.dialect.jsonText(input, '$.prebuild')} IS NULL`,
    resumeExists: 'SELECT 1 AS one FROM resumes WHERE id = ? AND user_id = ?',
    letterExists: 'SELECT 1 AS one FROM cover_letters WHERE id = ? AND user_id = ?',
  };

  /** The earlier task of the same tailoring whose documents are all still there, or null. */
  async function earlierResult(userId: string, signature: string): Promise<string | null> {
    const row = await db.one<{ id: string; result: string | null }>(sql.finished, [userId, signature, since(AUTOFILL_TAILOR_DEDUPE_HOURS * HOUR_MS)]);
    if (!row?.result) return null;
    const parsed = TailorResultSchema.safeParse(JSON.parse(row.result));
    if (!parsed.success) return null;
    const { resumeId, coverLetterId } = parsed.data;
    if (!(await db.one(sql.resumeExists, [resumeId, userId]))) return null;
    if (coverLetterId && !(await db.one(sql.letterExists, [coverLetterId, userId]))) return null;
    return row.id;
  }

  /**
   * 429 past the plan's tailorings an hour (v20 FIX-A, REQ-10: the resolved constant, read at each start; v32 FIX-PLAN,
   * E12: FREE_/PAID_TAILOR_PER_HOUR by the account's plan at this start, so a Paid term that ended is held to Free's),
   * with when the oldest of them leaves the hour. UNLIMITED (Paid's default): nothing is counted or refused. Every
   * tailoring the person started in the hour counts, whatever their plan was then.
   */
  async function assertUnderHourlyLimit(payer: PersonPayer): Promise<void> {
    // v33 SHARE-3: the payer's plan and count (B's on A's profile: a Free B is held to Free's on a Paid A's).
    const max = await hourlyLimitOf(deps, payer, 'tailorsPerHour');
    if (max === UNLIMITED) return;
    const { n, first } = (await db.one<{ n: number; first: string | null }>(sql.startedSince, [payer.id, since(HOUR_MS)])) ?? { n: 0, first: null };
    if (n < max) return;
    const freesAt = (first ? Date.parse(first) : deps.now().getTime()) + HOUR_MS;
    const seconds = Math.max(1, Math.ceil((freesAt - deps.now().getTime()) / 1000));
    throw tailorRateLimited(deps, seconds, max);
  }

  return {
    async start(userId, ask, options) {
      const ai = requireAi(deps);
      // The job: TailorIT's job, the tracker entry, or the posting the request carries.
      const facts = ask.jobId
        ? await jobFacts(deps, ask.jobId, userId)
        : ask.applicationId
          ? await applicationFacts(deps, userId, ask.applicationId)
          : {
              applicationId: null,
              jobId: null,
              companyName: ask.company ?? '',
              jobTitle: ask.title ?? '',
              jobDescription: '',
            };
      const company = (facts.companyName || ask.company || '').trim();
      const title = (facts.jobTitle || ask.title || '').trim();
      const text = ask.jobDescription?.trim() ? ask.jobDescription : facts.jobDescription;
      const postingText = untrustedLines(text ?? '', AUTOFILL_TAILOR_LIMITS.jobDescription);
      const postingUrl = (ask.postingUrl ?? '').trim();

      const source = await resolveSource(deps, userId, ask.resumeId);
      // v33 PROMPTS: the person's field is the source resume's (a tailored copy inherits it); the job's is its category's.
      const profileFamily = (await profileFamilyOf(deps, userId, source.resumeId)).familyId;
      const jobFamily = await jobFamilyOf(deps, { jobId: facts.jobId, title });
      const templates = await chooseTemplates(deps, userId, {
        resumeTemplateId: ask.resumeTemplateId,
        coverLetterTemplateId: ask.coverLetterTemplateId,
      });
      // v33 SHARE-3: B's tailoring never takes A's last resume places (SHARING_RESUME_RESERVE).
      const payer = taskPayerOf(userId, options.payer);
      await assertRoomForResumes(deps, userId, 1, options.payer);

      const signature = sha(
        JSON.stringify([
          jobKey(facts, company, title, postingUrl),
          source.resumeId,
          source.revision,
          templates.resumeTemplateId,
          ask.coverLetter ? (templates.coverLetterTemplate?.id ?? null) : 'no-letter',
          // v33: a resume's Field changes no document revision, so the field written for is part of the signature.
          personSideFamily(profileFamily, jobFamily),
        ]),
      );
      const dedupeKey = `tailor:${signature}`;
      if (!ask.force) {
        const earlier = await earlierResult(userId, signature);
        if (earlier) return { taskId: earlier, deduped: true };
      }
      // v33 SHARE-3: the running twin of the same payer only (the queue's scopedDedupeKey): A's identical tailoring while
      // B's runs is A's own task, and ending B's access never stops A's.
      const running = await db.one<{ id: string }>(sql.running, [scopedDedupeKey('tailor', userId, payer.charge_user_id, dedupeKey)]);
      if (running) return { taskId: running.id, deduped: true };
      // v2.0: a Prepare is paced by its own constant (features/prepare), never held to the interactive limit.
      if (!options.prepare) await assertUnderHourlyLimit(options.payer);

      const input: TailorTaskInput = {
        signature,
        jobId: facts.jobId,
        applicationId: facts.applicationId,
        company,
        title,
        postingText,
        postingUrl,
        sourceResumeId: source.resumeId,
        resumeTemplateId: templates.resumeTemplateId,
        coverLetterTemplateId: templates.coverLetterTemplate?.id ?? null,
        coverLetter: ask.coverLetter,
        profileFamily,
        jobFamily,
        ...(options.page ? { page: { canaries: ask.canaries ?? [] } } : {}),
        ...(options.prepare ? { prepare: { id: options.prepare.id } } : {}),
      };
      // v2.0: a Prepare's tailoring waits for the background slot, so it never holds up the person's own work.
      const priority = options.prepare && deps.config.ai.backgroundSlots > 0 ? 'background' : 'interactive';
      const accepted = await ai.enqueue(
        tailorTask.enqueueOptions({ userId, input, dedupeKey, priority, chargeTo: options.payer }),
      );
      deps.log.debug(
        `[tailor] account ${userId} ${accepted.deduped ? 'joined' : 'started'} task ${accepted.taskId}` +
          `${options.page ? ' (extension)' : ''}${options.prepare ? ' (prepare)' : ''}`,
      );
      return accepted;
    },

    async view(viewer, taskId) {
      // v33 SHARE-3: as the request's reader may see it (getTaskFor: B on A's profile reads A's tailorings, documents:view).
      const ai = requireAi(deps);
      const task = typeof viewer === 'string' ? await ai.getTask(taskId, viewer) : await ai.getTaskFor(taskId, viewer);
      if (!task || task.kind !== 'tailor') throw notFound('That tailoring');
      const step: TailorStep | null =
        task.status === 'queued' ? 'waiting' : task.status === 'running' ? (steps.get(taskId) ?? 'analyzing') : null;
      const parsed = task.status === 'succeeded' ? TailorResultSchema.safeParse(task.result) : null;
      return {
        id: task.id,
        status: task.status,
        step,
        message: step ? STEP_MESSAGES[step] : null,
        result: parsed?.success ? parsed.data : null,
        error: task.error,
        createdAt: task.createdAt,
        finishedAt: task.finishedAt,
      };
    },

    async handler(rawInput, ctx) {
      const parsedInput = TailorTaskInputSchema.safeParse(rawInput);
      if (!parsedInput.success || !ctx.userId) throw new AppError('ai_failed', UNREADABLE_INPUT);
      const input = parsedInput.data;
      const userId = ctx.userId;
      const setStep = (step: TailorStep) => steps.set(ctx.taskId, step);
      try {
        return await runTailoring(deps, store, userId, input, ctx, setStep);
      } finally {
        steps.delete(ctx.taskId);
      }
    },
  };
}

/** The score of the source resume's own words against the job, for "from 54 to 91". */
function sourceAsTailored(profile: Profile, softSkills: readonly string[]): TailoredContent {
  return {
    title: profile.title,
    summary: profile.summary,
    experience: profile.experience,
    skills: profile.skills,
    hardSkills: profile.skills,
    softSkills: [...softSkills],
    strengths: profile.strengths,
  };
}

/** For a request from a job page: the answers must hold no canary, no talk of being an AI and no prompt markup. */
function pageProblem(texts: readonly string[], replies: readonly string[], canaries: readonly string[]): boolean {
  const heard = [...texts, ...replies];
  return holdsCanary(heard, canaries) || heard.some(speaksAsAnAi) || texts.some(holdsPromptMarkup);
}

async function runTailoring(
  deps: AppDeps,
  store: AnalysisStore,
  userId: string,
  input: TailorTaskInput,
  ctx: AiTaskContext,
  setStep: (step: TailorStep) => void,
): Promise<TailorResult> {
  const { row, document: stored } = await sourceDocument(deps, userId, input.sourceResumeId);
  const templateId: ResumeTemplateId = isResumeTemplateId(input.resumeTemplateId)
    ? input.resumeTemplateId
    : effectiveTemplateId(stored);
  const editor = await editorDocumentOf(deps, userId, stored, templateId); // v33 LEGACY
  const evidence = await getResumeEvidence(deps, userId, row.id);
  const profile = profileFromDocument(editor, evidence?.profile);

  const replies: string[] = [];
  // v33 PROMPTS (F5): written for the person's field (the job's when theirs is general); a task from before v3.3 reads
  // as technical. The analysis reads the job's family.
  const fit = tailorFitOf(input.profileFamily && input.jobFamily ? personSideFamily(input.profileFamily, input.jobFamily) : input.profileFamily);
  const run: TailorRun = {
    runPrompt: ctx.runPrompt,
    promptOptions: { signal: ctx.signal, ...(input.page ? { onReply: (text: string) => void replies.push(text) } : {}) },
    onStep: setStep,
    fit,
  };

  let analysis: JobAnalysis | null = null;
  let tailored: TailoredContent | null = null;
  let letter = '';
  const stats: TailorStats = { revisions: 0, firstScore: 0, finalScore: 0 };
  if (readableForAi(input.postingText)) {
    setStep('analyzing');
    analysis = (
      await analyzePosting(run, input.postingText, input.title, store, deps.config.ai.features.tailor.model, input.jobFamily)
    ).analysis;
    tailored = withProfileFiguresKept(
      await tailorResume(run, profile, analysis, input.company, { coverLetter: input.coverLetter, stats }),
      profile,
    );
    letter = tailored.coverLetter ?? '';
  }
  if (input.coverLetter && !letter.trim()) {
    // No posting text to tailor to, or the letter call failed: tailor_builder0's fallback, generate-cover-letter.
    setStep('writing');
    letter = await generateCoverLetter(run, profile, input.company, input.title);
  }
  const paragraphs = input.coverLetter ? letterParagraphs(fillCompanyName(letter, input.company)) : [];

  if (input.page) {
    const texts = [...(tailored ? stringsOf(tailored) : []), ...paragraphs];
    if (pageProblem(texts, replies, input.page.canaries)) {
      deps.log.debug(`[tailor] task ${ctx.taskId}: not kept (a check for text from a job page)`);
      throw new AppError('ai_failed', NOT_KEPT);
    }
  }
  // v30 ST0: MSG_AI_CANCELLED, the AI queue's own words for a cancelled request (v30 ST2: through refuse()).
  if (ctx.signal.aborted) throw refuse(deps, 'ai_failed', 'MSG_AI_CANCELLED');

  setStep('saving');
  const title = tailoredTitle(input.company, input.title);
  const document = tailoredDocument(editor, tailored, { templateId, profile, skills: fit.skills });
  // The protected facts (employers, titles, dates, education and every other section) are the source's, by
  // construction; checked again here so that no change to the mapping can ever store a resume that alters them.
  if (!keptFacts(normalizeResumeDocument({ ...editor, templateId }), document)) {
    throw new AppError('internal', FACTS_CHANGED);
  }
  // A template deleted since the request reads as none.
  const coverLetterTemplate = input.coverLetterTemplateId
    ? await visibleTemplate(deps, userId, input.coverLetterTemplateId)
    : null;
  const person = evidence
    ? letterProfile(evidence)
    : {
        fullName: profile.name,
        email: profile.contact.email,
        phone: profile.contact.phone,
        location: profile.contact.location,
        linkedin: '',
        portfolio: '',
        title: profile.title,
      };
  const html =
    input.coverLetter && paragraphs.length > 0
      ? letterHtml({
          paragraphs,
          profile: person,
          company: input.company,
          jobTitle: input.title,
          today: deps.now(),
          template: coverLetterTemplate,
        })
      : null;
  // v33 SHARE-3: a tailoring B pays for on A's profile never takes A's last resume places (checked again as it stores).
  if (ctx.payer?.grantId) await assertRoomForResumes(deps, userId, 1, ctx.payer);
  const saved = await storeTailored(deps, userId, {
    title,
    document,
    sourceResumeId: row.id,
    letter: html,
    target: {
      jobId: input.jobId,
      applicationId: input.applicationId,
      company: input.company,
      jobTitle: input.title,
      postingUrl: input.postingUrl,
    },
    postingText: input.postingText,
    ...(ctx.payer ? { payer: ctx.payer } : {}), // v33 SHARE-3 (review): checked again behind the person's lock
  });

  const softSkills = documentPlainText(printedDocument(editor)).softSkills ?? [];
  const ats =
    analysis && tailored
      ? {
          ...buildAtsReport(tailored, analysis, profile, fit.numbers),
          scoreBefore: buildAtsReport(sourceAsTailored(profile, softSkills), analysis, profile, fit.numbers).score,
        }
      : null;
  deps.log.debug(
    `[tailor] task ${ctx.taskId} for account ${userId}: ${analysis ? `ATS ${stats.firstScore} -> ${ats?.score}` : 'no posting text'}, ` +
      `${stats.revisions} revision(s), letter ${saved.coverLetterId ? 'written' : 'not asked'}`,
  );
  return {
    resumeId: saved.resumeId,
    title,
    resumeTemplateId: templateId,
    coverLetterId: saved.coverLetterId,
    coverLetterTemplateId: saved.coverLetterTemplateId,
    applicationId: saved.applicationId,
    ats,
  };
}
