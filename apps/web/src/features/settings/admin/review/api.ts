import {
  AdminReviewCountsSchema,
  AdminFlagBulkResultSchema,
  AdminFlagListSchema,
  AdminFlagSchema,
  AdminReviewBulkResultSchema,
  AdminReviewDetailSchema,
  AdminReviewListSchema,
  AdminReviewReportersSchema,
  AdminReviewRowSchema,
  REVIEW_PAGE_SIZE, // v37 REVIEW (R1)
  type AdminFlag,
  type AdminFlagBulkBody,
  type AdminFlagDecisionBody,
  type AdminFlagList,
  type AdminReviewBulkBody,
  type AdminReviewBulkResult,
  type AdminReviewCounts,
  type AdminReviewDecisionBody,
  type AdminReviewDetail,
  type AdminReviewList,
  type AdminReviewReporters,
  type AdminReviewRow,
  type JobReviewKind,
  type NewJobFromFilter,
  type ReviewStateFilter,
} from '@tailorit/shared/reviews';
import { ReviewRetryReadSchema, type ReviewRetryRead } from '@tailorit/shared/jobs'; // v32 ADMINAPP (E6)
import type { z } from 'zod';
import { api } from '@/lib/api';

// v30 X1-WEB: Admin › Review's requests (docs/design/part2/14-extension-reports.md §6), in CT's contracts
// (@tailorit/shared/reviews). X1-API builds the routes; INT-3 renames a path here, in one place, if it must.
// v37 REVIEW (SP v37 PLAN.md R1, R3): each page is REVIEW_PAGE_SIZE (100) rows; the "all" routes of every lane are
// all.ts's.

/** The routes, in one place. */
export const REVIEW_ROUTES = {
  reviews: '/api/admin/reviews',
  counts: '/api/admin/reviews/counts', // v30 FIX-WEB (REQ-8)
  review: (id: number) => `/api/admin/reviews/${id}`,
  reporters: (id: number) => `/api/admin/reviews/${id}/reporters`,
  retry: (id: number) => `/api/admin/reviews/${id}/retry`, // v32 ADMINAPP (E6)
  reviewsBulk: '/api/admin/reviews/bulk',
  flags: '/api/admin/flags',
  flag: (id: number) => `/api/admin/flags/${id}`,
  flagsBulk: '/api/admin/flags/bulk',
  // v37 REVIEW (R3): "Select all N", then a decision on every item the lane's filter matches.
  reviewsAll: '/api/admin/reviews/all',
  reviewsAllCount: '/api/admin/reviews/all/count',
  flagsAll: '/api/admin/flags/all',
  flagsAllCount: '/api/admin/flags/all/count',
} as const;

/** The query a lane's list reads: its state filter, a search and the page's cursor. */
export interface ReviewListQuery {
  state: ReviewStateFilter;
  q: string;
  cursor?: string;
  /** v35 OPSWEB (PLAN H3): New jobs' From filter (absent: all) and one import (its run). */
  from?: NewJobFromFilter;
  importRunId?: number;
}

/** React Query keys (under the admin console's own `['admin', …]`). */
export const reviewKeys = {
  all: ['admin', 'review'] as const,
  counts: ['admin', 'review', 'counts'] as const, // v30 FIX-WEB (REQ-8)
  // v35 OPSWEB: and New jobs' From filter ('all' elsewhere).
  lane: (lane: JobReviewKind | 'flags', state: ReviewStateFilter, q: string, from = 'all') => ['admin', 'review', 'list', lane, state, q, from] as const,
  detail: (id: number) => ['admin', 'review', 'detail', id] as const,
  reporters: (id: number) => ['admin', 'review', 'reporters', id] as const,
  // v31 ADMINWEB: "Couldn't verify" (LINK's routes, review/unverified.ts), under `all` so a refresh reads it again too.
  unverified: ['admin', 'review', 'unverified', 'list'] as const,
  unverifiedCount: ['admin', 'review', 'unverified', 'count'] as const,
  // v32 FIX-API (SB-1): a row's job in full (every version), under `all` too.
  unverifiedDetail: (jobId: number) => ['admin', 'review', 'unverified', 'detail', jobId] as const,
};

const query = ({ state, q, cursor, from, importRunId }: ReviewListQuery) => ({ state, q: q.trim() || undefined, cursor, from, importRunId, limit: REVIEW_PAGE_SIZE });

/** GET /api/admin/reviews: one page of the Closed links or New jobs lane, and every lane's count. */
export function fetchReviews(lane: JobReviewKind, list: ReviewListQuery, signal?: AbortSignal): Promise<AdminReviewList> {
  return api.get<AdminReviewList>(REVIEW_ROUTES.reviews, { signal, query: { lane, ...query(list) }, schema: AdminReviewListSchema });
}

/** v30 FIX-WEB (REV-REQ REQ-8): GET /api/admin/reviews/counts: what waits for a decision in each lane (the admin nav's count). */
export function fetchReviewCounts(signal?: AbortSignal): Promise<AdminReviewCounts> {
  return api.get<AdminReviewCounts>(REVIEW_ROUTES.counts, { signal, schema: AdminReviewCountsSchema });
}

/** GET /api/admin/reviews/:id: the detail sheet's evidence. */
export function fetchReview(id: number, signal?: AbortSignal): Promise<AdminReviewDetail> {
  return api.get<AdminReviewDetail>(REVIEW_ROUTES.review(id), { signal, schema: AdminReviewDetailSchema });
}

/** GET /api/admin/reviews/:id/reporters: the accounts that reported it (admins only, owner question 28). */
export function fetchReporters(id: number, signal?: AbortSignal): Promise<AdminReviewReporters> {
  return api.get<AdminReviewReporters>(REVIEW_ROUTES.reporters(id), { signal, schema: AdminReviewReportersSchema });
}

/** PATCH /api/admin/reviews/:id: approve, reject or reopen one review, with an optional note. */
export function decideReview(id: number, body: AdminReviewDecisionBody): Promise<AdminReviewRow> {
  return api.patch<AdminReviewRow>(REVIEW_ROUTES.review(id), body, { schema: AdminReviewRowSchema });
}

/** v32 ADMINAPP (E6) POST /api/admin/reviews/:id/retry: TailorIT reads a waiting new job's link again now. */
export function retryReviewRead(id: number): Promise<ReviewRetryRead> {
  return api.post<ReviewRetryRead>(REVIEW_ROUTES.retry(id), {}, { schema: ReviewRetryReadSchema });
}

/** POST /api/admin/reviews/bulk: approve or reject up to ADMIN_BULK_MAX reviews; each row says what happened. */
export function bulkReviews(body: AdminReviewBulkBody): Promise<AdminReviewBulkResult> {
  return api.post<AdminReviewBulkResult>(REVIEW_ROUTES.reviewsBulk, body, { schema: AdminReviewBulkResultSchema });
}

/** GET /api/admin/flags: one page of the Flags lane (the Jobs page's other flags), and every lane's count. */
export function fetchFlags(list: ReviewListQuery, signal?: AbortSignal): Promise<AdminFlagList> {
  return api.get<AdminFlagList>(REVIEW_ROUTES.flags, { signal, query: query(list), schema: AdminFlagListSchema });
}

/** PATCH /api/admin/flags/:id: reopen, resolve or dismiss a flag, closing its job too when asked. */
export function decideFlag(id: number, body: AdminFlagDecisionBody): Promise<AdminFlag> {
  return api.patch<AdminFlag>(REVIEW_ROUTES.flag(id), body, { schema: AdminFlagSchema });
}

export type AdminFlagBulkResult = z.infer<typeof AdminFlagBulkResultSchema>;

/** POST /api/admin/flags/bulk: resolve or dismiss up to ADMIN_BULK_MAX flags. */
export function bulkFlags(body: AdminFlagBulkBody): Promise<AdminFlagBulkResult> {
  return api.post<AdminFlagBulkResult>(REVIEW_ROUTES.flagsBulk, body, { schema: AdminFlagBulkResultSchema });
}
