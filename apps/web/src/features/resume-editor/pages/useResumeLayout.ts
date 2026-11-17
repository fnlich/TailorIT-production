'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ResumeDocument } from '@tailorit/shared';
import { layoutResume, paginateResume, type LaidOutResume, type PagePlan, type ViewMode } from '@tailorit/resume-templates';
import { viewOf } from './views';

// The page breaks of the resume the editor shows, from the heights of its boxes as the browser lays them out: one
// ResizeObserver reads every `[data-rt-box]` (its border box, which a CSS scale does not change), and the plan is
// worked out again at most once a frame, with the same paginator the PDF uses. A box that changes page moves by a
// spacer, never by a remount, so a field keeps its caret while the pages reflow around it.

/** Two plans that break the same pages (React keeps the old object, and nothing redraws). */
function samePlan(a: PagePlan | null, b: PagePlan): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export interface ResumeLayoutState {
  layout: LaidOutResume;
  /** Null until every box has been measured once. */
  plan: PagePlan | null;
  /** The element the layout is drawn in. */
  rootRef: (element: HTMLElement | null) => void;
  /** Every box's height as last measured (CSS px, unscaled), by box id. */
  heightsNow(): Record<string, number>;
}

export function useResumeLayout(document: ResumeDocument, mode: ViewMode): ResumeLayoutState {
  const layout = useMemo(() => layoutResume(document, mode, viewOf(document, mode)), [document, mode]);
  const [plan, setPlan] = useState<PagePlan | null>(null);
  const heights = useRef(new Map<string, number>());
  const latest = useRef(layout);
  const frame = useRef(0);
  const root = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    latest.current = layout;
  }, [layout]);

  const replan = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      try {
        const next = paginateResume(latest.current, Object.fromEntries(heights.current));
        setPlan((previous) => (samePlan(previous, next) ? previous : next));
      } catch {
        // A box not measured yet: its first measure plans again.
      }
    });
  }, []);

  useEffect(() => {
    const watcher = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // A box that left the page reports nothing true (a new one may already hold its id).
        if (!entry.target.isConnected) {
          watcher.unobserve(entry.target);
          continue;
        }
        const id = entry.target.getAttribute('data-rt-box');
        if (!id) continue;
        heights.current.set(id, entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height);
      }
      replan();
    });
    observer.current = watcher;
    if (root.current) for (const box of root.current.querySelectorAll('[data-rt-box]')) watcher.observe(box);
    return () => {
      watcher.disconnect();
      observer.current = null;
      cancelAnimationFrame(frame.current);
    };
  }, [replan]);

  // After every render: watch the boxes that appeared, forget the ones that went, and plan with the new flows.
  useLayoutEffect(() => {
    const element = root.current;
    const watcher = observer.current;
    if (!element || !watcher) return;
    const present = new Set<string>();
    for (const box of element.querySelectorAll('[data-rt-box]')) {
      const id = box.getAttribute('data-rt-box');
      if (!id) continue;
      present.add(id);
      watcher.observe(box);
    }
    for (const id of [...heights.current.keys()]) if (!present.has(id)) heights.current.delete(id);
    replan();
  });

  const rootRef = useCallback((element: HTMLElement | null) => {
    root.current = element;
  }, []);

  const heightsNow = useCallback(() => Object.fromEntries(heights.current), []);

  return { layout, plan, rootRef, heightsNow };
}
