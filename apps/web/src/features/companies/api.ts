import {
  CompanyJobsResponseSchema,
  CompanyPageSchema,
  type CompanyJobState,
  type CompanyJobsResponse,
  type CompanyPage,
} from '@tailorit/shared/companies';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { COMPANY_ROUTES } from './routes';

// v30 E0-WEB: what the company page reads (owner question 24): the company with its profile, and its two lists.

export const companyKeys = {
  all: ['companies'] as const,
  page: (companyId: number) => ['companies', 'page', companyId] as const,
  jobs: (companyId: number, state: CompanyJobState) => ['companies', 'jobs', companyId, state] as const,
};

/** GET /api/companies/:id: the profile, "Part of", the sources and the counts. */
export function fetchCompanyPage(companyId: number, signal?: AbortSignal): Promise<CompanyPage> {
  return api.get<CompanyPage>(COMPANY_ROUTES.page(companyId), { schema: CompanyPageSchema, signal });
}

/** GET /api/companies/:id/jobs: a page of its open positions (newest first) or its closed history (latest closed first). */
export function fetchCompanyJobs(companyId: number, state: CompanyJobState, cursor: string | undefined, signal?: AbortSignal): Promise<CompanyJobsResponse> {
  return api.get<CompanyJobsResponse>(COMPANY_ROUTES.jobs(companyId), { schema: CompanyJobsResponseSchema, query: { state, cursor }, signal });
}

export function useCompanyPage(companyId: number | null) {
  return useQuery({
    queryKey: companyKeys.page(companyId ?? 0),
    queryFn: ({ signal }) => fetchCompanyPage(companyId!, signal),
    enabled: companyId !== null,
  });
}

export function useCompanyJobs(companyId: number | null, state: CompanyJobState, enabled = true) {
  return useInfiniteQuery({
    queryKey: companyKeys.jobs(companyId ?? 0, state),
    queryFn: ({ pageParam, signal }) => fetchCompanyJobs(companyId!, state, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: companyId !== null && enabled,
  });
}
