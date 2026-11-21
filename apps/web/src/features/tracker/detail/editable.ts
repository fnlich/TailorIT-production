'use client';

import { createContext, useContext } from 'react';

/**
 * v33 SHARE-9 (PLAN-sharing.md §9 "Permission-aware UI": can() hides write controls): whether the open application may
 * be changed: the tab's profile lets the person change its Job Tracker (`tracker:edit`; always on their own). The
 * detail sheet provides it; its panels hide or lock what would change the application (the stage, dates, notes,
 * questions, the linked documents, the header's actions). Absent: yes.
 */
export const TrackerEditContext = createContext(true);

/** Whether the open application may be changed (TrackerEditContext). */
export function useTrackerEditable(): boolean {
  return useContext(TrackerEditContext);
}
