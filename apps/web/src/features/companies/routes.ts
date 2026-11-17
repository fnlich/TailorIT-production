// v30 E0-WEB: the companies' API addresses, in one place, as E0-API serves them (companies/router.ts and admin.ts;
// v30 INT-3 checked them against the merged routes: all match). Unit tests and companies.spec still answer them
// themselves (contract fixtures). Bodies and answers are CT's schemas
// (@tailorit/shared/companies). A path that differs at INT-3 changes here.

const id = (value: number) => encodeURIComponent(String(value));

export const COMPANY_ROUTES = {
  /** GET: the company page (CompanyPage); a merged company answers its survivor. */
  page: (companyId: number) => `/api/companies/${id(companyId)}`,
  /** GET ?state=open|closed&cursor=: its open positions or its closed history (CompanyJobsResponse). */
  jobs: (companyId: number) => `/api/companies/${id(companyId)}/jobs`,
  /** GET ?q&filter&cursor&limit: Admin › Companies (AdminCompaniesList). */
  adminList: '/api/admin/companies',
  /** GET: the editor's company (AdminCompany); PATCH AdminCompanyEditBody: set, lock, unlock (AdminCompany). */
  adminCompany: (companyId: number) => `/api/admin/companies/${id(companyId)}`,
  /** POST AdminCompanyMergeBody: merge another company into this one (AdminCompany, the survivor). */
  adminMerge: (companyId: number) => `/api/admin/companies/${id(companyId)}/merge`,
  /** POST AdminCompanySplitBody: move boards to a new company (the new company: AdminCompany, or at least its id). */
  adminSplit: (companyId: number) => `/api/admin/companies/${id(companyId)}/split`,
  /** POST AdminCompanyRefreshBody: refresh now (202; the answer is not read). */
  adminRefresh: (companyId: number) => `/api/admin/companies/${id(companyId)}/refresh`,
  /** PUT AdminCompanyOptOutBody: the opt-out switch (AdminCompany). */
  adminOptOut: (companyId: number) => `/api/admin/companies/${id(companyId)}/opt-out`,
  /** PUT multipart (one file in `logo`): store an uploaded logo; DELETE: remove it (AdminCompany either way). */
  adminLogo: (companyId: number) => `/api/admin/companies/${id(companyId)}/logo`,
  /** GET ?status&kind&cursor&limit: the match review queue (AdminCompanyMatchReviewsList). */
  adminReviews: '/api/admin/company-reviews',
  /** POST AdminCompanyMatchDecisionBody: accept or reject one (AdminCompanyMatchReview). */
  adminReviewDecision: (reviewId: number) => `/api/admin/company-reviews/${id(reviewId)}`,
  /** GET ?cursor: the opt-out list (AdminOptOutList); POST AdminOptOutCreateBody: add a domain (201, AdminOptOut). */
  adminOptOuts: '/api/admin/company-opt-outs',
  /** DELETE: take a domain off the opt-out list (its answer is not read). */
  adminOptOutDomain: (domain: string) => `/api/admin/company-opt-outs/${encodeURIComponent(domain)}`,
} as const;

/** The company page's address in the web app. */
export function companyHref(companyId: number): string {
  return `/companies/${id(companyId)}`;
}
