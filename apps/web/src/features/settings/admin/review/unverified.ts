import {
  AddJobResultSchema,
  UnverifiedLinksResponseSchema,
  type AddJobResult,
  type JobVerifyReason,
  type UnverifiedLink,
  type UnverifiedLinksResponse,
} from '@tailorit/shared/jobs';
import { REVIEW_LANE_LABEL, REVIEW_LANES, type ReviewLane } from '@tailorit/shared/reviews';
import { z } from 'zod';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';

// v31 ADMINWEB: Admin › Review's fourth lane, "Couldn't verify" (docs/design/v3.1/21-jobs-from-links.md §6, decision
// D2): the links TailorIT could not read that someone keeps as their own job. An admin may ask TailorIT to read a link
// again (Retry read) or reject it (never published, whoever adds it); an admin never types or publishes a job's
// content. The lane is the web's own: the shared lanes (REVIEW_LANES) are the review queue's, this one reads LINK's
// routes. Pure, so the tests read it without a page.

/** LINK's routes (apps/api/src/features/jobs/add/router.ts), in one place. */
export const UNVERIFIED_ROUTES = {
  list: '/api/admin/jobs/unverified',
  count: '/api/admin/jobs/unverified/count',
  retry: (jobId: number) => `/api/admin/jobs/unverified/${jobId}/retry`,
  reject: (jobId: number) => `/api/admin/jobs/unverified/${jobId}/reject`,
} as const;

/** A page of the list (the server's cap is 100). */
export const UNVERIFIED_PAGE_SIZE = 50;

const CountSchema = z.object({ count: z.number().int().nonnegative() });
const RejectSchema = z.object({ rejected: z.boolean(), jobs: z.number().int().nonnegative() });
export type RejectLinkResult = z.infer<typeof RejectSchema>;

/** GET /api/admin/jobs/unverified: one page, newest check first. */
export function fetchUnverified(cursor: string | undefined, signal?: AbortSignal): Promise<UnverifiedLinksResponse> {
  return api.get<UnverifiedLinksResponse>(UNVERIFIED_ROUTES.list, {
    signal,
    query: { cursor, limit: UNVERIFIED_PAGE_SIZE },
    schema: UnverifiedLinksResponseSchema,
  });
}

/** GET /api/admin/jobs/unverified/count: how many links the list holds (0 while the list is off). */
export function fetchUnverifiedCount(signal?: AbortSignal): Promise<number> {
  return api.get<{ count: number }>(UNVERIFIED_ROUTES.count, { signal, schema: CountSchema }).then((answer) => answer.count);
}

/** POST …/:jobId/retry: TailorIT reads the link again now. */
export function retryUnverified(jobId: number): Promise<AddJobResult> {
  return api.post<AddJobResult>(UNVERIFIED_ROUTES.retry(jobId), {}, { schema: AddJobResultSchema });
}

/** POST …/:jobId/reject: the link is never published (each adder keeps their own job). */
export function rejectUnverified(jobId: number): Promise<RejectLinkResult> {
  return api.post<RejectLinkResult>(UNVERIFIED_ROUTES.reject(jobId), {}, { schema: RejectSchema });
}

// The lanes ------------------------------------------------------------------------------------------------------------

/** The Review page's lanes: the review queue's three and "Couldn't verify". */
export type AdminReviewLane = ReviewLane | 'unverified';
export const ADMIN_REVIEW_LANES: readonly AdminReviewLane[] = [...REVIEW_LANES, 'unverified'];
export const ADMIN_REVIEW_LANE_LABEL: Record<AdminReviewLane, string> = { ...REVIEW_LANE_LABEL, unverified: "Couldn't verify" };

/** Whether a lane is one of the review queue's (the shared routes), not "Couldn't verify". */
export function isQueueLane(lane: AdminReviewLane): lane is ReviewLane {
  return lane !== 'unverified';
}

// A row's words --------------------------------------------------------------------------------------------------------

/**
 * Why TailorIT could not read a link, in an admin's words (the constants' MSG_JOB_VERIFY_* speak to the person who
 * added the job: "the job stays yours"), each saying what an admin may do about it.
 */
export const REASON_ADMIN_TEXT: Record<JobVerifyReason, string> = {
  unreadable_host: 'A site TailorIT never reads (a job board or a sign-in page).',
  no_posting: "The page doesn't describe its job as a schema.org JobPosting.",
  robots: "The site's robots.txt asks automated readers not to read it.",
  blocked: 'The site asked for a sign-in or a bot check.',
  unavailable: 'No answer from the site this time. Retry read later.',
  not_set_up: 'Page reads are off here: set BOT_USER_AGENT in .env, and keep "Read job pages on add" on in Constants.',
  unlisted: "The posting is not on its board's public list.",
  opted_out: 'The company asked TailorIT not to read its site.',
  rejected: 'An admin rejected this link.',
  closed: 'The posting has closed.',
  invalid_link: 'Not an https job link TailorIT may read.',
};

/** A link's short name for buttons and messages: its host and path, without https:// ("careers.acme.com/jobs/7"). */
export function linkName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    const short = `${parsed.hostname}${path}`;
    return short.length > 80 ? `${short.slice(0, 77)}...` : short;
  } catch {
    return url;
  }
}

/** "1 person", "3 people". */
const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

/** "Added by 2 people · first 3 days ago · checked 1 hour ago · 3 tries". */
export function unverifiedMetaLine(row: Pick<UnverifiedLink, 'adders' | 'firstAddedAt' | 'checkedAt' | 'attempts'>, now: number): string {
  const parts = [
    `Added by ${people(row.adders)}`,
    `first ${relativeTime(row.firstAddedAt, now)}`,
    `checked ${relativeTime(row.checkedAt, now)}`,
  ];
  if (row.attempts > 0) parts.push(`${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}`);
  return parts.join(' · ');
}

/** The lane's empty state: the list is off, or nothing waits. */
export function unverifiedEmptyText(listOn: boolean | null): { title: string; description: string } {
  if (listOn === false) {
    return {
      title: 'This list is off',
      description: "Turn on the switch above to list the links TailorIT couldn't read, so you can read them again or reject them.",
    };
  }
  return {
    title: 'No links to verify',
    description: "When TailorIT can't read a job someone added from its link, the link waits here. Only the people who added it see that job.",
  };
}

/** What a Retry read came to, for the toast (title, body) and the live region. */
export function retryOutcomeText(result: Pick<AddJobResult, 'state' | 'reason'>): { tone: 'success' | 'info'; title: string; body: string } {
  switch (result.state) {
    case 'published':
      return { tone: 'success', title: 'Read and published', body: "It is in everyone's job search, and the people who added it see the shared job." };
    case 'waiting_admin':
      return {
        tone: 'success',
        title: 'Read: waiting for approval',
        body: "New jobs need an admin's approval here, so it waits in Review › New jobs.",
      };
    case 'private_unverified':
      return { tone: 'info', title: "Still couldn't read it", body: result.reason ? REASON_ADMIN_TEXT[result.reason] : 'TailorIT will list it again.' };
    case 'refused':
      return { tone: 'info', title: 'Not published', body: result.reason ? REASON_ADMIN_TEXT[result.reason] : 'TailorIT did not add it.' };
  }
}

/** The Reject confirm's sentence. */
export function rejectText(row: Pick<UnverifiedLink, 'adders'>): string {
  const keep = row.adders === 1 ? 'The person who added it keeps their own copy.' : `The ${row.adders} people who added it keep their own copies.`;
  return `TailorIT will never publish a job from this link, whoever adds it. ${keep}`;
}
