import { z } from 'zod';
import {
  COMPANY_SUMMARY_PROMPT_VERSION,
  companySummaryPrompt,
  type CompanySummaryProblem,
  type CompanySummaryPromptCompany,
} from '../../../ai/prompts/companies/summary';
import type { AiTaskContext } from '../../../ai/queue';
import { defineAiTask } from '../../../ai/task';
import { constantsOf } from '../../../core/constants/service';
import type { DbQueries } from '../../../core/db/types';
import { minConfidenceOf, recomputeProfile, upsertSource, type ProfileFields } from '../profile';
import { refreshCompanySearchIn } from '../search-refresh'; // v30 FIX-PERF (PGL-19)
import { nextBudgetDayAt, summaryBudgetLeft } from './budget';
import { checkSummaryAnswer, refusingProblems, type CheckedSummary } from './checks';
import { lookAtCompany, type SummaryInputs } from './inputs';
import { aiSummaryLabel } from './label';
import { recordAnswer, recordIdle, recordNotShared, releasePending, SUMMARY_FAILURE_WAIT_MS, type SummaryOutcome } from './state';
import { lookOptionsOf, type SummaryDeps } from './step';

// v30 E3: the `company_summary` AI task (ai/task.ts defineAiTask; docs/design/part2/13-company-enrichment.md §8): one
// batch of companies (COMPANY_AI_BATCH) the batch runner (runner.ts) took off the pending list. System-owned and
// charged to no one (platform spend: the day's COMPANY_AI_DAILY_BUDGET_USD, budget.ts), on COMPANY_AI_MODEL.
//
// For the batch: each company is looked at again (inputs.ts: a company no longer eligible is recorded and left out);
// one prompt run per company asks for its summary (v30 FIX-C SEC-4, DECISIONS P6.7: no company's untrusted text ever
// shares a call with another's); each answer is checked (checks.ts); a refused one is asked for once more, with its
// reasons; then each company is kept in a transaction of its own:
//   - written: the `ai` source row `summary` (summary and tagline; licence ai_derived; match confidence the lowest of
//     its inputs'; attribution the label "Summary written by AI from …"; the model, the prompt version, the inputs'
//     hash and the inputs' source kinds in its fields), which 13 §6.1 ranks first for the summary and the tagline;
//   - declined (its texts say too little) or refused (twice): that row is kept as `not_found` / `error`, never used, so
//     the profile shows the company's own words, labelled as such (the fallback);
//   - the industry, asked for only when no other source gives one: the `ai` row `industry`, 70 when its quote is in the
//     texts (shown), else 50 (kept, never shown) (13 §6.2);
//   - the profile recomputed (and the open jobs re-projected when the industry changed); the state recorded.
// The budget is read before each run: a batch stops when it is spent, and its companies wait for the next day.
//
// v30 FIX-C (W5 review, "E3 runner"): the batch's claim token. The runner passes the lease its claim set
// (company_summaries.leased_until); before each company's run the task checks the company is still held by that
// lease. A task that waited in the queue past its lease (the runner stopped waiting, and a later batch claimed the
// company again) makes no call for it: a company is never summarised twice for one claim's spend.

/** 13 §6.2: an AI industry mapping with a quote from its inputs; without one (kept, never shown). */
export const AI_INDUSTRY_QUOTED_CONFIDENCE = 70;
export const AI_INDUSTRY_UNQUOTED_CONFIDENCE = 50;

/** The `ai` source rows' refs. */
export const AI_SUMMARY_REF = 'summary';
export const AI_INDUSTRY_REF = 'industry';

export const CompanySummaryTaskInputSchema = z.object({
  companyIds: z.array(z.number().int().positive()).min(1).max(50),
  /** The claim's lease (company_summaries.leased_until, ISO): a company no longer held by it is not asked about. */
  lease: z.string().datetime().optional(),
});
export type CompanySummaryTaskInput = z.infer<typeof CompanySummaryTaskInputSchema>;

export interface CompanySummaryTaskResult {
  written: number;
  declined: number;
  refused: number;
  /** No longer eligible when the batch ran (recorded as such). */
  skipped: number;
  /** Left pending: the budget was spent, or the second run failed. */
  pending: number;
  /** Prompt runs made (one per company, and one per second ask). */
  runs: number;
  /** Companies another claim holds now (this task's claim ran out while it waited): not asked about. */
  lost: number;
  /** The day's budget stopped the batch (before its first run or its second). */
  budgetStopped: boolean;
}

interface Item {
  inputs: SummaryInputs;
  openJobs: number;
  checked: CheckedSummary | null;
  problems: CompanySummaryProblem[];
}

/** The company as the prompt quotes it. */
function promptCompany(item: Item, refused?: CompanySummaryProblem[]): CompanySummaryPromptCompany {
  return {
    name: item.inputs.name,
    facts: item.inputs.facts,
    texts: item.inputs.texts.map((text) => ({ from: text.from, text: text.text })),
    mapIndustry: item.inputs.mapIndustry,
    ...(refused ? { refused } : {}),
  };
}

/** One prompt run for one company (its own call: SEC-4), its answer checked; answers whether it was refused. */
async function askOne(ctx: AiTaskContext, model: string, item: Item, refused: boolean): Promise<boolean> {
  const answer = await ctx.runPrompt(companySummaryPrompt, { company: promptCompany(item, refused ? item.problems : undefined) }, { model });
  const checked = checkSummaryAnswer(
    { name: item.inputs.name, texts: item.inputs.texts.map((text) => text.text), facts: item.inputs.facts },
    answer,
    item.inputs.mapIndustry,
  );
  item.checked = checked;
  item.problems = checked.problems;
  return refusingProblems(checked).length > 0;
}

/** Whether the claim `lease` still holds the company (no lease given: an older caller's task, held as before). */
async function stillHeld(deps: SummaryDeps, companyId: number, lease: string | undefined): Promise<boolean> {
  if (lease === undefined) return true;
  const row = await deps.db.one<{ held: boolean }>(
    'SELECT leased_until = CAST(? AS timestamptz) AS held FROM company_summaries WHERE company_id = ?',
    [lease, companyId],
  );
  return row?.held === true;
}

const outcomeOf = (item: Item): SummaryOutcome =>
  item.checked && refusingProblems(item.checked).length === 0 ? (item.checked.declined ? 'declined' : 'written') : 'refused';

/** Turns an `ai` row off (not_found) when one is in use: a stale AI industry never outranks a newer source's. */
async function retire(t: DbQueries, companyId: number, ref: string, at: string): Promise<void> {
  await t.run(
    `UPDATE company_sources SET status = 'not_found', fields = '{}'::jsonb, content_hash = NULL, retrieved_at = ?
     WHERE company_id = ? AND kind = 'ai' AND ref = ? AND status = 'ok'`,
    [at, companyId, ref],
  );
}

/** Keeps one company's answer (see the module's note), in the caller's transaction. */
export async function keepAnswer(
  deps: SummaryDeps,
  t: DbQueries,
  input: { inputs: SummaryInputs; checked: CheckedSummary | null; problems: readonly CompanySummaryProblem[]; outcome: SummaryOutcome; model: string; openJobs: number },
): Promise<void> {
  const { inputs, checked, outcome } = input;
  const at = deps.now().toISOString();
  const companyId = inputs.companyId;
  const meta = {
    answer: outcome,
    model: input.model,
    promptVersion: COMPANY_SUMMARY_PROMPT_VERSION,
    inputsHash: inputs.hash,
    inputKinds: [...new Set(inputs.texts.map((text) => text.kind))],
  };
  const values =
    outcome === 'written'
      ? { summary: checked!.summary, tagline: checked!.tagline }
      : outcome === 'refused'
        ? { problems: input.problems.map((problem) => problem.kind) }
        : {};
  // The profile reads its fields' values; the rest (the answer, the model, the prompt version, the inputs' hash and
  // kinds) is the row's own record (13 §8 "Marking"), as the hiring-organisation row keeps its logo's address.
  const summaryFields: Record<string, unknown> = { ...values, ...meta };
  await upsertSource(
    t,
    companyId,
    {
      kind: 'ai',
      ref: AI_SUMMARY_REF,
      licence: 'ai_derived',
      matchConfidence: inputs.confidence,
      attribution: aiSummaryLabel(inputs.texts.map((text) => text.from)),
      status: outcome === 'written' ? 'ok' : outcome === 'declined' ? 'not_found' : 'error',
    },
    summaryFields as ProfileFields,
    at,
  );
  // The industry: only when asked for, from an answer that was not refused.
  if (inputs.mapIndustry && outcome !== 'refused' && checked?.industry) {
    const industryFields: Record<string, unknown> = { industry: checked.industry, industryQuoted: checked.industryQuoted, ...meta };
    await upsertSource(
      t,
      companyId,
      {
        kind: 'ai',
        ref: AI_INDUSTRY_REF,
        licence: 'ai_derived',
        matchConfidence: checked.industryQuoted ? Math.min(AI_INDUSTRY_QUOTED_CONFIDENCE, inputs.confidence) : AI_INDUSTRY_UNQUOTED_CONFIDENCE,
        attribution: aiSummaryLabel(inputs.texts.map((text) => text.from)),
      },
      industryFields as ProfileFields,
      at,
    );
  } else {
    await retire(t, companyId, AI_INDUSTRY_REF, at);
  }
  const result = await recomputeProfile(t, companyId, at, minConfidenceOf(deps));
  await refreshCompanySearchIn(t, companyId, result);
  await recordAnswer(t, companyId, { hash: inputs.hash, promptVersion: COMPANY_SUMMARY_PROMPT_VERSION, outcome, at, priority: input.openJobs });
}

/** The task's work (see the module's note). */
export async function summariseCompanies(
  deps: SummaryDeps,
  companyIds: readonly number[],
  ctx: AiTaskContext,
  lease?: string,
): Promise<CompanySummaryTaskResult> {
  const result: CompanySummaryTaskResult = { written: 0, declined: 0, refused: 0, skipped: 0, pending: 0, runs: 0, lost: 0, budgetStopped: false };
  const model = constantsOf(deps).get('COMPANY_AI_MODEL');
  const options = lookOptionsOf(deps);
  const items: Item[] = [];
  for (const companyId of companyIds) {
    if (!(await stillHeld(deps, companyId, lease))) {
      result.lost += 1;
      continue;
    }
    const look = await lookAtCompany(deps.db, companyId, options);
    if (look.eligible) {
      items.push({ inputs: look.inputs, openJobs: look.openJobs, checked: null, problems: [] });
      continue;
    }
    result.skipped += 1;
    const at = deps.now().toISOString();
    const reason = look.reason;
    await deps.db.tx((t) => (reason === 'not_shared' ? recordNotShared(t, companyId, at) : recordIdle(t, companyId, reason, at, look.openJobs)), {
      label: 'company summary look',
    });
  }
  if (items.length === 0) return result;

  /** Items no longer kept by this task (they wait, failed or were lost to another claim). */
  const away = new Set<Item>();
  /** Puts items back on the pending list for the budget's next day. */
  const waitForBudget = async (waiting: readonly Item[]) => {
    result.budgetStopped = true;
    result.pending += waiting.length;
    for (const item of waiting) away.add(item);
    const ids = waiting.map((item) => item.inputs.companyId);
    await deps.db.tx((t) => releasePending(t, ids, { dueAt: nextBudgetDayAt(deps) }), { label: 'company summaries wait' });
  };
  /** Puts items whose run failed back, due after SUMMARY_FAILURE_WAIT_MS (an attempt counted). */
  const waitAfterFailure = async (failed: readonly Item[], error: unknown) => {
    result.pending += failed.length;
    for (const item of failed) away.add(item);
    const ids = failed.map((item) => item.inputs.companyId);
    const dueAt = new Date(deps.now().getTime() + SUMMARY_FAILURE_WAIT_MS).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await deps.db.tx((t) => releasePending(t, ids, { dueAt, error: message }), { label: 'company summaries retry failed' });
  };

  // The first ask: one call per company, the budget and the claim read before each.
  const refused: Item[] = [];
  const failed: Item[] = [];
  let lastError: unknown = null;
  for (const [index, item] of items.entries()) {
    if ((await summaryBudgetLeft(deps)) <= 0) {
      await waitForBudget(items.slice(index));
      break;
    }
    if (!(await stillHeld(deps, item.inputs.companyId, lease))) {
      result.lost += 1;
      away.add(item);
      continue;
    }
    result.runs += 1;
    try {
      if (await askOne(ctx, model, item, false)) refused.push(item);
    } catch (error) {
      failed.push(item);
      lastError = error;
    }
  }
  // Every call failed: the task fails (the runner puts the batch back); else the failed ones wait on their own.
  if (failed.length > 0 && failed.length === items.length) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  if (failed.length > 0) await waitAfterFailure(failed, lastError);

  // The second ask: each refused one again, with why. A failure keeps the others' answers.
  for (const [index, item] of refused.entries()) {
    if ((await summaryBudgetLeft(deps)) <= 0) {
      await waitForBudget(refused.slice(index));
      break;
    }
    if (!(await stillHeld(deps, item.inputs.companyId, lease))) {
      result.lost += 1;
      away.add(item);
      continue;
    }
    result.runs += 1;
    try {
      await askOne(ctx, model, item, true);
    } catch (error) {
      await waitAfterFailure([item], error);
    }
  }
  for (const item of items) {
    if (away.has(item)) continue;
    const outcome = outcomeOf(item);
    await deps.db.tx(
      (t) => keepAnswer(deps, t, { inputs: item.inputs, checked: item.checked, problems: item.problems, outcome, model, openJobs: item.openJobs }),
      { label: 'company summary' },
    );
    result[outcome] += 1;
  }
  return result;
}

/** The `company_summary` kind: a batch of companies' summaries (one call each), charged to no one (platform spend), on Haiku by default. */
export const companySummaryTask = defineAiTask({
  kind: 'company_summary',
  prompts: [companySummaryPrompt],
  parse: CompanySummaryTaskInputSchema,
  charge: 'server',
  defaultModel: 'haiku',
  run: (deps, input, ctx) => summariseCompanies(deps, input.companyIds, ctx, input.lease),
});
