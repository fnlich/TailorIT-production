import {
  AdminCandidatesAddResultSchema,
  AdminCandidatesBulkResultSchema,
  AdminCandidatesListSchema,
  DiscoveryMeasuresSchema,
  type AdminCandidatesAddBody,
  type AdminCandidatesAddResult,
  type AdminCandidatesBulkResult,
  type DiscoveryMeasures,
  type JobSourceCandidateStatus,
  type JobSourceDiscoveredVia,
  type JobSourceKind,
} from '@tailorit/shared/sourcing';
import type { z } from 'zod';
import { api } from '@/lib/api';

// v30 S2: Admin › Candidates' calls (docs/design/part2/12-job-sourcing.md §4, §9.8): the boards discovery found, their
// funnel, retry and drop, an admin's own boards, and the measures by kind. Answers are CT's and S2's shapes
// (@tailorit/shared/sourcing); S2's API names the routes (/api/admin/candidates).

export type AdminCandidatesPage = z.infer<typeof AdminCandidatesListSchema>;
export type CandidateBulkAction = 'retry' | 'drop';

export interface CandidateFilters {
  q: string;
  kind: JobSourceKind[];
  status: JobSourceCandidateStatus[];
  discoveredVia: JobSourceDiscoveredVia[];
}

export const NO_CANDIDATE_FILTERS: CandidateFilters = { q: '', kind: [], status: [], discoveredVia: [] };

/** React Query keys of Candidates (under ['admin', 'candidates']). */
export const candidateKeys = {
  all: ['admin', 'candidates'] as const,
  page: (filters: CandidateFilters) => ['admin', 'candidates', 'page', filters] as const,
  measures: ['admin', 'candidates', 'measures'] as const,
};

/** The list's query string: each filter as one comma-separated value, the empty ones left out. */
export function candidatesQuery(filters: CandidateFilters, cursor?: string) {
  const list = (values: readonly string[]) => (values.length > 0 ? values.join(',') : undefined);
  return {
    q: filters.q.trim() || undefined,
    kind: list(filters.kind),
    status: list(filters.status),
    discoveredVia: list(filters.discoveredVia),
    cursor,
  };
}

/** GET /api/admin/candidates?q&kind&status&discoveredVia&cursor: a page, the total and the funnel. */
export function fetchCandidatesPage(filters: CandidateFilters, cursor?: string, signal?: AbortSignal): Promise<AdminCandidatesPage> {
  return api.get<AdminCandidatesPage>('/api/admin/candidates', { signal, query: candidatesQuery(filters, cursor), schema: AdminCandidatesListSchema });
}

/** POST /api/admin/candidates/bulk: retry or drop up to ADMIN_BULK_MAX candidates. */
export function bulkCandidates(action: CandidateBulkAction, ids: readonly number[]): Promise<AdminCandidatesBulkResult> {
  return api.post<AdminCandidatesBulkResult>('/api/admin/candidates/bulk', { action, ids }, { schema: AdminCandidatesBulkResultSchema });
}

/** POST /api/admin/candidates: an admin's boards, addresses or names (of `kind`). */
export function addCandidates(body: AdminCandidatesAddBody): Promise<AdminCandidatesAddResult> {
  return api.post<AdminCandidatesAddResult>('/api/admin/candidates', body, { schema: AdminCandidatesAddResultSchema });
}

/** GET /api/admin/candidates/measures: boards, open jobs per board, new postings and open life, by kind. */
export function fetchMeasures(signal?: AbortSignal): Promise<DiscoveryMeasures> {
  return api.get<DiscoveryMeasures>('/api/admin/candidates/measures', { signal, schema: DiscoveryMeasuresSchema });
}
