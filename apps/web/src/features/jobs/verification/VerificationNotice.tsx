'use client';

import type { JobVerification } from '@tailorit/shared';
import { clsx } from 'clsx';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ArrowsClockwiseIcon, EyeSlashIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { reasonText } from '../add/outcome';
import { HelpTip } from '@/components/ui/HelpTip';
import { RETRY_READ_COPY } from './copy';
import { ApprovedJobBadge } from './VerificationBadge';
import { useRetryRead } from './useRetryRead';

/**
 * v31 JOBSWEB: the state of the person's own job TailorIT could not read (./copy.ts), on the job's detail and the
 * Tracker's: "From your browser, not verified", and Retry read. v32 JOBS2 (E4): a chip, not a banner: its "?" holds the
 * sentence ("Only you can see this job until TailorIT verifies it."), why, and when TailorIT last tried. Nothing for any
 * other job (a job waiting for an admin has v3.0's held state).
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
  // v32 INT-1 (E6): a job an admin published as it was added: its chip and "?" (no Retry read: everyone sees it).
  if (verification?.state === 'admin_approved') return <ApprovedJobBadge className={className} />;
  if (verification?.state !== 'private_unverified') return null;
  const why = reasonText(verification.reason, t);
  const title = t('LABEL_JOB_FROM_BROWSER');
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-1.5', className)} data-private-state="">
      <span className="inline-flex items-center gap-1">
        <Badge tone="warning" icon={<EyeSlashIcon size={12} weight="bold" aria-hidden="true" />} data-private-badge="">
          {title}
        </Badge>
        <HelpTip label={title}>
          <span data-only-you-line="">{t('MSG_JOB_ONLY_YOU_UNTIL_VERIFIED')}</span>
          {why && ` ${why}`}
          {verification.checkedAt && ` ${RETRY_READ_COPY.checked} ${relativeTime(verification.checkedAt, now)}.`}
        </HelpTip>
      </span>
      <Button
        variant="outline"
        size="sm"
        icon={<ArrowsClockwiseIcon size={14} />}
        loading={pending}
        onClick={() => retry(jobId)}
        className="h-7 px-2.5"
        data-retry-read=""
      >
        {RETRY_READ_COPY.button}
      </Button>
    </span>
  );
}
