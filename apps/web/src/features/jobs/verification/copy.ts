import type { AddJobResult, JobVerification, JobVerifyReason } from '@tailorit/shared';
import { isNeverReadLink } from '@tailorit/shared/sourcing'; // v38 FIX-APP (ux L3)
import type { MessageRenderer } from '@/lib/messages';
import { reasonText } from '../add/outcome';

// v31 JOBSWEB (docs/design/v3.1/21-jobs-from-links.md §6): a job others do not see says so wherever its person meets it
// (the Jobs card and detail, the Tracker's card and row, the Saved pane):
// - `waiting_admin`: TailorIT read it, an admin approves it next. v3.0's held mark says it ("Waiting for approval",
//   MSG_JOB_HELD_TITLE), as the API also sends `held: true` for it.
// - `private_unverified`: TailorIT could not read its link, so it is the person's own, its words from their browser:
//   LABEL_JOB_FROM_BROWSER, with MSG_JOB_ONLY_YOU_UNTIL_VERIFIED, and Retry read (POST /api/jobs/:id/verify).
// - v32 INT-1 (E6, ADMINAPP's `admin_approved`): a job everyone sees that TailorIT could not read, published by an
//   admin as it was captured: LABEL_JOB_APPROVED_BY_ADMIN, its "?" MSG_JOB_APPROVED_BY_ADMIN. v36 JOBS (PLAN J7): shown
//   to admins only (VerificationBadge.tsx useVerificationMark; the API sends the state to admins alone).

/**
 * Which mark an item's job carries: its own (unverified), waiting for an admin, approved by an admin (everyone sees it,
 * as it was added), or none (everyone sees it, as TailorIT read it).
 */
export type VerificationMark = 'private' | 'held' | 'approved' | null;

/** The mark of a job or a tracker entry (`held` and `verification` are optional fields of their DTOs). */
export function verificationMark(item: { held?: boolean; verification?: JobVerification }): VerificationMark {
  if (item.verification?.state === 'private_unverified') return 'private';
  if (item.held === true || item.verification?.state === 'waiting_admin') return 'held';
  if (item.verification?.state === 'admin_approved') return 'approved';
  return null;
}

/**
 * v38 FIX-APP (REVIEW38-ux L3): a link on a site TailorIT never reads: its reason is the platform's lasting answer (a bot
 * check on every page, the employer's own login), or robots.txt's refusal on a platform TailorIT never reads (SAP
 * SuccessFactors). Its job is its adder's for good: no Retry read (it would only spend a try and answer the same).
 */
export function isNeverRead(reason: JobVerifyReason | null | undefined, url?: string | null): boolean {
  return reason === 'bot_check' || reason === 'needs_login' || (reason === 'robots' && isNeverReadLink(url));
}

/**
 * Retry read applies: a job only its adder sees because TailorIT could not read its link. v38 FIX-APP (ux L3): never one
 * of a site TailorIT never reads (the entry's link, or the job's).
 */
export const canRetryRead = (item: { verification?: JobVerification; postingUrl?: string | null; applyUrl?: string | null }): boolean =>
  item.verification?.state === 'private_unverified' && !isNeverRead(item.verification.reason, item.postingUrl ?? item.applyUrl);

/** The Retry read button's words, and its results' titles. */
export const RETRY_READ_COPY = {
  button: 'Retry read',
  published: 'Now everyone can see this job',
  stillPrivate: 'Still only yours',
  refused: "This job can't be shared",
  // v37 FIX-REV (REVIEW361-ux M5): a Retry read that found the posting closed closed the person's own job.
  closed: 'Job closed',
  failed: "TailorIT couldn't try again right now",
  checked: 'Last tried',
} as const;

/**
 * What a Retry read came to, as its toast says it: read now (everyone sees it, or an admin approves it next: `read`, the
 * shared job opens), still only the person's (why), or refused. v37 FIX-REV (REVIEW361-ux M5): a posting found closed
 * is an answer, not an error: TailorIT closed the person's own job (it stays in their list, Closed, with no "not
 * verified" mark and no Retry read).
 */
export function retryReadAnswer(
  result: Pick<AddJobResult, 'state' | 'reason' | 'message'>,
  t: MessageRenderer,
): { tone: 'success' | 'info' | 'error'; title: string; body: string; read: boolean } {
  if (result.state === 'published') return { tone: 'success', title: RETRY_READ_COPY.published, body: result.message, read: true };
  if (result.state === 'waiting_admin') return { tone: 'success', title: t('MSG_JOB_HELD_TITLE'), body: result.message, read: true };
  if (result.state === 'refused' && result.reason === 'closed') return { tone: 'info', title: RETRY_READ_COPY.closed, body: result.message, read: false };
  if (result.state === 'private_unverified') {
    const why = reasonText(result.reason, t);
    return { tone: 'info', title: RETRY_READ_COPY.stillPrivate, body: why && why !== result.message ? `${result.message} ${why}` : result.message, read: false };
  }
  return { tone: 'error', title: RETRY_READ_COPY.refused, body: result.message, read: false };
}
