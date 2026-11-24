import {
  JobDetailSchema,
  JobFacetResponseSchema,
  JobFacetsSummarySchema,
  JobInsightsSchema, // v33 JOBDETAIL: the shared contract
  JobMatchWithLevelSchema, // v33 JOBDETAIL
  JobRowMatchesResponseSchema, // v31 FIX-JOBS
  JobSummarySchema,
  SavedSearchListSchema,
  SavedSearchSchema,
  jobsQueryToQueryString,
  listResponse,
  type JobDetail,
  type JobFacet,
  type JobFacetResponse,
  type JobFacetsSummary,
  type JobInsights, // v33 JOBDETAIL
  type JobMatchWithLevel, // v33 JOBDETAIL
  type JobRowMatchesResponse, // v31 FIX-JOBS
  type JobsQuery,
  type SavedSearch,
} from '@tailorit/shared';
import { z } from 'zod';
import { api } from '@/lib/api';

/*
 * Everything the Jobs page reads and writes. Reads go through /api/jobs (work package J2); Save and Apply go through
 * the tracker's /api/applications (work package T), so the Job Tracker shows the same applications.
 */

/** A list card: the shared JobSummary plus its tracker application (to un-save from the list). */
export const JobListItemSchema = JobSummarySchema.extend({ applicationId: z.string().nullable().default(null) });
export type JobListItem = z.infer<typeof JobListItemSchema>;
export const JobListPageSchema = listResponse(JobListItemSchema);
export type JobListPage = z.infer<typeof JobListPageSchema>;

/**
 * The job's Skills (its keyword match) plus the experience-level check. v33 JOBDETAIL: GET /api/jobs/:id/insights'
 * contract is the shared JobInsightsSchema (the analysis, this match and the requirements at a glance).
 */
export const JobMatchSchema = JobMatchWithLevelSchema;
export type JobMatch = JobMatchWithLevel;
export { JobInsightsSchema, type JobInsights };

const HiddenSchema = z.object({ hidden: z.boolean() });
const CountSchema = z.object({ total: z.number().int().nonnegative() });

export const jobsKeys = {
  all: ['jobs'] as const,
  lists: ['jobs', 'list'] as const,
  list: (queryString: string) => ['jobs', 'list', queryString] as const,
  counts: ['jobs', 'count'] as const,
  count: (queryString: string) => ['jobs', 'count', queryString] as const,
  details: ['jobs', 'detail'] as const,
  detail: (id: number) => ['jobs', 'detail', id] as const,
  allInsights: ['jobs', 'insights'] as const,
  insights: (id: number) => ['jobs', 'insights', id] as const,
  facet: (facet: JobFacet, q: string) => ['jobs', 'facets', facet, q] as const,
  facetsSummary: ['jobs', 'facets', 'summary'] as const,
  savedSearches: ['jobs', 'saved-searches'] as const,
  /** v31 FIX-JOBS: the feed's per-row keyword match of one list page's jobs (under 'jobs', so saves refresh it). */
  allRowMatches: ['jobs', 'row-matches'] as const,
  rowMatches: (ids: readonly number[]) => ['jobs', 'row-matches', ids.join(',')] as const,
};

/** The list's query string: the filters without a cursor (the cursor is the page parameter). */
export function listQueryString(query: JobsQuery): string {
  return jobsQueryToQueryString({ ...query, cursor: undefined });
}

export function fetchJobsPage(queryString: string, cursor: string | undefined, signal?: AbortSignal) {
  const path = `/api/jobs${queryString ? `?${queryString}` : ''}`;
  return api.get<JobListPage>(path, { schema: JobListPageSchema, query: { cursor }, signal });
}

export async function fetchJobsCount(queryString: string, signal?: AbortSignal): Promise<number> {
  const result = await api.get<{ total: number }>(`/api/jobs/count${queryString ? `?${queryString}` : ''}`, {
    schema: CountSchema,
    signal,
  });
  return result.total;
}

export function fetchJob(id: number, signal?: AbortSignal) {
  return api.get<JobDetail>(`/api/jobs/${id}`, { schema: JobDetailSchema, signal });
}

export function fetchInsights(id: number, signal?: AbortSignal) {
  return api.get<JobInsights>(`/api/jobs/${id}/insights`, { schema: JobInsightsSchema, signal });
}

/**
 * v31 FIX-JOBS: the keyword match of each listed job (GET /api/jobs/matches?ids=…, at most JOB_ROW_MATCHES_MAX_IDS):
 * the numbers each job's detail shows, read without starting an analysis.
 */
export function fetchRowMatches(ids: readonly number[], signal?: AbortSignal) {
  return api.get<JobRowMatchesResponse>(`/api/jobs/matches`, { schema: JobRowMatchesResponseSchema, query: { ids: ids.join(',') }, signal });
}

export function fetchFacet(facet: JobFacet, q: string, signal?: AbortSignal) {
  return api.get<JobFacetResponse>(`/api/jobs/facets/${facet}`, {
    schema: JobFacetResponseSchema,
    query: { q: q || undefined },
    signal,
  });
}

export function fetchFacetsSummary(signal?: AbortSignal) {
  return api.get<JobFacetsSummary>(`/api/jobs/facets/summary`, { schema: JobFacetsSummarySchema, signal });
}

export const hideJob = (id: number) => api.post(`/api/jobs/${id}/hide`, undefined, { schema: HiddenSchema });
export const unhideJob = (id: number) => api.delete(`/api/jobs/${id}/hide`, { schema: HiddenSchema });
export const hideCompany = (id: number) => api.post(`/api/companies/${id}/hide`, undefined, { schema: HiddenSchema });
export const unhideCompany = (id: number) => api.delete(`/api/companies/${id}/hide`, { schema: HiddenSchema });

export function fetchSavedSearches(signal?: AbortSignal) {
  return api.get<{ items: SavedSearch[] }>(`/api/saved-searches`, { schema: SavedSearchListSchema, signal });
}

export function createSavedSearch(name: string, query: JobsQuery) {
  return api.post<SavedSearch>(`/api/saved-searches`, { name, query: { ...query, cursor: undefined } }, { schema: SavedSearchSchema });
}

export const deleteSavedSearch = (id: string) => api.delete(`/api/saved-searches/${encodeURIComponent(id)}`);

// ------------------------------------------------------------------------------------------- the tracker (T)

/** Application statuses the Jobs page sets: Saved (bookmark) and Applied ("Applied to this job?" → Yes). */
export const SAVED_STATUS = 1 as const;
export const APPLIED_STATUS = 2 as const;

/** The parts of the tracker's application answer the Jobs page reads. */
const ApplicationRefSchema = z.object({ id: z.string(), currentStatus: z.number().int().optional() });
export type ApplicationRef = z.infer<typeof ApplicationRefSchema>;

/**
 * Tracks the job in the Job Tracker: POST /api/applications with the job id. Creating it again for the same job
 * answers the existing application, moved up to `status` when that is further along.
 */
export function trackJob(jobId: number, status: typeof SAVED_STATUS | typeof APPLIED_STATUS, occurredOn?: string) {
  return api.post<ApplicationRef>(`/api/applications`, { jobId, status, ...(occurredOn ? { occurredOn } : {}) }, {
    schema: ApplicationRefSchema,
  });
}

/**
 * Un-saves a job: archives its application (never deletes it, so its notes survive and Undo can bring it back). The
 * Jobs page counts an archived application that is only Saved as not saved.
 */
/**
 * v36 FIX-WEB (SP v36 FINAL-FIXES D1): an un-save's answer also says what it did to the auto-apply queue (FIX-API: each
 * count only when not 0); a Saved entry the extension is applying to now, or queued on a profile shared without Queue
 * changes, is left as it is (`archivedAt` still null).
 */
const UnsaveAnswerSchema = ApplicationRefSchema.extend({
  archivedAt: z.string().nullable().optional(),
  // v36 FIX-WEB (FIX-API's answer)
  dequeued: z.number().int().nonnegative().optional(),
  // v36 FIX-WEB (FIX-API's answer)
  applying: z.number().int().nonnegative().optional(),
  // v36 FIX-WEB (FIX-API's answer)
  queueLocked: z.number().int().nonnegative().optional(),
});
export type UnsaveAnswer = z.infer<typeof UnsaveAnswerSchema>;

export const archiveApplication = (applicationId: string) =>
  api.post<UnsaveAnswer>(`/api/applications/${encodeURIComponent(applicationId)}/archive`, undefined, { schema: UnsaveAnswerSchema });

/** Undo of an un-save: the archived application is active (and the job saved) again. */
export const restoreApplication = (applicationId: string) =>
  api.post<ApplicationRef>(`/api/applications/${encodeURIComponent(applicationId)}/restore`, undefined, { schema: ApplicationRefSchema });
