'use client';

import type { JobVerification } from '@tailorit/shared';
import { Badge } from '@/components/ui/Badge';
import { EyeSlashIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { HeldBadge } from '../detail/held/HeldNotice';
import { verificationMark } from './copy';

// v31 JOBSWEB: a list row's mark of a job others do not see (./copy.ts): v3.0's "Waiting for approval" for a job an
// admin approves next, and "From your browser, not verified" for the person's own job TailorIT could not read, its
// sentence ("Only you can see this job until TailorIT verifies it.") read out and on hover.

/** The private mark alone (LABEL_JOB_FROM_BROWSER); `sentenceId` names its sentence for a card's aria-describedby. */
export function PrivateJobBadge({ className, sentenceId }: { className?: string; sentenceId?: string }) {
  const { t } = usePublicConstants();
  const sentence = t('MSG_JOB_ONLY_YOU_UNTIL_VERIFIED');
  return (
    <Badge
      tone="warning"
      icon={<EyeSlashIcon size={12} weight="bold" aria-hidden="true" />}
      title={sentence}
      className={className}
      data-private-badge=""
    >
      {t('LABEL_JOB_FROM_BROWSER')}
      <span className="sr-only" id={sentenceId}>
        . {sentence}
      </span>
    </Badge>
  );
}

/** The mark of a job or a tracker entry: nothing for a job everyone sees. */
export function VerificationBadge({
  held,
  verification,
  className,
  sentenceId,
}: {
  held?: boolean;
  verification?: JobVerification;
  className?: string;
  sentenceId?: string;
}) {
  const mark = verificationMark({ held, verification });
  if (mark === 'private') return <PrivateJobBadge className={className} sentenceId={sentenceId} />;
  if (mark === 'held') return <HeldBadge held className={className} sentenceId={sentenceId} />;
  return null;
}

/** The words a card adds to its accessible name for its mark (empty for a job everyone sees). */
export function useVerificationTitle(item: { held?: boolean; verification?: JobVerification }): string {
  const { t } = usePublicConstants();
  const mark = verificationMark(item);
  if (mark === 'private') return t('LABEL_JOB_FROM_BROWSER');
  if (mark === 'held') return t('MSG_JOB_HELD_TITLE');
  return '';
}
