import type { AiUsageRow, AiUsageSummary } from '@tailorit/shared/ai';

// v1.3 C (decision 8): the words and numbers of Admin › AI usage (pure, so the web unit tests can import it).

/** How often the page reads the ledger again while it is open. */
export const USAGE_REFRESH_MS = 60_000;

/** The windows the page offers, in days (the API answers each). */
export const USAGE_WINDOWS = ['1', '7', '30'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/** Each AI task kind as people read it; an unknown kind (one added later) shows its own name. */
export const USAGE_KIND_LABEL: Record<string, string> = {
  resume_import: 'Resume import',
  entry_bullets: 'Write with AI',
  job_analysis: 'Job analysis',
  cover_letter: 'Cover letters',
  template_fill: 'Letter templates',
  resume_analysis: 'Resume analysis',
  autofill_pick: 'Autofill: option tiebreaks',
  autofill_classify: 'Autofill: field categories',
  autofill_draft: 'Autofill: drafts',
  autofill_answer: 'Autofill: answers',
  // v2.0 fix (UX-16): every kind has words (Tailor from v1.4, the two of v2.0).
  tailor: 'Resume tailoring', // v31 FIX-WEB (REV-REQ REQ-3)
  job_search: 'AI job search',
  custom_filter: 'Custom filter',
  company_summary: 'Company summaries', // v30 E3
  echo: 'Admin test',
  total: 'Total',
};

export const kindLabel = (kind: string) => USAGE_KIND_LABEL[kind] ?? kind;

/** "950", "12.3k", "4.56M": a token count in a narrow column. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`;
  return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** "45%", "-" when nothing was reported. */
export const formatRate = (rate: number | null) => (rate === null ? '-' : `${Math.round(rate * 100)}%`);

/** "$0", "<$0.01", "$0.42", "$12.30": what the calls would cost at API prices. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** "3 calls" or "3 runs, 4 calls" (a repair retry is a second call). */
export function callsLine(row: Pick<AiUsageRow, 'runs' | 'calls'>): string {
  const calls = `${row.calls.toLocaleString('en-US')} call${row.calls === 1 ? '' : 's'}`;
  return row.runs === row.calls ? calls : `${row.runs.toLocaleString('en-US')} runs, ${calls}`;
}

/** A window's rows, the costliest first (by cost, then by tokens), and its total. */
export function usageRows(summary: AiUsageSummary, days: UsageWindow): { rows: AiUsageRow[]; total: AiUsageRow } | null {
  const window = summary.windows.find((entry) => entry.days === Number(days));
  if (!window) return null;
  const tokens = (row: AiUsageRow) => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
  const rows = [...window.kinds].sort((a, b) => b.costUsd - a.costUsd || tokens(b) - tokens(a) || a.kind.localeCompare(b.kind));
  return { rows, total: window.total };
}

/**
 * The line under the title: what the window holds, and the share of prompt tokens the cache answered, e.g.
 * "1,234 calls in the last 7 days. 62% of the prompt tokens were read from the prompt cache."
 */
export function summaryLine(total: AiUsageRow, days: UsageWindow): string {
  const span = days === '1' ? 'the last 24 hours' : `the last ${days} days`;
  if (total.calls === 0 && total.cachedItems === 0) return `No AI calls in ${span}.`;
  const calls = `${total.calls.toLocaleString('en-US')} AI call${total.calls === 1 ? '' : 's'} in ${span}.`;
  const rate = total.cacheHitRate === null ? '' : ` ${formatRate(total.cacheHitRate)} of the prompt tokens were read from the prompt cache.`;
  const cached = total.cachedItems > 0 ? ` ${total.cachedItems.toLocaleString('en-US')} answers came from TailorIT's own cache, with no call.` : '';
  return `${calls}${rate}${cached}`;
}
