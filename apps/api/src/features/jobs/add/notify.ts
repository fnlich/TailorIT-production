import { JOB_VERIFY_REASON_MESSAGE, type JobAddState, type JobVerifyReason } from '@tailorit/shared';
import { grantHolds, liveGrantById } from '../../../core/auth/grants'; // v33 SHARE-6
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { LinkAdder } from './verification'; // v33 SHARE-6

// v31 LINK: the notices of a job's verification (TailorIT read it, it waits for an admin, it could not read it, it was
// refused), for the people it concerns, through NOTIFY's notifyJobVerification (features/notifications/index.ts: never
// throws, dedupes per job and state, `reason` a sentence for people).
import { notifyJobVerification } from '../../notifications/index'; // v31 LINK (INT-1: NOTIFY's)

/** v33 SHARE-6: who hears about a link's job, and on which profile (a shared profile's key; none: their own). */
export interface LinkNoticeTarget {
  userId: string;
  profile: string | null;
}

/**
 * v33 SHARE-6 (PLAN-sharing §4 "Explicit changes": addJobByLink takes the actor, who receives the job-link notices,
 * separately from the owner): who hears what became of a job's link. Someone who added it on the owner's profile hears it
 * there (the notice opens the job on that profile) while the grant they added it under is live, is still that owner's
 * and theirs, and lets them see the Job Tracker; otherwise the job's owner hears it, as before.
 */
export async function linkNoticeTarget(deps: AppDeps, adder: LinkAdder): Promise<LinkNoticeTarget> {
  const own: LinkNoticeTarget = { userId: adder.user_id, profile: null };
  if (!adder.added_by || !adder.grant_id || adder.added_by === adder.user_id) return own;
  const grant = await liveGrantById(deps, adder.grant_id);
  if (!grant || grant.owner.id !== adder.user_id || grant.granteeId !== adder.added_by || !grantHolds(grant, 'tracker:view')) return own;
  return { userId: adder.added_by, profile: grant.id };
}

/**
 * Tells a person what became of their job's link, the reason in words; never fails the caller. v32 ADMINAPP (E6):
 * `approvedByAdmin`, a job TailorIT could not read that an admin published as it was captured (approve.ts). v32 FIX-API
 * (SB-1): `publicVersion`, an admin published another adder's version of the person's job (theirs stays theirs).
 */
export async function noticeVerification(
  deps: AppDeps,
  notice: {
    userId: string;
    jobId: number | null;
    state: JobAddState;
    reason?: JobVerifyReason | null;
    approvedByAdmin?: boolean;
    publicVersion?: boolean;
    /** v33 SHARE-6: a shared profile the notice opens the job on (linkNoticeTarget). */
    profile?: string | null;
  },
): Promise<void> {
  try {
    const reason = notice.reason ? constantsOf(deps).message(JOB_VERIFY_REASON_MESSAGE[notice.reason]) : null;
    await notifyJobVerification(deps, {
      userId: notice.userId,
      jobId: notice.jobId,
      state: notice.state,
      reason,
      ...(notice.approvedByAdmin ? { approvedByAdmin: true } : {}),
      ...(notice.publicVersion ? { publicVersion: true } : {}),
      ...(notice.profile ? { profile: notice.profile } : {}), // v33 SHARE-6
    });
  } catch (error) {
    deps.log.warn('[job-links] a verification notice could not be written', error instanceof Error ? error.name : 'unknown');
  }
}
