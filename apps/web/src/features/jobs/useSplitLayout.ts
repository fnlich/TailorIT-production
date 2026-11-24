'use client';

import { useSyncExternalStore } from 'react';

// v32 JOBS2 (E3): the Jobs page's two layouts. From 1024 px the list and the job's detail sit side by side (the split);
// below, the list fills the page and a job opens full screen over it (the stack). The CSS draws the frame of each with
// the same breakpoint (`lg:`); the page's code needs to know which one is on to open a job the right way.

/** The split's media query: Tailwind's `lg`. */
export const SPLIT_QUERY = '(min-width: 1024px)';

function subscribe(listener: () => void): () => void {
  const list = window.matchMedia(SPLIT_QUERY);
  list.addEventListener('change', listener);
  return () => list.removeEventListener('change', listener);
}

/**
 * True for the split, false for the stack, null before the page knows (the server's render and hydration), so neither
 * the detail pane nor the full-screen sheet opens on a guess.
 */
export function useSplitLayout(): boolean | null {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(SPLIT_QUERY).matches,
    () => null,
  );
}

// v36 JOBS (PLAN J8): v3.2's pane measure (usePaneHeight) became lib/useFrameHeight.ts: the whole frame (the list and
// the pane) is measured to the window, so only the list and the pane scroll.
