'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import type { FocusQueue, FocusTarget } from '../toolbars/useToolbarCommands';
import { partKey, partOfFocus, type PhonePart } from './parts';

// Where focus goes on a phone's page: onto a part's tap target, never into a field (nothing is typed on the page).
// The toolbars' commands ask for a place once they have acted (the next entry after a delete, a section just added);
// on a phone they always act from a sheet, a form or a dialog, so the ask waits until that has closed (`flush`).

/** Frames to wait for a tap target (the targets are measured a frame after the page changed). */
const TRIES = 20;
const SAFE_KEY = /^[A-Za-z0-9_.:-]+$/;

export interface PhoneFocus extends FocusQueue {
  /** Whether a command asked for a place since the last flush. */
  pending(): boolean;
  /** Focus onto a part's tap target (the part a sheet or a form was about). */
  toPart(part: PhonePart): void;
}

/** The tap target of the part with this key, on the page in `container`. */
export function tapTargetOf(container: ParentNode, key: string): HTMLElement | null {
  return SAFE_KEY.test(key) ? container.querySelector<HTMLElement>(`[data-phone-part="${key}"]`) : null;
}

export function usePhoneFocus(canvas: RefObject<HTMLElement | null>): PhoneFocus {
  const asked = useRef<FocusTarget | null>(null);
  const frame = useRef(0);

  const focusKey = useCallback(
    (key: string) => {
      cancelAnimationFrame(frame.current);
      let tries = 0;
      const attempt = () => {
        const target = canvas.current ? tapTargetOf(canvas.current, key) : null;
        // Focus scrolls it into view (the part moved, or the one after a deleted part). It is tried again while the
        // target is not drawn yet, or while the dialog that just closed still keeps focus from the page.
        target?.focus();
        if (target && document.activeElement === target) return;
        tries += 1;
        if (tries <= TRIES) frame.current = requestAnimationFrame(attempt);
      };
      attempt();
    },
    [canvas],
  );

  useLayoutEffect(() => {
    const frames = frame;
    return () => cancelAnimationFrame(frames.current);
  }, []);

  return useMemo(
    () => ({
      request(target) {
        asked.current = target;
      },
      flush() {
        const target = asked.current;
        asked.current = null;
        const part = target ? partOfFocus(target) : null;
        if (part) focusKey(partKey(part));
      },
      pending: () => asked.current !== null,
      toPart: (part) => focusKey(partKey(part)),
    }),
    [focusKey],
  );
}
