'use client';

import { useCallback, useSyncExternalStore } from 'react';

// v30 ST5: one copy for the whole web (the tracker and the resume editor each had one, word for word), read by the
// queue panes' hooks (components/queue), the Auto-apply page, the tracker's detail sheet and the editor's phone layout.

/** Whether a media query matches, kept in step with the window (`serverValue` before hydration). */
export function useMediaQuery(query: string, serverValue = true): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
