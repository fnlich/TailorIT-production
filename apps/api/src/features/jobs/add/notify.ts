import { JOB_VERIFY_REASON_MESSAGE, type JobAddState, type JobVerifyReason } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';

// v31 LINK: the notices of a job's verification (TailorIT read it, it waits for an admin, it could not read it, it was
// refused), for the people it concerns, through NOTIFY's notifyJobVerification (features/notifications/index.ts: never
// throws, dedupes per job and state, `reason` a sentence for people).
import { notifyJobVerification } from '../../notifications/index'; // v31 LINK (INT-1: NOTIFY's)

/** Tells a person what became of their job's link, the reason in words; never fails the caller. */
export async function noticeVerification(
  deps: AppDeps,
  notice: { userId: string; jobId: number | null; state: JobAddState; reason?: JobVerifyReason | null },
): Promise<void> {
  try {
    const reason = notice.reason ? constantsOf(deps).message(JOB_VERIFY_REASON_MESSAGE[notice.reason]) : null;
    await notifyJobVerification(deps, { userId: notice.userId, jobId: notice.jobId, state: notice.state, reason });
  } catch (error) {
    deps.log.warn('[job-links] a verification notice could not be written', error instanceof Error ? error.name : 'unknown');
  }
}
