import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EMPLOYMENT_TYPE_LABEL,
  WORK_ARRANGEMENT_LABEL,
  industryLabel,
  salaryWord,
  type CustomFilterState,
  type JobFactsView,
  type PrepareFilters,
} from '@tailorit/shared';
import type { AiService, AiTaskContext } from '../../ai/index';
import { taskInputSql } from '../../ai/payloads';
import { customFilterPrompt } from '../../ai/prompts/prepare-filters/custom-filter';
import { defineAiTask } from '../../ai/task';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/index';
import { AppError } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { untrusted, untrustedText } from '../autofill/ai/untrusted';
import { analysisById } from '../job-analysis/store';
import { readFilterSettings } from './settings';

// v2.0 P4 (06-filters-analysis.md, "The Custom filter"): the only filter an AI judges, against the person's own prompt
// and nothing else. Server path: `custom_filter` tasks (Haiku by default), charged to the person, CUSTOM_FILTER_BATCH
// jobs a call, each job's facts and summary wrapped as untrusted text. MCP path: the person's own AI saves verdicts
// (P5's custom_filter_verdicts tool, through saveCustomVerdicts). Either way a verdict is kept per (person, job, prompt
// hash) with the posting's content hash, so the same prompt and posting are never judged twice, and a changed prompt
// or posting is judged again. A job the answer leaves out passes.
// v3.0 D2-F: on the async client.

/** The first 16 hex characters of the SHA-256 of the (trimmed) prompt: custom_filter_verdicts.prompt_hash. */
export function promptHashOf(prompt: string): string {
  return createHash('sha256').update(prompt.trim()).digest('hex').slice(0, 16);
}

/** The person's Custom filter when it is on (with a prompt), with its hash; else null. */
export async function customPromptOf(deps: Pick<AppDeps, 'db' | 'log'>, userId: string): Promise<{ prompt: string; hash: string } | null> {
  return customPromptIn((await readFilterSettings(deps, userId)).filters);
}

/** The Custom filter of a set of filters when it is on (with a prompt), with its hash; else null. */
export function customPromptIn(filters: PrepareFilters): { prompt: string; hash: string } | null {
  const prompt = filters.custom.prompt.trim();
  if (!filters.custom.enabled || !prompt) return null;
  return { prompt, hash: promptHashOf(prompt) };
}

// ---------------------------------------------------------------------------------------------------- verdicts

/** A stored Custom verdict, as customStates reads it. */
export interface VerdictRow {
  job_id: number;
  verdict: 'pass' | 'fail';
  content_hash: string;
}

/**
 * The Custom filter's state of each job: its stored verdict for this prompt and the job's current posting, `pending`
 * when it has none, or `off` for every job when the filter is off.
 */
export async function customStates(
  db: DbQueries,
  userId: string,
  prompt: { hash: string } | null,
  jobs: ReadonlyArray<{ jobId: number; contentHash: string }>,
): Promise<Map<number, CustomFilterState>> {
  if (!prompt) return customStatesOf(null, jobs, []);
  const rows: VerdictRow[] = [];
  const ids = [...new Set(jobs.map((job) => job.jobId))];
  for (let index = 0; index < ids.length; index += 500) {
    rows.push(...(await db.all<VerdictRow>(VERDICTS_SQL(db.dialect.jsonEach('?')), [userId, prompt.hash, JSON.stringify(ids.slice(index, index + 500))])));
  }
  return customStatesOf(prompt, jobs, rows);
}

/** The stored verdicts of some jobs under a prompt hash. */
export const VERDICTS_SQL = (jsonEach: string) =>
  'SELECT job_id, verdict, content_hash FROM custom_filter_verdicts WHERE user_id = ? AND prompt_hash = ? ' +
  `AND job_id IN (SELECT CAST(value AS INTEGER) FROM ${jsonEach})`;

/** Each job's state from its stored verdict rows: the verdict of its current posting, else `pending`; `off` with no prompt. */
export function customStatesOf(
  prompt: { hash: string } | null,
  jobs: ReadonlyArray<{ jobId: number; contentHash: string }>,
  rows: readonly VerdictRow[],
): Map<number, CustomFilterState> {
  const out = new Map<number, CustomFilterState>();
  if (!prompt) {
    for (const job of jobs) out.set(job.jobId, 'off');
    return out;
  }
  const stored = new Map(rows.map((row) => [row.job_id, row]));
  for (const job of jobs) {
    const row = stored.get(job.jobId);
    out.set(job.jobId, row && row.content_hash === job.contentHash ? row.verdict : 'pending');
  }
  return out;
}

/** A verdict's reason as stored: plain, one line, at most 80 characters (the column holds 120). */
export function reasonOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = untrustedText(value, 80);
  return text || null;
}

/**
 * Stores verdicts under the person's current prompt hash and each job's current content hash. Only jobs the person
 * tracks (an application with that job) are kept; others, unknown jobs, and every verdict while the filter is off are
 * ignored (their ids are answered).
 */
export async function storeVerdicts(
  deps: Pick<AppDeps, 'db' | 'log' | 'now'>,
  userId: string,
  verdicts: ReadonlyArray<{ jobId: number; pass: boolean; reason?: string | null }>,
  decidedBy: 'server' | 'mcp',
  expectedHash?: string,
): Promise<{ saved: number; ignored: number[] }> {
  const prompt = await customPromptOf(deps, userId);
  if (!prompt || (expectedHash !== undefined && prompt.hash !== expectedHash)) {
    return { saved: 0, ignored: verdicts.map((verdict) => verdict.jobId) };
  }
  const ids = [...new Set(verdicts.map((verdict) => verdict.jobId).filter((id) => Number.isInteger(id) && id > 0))];
  const tracked = new Map<number, string>();
  for (let index = 0; index < ids.length; index += 500) {
    const rows = await deps.db.all<{ id: number; content_hash: string }>(TRACKED_SQL(deps.db.dialect.jsonEach('?')), [
      userId,
      JSON.stringify(ids.slice(index, index + 500)),
    ]);
    for (const row of rows) tracked.set(row.id, row.content_hash);
  }
  const ignored: number[] = [];
  let saved = 0;
  const now = nowIso(deps);
  await deps.db.atomic(
    async (t) => {
      for (const verdict of verdicts) {
        const contentHash = tracked.get(verdict.jobId);
        if (contentHash === undefined || typeof verdict.pass !== 'boolean') {
          ignored.push(verdict.jobId);
          continue;
        }
        await t.run(UPSERT_VERDICT_SQL, [userId, verdict.jobId, prompt.hash, contentHash, verdict.pass ? 'pass' : 'fail', reasonOf(verdict.reason), decidedBy, now]);
        // The job's stored label was read without this verdict: it is computed again at the next read.
        await t.run(FORGET_RESULT_SQL, [userId, verdict.jobId]);
        saved += 1;
      }
    },
    { label: 'storeVerdicts' },
  );
  return { saved, ignored };
}

/** The person's tracked jobs among some ids, with their content hash. */
export const TRACKED_SQL = (jsonEach: string) =>
  'SELECT DISTINCT j.id, j.content_hash FROM applications a JOIN jobs j ON j.id = a.job_id ' +
  `WHERE a.user_id = ? AND a.job_id IN (SELECT CAST(value AS INTEGER) FROM ${jsonEach})`;
export const UPSERT_VERDICT_SQL = `INSERT INTO custom_filter_verdicts(user_id, job_id, prompt_hash, content_hash, verdict, reason, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, job_id, prompt_hash) DO UPDATE SET content_hash = excluded.content_hash, verdict = excluded.verdict,
       reason = excluded.reason, decided_by = excluded.decided_by, decided_at = excluded.decided_at`;
export const FORGET_RESULT_SQL = 'DELETE FROM prepare_filter_results WHERE user_id = ? AND job_id = ?';

// ------------------------------------------------------------------------------------------------------ the task

// v30 ST2: the prompt (its words, its input and output) is the prompt catalogue's
// (ai/prompts/prepare-filters/custom-filter.ts); the task is defined with defineAiTask and listed on the feature.

export const CustomFilterTaskInputSchema = z.object({
  promptHash: z.string().length(16),
  jobIds: z.array(z.number().int().positive()).min(1).max(25),
  /** The Prepare this judgment is for (05's step a): the AI queue adds the task's cost to prepare_jobs.cost_micros. */
  prepare: z.object({ id: z.string().min(1).max(64) }).optional(),
});
export type CustomFilterTaskInput = z.infer<typeof CustomFilterTaskInputSchema>;

interface JobBlockRow {
  id: number;
  title: string;
  company_name: string;
  locations_text: string;
  analysis_id: number | null;
}

/** One job as the Custom filter reads it: its title, company, facts and summary bullets, wrapped as untrusted text. */
async function jobBlock(db: DbQueries, row: JobBlockRow, facts: JobFactsView | undefined): Promise<string> {
  const lines = [`Title: ${row.title}`, `Company: ${row.company_name}`];
  if (row.locations_text) lines.push(`Locations: ${row.locations_text}`);
  if (facts?.workArrangement) lines.push(`Arrangement: ${WORK_ARRANGEMENT_LABEL[facts.workArrangement]}`);
  if (facts?.employmentType) {
    const type = facts.employmentType;
    lines.push(`Type: ${type === 'unpaid' ? 'Unpaid' : type === 'temporary' ? 'Temporary' : EMPLOYMENT_TYPE_LABEL[type]}`);
  }
  if (facts?.industry) lines.push(`Industry: ${industryLabel(facts.industry) || facts.industry}`);
  const pay = [facts?.salaryMinUsd, facts?.salaryMaxUsd].filter((value): value is number => typeof value === 'number');
  if (pay.length > 0) lines.push(`Salary (yearly, USD): ${pay.map(salaryWord).join(' - ')}`);
  const analysis = row.analysis_id === null ? null : await analysisById(db, row.analysis_id);
  if (analysis) {
    if (analysis.requirements.length) lines.push(`Requirements: ${analysis.requirements.slice(0, 8).join('; ')}`);
    if (analysis.responsibilities.length) lines.push(`Responsibilities: ${analysis.responsibilities.slice(0, 6).join('; ')}`);
  }
  return untrusted(lines.join(' | '), 1500);
}

/**
 * One `custom_filter` task: judges up to CUSTOM_FILTER_BATCH jobs against the person's current prompt (read when it
 * runs: a prompt changed since it was queued is not the one asked about, and the task stores nothing), and stores a
 * verdict for every job, `pass` for one the answer leaves out.
 */
async function judgeBatch(
  deps: AppDeps,
  task: CustomFilterTaskInput,
  ctx: AiTaskContext,
): Promise<{ judged: number; skipped?: string }> {
  const userId = ctx.userId;
  if (!userId) return { judged: 0, skipped: 'No account.' };
  const prompt = await customPromptOf(deps, userId);
  if (!prompt || prompt.hash !== task.promptHash) return { judged: 0, skipped: 'The custom filter changed.' };
  const rows = await deps.db.all<JobBlockRow>(
    'SELECT j.id, j.title, c.name AS company_name, j.locations_text, j.analysis_id FROM jobs j JOIN companies c ON c.id = j.company_id ' +
      `WHERE j.id IN (SELECT CAST(value AS INTEGER) FROM ${deps.db.dialect.jsonEach('?')})`,
    [JSON.stringify(task.jobIds)],
  );
  if (rows.length === 0) return { judged: 0, skipped: 'The jobs are gone.' };
  const facts = await deps.services.jobFacts?.ensureAndRead(rows.map((row) => row.id)) ?? new Map<number, JobFactsView>();
  const jobs: Array<{ key: string; jobId: number; block: string }> = [];
  for (const [index, row] of rows.entries()) jobs.push({ key: String(index + 1), jobId: row.id, block: await jobBlock(deps.db, row, facts.get(row.id)) });
  const output = await ctx.runPrompt(customFilterPrompt, { prompt: prompt.prompt, jobs });
  const byKey = new Map(output.verdicts.map((verdict) => [verdict.key, verdict]));
  const verdicts = jobs.map((job) => {
    const verdict = byKey.get(job.key);
    return { jobId: job.jobId, pass: verdict ? verdict.pass : true, reason: verdict?.reason ?? null };
  });
  const stored = await storeVerdicts(deps, userId, verdicts, 'server', task.promptHash);
  return { judged: stored.saved };
}

/** The AI task kind `custom_filter` (Haiku by default): one batch of the server path's judging (judgeOnServer). */
export const customFilterTask = defineAiTask({
  kind: 'custom_filter',
  prompts: [customFilterPrompt],
  // A stored input that does not read fails the task, as it always has (the schema's own error).
  parse: CustomFilterTaskInputSchema,
  // The person's own task: each batch names them as the one it charges (03-ai-usage.md, A7), as v2.0's did.
  charge: 'caller',
  defaultModel: 'haiku',
  run: judgeBatch,
});

/** How long the server path waits for one batch (the queue's own timeout is longer still). */
const BATCH_WAIT_MS = 10 * 60_000;

/** v20 FIX-A: the person's `custom_filter` batches still queued or running under the prompt `promptHash`, oldest first. */
async function liveCustomBatches(deps: Pick<AppDeps, 'db'>, userId: string, promptHash: string): Promise<Array<{ id: string; jobIds: number[] }>> {
  // The insertion order breaks a tie: ai_tasks.seq (dialect.seq; v3.0 PG-F, SQLite's rowid before). v30 D5L: the
  // input lives in ai_task_payloads (ai/payloads.ts).
  const input = taskInputSql(deps.db.dialect);
  const rows = await deps.db.all<{ id: string; input: string | null }>(
    `SELECT id, ${input} AS input FROM ai_tasks WHERE user_id = ? AND kind = 'custom_filter' AND status IN ('queued', 'running')
       AND ${deps.db.dialect.jsonText(input, '$.promptHash')} = ? ORDER BY created_at, ${deps.db.dialect.seq()}`,
    [userId, promptHash],
  );
  return rows.flatMap((row) => {
    const parsed = CustomFilterTaskInputSchema.safeParse(JSON.parse(row.input ?? 'null'));
    return parsed.success ? [{ id: row.id, jobIds: parsed.data.jobIds }] : [];
  });
}

/**
 * The server path (05's step a): the jobs with no fresh verdict are judged in `custom_filter` tasks of
 * CUSTOM_FILTER_BATCH jobs, one after another, charged to the person; then every job's verdict is answered. A job
 * missing from the answer was not judged (gone, or the prompt changed meanwhile). With the filter off, every job
 * passes. A refusal of the AI gate, or a failed task, is thrown as its AppError. `prepareId` (P2's runner) puts
 * `prepare: {id}` in each task's input, so the cost adds up on that Prepare.
 */
export async function judgeOnServer(
  deps: AppDeps,
  userId: string,
  jobIds: readonly number[],
  prepareId?: string,
): Promise<Map<number, 'pass' | 'fail'>> {
  const ids = [...new Set(jobIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, 'pass' | 'fail'>();
  const prompt = await customPromptOf(deps, userId);
  if (!prompt) {
    for (const id of ids) out.set(id, 'pass');
    return out;
  }
  const hashes = async (list: readonly number[]) =>
    (
      await deps.db.all<{ id: number; content_hash: string }>(
        `SELECT id, content_hash FROM jobs WHERE id IN (SELECT CAST(value AS INTEGER) FROM ${deps.db.dialect.jsonEach('?')})`,
        [JSON.stringify(list)],
      )
    ).map((row) => ({ jobId: row.id, contentHash: row.content_hash }));
  const pendingOf = async () =>
    [...(await customStates(deps.db, userId, prompt, await hashes(ids)))].filter(([, state]) => state === 'pending').map(([id]) => id);
  let pending = await pendingOf();
  if (pending.length > 0) {
    const ai: AiService | undefined = deps.services.ai;
    if (!ai) throw refuse(deps, 'ai_unavailable', 'MSG_AI_UNAVAILABLE');
    // v20 FIX-A (with FIX-B's BEH-5): a batch already queued or running for some of these jobs under this prompt (a
    // previous process's, which the AI queue's start() runs again after a restart, or another Prepare's) is waited for,
    // never started a second time beside it: the work would be done, and charged, twice. A batch that failed leaves its
    // jobs pending, and they are judged below.
    const waiting = (await liveCustomBatches(deps, userId, prompt.hash)).filter((live) => live.jobIds.some((id) => pending.includes(id)));
    for (const live of waiting) await ai.waitFor(live.id, BATCH_WAIT_MS).catch(() => undefined);
    if (waiting.length > 0) pending = await pendingOf();
  }
  if (pending.length > 0) {
    const ai: AiService | undefined = deps.services.ai;
    if (!ai) throw refuse(deps, 'ai_unavailable', 'MSG_AI_UNAVAILABLE');
    const batch = constantsOf(deps).get('CUSTOM_FILTER_BATCH');
    for (let index = 0; index < pending.length; index += batch) {
      const options = customFilterTask.enqueueOptions({
        userId,
        // The person's own task: the queue charges it to them (03-ai-usage.md, A7).
        chargeTo: userId,
        input: {
          promptHash: prompt.hash,
          jobIds: pending.slice(index, index + batch),
          ...(prepareId ? { prepare: { id: prepareId } } : {}),
        },
        priority: deps.config.ai.backgroundSlots > 0 ? 'background' : 'interactive',
        // v20 FIX-A: the same batch asked twice at once (two Prepares) is one task.
        dedupeKey: `custom_filter:${prompt.hash}:${pending.slice(index, index + batch).join(',')}`,
      });
      const { taskId } = await ai.enqueue(options);
      const view = await ai.waitFor(taskId, BATCH_WAIT_MS);
      if (view.status !== 'succeeded') {
        const code = view.error?.code === 'ai_usage_exhausted' || view.error?.code === 'ai_unavailable' ? view.error.code : 'ai_failed';
        throw view.error?.message ? new AppError(code, view.error.message) : refuse(deps, code, 'MSG_CUSTOM_FILTER_FAILED');
      }
    }
  }
  for (const [id, state] of await customStates(deps.db, userId, prompt, await hashes(ids))) {
    if (state === 'pass' || state === 'fail') out.set(id, state);
  }
  return out;
}
