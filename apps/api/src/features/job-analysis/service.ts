import { z } from 'zod';
import {
  EXPERIENCE_LEVELS,
  NEW_CATEGORY_IDS_V33,
  resolveJobFamily,
  type ExperienceLevel,
  type JobAnalysisView,
} from '@tailorit/shared';
import type { AiService, AiTaskContext, AiTaskHandler } from '../../ai/index';
import { taskInputSql } from '../../ai/payloads';
import type { EnqueueOptions } from '../../ai/queue';
import { serverCost, type Payer, type PersonPayer } from '../../core/accounts/payer'; // v33 SHARE-3 (INT-1: PersonPayer)
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/index';
import { AppError } from '../../core/http/errors';
import { projectJobs } from '../jobs/search-projection/index';
import { jobTextJoin, plainTextOf } from '../jobs/text';
import { finishAiAnalysis, type FinishedAiAnalysis } from './ai';
import { analyzeDeterministic, DETERMINISTIC_VERSION, jobFacetsOf, type AnalysisDraft, type JobFacetsDraft } from './deterministic';
import { JOB_ANALYSIS_PROMPT_HASH, JOB_ANALYSIS_PROMPT_VERSION, jobAnalysisPrompt } from '../../ai/prompts/job-analysis/job-analysis';
import {
  AI_OUTAGE_WAIT_MS,
  analysesFor,
  applyAiFacts,
  bestOf,
  clearAiAttempts,
  deferAiAttempt,
  facetsOf,
  fillFacets,
  recordAiFailure,
  refreshAnalysisLinks,
  saveAnalysis,
  type AnalysisRecord,
  type ViewFacets,
} from './store';
import type { EnsuredAnalysis, JobAnalysisService } from './types';
import { ADDED_BY_AUTOFILL } from '../ingest/types'; // v31 FIX-LINK (SEC-7)

// The analysis a job shows (docs/ARCHITECTURE.md §9): the best one stored for its text (AI > free_tailor lake >
// deterministic), with the posting's facets (soft skills, certifications and industries, required years).
//
// When Claude reads a job is AI_JOB_ANALYSIS's to say:
//   - `ingest` (the default) and `saved`: the add-time backlog (./backlog.ts) has Claude read each added job (or each
//     saved one) once. Opening or saving (one job or many) never queues anything: a view shows the best analysis so far,
//     with "Refining..." while the backlog's task for that text runs;
//   - `lazy`: the first view of a job without an AI analysis queues one, system-owned and deduplicated by the text's
//     hash, on the background slot; each account starts at most JOB_ANALYSIS_PER_ACCOUNT_PER_HOUR new ones;
//   - `off`: never.
// `get` and `ensure` complete what is missing as they read (a current deterministic analysis, the facets of one
// stored before they were read); `peek` answers the same and writes nothing.
//
// v3.0 D2-F: on the async client; deps.services.jobAnalysis is this service (job-analysis/types.ts's contract).
// v3.0 PG-F: a job's posting text is read through features/jobs/text.ts (job_texts): the job's statement joins its
// HTML (`jobTextJoin`) and the plain text is derived from it (`plainTextOf`), as ingest derived jobs.description_text.

/** A failed AI analysis of one text is not asked for again from a view (lazy mode) for this long. */
export const RETRY_AFTER_FAILURE_MS = 30 * 60_000;

/** Postings shorter than this are not worth a model call (the deterministic reading is all there is). */
export const MIN_TEXT_FOR_AI = 80;

/** Whether a posting's text is long enough to ask Claude about. */
export function readableForAi(text: string): boolean {
  return text.trim().length >= MIN_TEXT_FOR_AI;
}

/**
 * AI job analyses queued or running at once. Past this many nothing new is queued (a lazy view shows the
 * deterministic analysis and a later view asks again), so people's own AI requests (imports, letters) never wait
 * behind a pile of system work on the CLI's few slots.
 */
export const MAX_PENDING_ANALYSES = 3;

/**
 * New AI analyses one account can start per hour by opening jobs (lazy mode; a sliding window, in memory) is the
 * constant JOB_ANALYSIS_PER_ACCOUNT_PER_HOUR (v30 ST1: it was AI_ANALYSES_PER_USER_PER_HOUR here; an admin's change
 * applies at the next view). Past it, that account sees the current best analysis without "Refining..." until the
 * hour has moved on; jobs that already have an AI analysis, or one under way, are not limited. Without it, one script
 * sweeping job ids would keep the CLI busy with system work, on the owner's subscription, for as long as it ran.
 */
const BUDGET_WINDOW_MS = 60 * 60_000;

export const JobAnalysisTaskInputSchema = z.object({
  jobId: z.number().int().positive(),
  contentHash: z.string().min(16).max(128),
  version: z.number().int().positive(),
  /** v2.0: the Prepare that forced this reading (05's step b): the AI queue adds its cost to prepare_jobs.cost_micros. */
  prepare: z.object({ id: z.string().min(1).max(64) }).optional(),
});
export type JobAnalysisTaskInput = z.infer<typeof JobAnalysisTaskInputSchema>;

export interface JobAnalysisTaskResult {
  analysisId: number | null;
  skipped?: string;
}

interface JobRow {
  id: number;
  title: string;
  content_hash: string;
  /** The posting's HTML (job_texts; '' for a job without a text). */
  description_html: string;
  /** Its plain text, derived (plainTextOf). */
  description_text: string;
  locations_text: string;
  experience_levels: string;
  category_id: string | null;
  subcategory_ids: string;
  analysis_id: number | null;
  company_name: string;
}

const JOB_SELECT =
  "SELECT j.id, j.title, j.content_hash, coalesce(jt.description_html, '') AS description_html, j.locations_text, " +
  'j.experience_levels, j.category_id, j.subcategory_ids, j.analysis_id, c.name AS company_name ' +
  `FROM jobs j JOIN companies c ON c.id = j.company_id ${jobTextJoin('j', 'jt')}`;

/** A job as SERVICE_SQL.job and jobByHash read it, with its plain text derived. */
async function readAnalysisJob(db: DbQueries, sql: string, args: Array<string | number>): Promise<JobRow | undefined> {
  const row = await db.one<Omit<JobRow, 'description_text'>>(sql, args);
  return row ? { ...row, description_text: plainTextOf(row.description_html) } : undefined;
}

function parseList(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function dedupeKeyOf(contentHash: string, version = JOB_ANALYSIS_PROMPT_VERSION): string {
  return `job_analysis:${contentHash}:${version}`;
}

/**
 * The view J2's endpoints answer: the analysis, with the job's own facts where the source of the analysis is weaker,
 * and the facets of the text's analyses (`facetsOf`).
 */
export function analysisView(
  record: AnalysisRecord,
  job: Pick<JobRow, 'experience_levels' | 'category_id' | 'subcategory_ids'>,
  refining: boolean,
  facets: ViewFacets,
): JobAnalysisView {
  const jobLevels = parseList(job.experience_levels).filter((level): level is ExperienceLevel =>
    (EXPERIENCE_LEVELS as readonly string[]).includes(level),
  );
  const fromAi = record.source === 'ai';
  const experienceLevels = fromAi && record.experienceLevels.length ? record.experienceLevels : jobLevels.length ? jobLevels : record.experienceLevels;
  // v33 (ROLES's exact edit, PROMPTS): a stored v3.3 category (NEW_CATEGORY_IDS_V33) beats an AI answer that names none
  // of v3.3's parents (v3.2's AI could not file a nurse as healthcare), as resolveJobFamily reads them.
  const newParents: readonly string[] = NEW_CATEGORY_IDS_V33;
  const storedNew = Boolean(job.category_id && newParents.includes(job.category_id));
  const aiCategory =
    fromAi && record.categoryId && record.categoryId !== 'other' && (!storedNew || newParents.includes(record.categoryId));
  const categoryId = aiCategory ? record.categoryId : (job.category_id ?? record.categoryId);
  const jobSubcategories = parseList(job.subcategory_ids);
  const subcategoryIds = aiCategory ? record.subcategoryIds : jobSubcategories.length ? jobSubcategories : record.subcategoryIds;
  return {
    source: record.source,
    refining,
    requirements: record.requirements,
    responsibilities: record.responsibilities,
    desired: record.desired,
    keywords: record.keywords,
    experienceLevels,
    categoryId,
    subcategoryIds,
    softSkills: facets.softSkills,
    terms: facets.terms,
    requiredYears: facets.requiredYears,
  };
}

export interface JobAnalysisServiceInternals extends JobAnalysisService {
  /** The `job_analysis` task on a raw input: the input read (JobAnalysisTaskInputSchema), then `analyse`. */
  readonly handler: AiTaskHandler;
  /** The `job_analysis` task on its read input (v30 ST1: the feature's jobAnalysisTask runs it). */
  analyse(task: JobAnalysisTaskInput, ctx: AiTaskContext): Promise<JobAnalysisTaskResult>;
  peek(jobId: number): Promise<EnsuredAnalysis | null>;
  /**
   * Queues Claude's analysis of a job: system-owned, deduplicated by the posting's text, charged to no one. Answers
   * the task (also one already queued or running for that text); null when none can be queued: no such job, an AI
   * analysis of the current version already, too little text, AI off or unavailable, MAX_PENDING_ANALYSES pending, or
   * (v2.0) a text read at an older version that JOB_ANALYSIS_V2_REREAD leaves out.
   */
  enqueueTask(jobId: number, priority: 'interactive' | 'background'): Promise<{ taskId: string; deduped: boolean } | null>;
  forceAnalysis(jobId: number, chargeTo: PersonPayer, prepare?: { id: string }): Promise<{ taskId: string; deduped: boolean } | null>; // v33 SHARE-3: a Payer (INT-1: only)
  /**
   * `enqueueTask` as the lazy warm-up asks it: true when an analysis is queued or running now; false also while the
   * text's last AI analysis failed less than RETRY_AFTER_FAILURE_MS ago.
   */
  enqueue(jobId: number, priority: 'interactive' | 'background'): Promise<boolean>;
  /** Whether an AI analysis of this text is queued or running. */
  isRefining(contentHash: string): Promise<boolean>;
  /** The lazy views' memory. */
  readonly memory: JobAnalysisMemory;
}

/** What the service remembers in this process: failed texts (lazy views) and each account's starts (its budget). */
export interface JobAnalysisMemory {
  /** contentHash -> when its last AI analysis failed (this process only; the lazy views' memory). */
  failedAt: Map<string, number>;
  /** userId -> when the AI analyses that account started began, within the budget window (this process only). */
  startedBy: Map<string, number[]>;
}

/** The SQL the service reads. `refining` takes the dialect's JSON read. */
export const SERVICE_SQL = {
  job: `${JOB_SELECT} WHERE j.id = ?`,
  // An owned job's text has its owner's hash (ingest/normalize.ts contentHashOf), so every job of one hash is shared,
  // or one account's: the job read for the text is never another account's.
  jobByHash: `${JOB_SELECT} WHERE j.content_hash = ? ORDER BY j.active DESC, j.id DESC LIMIT 1`,
  setAnalysis: 'UPDATE jobs SET analysis_id = ? WHERE id = ?',
  refining: (contentHash: string) =>
    `SELECT id FROM ai_tasks WHERE kind = 'job_analysis' AND status IN ('queued', 'running') AND ${contentHash} = ? LIMIT 1`,
  pending: "SELECT count(*) AS n FROM ai_tasks WHERE kind = 'job_analysis' AND status IN ('queued', 'running')",
  hasCurrentAi: "SELECT 1 AS found FROM job_analyses WHERE content_hash = ? AND source = 'ai' AND version = ?",
  // v2.0: a text Claude read at an older prompt version, and whether a job of it sits in someone's Saved Jobs.
  hasOlderAi: "SELECT 1 AS found FROM job_analyses WHERE content_hash = ? AND source = 'ai' AND version < ? LIMIT 1",
  savedText:
    'SELECT 1 AS found FROM jobs j JOIN applications p ON p.job_id = j.id ' +
    'WHERE j.content_hash = ? AND p.current_status = 1 AND p.archived_at IS NULL LIMIT 1',
  // A text a person's page gave (autofill API version 5): quoted as untrusted. Any job of the text that an account
  // owns (made from a page; so whatever became of the job pages' source) or that the job pages' source holds.
  // v31 FIX-LINK (REV-SEC SEC-7): or that a page an add read holds (Add job's career-site source: disabled, marked
  // `addedBy: autofill`; the page's JSON-LD is whatever its owner wrote), or v3.0's published page copies (`ext_page`:
  // a browser's text). Its two parameters: the text's hash, Add job's marker (ingest/types.ts ADDED_BY_AUTOFILL).
  // v35 FIX-PIPE (sec S2, the coordinator's decision 3: imported row text is untrusted page text): or a job a row's words
  // made (an import's record, `csv`/`json`: a file or a sheet anyone may have written; v3.5's jobs from an admin import's
  // rows, jobs/add/import-jobs.ts jobFromRow), or a job an admin import's row with a description landed on (a read whose
  // text the row filled: import-jobs.ts fillReadPosting; job_import_rows by idx_job_import_rows_job).
  fromPage: `SELECT 1 AS found FROM jobs WHERE content_hash = ? AND owner_user_id IS NOT NULL
       UNION ALL
       SELECT 1 FROM jobs j JOIN job_source_links l ON l.job_id = j.id JOIN job_sources s ON s.id = l.source_id
       WHERE j.content_hash = ? AND (s.kind IN ('page', 'ext_page', 'csv', 'json')
         OR (s.kind = 'career_site' AND NOT s.enabled AND s.config ->> 'addedBy' = ?)
         OR EXISTS (SELECT 1 FROM job_import_rows ir JOIN job_imports ii ON ii.id = ir.import_id
                    WHERE ir.job_id = j.id AND ii.kind = 'admin' AND ir.details ->> 'description' IS NOT NULL)) LIMIT 1`,
} as const;

/** A job row as the service reads it. */
export type { JobRow as AnalysisJobRow };

export const newJobAnalysisMemory = (): JobAnalysisMemory => ({ failedAt: new Map(), startedBy: new Map() });

/** A job's facets from its text and an analysis's lists. */
export function facetsForJob(job: JobRow, record: AnalysisRecord): JobFacetsDraft {
  return jobFacetsOf({
    title: job.title,
    text: job.description_text,
    requirements: record.requirements,
    responsibilities: record.responsibilities,
    desired: record.desired,
  });
}

/**
 * The analyses of a job's text, completed in memory: a current deterministic analysis when none is stored (made from
 * the job's title and text), and the facets of one stored before they were read. Also says what it added, so the
 * service can store it; `peek` does not. `stored` is the text's stored analyses.
 */
export function completedAnalyses(
  deps: Pick<AppDeps, 'now'>,
  job: JobRow,
  stored: AnalysisRecord[],
): { list: AnalysisRecord[]; draft: AnalysisDraft | null; facets: { id: number; facets: JobFacetsDraft } | null } {
  const deterministic = stored.find((record) => record.source === 'deterministic' && record.version === DETERMINISTIC_VERSION);
  if (!deterministic) {
    const draft = analyzeDeterministic({ title: job.title, html: job.description_html, text: job.description_text });
    const record: AnalysisRecord = {
      ...draft,
      id: 0,
      contentHash: job.content_hash,
      source: 'deterministic',
      version: DETERMINISTIC_VERSION,
      model: null,
      promptHash: null,
      createdAt: nowIso(deps),
      softSkills: draft.softSkills ?? null,
      terms: draft.terms ?? null,
      requiredYears: draft.requiredYears ?? null,
    };
    return { list: [...stored, record], draft, facets: null };
  }
  if (deterministic.softSkills === null) {
    const facets = facetsForJob(job, deterministic);
    const list = stored.map((record) => (record === deterministic ? { ...record, ...facets } : record));
    return { list, draft: null, facets: { id: deterministic.id, facets } };
  }
  return { list: stored, draft: null, facets: null };
}

/** Whether a list holds Claude's analysis of the current prompt version. */
export const hasCurrentAiIn = (list: readonly AnalysisRecord[]) =>
  list.some((record) => record.source === 'ai' && record.version === JOB_ANALYSIS_PROMPT_VERSION);

/** An account's analyses started within the window (and the map forgets accounts whose window is empty). */
export function recentStarts(memory: JobAnalysisMemory, userId: string, nowMs: number): number[] {
  const recent = (memory.startedBy.get(userId) ?? []).filter((at) => nowMs - at < BUDGET_WINDOW_MS);
  if (recent.length > 0) memory.startedBy.set(userId, recent);
  else memory.startedBy.delete(userId);
  return recent;
}

/** Notes one analysis the account started (its hourly budget). */
export function spendAnalysisBudget(memory: JobAnalysisMemory, userId: string, nowMs: number): void {
  memory.startedBy.set(userId, [...recentStarts(memory, userId, nowMs), nowMs]);
  if (memory.startedBy.size > 1000) for (const id of [...memory.startedBy.keys()]) recentStarts(memory, id, nowMs);
}

/**
 * v33 SHARE-3 (PLAN F9 "Who pays"; PLAN-sharing §5): the backlog's, the warm-up's and a lazy view's readings are a server
 * cost (nobody pays: the reading serves everyone who opens the job). A reading a Prepare forces is its starter's (a
 * Payer: B for B's Prepare on A's profile), tied to no grant: its result is public, so it is never cancelled when a
 * grant ends.
 */
const ANALYSIS_SERVER_COST = serverCost('job analysis backlog');

/** The queue options of a job's `job_analysis` task (system-owned, deduplicated by its text). */
export function analysisEnqueueOptions(
  job: Pick<JobRow, 'id' | 'content_hash'>,
  options: { priority: 'interactive' | 'background'; chargeTo: Payer; prepare?: { id: string } }, // v33 INT-1: a Payer (serverCost or the starter's)
): EnqueueOptions {
  const input: JobAnalysisTaskInput = {
    jobId: job.id,
    contentHash: job.content_hash,
    version: JOB_ANALYSIS_PROMPT_VERSION,
    ...(options.prepare ? { prepare: { id: options.prepare.id } } : {}),
  };
  return {
    kind: 'job_analysis',
    userId: null,
    chargeTo: options.chargeTo,
    input,
    priority: options.priority,
    dedupeKey: dedupeKeyOf(job.content_hash),
  };
}

export function createJobAnalysisService(deps: AppDeps, memory: JobAnalysisMemory = newJobAnalysisMemory()): JobAnalysisServiceInternals {
  const { log } = deps;
  const { db } = deps;
  const { failedAt } = memory;
  // v30 D5L: a task's input lives in ai_task_payloads (ai/payloads.ts).
  const refiningSql = SERVICE_SQL.refining(db.dialect.jsonText(taskInputSql(db.dialect), '$.contentHash'));
  const jobOf = (jobId: number) => readAnalysisJob(db, SERVICE_SQL.job, [jobId]);
  const runningOf = (contentHash: string) => db.one<{ id: string }>(refiningSql, [contentHash]);
  const hasCurrentAi = async (contentHash: string) =>
    (await db.one(SERVICE_SQL.hasCurrentAi, [contentHash, JOB_ANALYSIS_PROMPT_VERSION])) !== undefined;

  const ai = (): AiService | undefined => deps.services.ai;

  /** Every analysis of the job's text, with what completedAnalyses added stored. */
  async function analysesOf(job: JobRow): Promise<AnalysisRecord[]> {
    const { list, draft, facets } = completedAnalyses(deps, job, await analysesFor(db, job.content_hash));
    if (draft) {
      await saveAnalysis(db, { ...draft, contentHash: job.content_hash, source: 'deterministic', version: DETERMINISTIC_VERSION }, nowIso(deps));
      return analysesFor(db, job.content_hash);
    }
    if (facets) await fillFacets(db, facets.id, facets.facets);
    return list;
  }

  async function current(job: JobRow): Promise<{ best: AnalysisRecord; list: AnalysisRecord[]; hasCurrentAi: boolean }> {
    const list = await analysesOf(job);
    const best = bestOf(list)!;
    if (job.analysis_id !== best.id) await db.run(SERVICE_SQL.setAnalysis, [best.id, job.id]);
    return { best, list, hasCurrentAi: hasCurrentAiIn(list) };
  }

  function answer(job: JobRow, best: AnalysisRecord, list: readonly AnalysisRecord[], refining: boolean): EnsuredAnalysis {
    return { analysis: analysisView(best, job, refining, facetsOf(list)), refining };
  }

  async function isRefining(contentHash: string): Promise<boolean> {
    return (await runningOf(contentHash)) !== undefined;
  }

  function recentlyFailed(job: JobRow): boolean {
    const failed = failedAt.get(job.content_hash);
    return failed !== undefined && deps.now().getTime() - failed < RETRY_AFTER_FAILURE_MS;
  }

  function withinBudget(userId: string): boolean {
    return recentStarts(memory, userId, deps.now().getTime()).length < constantsOf(deps).get('JOB_ANALYSIS_PER_ACCOUNT_PER_HOUR');
  }

  /**
   * v2.0 (06, "Reading jobs again for v2"): whether a text Claude read at an older prompt version may be read again by
   * system work (the backlog, a lazy view): JOB_ANALYSIS_V2_REREAD `all`, or `saved` while a job of it sits in someone's
   * Saved Jobs; never with `off`. A text with no Claude reading at all is new work, always allowed.
   */
  async function rereadAllowed(contentHash: string): Promise<boolean> {
    if (!(await db.one(SERVICE_SQL.hasOlderAi, [contentHash, JOB_ANALYSIS_PROMPT_VERSION]))) return true;
    const scope = constantsOf(deps).get('JOB_ANALYSIS_V2_REREAD');
    if (scope === 'all') return true;
    if (scope === 'saved') return (await db.one(SERVICE_SQL.savedText, [contentHash])) !== undefined;
    return false;
  }

  /**
   * The `job_analysis` task of a job's text: system-owned (userId null, the result serves everyone who opens the job),
   * deduplicated by the text. `chargeTo` (03-ai-usage.md, A7): null for the backlog, the warm-up and a lazy view (a
   * server cost, charged to no one); the person for the reading their Prepare forces, with `prepare: {id}` in the input.
   */
  function enqueueAnalysis(
    service: AiService,
    job: JobRow,
    options: { priority: 'interactive' | 'background'; chargeTo: Payer; prepare?: { id: string } },
  ): Promise<{ taskId: string; deduped: boolean }> {
    return service.enqueue(analysisEnqueueOptions(job, options));
  }

  /**
   * Queues the AI analysis of a job's text for system work (the backlog, the warm-up, a lazy view): `chargeTo` null, a
   * server cost. `requestedBy` pays from its hourly budget (lazy views only); it is never charged.
   */
  async function startTask(
    job: JobRow,
    priority: 'interactive' | 'background',
    requestedBy?: string,
    chargeTo: Payer = ANALYSIS_SERVER_COST, // v33 SHARE-3
  ): Promise<{ taskId: string; deduped: boolean } | null> {
    const service = ai();
    if (!service || deps.config.ai.jobAnalysis === 'off' || !readableForAi(job.description_text)) return null;
    if (!(await rereadAllowed(job.content_hash))) return null;
    if (((await db.one<{ n: number }>(SERVICE_SQL.pending))?.n ?? 0) >= MAX_PENDING_ANALYSES) return null;
    if (requestedBy !== undefined && !withinBudget(requestedBy)) return null;
    try {
      const accepted = await enqueueAnalysis(service, job, { priority, chargeTo });
      if (requestedBy !== undefined && !accepted.deduped) spendAnalysisBudget(memory, requestedBy, deps.now().getTime());
      return accepted;
    } catch (error) {
      // Paused, turned off, no background slot: the deterministic analysis stands.
      log.debug(`[job-analysis] no AI analysis queued for job ${job.id}: ${(error as Error).message}`);
      return null;
    }
  }

  async function enqueueTask(jobId: number, priority: 'interactive' | 'background'): Promise<{ taskId: string; deduped: boolean } | null> {
    const job = await jobOf(jobId);
    if (!job || (await hasCurrentAi(job.content_hash))) return null;
    const running = await runningOf(job.content_hash);
    if (running) return { taskId: running.id, deduped: true };
    return startTask(job, priority);
  }

  /**
   * v2.0 (05's step b, A7): Prepare forces a version 2 analysis of its job, charged to the person (`chargeTo`). It
   * ignores JOB_ANALYSIS_V2_REREAD and the pending cap (a person's own Prepare); it joins a task already queued or
   * running for the text (deduplicated by it, so the person is charged nothing for a background reading). Null when
   * the job is gone, has a version 2 analysis already, is too short, or AI_JOB_ANALYSIS is `off`. A refusal of the
   * AI gate (ai_unavailable, ai_usage_exhausted) is thrown as the AppError. `prepare` names the Prepare in the task's
   * input (`$.prepare.id`), so the queue adds the cost to that Prepare.
   */
  async function forceAnalysis(jobId: number, chargeTo: PersonPayer, prepare?: { id: string }): Promise<{ taskId: string; deduped: boolean } | null> {
    const job = await jobOf(jobId);
    const service = ai();
    if (!job || !service || deps.config.ai.jobAnalysis === 'off' || !readableForAi(job.description_text)) return null;
    if (await hasCurrentAi(job.content_hash)) return null;
    const running = await runningOf(job.content_hash);
    if (running) return { taskId: running.id, deduped: true };
    return enqueueAnalysis(service, job, {
      priority: deps.config.ai.backgroundSlots > 0 ? 'background' : 'interactive',
      chargeTo,
      ...(prepare ? { prepare } : {}),
    });
  }

  /**
   * What a failed analysis means for the add-time backlog (job_ai_attempts): Claude failing on the text (`ai_failed`)
   * counts as an attempt and backs it off; Claude being unavailable (signed out, a usage limit, a stall) is not the
   * text's fault, so it only waits for the outage to pass, AI_OUTAGE_WAIT_MS at least.
   */
  async function noteFailure(contentHash: string, error: unknown): Promise<void> {
    try {
      const code = error instanceof AppError ? error.code : 'ai_failed';
      const message = error instanceof Error ? error.message : String(error);
      const now = deps.now();
      if (code === 'ai_failed') {
        const attempts = await recordAiFailure(db, { contentHash, version: JOB_ANALYSIS_PROMPT_VERSION, message, now });
        log.info(`[job-analysis] Claude's analysis of text ${contentHash.slice(0, 12)} failed (${attempts.attempts}); next try ${attempts.nextAttemptAt}`);
        return;
      }
      const retryAfterMs = error instanceof AppError && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0;
      const holdsEnd = Math.max(0, ...(ai()?.provider.activeHolds().map((hold) => hold.until) ?? []));
      const until = Math.max(now.getTime() + Math.max(AI_OUTAGE_WAIT_MS, retryAfterMs), holdsEnd);
      await deferAiAttempt(db, { contentHash, version: JOB_ANALYSIS_PROMPT_VERSION, message, until: new Date(until), now });
    } catch (recordError) {
      log.warn(`[job-analysis] could not record the AI failure of text ${contentHash.slice(0, 12)}`, recordError);
    }
  }

  async function storeAi(job: JobRow, finished: FinishedAiAnalysis): Promise<number> {
    const stored = await db.tx(
      async (t) => {
        // Inserting the AI row marks the Saved applications of jobs with this text for a re-match (migration 0301).
        const id = await saveAnalysis(
          t,
          {
            ...finished,
            facts: finished.v2,
            contentHash: job.content_hash,
            source: 'ai',
            version: JOB_ANALYSIS_PROMPT_VERSION,
            model: deps.config.ai.features.job_analysis.model,
            promptHash: JOB_ANALYSIS_PROMPT_HASH,
          },
          nowIso(deps),
        );
        await refreshAnalysisLinks(t, job.content_hash);
        const jobIds = await applyAiFacts(t, job.content_hash);
        // v3.0 PG-F: the jobs of this text take the reading's facts and analysis: their search rows follow, in this
        // transaction (PG-SEARCH's projection; ingest projects its own writes).
        await projectJobs(t, jobIds);
        await clearAiAttempts(t, job.content_hash, JOB_ANALYSIS_PROMPT_VERSION);
        return id;
      },
      { label: 'job analysis: store AI' },
    );
    // v2.0: the jobs of this text whose facts were computed are computed again now (their analysis changed). A failure
    // here never fails the analysis: the facts are stale, and the next read computes them.
    try {
      await deps.services.jobFacts?.refreshText(job.content_hash);
    } catch (error) {
      log.warn(`[job-analysis] the facts of text ${job.content_hash.slice(0, 12)} were not refreshed`, error);
    }
    return stored;
  }

  async function analyse(task: JobAnalysisTaskInput, ctx: AiTaskContext): Promise<JobAnalysisTaskResult> {
    const job = await jobOf(task.jobId);
    const target = job && job.content_hash === task.contentHash ? job : await readAnalysisJob(db, SERVICE_SQL.jobByHash, [task.contentHash]);
    if (!target) return { analysisId: null, skipped: 'The job is gone.' } satisfies JobAnalysisTaskResult;
    const existing = (await analysesFor(db, target.content_hash)).find((record) => record.source === 'ai' && record.version === task.version);
    if (existing) return { analysisId: existing.id } satisfies JobAnalysisTaskResult;
    try {
      const output = await ctx.runPrompt(jobAnalysisPrompt, {
        title: target.title,
        company: target.company_name,
        locations: target.locations_text,
        description: target.description_text,
        fromPage: (await db.one(SERVICE_SQL.fromPage, [target.content_hash, target.content_hash, ADDED_BY_AUTOFILL])) !== undefined,
        // v33 PROMPTS (F5): the job's field, from its stored category or its title (the analysis is about to name its own).
        family: resolveJobFamily({ categoryId: target.category_id, subcategoryIds: parseList(target.subcategory_ids), title: target.title }),
      });
      const deterministic = (await analysesOf(target)).find((record) => record.source === 'deterministic' && record.version === DETERMINISTIC_VERSION);
      const finished = finishAiAnalysis(
        output,
        { title: target.title, text: target.description_text, locations: target.locations_text },
        deterministic ?? { requirements: [], responsibilities: [], desired: [] },
      );
      const analysisId = await storeAi(target, finished);
      failedAt.delete(target.content_hash);
      return { analysisId } satisfies JobAnalysisTaskResult;
    } catch (error) {
      failedAt.set(target.content_hash, deps.now().getTime());
      // Cancelled, or the server is stopping (the task reads "interrupted"): neither says anything about the text.
      if (!ctx.signal.aborted) await noteFailure(target.content_hash, error);
      throw error;
    }
  }

  const handler: AiTaskHandler = async (input, ctx) => analyse(JobAnalysisTaskInputSchema.parse(input), ctx);

  return {
    handler,
    analyse,
    isRefining,
    enqueueTask,
    forceAnalysis,
    memory,

    async ensure(jobId, options = {}) {
      const job = await jobOf(jobId);
      if (!job) return null;
      const { best, list, hasCurrentAi: upToDate } = await current(job);
      let refining = false;
      if (!upToDate) {
        // Only lazy mode queues from a view; in the other modes "Refining..." means the backlog is reading it now.
        refining =
          (await isRefining(job.content_hash)) ||
          (deps.config.ai.jobAnalysis === 'lazy' &&
            !recentlyFailed(job) &&
            (await startTask(job, options.interactive ? 'interactive' : 'background', options.requestedBy)) !== null);
      }
      return answer(job, best, list, refining);
    },

    async get(jobId) {
      const job = await jobOf(jobId);
      if (!job) return null;
      const { best, list } = await current(job);
      return answer(job, best, list, await isRefining(job.content_hash));
    },

    async peek(jobId) {
      const job = await jobOf(jobId);
      if (!job) return null;
      const { list } = completedAnalyses(deps, job, await analysesFor(db, job.content_hash));
      return answer(job, bestOf(list)!, list, await isRefining(job.content_hash));
    },

    async enqueue(jobId, priority) {
      const job = await jobOf(jobId);
      if (!job) return false;
      if (!(await isRefining(job.content_hash)) && recentlyFailed(job)) return false;
      return (await enqueueTask(jobId, priority)) !== null;
    },
  };
}
