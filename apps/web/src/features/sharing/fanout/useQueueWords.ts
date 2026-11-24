'use client';

// Relative, not '@/': the web tests draw the parts that use it.
import { usePublicConstants, type PublicMessageKey } from '../../../lib/constants';
import { tabCan, useTabProfile } from '../access';
import { FANOUT_COPY } from './copy';
import { rowName } from './targets';

// v36 FIX-WEB (SP v36 FINAL-FIXES D1): the words a removal on the tab's profile says about the auto-apply queue: the
// box that takes a job out of a shared profile's queue ("Queue changes"), whose profile it is, and whether the tab may.

export interface QueueWords {
  /** The Queue changes box's row name, as the Sharing page shows it. */
  box: string;
  /** The tab's profile as a result names it: its owner's name on a shared profile, "You" on the person's own. */
  name: string;
  /** The tab may take jobs out of its queue (always on the person's own profile). */
  canChange: boolean;
}

export function useQueueWords(): QueueWords {
  const tab = useTabProfile();
  const { t } = usePublicConstants();
  return {
    box: rowName('queue:edit', (key) => t(key as PublicMessageKey)),
    name: tab.ownerName ?? FANOUT_COPY.you,
    canChange: tabCan(tab, 'queue:edit'),
  };
}
