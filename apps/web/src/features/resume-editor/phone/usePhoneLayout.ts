'use client';

import { useMediaQuery } from '@/lib/useMediaQuery';

/** Below 768 px the editor works Enhancv's phone way: tap a part of the page, then edit it in a full-screen form. */
export const PHONE_QUERY = '(max-width: 767.98px)';

/** Whether the editor is in phone mode. The server and the first hydrating render say no (the desktop editor). */
export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_QUERY, false);
}

/** The phone page's room: almost the whole width, and space under it for the bottom bar. */
export const PHONE_MAIN_CLASS = 'px-2 pt-3 pb-[calc(5rem+env(safe-area-inset-bottom))]';
