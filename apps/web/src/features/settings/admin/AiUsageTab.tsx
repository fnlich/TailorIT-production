'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AiUsageRow } from '@tailorit/shared/ai';
import { ChartLineIcon } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { adminKeys, fetchAiUsage } from './api';
import { AdminResourceTab, type AdminColumn } from '@/components/admin';
import {
  callsLine,
  formatCost,
  formatRate,
  formatTokens,
  kindLabel,
  summaryLine,
  USAGE_REFRESH_MS,
  usageRows,
  type UsageWindow,
} from './usage';

const WINDOW_ITEMS = [
  { value: '1', label: '24 hours' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
] as const satisfies ReadonlyArray<{ value: UsageWindow; label: string }>;

const numeric = 'w-24';

/** The table's columns: the task and its models, its calls, the tokens by kind, the cache hit rate and the cost. */
const COLUMNS: readonly AdminColumn<AiUsageRow>[] = [
  {
    key: 'kind',
    header: 'Task',
    cell: (row) => (
      <div className="min-w-0">
        <p className={row.kind === 'total' ? 'font-semibold' : 'font-medium'}>{kindLabel(row.kind)}</p>
        {row.kind !== 'total' && row.models.length > 0 && (
          <p className="mt-0.5 font-mono text-xs leading-5 text-muted-foreground">{row.models.join(', ')}</p>
        )}
      </div>
    ),
  },
  { key: 'calls', header: 'Calls', cell: (row) => callsLine(row), className: 'w-36 whitespace-nowrap', numeric: true },
  { key: 'input', header: 'Input', cell: (row) => formatTokens(row.inputTokens), className: numeric, numeric: true },
  { key: 'read', header: 'Cache read', cell: (row) => formatTokens(row.cacheReadTokens), className: numeric, numeric: true },
  { key: 'write', header: 'Cache write', cell: (row) => formatTokens(row.cacheWriteTokens), className: numeric, numeric: true },
  { key: 'output', header: 'Output', cell: (row) => formatTokens(row.outputTokens), className: numeric, numeric: true },
  { key: 'rate', header: 'Cache hit', cell: (row) => formatRate(row.cacheHitRate), className: numeric, numeric: true },
  { key: 'cached', header: 'From cache', cell: (row) => row.cachedItems.toLocaleString('en-US'), className: numeric, numeric: true },
  { key: 'cost', header: 'API price', cell: (row) => formatCost(row.costUsd), className: numeric, numeric: true },
];

/**
 * Admin › AI usage (v1.3 C, decision 8): what the AI calls used, per task, over the last 24 hours, 7 or 30 days, from
 * the Claude CLI's own reports. Read again every minute while the tab is open.
 */
export function AiUsageTab() {
  const [days, setDays] = useState<UsageWindow>('7');
  const usage = useQuery({
    queryKey: adminKeys.aiUsage,
    queryFn: ({ signal }) => fetchAiUsage(signal),
    refetchInterval: USAGE_REFRESH_MS,
  });
  const window = usage.data ? usageRows(usage.data, days) : null;

  // The total row closes the table, so a window with no calls is empty (its summary says so).
  const items = window ? (window.rows.length === 0 ? [] : [...window.rows, window.total]) : undefined;

  return (
    <AdminResourceTab
      sectionProps={{ 'data-ai-usage': true }}
      title="AI usage"
      description="Tokens each AI task used, as the Claude CLI reports them. Cache read is the part of a prompt read from Claude's prompt cache, at a tenth of the price; From cache counts the answers TailorIT gave from its own cache, with no call. The API price is what the calls would cost on the API; the subscription is not billed per call."
      actions={<SegmentedControl aria-label="Period" size="sm" items={WINDOW_ITEMS} value={days} onValueChange={setDays} />}
      items={items}
      error={usage.error}
      errorTitle="AI usage could not be read"
      empty={{ icon: <ChartLineIcon size={22} />, title: 'No AI calls yet', description: window ? summaryLine(window.total, days) : undefined }}
      toolbar={
        window && (
          <p className="mb-3 text-sm leading-5 text-muted-foreground" data-ai-usage-summary>
            {summaryLine(window.total, days)}
          </p>
        )
      }
      tableLabel="AI usage by task"
      columns={COLUMNS}
      getKey={(row) => row.kind}
    />
  );
}
