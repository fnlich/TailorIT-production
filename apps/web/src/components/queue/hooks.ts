'use client';

import { useEffect, useRef, useState, type FocusEvent, type RefObject } from 'react';
// Relative, not '@/': the web tests draw the panes that use these hooks.
import { useMediaQuery } from '../../lib/useMediaQuery';

// v30 ST0: the queue-style panes' hooks, moved unchanged from features/auto-apply/Pane.tsx (v2.0).

/** What a row's action carries, so focus can find the row's action again once it changed (useRowFocus). */
export const ROW_ACTION = { 'data-row-action': '' } as const;

/**
 * v2.0 fix (UX-3): keeps keyboard focus in a row whose action changes under it. Prepare becomes Cancel, then
 * View in queue: the focused button unmounts and focus fell to `<body>`, so the person started again from the top of
 * the page. When focus was in the row and nothing else has it now, it moves to the row's new action (the element
 * marked ROW_ACTION, else its first button). `signature` names the row's actions. Returns the row's ref and its
 * focus handlers (spread them on the row).
 */
export function useRowFocus<T extends HTMLElement>(
  signature: string,
): [RefObject<T | null>, { onFocus: () => void; onBlur: (event: FocusEvent<T>) => void }] {
  const ref = useRef<T>(null);
  const within = useRef(false);
  useEffect(() => {
    const row = ref.current;
    if (!row || !within.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      if (!row.contains(active)) within.current = false;
      return;
    }
    (row.querySelector<HTMLElement>('[data-row-action]') ?? row.querySelector<HTMLElement>('button'))?.focus();
  }, [signature]);
  const onFocus = () => {
    within.current = true;
  };
  const onBlur = (event: FocusEvent<T>) => {
    const to = event.relatedTarget;
    if (to instanceof Node && ref.current?.contains(to)) return;
    if (to) {
      within.current = false;
      return;
    }
    // No new target: the button was removed (focus stays "in" the row), or focus left for the page itself.
    const from = event.target;
    window.requestAnimationFrame(() => {
      if (from.isConnected && document.activeElement !== from) within.current = false;
    });
  };
  return [ref, { onFocus, onBlur }];
}

/** Whether the person asked for less motion (no flashes, fades or pulsing dot). */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)', false);
}

/** `value`, changing at most every `interval` ms (the latest value wins once the interval is over). */
export function useThrottled(value: string, interval: number): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (value === shown) return;
    const wait = Math.max(0, last.current + interval - Date.now());
    const timer = window.setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [value, shown, interval]);
  return shown;
}
