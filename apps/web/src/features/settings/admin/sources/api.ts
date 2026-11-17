import { z } from 'zod';
import {
  AdminPurgesListSchema,
  AdminSourcesBulkResultSchema,
  AdminSourcesListSchema,
  JobSourcePurgeSchema,
  type AdminSourceBulkAction,
  type AdminSourcesBulkResult,
  type AdminSourcesList,
  type JobSourcePurge,
  type JobSourcePurgeRequest,
  type JobSourcePurgeState,
} from '@tailorit/shared/sourcing';
import { api } from '@/lib/api';
import type { AddableKind, LakeTestResult, NewSourceBody, SourceTestResult } from '../types';
import { sourcesQuery, type SourceFilters } from './filters';

// v30 S1-WEB: Admin › Sources' calls at scale (docs/design/part2/12-job-sourcing.md §9.8). The bodies and answers are
// CT's (@tailorit/shared/sourcing); S1-API names the routes (see SP\p2\build\S1-WEB.md, "Routes"). A list is a page of
// rows behind an opaque cursor; a bulk action is one request per ADMIN_BULK_MAX rows (bulk.ts).

/** React Query keys of Sources (under ['admin', 'sources'], so a change invalidates every page at once). */
export const sourceKeys = {
  all: ['admin', 'sources'] as const,
  /** Every page of every filter (a change written into the rows shown). */
  pages: ['admin', 'sources', 'page'] as const,
  page: (filters: SourceFilters) => ['admin', 'sources', 'page', filters] as const,
  detail: (id: number) => ['admin', 'sources', 'detail', id] as const,
  purges: (states: readonly JobSourcePurgeState[]) => ['admin', 'sources', 'purges', states] as const,
};

/** GET /api/admin/sources?q&kind&tier&terms&robots&discoveredVia&enabled&failing&host&companyId&sort&cursor&limit. */
export function fetchSourcesPage(filters: SourceFilters, cursor?: string, signal?: AbortSignal): Promise<AdminSourcesList> {
  return api.get<AdminSourcesList>('/api/admin/sources', { signal, query: sourcesQuery(filters, cursor), schema: AdminSourcesListSchema });
}

/**
 * What the source sheet and Import the sheet again read of one source past its row: its settings (`config`: a board's
 * token, a Google Sheet's tab). Only these fields are read, so v2.0's answer and S1-API's both fit.
 */
export const SourceSettingsSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type SourceSettings = z.infer<typeof SourceSettingsSchema>;

/** GET /api/admin/sources/:id: one source (only its settings are read here). */
export function fetchSourceSettings(id: number, signal?: AbortSignal): Promise<SourceSettings> {
  return api.get<SourceSettings>(`/api/admin/sources/${id}`, { signal, schema: SourceSettingsSchema });
}

/** POST /api/admin/sources/bulk {action, ids}: enable, disable or make due now, each row answered. */
export function bulkSources(action: AdminSourceBulkAction, ids: readonly number[]): Promise<AdminSourcesBulkResult> {
  return api.post<AdminSourcesBulkResult>('/api/admin/sources/bulk', { action, ids }, { schema: AdminSourcesBulkResultSchema });
}

/** POST /api/admin/sources: a board, the lake or the demo jobs (v2.0's route). */
export function createSource(body: NewSourceBody) {
  return api.post<{ id: number; name: string }>('/api/admin/sources', body);
}

/** PATCH /api/admin/sources/:id {enabled}: pauses or enables one source (v2.0's route; its answer is not read). */
export function setSourceEnabled(id: number, enabled: boolean) {
  return api.patch<unknown>(`/api/admin/sources/${id}`, { enabled });
}

/** DELETE /api/admin/sources/:id (v2.0's route). */
export function deleteSource(id: number) {
  return api.delete<void>(`/api/admin/sources/${id}`);
}

/** POST /api/admin/sources/:id/run: runs it now, in the background (v2.0's route, 202). */
export function runSource(id: number) {
  return api.post<{ runId: number; sourceId: number }>(`/api/admin/sources/${id}/run`);
}

/** POST /api/admin/sources/test: reads a board once without saving it (v2.0's route). */
export function testSource(body: { kind: Exclude<AddableKind, 'seed'>; config: Record<string, string> }) {
  return api.post<SourceTestResult>('/api/admin/sources/test', body);
}

/** POST /api/admin/sources/ft-lake/test {path?} (v2.0's route). */
export function testLake(path: string) {
  return api.post<LakeTestResult>('/api/admin/sources/ft-lake/test', path.trim() ? { path: path.trim() } : {});
}

/** GET /api/admin/purges?state&cursor&limit: the purges by source, newest first. */
export function fetchPurges(states: readonly JobSourcePurgeState[], cursor?: string, signal?: AbortSignal) {
  return api.get<z.infer<typeof AdminPurgesListSchema>>('/api/admin/purges', {
    signal,
    query: { state: states.length ? [...states] : undefined, cursor },
    schema: AdminPurgesListSchema,
  });
}

/** POST /api/admin/purges: a purge of one source or of every source of a company (queued; 201 with its row). */
export function startPurge(body: JobSourcePurgeRequest): Promise<JobSourcePurge> {
  return api.post<JobSourcePurge>('/api/admin/purges', body, { schema: JobSourcePurgeSchema });
}
