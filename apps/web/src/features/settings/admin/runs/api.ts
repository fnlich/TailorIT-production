import { z } from 'zod';
import {
  AdminRunsListSchema,
  JobSourceRunSchema,
  SourcingDailyReportSchema,
  type JobSourceKind,
  type JobSourceRunStatus,
  type SourcingDailyReport,
} from '@tailorit/shared/sourcing';
import { api } from '@/lib/api';

// v30 S1-WEB: Admin › Runs' calls (12 §9.8): the run history at scale (a page behind an opaque cursor, by source, kind
// and status) and the daily report. Answers are CT's (@tailorit/shared/sourcing); S1-API names the routes.

/**
 * A run as the history reads it: CT's row, and the kind's own words when the server sends them (v2.0's runs name a
 * Google Sheet import "Google Sheet": its upload then reads "Import").
 */
/** A run row: CT's (its sourceKindLabel included since v30 INT-3). */
export const AdminRunRowSchema = JobSourceRunSchema;
export type AdminRunRow = z.infer<typeof AdminRunRowSchema>;
const RunsPageSchema = AdminRunsListSchema.extend({ items: z.array(AdminRunRowSchema) });
export type AdminRunsPage = z.infer<typeof RunsPageSchema>;

/** What a run's opened row reads: its error and its log lines (v2.0's route; only these fields are read). */
export const RunLogSchema = z.object({ id: z.number().int(), error: z.string().nullable().default(null), log: z.array(z.string()).default([]) });
export type RunLog = z.infer<typeof RunLogSchema>;

export interface RunFilters {
  sourceId: number | null;
  kinds: readonly JobSourceKind[];
  statuses: readonly JobSourceRunStatus[];
}

/** React Query keys of Runs (under ['admin', 'runs'], which a source's Run now invalidates). */
export const runKeys = {
  all: ['admin', 'runs'] as const,
  page: (filters: RunFilters) => ['admin', 'runs', 'page', filters] as const,
  log: (id: number) => ['admin', 'runs', 'log', id] as const,
  report: (day: string | null) => ['admin', 'sourcing-report', day ?? 'today'] as const,
};

/** The history's query string: the source, the kinds and statuses as repeated keys, the cursor. */
export function runsQuery(filters: RunFilters, cursor?: string) {
  return {
    sourceId: filters.sourceId ?? undefined,
    kind: filters.kinds.length ? [...filters.kinds] : undefined,
    status: filters.statuses.length ? [...filters.statuses] : undefined,
    cursor,
  };
}

/** GET /api/admin/runs?sourceId&kind&status&cursor&limit: newest first. */
export function fetchRunsPage(filters: RunFilters, cursor?: string, signal?: AbortSignal): Promise<AdminRunsPage> {
  return api.get<AdminRunsPage>('/api/admin/runs', { signal, query: runsQuery(filters, cursor), schema: RunsPageSchema });
}

/** GET /api/admin/runs/:id: its error and log. */
export function fetchRunLog(id: number, signal?: AbortSignal): Promise<RunLog> {
  return api.get<RunLog>(`/api/admin/runs/${id}`, { signal, schema: RunLogSchema });
}

/** GET /api/admin/sourcing/report?day=YYYY-MM-DD: one day's sourcing (no day: today, as the server counts days). */
export function fetchSourcingReport(day: string | null, signal?: AbortSignal): Promise<SourcingDailyReport> {
  return api.get<SourcingDailyReport>('/api/admin/sourcing/report', { signal, query: { day: day ?? undefined }, schema: SourcingDailyReportSchema });
}
