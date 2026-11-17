'use client';

import { Badge } from '@/components/ui/Badge';
import { usePublicConstants } from '@/lib/constants';

// v30 FIX-WEB (REV-UX UX-10): a saved or tracked job that closed (an approved closed report, two listings that missed it)
// says so where the person keeps it, in the Saved pane and the Tracker, not only on its detail: a "Closed" mark
// (LABEL_JOB_CLOSED_MARK), its sentence (LABEL_JOB_CLOSED) read out and on hover. The API sends `closed: true` on
// Saved, Tracker and Queue items (FIX-B's optional field); an answer without it shows nothing.

/** Whether an item's job closed: `closed` is absent (an older answer, or a job still open) or false otherwise. */
export const isClosed = (item: object): boolean => (item as { closed?: unknown }).closed === true;

/** The closed mark, nothing for a job still open. `sentenceId` names its sentence for a card's aria-describedby. */
export function ClosedBadge({ closed, className, sentenceId }: { closed: boolean; className?: string; sentenceId?: string }) {
  const { t } = usePublicConstants();
  if (!closed) return null;
  const sentence = t('LABEL_JOB_CLOSED');
  return (
    <Badge tone="neutral" title={sentence} className={className} data-closed-badge="">
      {t('LABEL_JOB_CLOSED_MARK')}
      <span className="sr-only" id={sentenceId}>
        . {sentence}
      </span>
    </Badge>
  );
}
