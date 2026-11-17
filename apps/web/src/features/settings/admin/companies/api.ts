import {
  AdminCompaniesListSchema,
  AdminCompanyMatchReviewSchema,
  AdminCompanyMatchReviewsListSchema,
  AdminCompanySchema,
  AdminOptOutListSchema,
  AdminOptOutSchema,
  type AdminCompaniesQuery,
  type AdminCompany,
  type AdminCompanyEditBody,
  type AdminCompanyMatchDecisionBody,
  type AdminCompanyMatchReview,
  type AdminCompanyMergeBody,
  type AdminCompanyOptOutBody,
  type AdminCompanyRefreshBody,
  type AdminCompanySplitBody,
  type AdminOptOut,
  type AdminOptOutCreateBody,
  type CompanyMatchReviewKind,
  type CompanyMatchReviewStatus,
} from '@tailorit/shared/companies';
import { z } from 'zod';
import { COMPANY_ROUTES } from '@/features/companies/routes';
import { api } from '@/lib/api';

// v30 E0-WEB: Admin › Companies' requests (13-company-enrichment.md §5.5, §6.4): the companies, the editor's company
// and its changes (set, lock, unlock, merge, split, refresh, the opt-out), the match review queue and the opt-out list.

export type AdminCompaniesList = z.infer<typeof AdminCompaniesListSchema>;
export type AdminCompanyMatchReviewsList = z.infer<typeof AdminCompanyMatchReviewsListSchema>;
export type AdminOptOutList = z.infer<typeof AdminOptOutListSchema>;
export type ReviewStatusFilter = CompanyMatchReviewStatus | 'all';

/** React Query keys of Admin › Companies (all under ['admin', 'companies']). */
export const companiesAdminKeys = {
  all: ['admin', 'companies'] as const,
  lists: ['admin', 'companies', 'list'] as const,
  list: (q: string, filter: AdminCompaniesQuery['filter']) => ['admin', 'companies', 'list', q, filter] as const,
  company: (companyId: number) => ['admin', 'companies', 'one', companyId] as const,
  reviews: ['admin', 'companies', 'reviews'] as const,
  reviewList: (status: ReviewStatusFilter, kind: CompanyMatchReviewKind | null) => ['admin', 'companies', 'reviews', status, kind ?? 'all'] as const,
  optOuts: ['admin', 'companies', 'opt-outs'] as const,
};

export function fetchAdminCompanies(
  query: { q: string; filter: AdminCompaniesQuery['filter']; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<AdminCompaniesList> {
  return api.get<AdminCompaniesList>(COMPANY_ROUTES.adminList, {
    schema: AdminCompaniesListSchema,
    query: { q: query.q || undefined, filter: query.filter, cursor: query.cursor, limit: query.limit },
    signal,
  });
}

export function fetchAdminCompany(companyId: number, signal?: AbortSignal): Promise<AdminCompany> {
  return api.get<AdminCompany>(COMPANY_ROUTES.adminCompany(companyId), { schema: AdminCompanySchema, signal });
}

/** Set values (each then locked), lock or unlock fields. */
export function editAdminCompany(companyId: number, body: AdminCompanyEditBody): Promise<AdminCompany> {
  return api.patch<AdminCompany>(COMPANY_ROUTES.adminCompany(companyId), body, { schema: AdminCompanySchema });
}

/** Merge `otherId` into this company: the answer is the survivor. */
export function mergeAdminCompany(companyId: number, body: AdminCompanyMergeBody): Promise<AdminCompany> {
  return api.post<AdminCompany>(COMPANY_ROUTES.adminMerge(companyId), body, { schema: AdminCompanySchema });
}

/** The new company of a split: its id is all the editor needs (the rest, if sent, is not read). */
const SplitAnswerSchema = z.object({ id: z.number().int().positive() });

/** Move these boards and their jobs to a new company: the answer names it. */
export function splitAdminCompany(companyId: number, body: AdminCompanySplitBody): Promise<{ id: number }> {
  return api.post<{ id: number }>(COMPANY_ROUTES.adminSplit(companyId), body, { schema: SplitAnswerSchema });
}

/** Queue these enrichment steps (every step due, with none named). */
export function refreshAdminCompany(companyId: number, body: AdminCompanyRefreshBody): Promise<unknown> {
  return api.post(COMPANY_ROUTES.adminRefresh(companyId), body);
}

/** The opt-out switch: on adds its domains to the opt-out list, disables and purges its sources. */
export function setAdminCompanyOptOut(companyId: number, body: AdminCompanyOptOutBody): Promise<AdminCompany> {
  return api.put<AdminCompany>(COMPANY_ROUTES.adminOptOut(companyId), body, { schema: AdminCompanySchema });
}

/** Store an uploaded logo (TailorIT serves its own copy; the server checks the size and re-encodes it). */
export function uploadAdminCompanyLogo(companyId: number, file: File): Promise<AdminCompany> {
  const form = new FormData();
  form.append('logo', file);
  return api.put<AdminCompany>(COMPANY_ROUTES.adminLogo(companyId), form, { schema: AdminCompanySchema });
}

/** Remove the stored logo (the company shows its letter again). */
export function removeAdminCompanyLogo(companyId: number): Promise<AdminCompany> {
  return api.delete<AdminCompany>(COMPANY_ROUTES.adminLogo(companyId), { schema: AdminCompanySchema });
}

export function fetchCompanyReviews(
  query: { status: ReviewStatusFilter; kind: CompanyMatchReviewKind | null; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<AdminCompanyMatchReviewsList> {
  return api.get<AdminCompanyMatchReviewsList>(COMPANY_ROUTES.adminReviews, {
    schema: AdminCompanyMatchReviewsListSchema,
    query: { status: query.status, kind: query.kind ?? undefined, cursor: query.cursor, limit: query.limit },
    signal,
  });
}

export function decideCompanyReview(reviewId: number, body: AdminCompanyMatchDecisionBody): Promise<AdminCompanyMatchReview> {
  return api.post<AdminCompanyMatchReview>(COMPANY_ROUTES.adminReviewDecision(reviewId), body, { schema: AdminCompanyMatchReviewSchema });
}

/**
 * v30 FIX-WEB (REV-UX UX-13): takes a rejected review back to the queue (status open), through FIX-C's reopen route:
 * the decision route with `{ decision: 'reopen' }`. FIX-INT: if FIX-C's route has another shape, this is the one place.
 */
export function reopenCompanyReview(reviewId: number): Promise<AdminCompanyMatchReview> {
  return api.post<AdminCompanyMatchReview>(COMPANY_ROUTES.adminReviewDecision(reviewId), { decision: 'reopen' }, { schema: AdminCompanyMatchReviewSchema });
}

export function fetchOptOuts(cursor: string | undefined, signal?: AbortSignal): Promise<AdminOptOutList> {
  return api.get<AdminOptOutList>(COMPANY_ROUTES.adminOptOuts, { schema: AdminOptOutListSchema, query: { cursor }, signal });
}

export function addOptOut(body: AdminOptOutCreateBody): Promise<AdminOptOut> {
  return api.post<AdminOptOut>(COMPANY_ROUTES.adminOptOuts, body, { schema: AdminOptOutSchema });
}

export function removeOptOut(domain: string): Promise<unknown> {
  return api.delete(COMPANY_ROUTES.adminOptOutDomain(domain));
}
