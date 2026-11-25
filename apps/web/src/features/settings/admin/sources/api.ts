import { z } from 'zod';
import {
  AdminPurgesListSchema,
  AdminSourceRowSchema,
  AdminSourcesAllCountSchema,
  AdminSourcesTurnedOffSchema, // v36 SOURCES
  AdminSourcesAllResultSchema,
  AdminSourcesBulkResultSchema,
  AdminSourcesImportResultSchema, // v37 TRANSFER
  AdminSourcesListSchema,
  JobSourcePurgeSchema,
  type AdminSourceAllAction,
  type AdminSourcesAllCount,
  type AdminSourcesAllResult,
  type AdminSourceBulkAction,
  type AdminSourceRow,
  type AdminSourcesBulkResult,
  type AdminSourcesImportResult, // v37 TRANSFER
  type AdminSourcesList,
  type AdminSourcesTurnedOff, // v36 SOURCES
  type JobSourcePurge,
  type JobSourcePurgeRequest,
  type JobSourcePurgeState,
  type JobSourceTermsStatus, // v37 BOARDS
} from '@tailorit/shared/sourcing';
import { ApiError, UNREACHABLE_MESSAGE, api } from '@/lib/api';
import { profileHeaders } from '@/lib/profile'; // v37 TRANSFER
import type { AddableKind, LakeTestResult, NewSourceBody, SourceTestResult } from '../types';
import { sourcesAllFilter, sourcesFilterQuery, sourcesQuery, type SourceFilters } from './filters';

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
  /** v35 OPSWEB: what Enable all / Disable all would change under a filter (read when the confirm opens). */
  allCount: (filters: SourceFilters) => ['admin', 'sources', 'all-count', filters] as const,
  /** v36 SOURCES: v3.6's notice of the sources 0060 turned off. */
  turnedOff: ['admin', 'sources', 'turned-off'] as const,
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
  // v37 BOARDS (SP v37 PLAN B3): its recorded terms (absent from a server before v3.0's detail fields).
  termsUrl: z.string().nullable().optional(),
  termsNote: z.string().nullable().optional(),
  termsCheckedAt: z.string().nullable().optional(),
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

// v35 OPSWEB (PLAN H6, ADMIN's routes): Enable all / Disable all for everything the filter shows: the count first (the
// confirm's "Enable 42 sources?"), then one request that the server works through in batches, answered once.

/** GET /api/admin/sources/all/count?<filter>: every source the filter matches, and how many each action would change. */
export function fetchSourcesAllCount(filters: SourceFilters, signal?: AbortSignal): Promise<AdminSourcesAllCount> {
  return api.get<AdminSourcesAllCount>('/api/admin/sources/all/count', { signal, query: sourcesFilterQuery(filters), schema: AdminSourcesAllCountSchema });
}

/** POST /api/admin/sources/all {action, filter}: turns every source the filter matches on, or off. */
export function changeAllSources(action: AdminSourceAllAction, filters: SourceFilters): Promise<AdminSourcesAllResult> {
  return api.post<AdminSourcesAllResult>('/api/admin/sources/all', { action, filter: sourcesAllFilter(filters) }, { schema: AdminSourcesAllResultSchema });
}
// end v35 OPSWEB

/**
 * POST /api/admin/sources: a board, the lake or the demo jobs (v2.0's route). v36 SOURCES: `enabled` is "Turn on now"
 * (the server records the admin); the answer says whether it is on.
 */
export function createSource(body: NewSourceBody) {
  return api.post<{ id: number; name: string; enabled?: boolean }>('/api/admin/sources', body);
}

/**
 * PATCH /api/admin/sources/:id {enabled}: turns one source on (the server records the admin) or off. v36 SOURCES: the
 * answer is the source's row (who turned it on, and whether it still waits for an admin).
 */
export function setSourceEnabled(id: number, enabled: boolean): Promise<AdminSourceRow> {
  return api.patch<AdminSourceRow>(`/api/admin/sources/${id}`, { enabled }, { schema: AdminSourceRowSchema });
}

// v36 SOURCES (PLAN S7): v3.6's one-time notice of the sources migration 0060 turned off.

/** GET /api/admin/sources/turned-off: the notice's counts, or null once an admin dismissed it (or there is none). */
export function fetchTurnedOff(signal?: AbortSignal): Promise<AdminSourcesTurnedOff> {
  return api.get<AdminSourcesTurnedOff>('/api/admin/sources/turned-off', { signal, schema: AdminSourcesTurnedOffSchema });
}

/** POST /api/admin/sources/turned-off/dismiss: the notice goes, for every admin. */
export function dismissTurnedOff(): Promise<AdminSourcesTurnedOff> {
  return api.post<AdminSourcesTurnedOff>('/api/admin/sources/turned-off/dismiss', undefined, { schema: AdminSourcesTurnedOffSchema });
}
// end v36 SOURCES

// v37 BOARDS (SP v37 PLAN B3): a source's recorded terms (the route v3.0 made; the web had no editor).

/** What the Terms editor saves: the status, and the terms page and note (null clears them). */
export interface SourceTermsBody {
  termsStatus: JobSourceTermsStatus;
  termsUrl: string | null;
  termsNote: string | null;
}

/** PATCH /api/admin/sources/:id {termsStatus, termsUrl, termsNote}: records the terms (their checked time moves). */
export function saveSourceTerms(id: number, body: SourceTermsBody): Promise<AdminSourceRow> {
  return api.patch<AdminSourceRow>(`/api/admin/sources/${id}`, body, { schema: AdminSourceRowSchema });
}
// end v37 BOARDS
// v37 TRANSFER (SP v37 PLAN T1, T2): the sources file. Export saves the sources the filter shows; Import sends a file
// for its preview, then imports it (every source it adds is off and waits for an admin).

/** The export's address for the filter shown (the list's own filter query: sourcesFilterQuery). */
export function sourcesExportPath(filters: SourceFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sourcesFilterQuery(filters))) {
    if (value === undefined || value === null || value === '') continue;
    for (const each of Array.isArray(value) ? value : [value]) params.append(key, String(each));
  }
  const search = params.toString();
  return `/api/admin/sources/export${search ? `?${search}` : ''}`;
}

/** v37 FIX-37B (L9): tailorit-sources-YYYY-MM-DD.json, the day as the viewer's clock reads it. */
export function exportFileNameOn(now: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `tailorit-sources-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.json`;
}

/** An export: its file to save, how many sources it holds, and how many shown it left out (kinds a file never holds). */
export interface SourcesExportFile {
  fileName: string;
  blob: Blob;
  count: number;
  leftOut: number;
}

/**
 * GET /api/admin/sources/export?<filter>: the sources file, as the API wrote it (v37 FIX-37B: named by the viewer's day,
 * exportFileNameOn). A refusal (too many sources shown) throws an ApiError with the server's words.
 */
export async function downloadSourcesExport(filters: SourceFilters, now: Date = new Date()): Promise<SourcesExportFile> {
  const path = sourcesExportPath(filters);
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json', ...profileHeaders(path) } });
  } catch {
    throw new ApiError({ status: 0, code: 'internal', message: UNREACHABLE_MESSAGE, path });
  }
  if (!response.ok) {
    let message = '';
    let code = '';
    try {
      const body = (await response.json()) as { error?: { message?: unknown; code?: unknown } | string };
      const error = body.error;
      message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
      code = typeof error === 'object' && typeof error?.code === 'string' ? error.code : '';
    } catch {
      // not JSON
    }
    throw new ApiError({
      status: response.status,
      code: (code || (response.status === 400 ? 'validation_failed' : response.status === 403 ? 'forbidden' : 'internal')) as ApiError['code'],
      message: message || 'The sources did not export. Please try again.',
      path,
    });
  }
  const text = await response.text();
  let count = 0;
  try {
    const sources = (JSON.parse(text) as { sources?: unknown }).sources;
    count = Array.isArray(sources) ? sources.length : 0;
  } catch {
    count = 0;
  }
  const leftOut = Number(response.headers.get('X-Sources-Left-Out') ?? 0);
  return {
    // v37 FIX-37B (the ux review's L9): named by the viewer's own day (the server names it by its UTC day).
    fileName: exportFileNameOn(now),
    blob: new Blob([text], { type: 'application/json' }),
    count,
    leftOut: Number.isFinite(leftOut) ? leftOut : 0,
  };
}

function sourcesFileForm(file: File): FormData {
  const form = new FormData();
  form.append('file', file, file.name);
  return form;
}

/** POST /api/admin/sources/import/preview: what the file would do (new, already there, renamed, not valid). Saves nothing. */
export function previewSourcesFile(file: File): Promise<AdminSourcesImportResult> {
  return api.post<AdminSourcesImportResult>('/api/admin/sources/import/preview', sourcesFileForm(file), { schema: AdminSourcesImportResultSchema });
}

/** POST /api/admin/sources/import: adds the file's new sources, each off and waiting for an admin. */
export function importSourcesFile(file: File): Promise<AdminSourcesImportResult> {
  return api.post<AdminSourcesImportResult>('/api/admin/sources/import', sourcesFileForm(file), { schema: AdminSourcesImportResultSchema });
}
// end v37 TRANSFER

/** DELETE /api/admin/sources/:id (v2.0's route). */
export function deleteSource(id: number) {
  return api.delete<void>(`/api/admin/sources/${id}`);
}

/** POST /api/admin/sources/:id/run: runs it now, in the background (v2.0's route, 202). */
export function runSource(id: number) {
  return api.post<{ runId: number; sourceId: number }>(`/api/admin/sources/${id}/run`);
}

/** v31 RUNS: POST /api/admin/sources/:id/pause: no run of it starts until Continue; its running run stops. */
export function pauseSource(id: number): Promise<AdminSourceRow> {
  return api.post<AdminSourceRow>(`/api/admin/sources/${id}/pause`, undefined, { schema: AdminSourceRowSchema });
}

/** v31 RUNS: POST /api/admin/sources/:id/continue: it runs again (now, when its last run was paused). */
export function continueSource(id: number): Promise<AdminSourceRow> {
  return api.post<AdminSourceRow>(`/api/admin/sources/${id}/continue`, undefined, { schema: AdminSourceRowSchema });
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
