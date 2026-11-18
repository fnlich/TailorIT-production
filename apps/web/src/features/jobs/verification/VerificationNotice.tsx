'use client';

import type { JobVerification } from '@tailorit/shared';
import { Button } from '@/components/ui/Button';
import { ArrowsClockwiseIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { usePublicConstants } from '@/lib/constants';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { reasonText } from '../add/outcome';
import { RETRY_READ_COPY } from './copy';
import { useRetryRead } from './useRetryRead';

/**
 * v31 JOBSWEB: the job detail's line for the person's own job TailorIT could not read (./copy.ts): "From your browser,
 * not verified", "Only you can see this job until TailorIT verifies it.", why, when TailorIT last tried, and Retry read.
 * Nothing for any other job (a job waiting for an admin has v3.0's held line).
 */
export function VerificationNotice({
  jobId,
  verification,
  onRead,
  className,
}: {
  jobId: number;
  verification: JobVerification | undefined;
  /** The shared job that took the place of this one after a Retry read that worked. */
  onRead?: (jobId: number) => void;
  className?: string;
}) {
  const { t } = usePublicConstants();
  const now = useNow();
  const { retry, pending } = useRetryRead({ onRead });
  if (verification?.state !== 'private_unverified') return null;
  const why = reasonText(verification.reason, t);
  return (
    <Notice
      tone="warning"
      title={t('LABEL_JOB_FROM_BROWSER')}
      className={className}
      action={
        <Button
          variant="outline"
          size="sm"
          icon={<ArrowsClockwiseIcon size={14} />}
          loading={pending}
          onClick={() => retry(jobId)}
          data-retry-read=""
        >
          {RETRY_READ_COPY.button}
        </Button>
      }
    >
      <p data-only-you-line="">{t('MSG_JOB_ONLY_YOU_UNTIL_VERIFIED')}</p>
      {why && <p className="mt-1">{why}</p>}
      {verification.checkedAt && (
        <p className="mt-1 text-xs leading-4">
          {RETRY_READ_COPY.checked} {relativeTime(verification.checkedAt, now)}.
        </p>
      )}
    </Notice>
  );
}
