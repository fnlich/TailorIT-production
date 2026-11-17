'use client';

import { Badge } from '@/components/ui/Badge';
import { ClockIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { usePublicConstants } from '@/lib/constants';
import { heldTitleOf } from './copy';

// v30 X1-WEB: the held line (docs/design/part2/14-extension-reports.md §4.3): a job someone added with the extension,
// from a board no enabled source runs, is held for review (JobSummary.held). It is in their own lists (Saved Jobs,
// Tracker, Queue) at once, and in nobody else's search until an admin approves it; its detail says so, in
// MSG_EXT_JOB_HELD's words. Nothing tells the person who else added or reported it.

/** The job detail's held line: nothing for a job that is not held. */
export function HeldNotice({ held, className }: { held: boolean | undefined; className?: string }) {
  const { t, values } = usePublicConstants();
  if (!held) return null;
  return (
    <Notice tone="info" title={heldTitleOf(values)} className={className}>
      <span data-held-line="">{t('MSG_EXT_JOB_HELD')}</span>
    </Notice>
  );
}

/**
 * A list row's held mark ("Waiting for approval"), its sentence for assistive technology and on hover. v30 FIX-WEB
 * (UX-8): `sentenceId` names the sentence, for a card that points its aria-describedby at it.
 */
export function HeldBadge({ held, className, sentenceId }: { held: boolean | undefined; className?: string; sentenceId?: string }) {
  const { t, values } = usePublicConstants();
  if (!held) return null;
  const sentence = t('MSG_EXT_JOB_HELD');
  return (
    <Badge tone="warning" icon={<ClockIcon size={12} aria-hidden="true" />} title={sentence} className={className} data-held-badge="">
      {heldTitleOf(values)}
      <span className="sr-only" id={sentenceId}>
        . {sentence}
      </span>
    </Badge>
  );
}

/** v30 FIX-WEB (UX-8, UX-15): the held title in use, for a card's accessible name. */
export function useHeldTitle(): string {
  return heldTitleOf(usePublicConstants().values);
}
