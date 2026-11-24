'use client';

import { useEffect, type RefObject } from 'react';

// v36 JOBS (PLAN J8, A1; SP v36 REQUEST.md: "left bar (job list bar) will have scroll, so that there is no scroll for
// full page", "In Auto-Apply Page, There will be no scroll for full screen"): a page frame measured to the window. From
// its top on the page down to the window's edge less a small gap, so the page itself does not scroll and the frame's
// parts (the Jobs list and the job's details; the Auto-apply panes) scroll inside it. Measured, never guessed: the
// announcement banner, a search panel whose chips wrap, a card above it all move the frame's top. A window too short
// for the least height keeps it (the page then scrolls a little, as it must). v3.2's Jobs pane measure
// (features/jobs/useSplitLayout.ts usePaneHeight) generalised: one helper the Jobs and Auto-apply pages share.

/** The gap under a measured frame, above the window's edge (px). */
export const FRAME_BOTTOM_GAP = 16;
/** The least height a measured frame keeps (px): a shorter window scrolls the page instead. */
export const FRAME_MIN_HEIGHT = 360;
/** The CSS custom property the hook writes on the frame. */
export const FRAME_HEIGHT_VAR = '--frame-height';

export interface FrameHeightOptions {
  /** The least height (default FRAME_MIN_HEIGHT). */
  min?: number;
  /** The gap above the window's edge (default FRAME_BOTTOM_GAP). */
  gap?: number;
  /** The custom property written on the element (default FRAME_HEIGHT_VAR). */
  property?: string;
}

/**
 * A frame's height for its top at `top` on the page (from the page's top, so it does not move as the page scrolls) in a
 * window `viewport` tall: down to the window's edge less the gap, at least `min`. Whole pixels, rounded down (a frame a
 * fraction too tall would scroll the page by a pixel).
 */
export function frameHeight(top: number, viewport: number, options: Pick<FrameHeightOptions, 'min' | 'gap'> = {}): number {
  const min = options.min ?? FRAME_MIN_HEIGHT;
  const gap = options.gap ?? FRAME_BOTTOM_GAP;
  return Math.max(min, Math.floor(viewport - Math.max(top, 0) - gap));
}

/**
 * While `enabled`, writes the frame's height (frameHeight) on `frame` as a CSS custom property (`--frame-height`, or
 * `options.property`), which the frame's own classes read (e.g. `lg:h-[var(--frame-height,...)]`, with a fallback for
 * the first paint). Measured again when the window resizes and when anything on the page changes size (a
 * ResizeObserver on the body: the banner comes and goes, the search panel's chips wrap). Removed when off.
 */
export function useFrameHeight(frame: RefObject<HTMLElement | null>, enabled: boolean, options: FrameHeightOptions = {}): void {
  const { min, gap, property = FRAME_HEIGHT_VAR } = options;
  useEffect(() => {
    const element = frame.current;
    if (!enabled || !element) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.setProperty(property, `${frameHeight(top, window.innerHeight, { min, gap })}px`);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      element.style.removeProperty(property);
    };
  }, [frame, enabled, min, gap, property]);
}
