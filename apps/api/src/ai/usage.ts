import { CONSTANTS, DAY_MS, type AiPrice, type AiPrices, type AiUsageRow, type AiUsageSummary } from '@tailorit/shared';
import type { DbQueries } from '../core/db/types';

// v1.3 C (decision 8): what the AI calls used. The CLI's result event reports `usage` (the main turn's tokens),
// `modelUsage` (every model the process billed, a side call's included) and `total_cost_usd`; claudeCli.ts reads them
// per call (usageOfResult), runPrompt.ts adds them up over a prompt run and its repair retry, and the queue writes
// them on the task row (ai_tasks' token columns) and in the hourly ledger below (ai_usage_hourly, migration 0812),
// which Admin › AI usage reads. Counts only: never a prompt, an answer or an account.

/** What one CLI call, or several added up, used. `input` is the uncached part: the cached part is cacheRead/Write. */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * At API prices (the subscription is not billed per call). v2.0 (03-ai-usage.md, "The cost of one prompt run"): the
   * sum of modelUsage's costUSD, else total_cost_usd, else the tokens at AI_PRICES.
   */
  costUsd: number;
  /** v2.0: where costUsd came from; absent on usage made by hand (tests, a provider other than the CLI). */
  costSource?: AiCostSource;
  /** The models the CLI billed (modelUsage's keys): more than the answering one means a side call. */
  models: string[];
}

/** v2.0: modelUsage's costUSD summed, `total_cost_usd`, or the tokens priced with AI_PRICES (the CLI said no cost). */
export const AI_COST_SOURCES = ['model_usage', 'total', 'computed'] as const;
export type AiCostSource = (typeof AI_COST_SOURCES)[number];

export const NO_USAGE: AiUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  models: [],
}) as AiUsage;

export function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
    ...(a.costSource || b.costSource ? { costSource: weakerSource(a.costSource, b.costSource) } : {}),
    models: [...new Set([...a.models, ...b.models])],
  };
}

/** v2.0: two calls' sources added up name the less exact one (a computed price is the least exact). */
function weakerSource(a: AiCostSource | undefined, b: AiCostSource | undefined): AiCostSource {
  const rank = (source: AiCostSource | undefined) => (source ? AI_COST_SOURCES.indexOf(source) : -1);
  return (rank(a) >= rank(b) ? a : b) ?? 'computed';
}

/**
 * v2.0: whole micro-dollars for one prompt run's cost, rounded up once per run (03-ai-usage.md, "Micro-dollars"). The
 * product is first rounded to a thousandth of a micro-dollar, so float noise (0.000123 * 1e6 = 122.99999999999999)
 * never adds a micro-dollar. A cost that is not a finite number of 0 or more charges 0.
 */
export function microsOf(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.ceil(Math.round(costUsd * 1e9) / 1000);
}

/**
 * v2.0: the price of a model: its own row of AI_PRICES, else the longest row whose name starts the model's id (a dated
 * id such as claude-sonnet-5-5-20261101), else `*` (the dearest, so an unknown model is never under-charged).
 */
export function priceOf(prices: AiPrices, model: string | null | undefined): AiPrice {
  const id = (model ?? '').trim();
  if (id && Object.hasOwn(prices, id)) return prices[id]!;
  let best: string | null = null;
  for (const name of Object.keys(prices)) {
    if (name !== '*' && id.startsWith(name) && (best === null || name.length > best.length)) best = name;
  }
  return prices[best ?? '*'] ?? CONSTANTS.AI_PRICES.default['*'];
}

/** USD for some tokens at a model's price (prices are USD per million tokens). */
function priced(price: AiPrice, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1e6
  );
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A token count as reported: a finite number of 0 or more, whole; anything else counts 0. */
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
const dollars = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** v2.0: what the cost of a result event is read with: the price table and the model that answered. */
export interface UsageReadOptions {
  /** AI_PRICES as resolved now; default: the shipped default table. */
  prices?: AiPrices;
  /** The model that answered (system/init, assistant): prices a result with `usage` alone. */
  model?: string | null;
}

/**
 * The usage a `result` event reports, or null when it reports none. The tokens are modelUsage's, added up over its
 * models, when it has any (it covers a side call the CLI made with another model); otherwise `usage`'s.
 *
 * v2.0 (A7; 03-ai-usage.md, "The cost of one prompt run"; the order v1.3 C had is reversed): the cost is
 *   1. the sum of modelUsage[model].costUSD, when at least one model has a numeric costUSD (the whole tree of calls);
 *   2. else total_cost_usd (a session total when a session is resumed);
 *   3. else the tokens priced with AI_PRICES: each modelUsage model at its own price, or the answering model with
 *      `usage` alone;
 * and a result with none of modelUsage, usage and total_cost_usd reports nothing (null: charged 0, counted as a run).
 */
export function usageOfResult(event: Json, options: UsageReadOptions = {}): AiUsage | null {
  const perModel = (isObject(event.modelUsage) ? Object.entries(event.modelUsage).filter(([, value]) => isObject(value)) : []) as Array<
    [string, Json]
  >;
  const usage = isObject(event.usage) ? event.usage : null;
  const total = dollars(event.total_cost_usd);
  if (perModel.length === 0 && !usage && total === null) return null;
  const prices = options.prices ?? CONSTANTS.AI_PRICES.default;
  let tokens: Omit<AiUsage, 'costUsd' | 'costSource' | 'models'>;
  let computed = 0;
  if (perModel.length > 0) {
    tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const [model, value] of perModel) {
      const own = {
        input: count(value.inputTokens),
        output: count(value.outputTokens),
        cacheRead: count(value.cacheReadInputTokens),
        cacheWrite: count(value.cacheCreationInputTokens),
      };
      tokens.inputTokens += own.input;
      tokens.outputTokens += own.output;
      tokens.cacheReadTokens += own.cacheRead;
      tokens.cacheWriteTokens += own.cacheWrite;
      computed += priced(priceOf(prices, model), own);
    }
  } else {
    tokens = {
      inputTokens: count(usage?.input_tokens),
      outputTokens: count(usage?.output_tokens),
      cacheReadTokens: count(usage?.cache_read_input_tokens),
      cacheWriteTokens: count(usage?.cache_creation_input_tokens),
    };
    computed = priced(priceOf(prices, options.model), {
      input: tokens.inputTokens,
      output: tokens.outputTokens,
      cacheRead: tokens.cacheReadTokens,
      cacheWrite: tokens.cacheWriteTokens,
    });
  }
  const reported = perModel.map(([, value]) => dollars(value.costUSD)).filter((cost): cost is number => cost !== null);
  const [costUsd, costSource]: [number, AiCostSource] =
    reported.length > 0
      ? [reported.reduce((sum, cost) => sum + cost, 0), 'model_usage']
      : total !== null
        ? [total, 'total']
        : [computed, 'computed'];
  return { ...tokens, costUsd, costSource, models: perModel.map(([model]) => model) };
}

// ------------------------------------------------------------------------------------------------ the ledger

/** The UTC hour of a moment, as the ledger keys it: '2026-11-09T14'. */
export const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);

/** The windows Admin › AI usage shows. */
export const USAGE_WINDOWS_DAYS = [1, 7, 30] as const;

interface WindowRow {
  kind: string;
  model: string;
  runs: number;
  calls: number;
  reported: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cachedItems: number;
}

interface AddParams {
  hour: string;
  kind: string;
  model: string;
  calls: number;
  reported: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** The ledger's SQL (v3.0 D2: portable). */
export const USAGE_SQL = {
  add:
    'INSERT INTO ai_usage_hourly(hour, kind, model, runs, calls, reported, input_tokens, output_tokens, ' +
    'cache_read_tokens, cache_write_tokens, cost_usd) VALUES (@hour, @kind, @model, 1, @calls, @reported, @input, ' +
    '@output, @cacheRead, @cacheWrite, @cost) ON CONFLICT(hour, kind, model) DO UPDATE SET runs = ai_usage_hourly.runs + 1, ' +
    'calls = ai_usage_hourly.calls + excluded.calls, reported = ai_usage_hourly.reported + excluded.reported, ' +
    'input_tokens = ai_usage_hourly.input_tokens + excluded.input_tokens, ' +
    'output_tokens = ai_usage_hourly.output_tokens + excluded.output_tokens, ' +
    'cache_read_tokens = ai_usage_hourly.cache_read_tokens + excluded.cache_read_tokens, ' +
    'cache_write_tokens = ai_usage_hourly.cache_write_tokens + excluded.cache_write_tokens, ' +
    'cost_usd = ai_usage_hourly.cost_usd + excluded.cost_usd',
  cached:
    'INSERT INTO ai_usage_hourly(hour, kind, model, cached_items) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(hour, kind, model) DO UPDATE SET cached_items = ai_usage_hourly.cached_items + excluded.cached_items',
  window:
    'SELECT kind, model, sum(runs) AS runs, sum(calls) AS calls, sum(reported) AS reported, ' +
    'sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS "cacheRead", ' +
    'sum(cache_write_tokens) AS "cacheWrite", sum(cost_usd) AS cost, sum(cached_items) AS "cachedItems" ' +
    'FROM ai_usage_hourly WHERE hour >= ? GROUP BY kind, model ORDER BY kind, model',
  prune: 'DELETE FROM ai_usage_hourly WHERE hour < ?',
} as const;

/** One prompt run in the ledger: its CLI calls and, when the CLI reported it, what they used. */
export async function recordUsage(
  db: DbQueries,
  entry: { atMs: number; kind: string; model: string; calls: number; reportedCalls: number; usage: AiUsage | null },
): Promise<void> {
  const usage = entry.usage ?? NO_USAGE;
  const params: AddParams = {
    hour: hourOf(entry.atMs),
    kind: entry.kind,
    model: entry.model,
    calls: entry.calls,
    reported: entry.reportedCalls,
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    cost: usage.costUsd,
  };
  await db.run(USAGE_SQL.add, { ...params });
}

/** Items a handler answered from the result cache (ai/resultCache.ts) instead of asking the AI. */
export async function recordCachedItems(db: DbQueries, entry: { atMs: number; kind: string; model: string; items: number }): Promise<void> {
  if (entry.items > 0) await db.run(USAGE_SQL.cached, [hourOf(entry.atMs), entry.kind, entry.model, entry.items]);
}

/**
 * Deletes the ledger rows older than `keepDays` (AI_USAGE_KEEP_DAYS: the view's longest window and a few days more;
 * v30 INT-0: the constant, which the queue's prune reads). Returns how many.
 */
export async function pruneUsage(db: DbQueries, nowMs: number, keepDays: number): Promise<number> {
  return (await db.run(USAGE_SQL.prune, [hourOf(nowMs - keepDays * DAY_MS)])).changes;
}


/** cacheRead over every prompt token (uncached input, cache reads and cache writes); null with none reported. */
export function cacheHitRate(row: Pick<AiUsageRow, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number | null {
  const prompt = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
  return prompt > 0 ? row.cacheReadTokens / prompt : null;
}

const emptyRow = (kind: string): AiUsageRow => ({
  kind,
  models: [],
  runs: 0,
  calls: 0,
  reported: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  cachedItems: 0,
  cacheHitRate: null,
});

function addRow(target: AiUsageRow, row: WindowRow): void {
  if (row.runs > 0 && !target.models.includes(row.model)) target.models.push(row.model);
  target.runs += row.runs;
  target.calls += row.calls;
  target.reported += row.reported;
  target.inputTokens += row.input;
  target.outputTokens += row.output;
  target.cacheReadTokens += row.cacheRead;
  target.cacheWriteTokens += row.cacheWrite;
  target.costUsd += row.cost;
  target.cachedItems += row.cachedItems;
}

/**
 * Admin › AI usage: per task kind (its models listed), over the last 1, 7 and 30 days counted in whole UTC hours (the
 * day's window starts at the top of the hour 24 hours ago), and the total. Reads the ledger only.
 */
export async function readUsageSummary(db: DbQueries, nowMs: number): Promise<AiUsageSummary> {
  const windows: AiUsageSummary['windows'] = [];
  for (const days of USAGE_WINDOWS_DAYS) {
    const sinceMs = nowMs - days * DAY_MS;
    const byKind = new Map<string, AiUsageRow>();
    const total = emptyRow('total');
    for (const row of await db.all<WindowRow>(USAGE_SQL.window, [hourOf(sinceMs)])) {
      const kindRow = byKind.get(row.kind) ?? emptyRow(row.kind);
      byKind.set(row.kind, kindRow);
      addRow(kindRow, row);
      addRow(total, row);
    }
    const kinds = [...byKind.values()].map((row) => ({ ...row, cacheHitRate: cacheHitRate(row) }));
    windows.push({
      days,
      since: `${hourOf(sinceMs)}:00:00.000Z`,
      kinds,
      total: { ...total, cacheHitRate: cacheHitRate(total) },
    });
  }
  return { windows, checkedAt: new Date(nowMs).toISOString() };
}
