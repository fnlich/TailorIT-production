'use client';

import { useCallback, useEffect, useRef, type FocusEvent, type RefObject } from 'react';
import { ROW_ACTION } from './hooks';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

// v37 REVIEW (SP v37 PLAN.md R1, the owner's "admin currently can't see the whole jobs for review"): a queue pane's list
// loads as you scroll, with no "Load more" button. The next page is read when the list's end comes near the window
// (an IntersectionObserver with a wide bottom margin, the Jobs list's way), and when keyboard focus reaches one of the
// last rows (so tabbing down the list never runs out of rows before the next page is in). The list's end says what
// is happening: "Loading more..." (announced), an error with Try again, or, once every row is in, how many there are.

/** How many rows before the end keyboard focus asks for the next page. */
export const LOAD_AHEAD_ROWS = 10;
/** How far below the window the list's end starts the next read. */
const LOAD_MARGIN = '0px 0px 150% 0px';

export interface LoadOnScroll {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => unknown;
}

/**
 * The list's end (`sentinel`, on ListEnd) and a focus handler for the list (`onFocusCapture`, on the element holding the
 * rows, each row matching `rows`): the next page is read when either comes near, once at a time, never after a failed
 * read (Try again asks).
 */
export function useLoadOnScroll(
  list: LoadOnScroll,
  rows: string,
): {
  sentinel: RefObject<HTMLDivElement | null>;
  onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
} {
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  const ready = hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
  const more = useRef(fetchNextPage);
  useEffect(() => {
    more.current = fetchNextPage;
  });
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !ready || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void more.current();
      },
      { root: null, rootMargin: LOAD_MARGIN },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [ready]);
  const onFocusCapture = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (!ready || !(event.target instanceof Element)) return;
      const row = event.target.closest(rows);
      if (!row) return;
      const all = [...event.currentTarget.querySelectorAll(rows)];
      const index = all.indexOf(row);
      if (index >= 0 && all.length - index <= LOAD_AHEAD_ROWS) void more.current();
    },
    [ready, rows],
  );
  return { sentinel, onFocusCapture };
}

/**
 * The end of a list that loads as you scroll: the sentinel the hook watches, then "Loading more {things}..." while the
 * next page is read, the read's error with Try again, or "All {n} {things} shown" once every row is in (only after more
 * than one page, where it says the list is whole). v37 FIX-REV (REVIEW361-ux L2): Try again keeps keyboard focus (its
 * button went as the read started, and focus fell to the page): on "Loading more..." while it reads, then on the first
 * row it brought (`rows`, the rows' selector, beside this end), or on Try again when it failed again.
 */
export function ListEnd({
  sentinel,
  list,
  things,
  shown,
  pages,
  error,
  rows,
}: {
  sentinel: RefObject<HTMLDivElement | null>;
  list: LoadOnScroll;
  /** "reviews", "flags", "links". */
  things: string;
  /** How many rows are in. */
  shown: number;
  /** How many pages were read. */
  pages: number;
  /** The failed read's words. */
  error: string;
  /** v37 FIX-REV (L2): the rows' selector (as useLoadOnScroll's), so focus can reach the first row a Try again brought. */
  rows?: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  const loading = useRef<HTMLDivElement>(null);
  const again = useRef<HTMLButtonElement>(null);
  /** v37 FIX-REV (L2): how many rows were in when Try again was pressed, while focus follows its read; else null. */
  const retried = useRef<number | null>(null);
  const { isFetchingNextPage, isFetchNextPageError } = list;
  useEffect(() => {
    const before = retried.current;
    if (before === null) return;
    if (isFetchingNextPage) {
      loading.current?.focus();
      return;
    }
    retried.current = null;
    if (isFetchNextPageError) {
      again.current?.focus();
      return;
    }
    const all = rows ? end.current?.parentElement?.querySelectorAll<HTMLElement>(rows) : undefined;
    const row = all && all.length > before ? all[before] : undefined;
    const target = row?.querySelector<HTMLElement>(`[${Object.keys(ROW_ACTION)[0]}]`) ?? row?.querySelector<HTMLElement>('button, a[href]');
    (target ?? end.current)?.focus();
  }, [isFetchingNextPage, isFetchNextPageError, shown, rows]);
  return (
    <div ref={end} tabIndex={-1} className="outline-none" data-list-end="">
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      {list.isFetchingNextPage ? (
        <div ref={loading} tabIndex={-1} className="flex justify-center border-t border-divider-soft px-4 py-4 outline-none" data-list-loading="">
          <Spinner size={18} label={`Loading more ${things}...`} />
        </div>
      ) : list.isFetchNextPageError ? (
        <div role="alert" className="flex flex-col items-center gap-2 border-t border-divider-soft px-4 py-4 text-center" data-list-error="">
          <p className="text-sm text-foreground">{error}</p>
          <Button
            ref={again}
            variant="outline"
            size="sm"
            className="max-sm:h-11"
            onClick={() => {
              retried.current = shown;
              void list.fetchNextPage();
            }}
          >
            Try again
          </Button>
        </div>
      ) : !list.hasNextPage && pages > 1 ? (
        <p className="border-t border-divider-soft px-4 py-3 text-center text-[13px] leading-5 text-muted-foreground" data-list-all="">
          All {shown.toLocaleString('en-US')} {things} shown
        </p>
      ) : null}
    </div>
  );
}
