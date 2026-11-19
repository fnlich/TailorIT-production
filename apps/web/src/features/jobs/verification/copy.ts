import type { JobVerification } from '@tailorit/shared';

// v31 JOBSWEB (docs/design/v3.1/21-jobs-from-links.md §6): a job others do not see says so wherever its person meets it
// (the Jobs card and detail, the Tracker's card and row, the Saved pane):
// - `waiting_admin`: TailorIT read it, an admin approves it next. v3.0's held mark says it ("Waiting for approval",
//   MSG_JOB_HELD_TITLE), as the API also sends `held: true` for it.
// - `private_unverified`: TailorIT could not read its link, so it is the person's own, its words from their browser:
//   LABEL_JOB_FROM_BROWSER, with MSG_JOB_ONLY_YOU_UNTIL_VERIFIED, and Retry read (POST /api/jobs/:id/verify).
// - v32 INT-1 (E6, ADMINAPP's `admin_approved`): a job everyone sees that TailorIT could not read, published by an
//   admin as it was captured: LABEL_JOB_APPROVED_BY_ADMIN, its "?" MSG_JOB_APPROVED_BY_ADMIN.

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

/** Retry read applies: a job only its adder sees because TailorIT could not read its link. */
export const canRetryRead = (item: { verification?: JobVerification }): boolean => item.verification?.state === 'private_unverified';

/** The Retry read button's words, and its results' titles. */
export const RETRY_READ_COPY = {
  button: 'Retry read',
  published: 'Now everyone can see this job',
  stillPrivate: 'Still only yours',
  refused: "This job can't be shared",
  failed: "TailorIT couldn't try again right now",
  checked: 'Last tried',
} as const;
