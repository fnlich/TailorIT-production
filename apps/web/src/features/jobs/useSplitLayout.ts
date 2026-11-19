'use client';

import { useEffect, useSyncExternalStore, type RefObject } from 'react';

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

/** The pane's bottom margin above the window's edge, and the least height it keeps on a short window. */
export const PANE_BOTTOM_GAP = 16;
export const PANE_MIN_HEIGHT = 360;

/** The pane's height for its top edge at `top` in a window `viewport` tall: down to the window's edge, less the gap. */
export function paneHeight(top: number, viewport: number): number {
  return Math.max(PANE_MIN_HEIGHT, Math.round(viewport - Math.max(top, 0) - PANE_BOTTOM_GAP));
}

/**
 * The split's pane is as tall as the window shows of it: its bottom stays just above the window's edge while the page
 * header and the search panel scroll away, and it grows until it sticks under the results bar. So the whole job is in
 * reach from the first look (nothing of it hides below the fold), and wheeling over it scrolls the job, never the page
 * behind it. Writes `--pane-height` on the pane (the CSS falls back to the stuck height before this runs).
 */
export function usePaneHeight(pane: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const element = pane.current;
    if (!enabled || !element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      element.style.setProperty('--pane-height', `${paneHeight(element.getBoundingClientRect().top, window.innerHeight)}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // The search panel above can change height (the filters' chips come and go): the pane's top moves with it.
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      element.style.removeProperty('--pane-height');
    };
  }, [pane, enabled]);
}
