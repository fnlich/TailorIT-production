// v3.1 HEADER (docs/design/v3.1/24-notifications-usage.md §8): the header's summary is read every 60 s while the page
// is shown, and again when the page comes back (the tab shown again, the window focused); never while the tab is
// hidden. React Query's own interval would keep a timer per component and its focus refetch only follows the tab's
// visibility, so the header drives the reads itself, once per tab, through this.

/** How often the header reads its summary while the page is shown. */
export const HEADER_POLL_MS = 60_000;
/** A focus within this long of the last read reads nothing (focus and visibility often come together). */
export const HEADER_FOCUS_GAP_MS = 5_000;

/** What the poll needs from the browser (the tests pass their own). */
export interface PollHost {
  /** The tab is hidden (`document.visibilityState === 'hidden'`). */
  hidden(): boolean;
  /** Listens to the tab's visibility changes; returns the unsubscribe. */
  onVisibility(listener: () => void): () => void;
  /** Listens to the window's focus; returns the unsubscribe. */
  onFocus(listener: () => void): () => void;
  now(): number;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PollOptions {
  /** Reads the summary again. */
  refresh: () => void;
  host: PollHost;
  intervalMs?: number;
  focusGapMs?: number;
  /** When the summary was last read (its first read happens as the page mounts); defaults to now. */
  lastReadAt?: number;
}

/**
 * Starts the header's reads: every `intervalMs` while the tab is shown; when the tab is hidden the timer stops; when
 * it is shown again, or the window gets focus, it reads at once (unless it read within `focusGapMs`) and the timer
 * starts over. Returns the stop.
 */
export function startVisiblePoll({
  refresh,
  host,
  intervalMs = HEADER_POLL_MS,
  focusGapMs = HEADER_FOCUS_GAP_MS,
  lastReadAt,
}: PollOptions): () => void {
  let last = lastReadAt ?? host.now();
  let timer: unknown = null;
  let stopped = false;

  const read = () => {
    last = host.now();
    refresh();
  };
  const stopTimer = () => {
    if (timer !== null) host.clearInterval(timer);
    timer = null;
  };
  const startTimer = () => {
    stopTimer();
    timer = host.setInterval(() => {
      // A timer that fires in a hidden tab (a browser may run it late) reads nothing.
      if (!stopped && !host.hidden()) read();
    }, intervalMs);
  };
  const comeBack = () => {
    if (stopped || host.hidden()) return;
    if (host.now() - last >= focusGapMs) read();
    startTimer();
  };

  const offVisibility = host.onVisibility(() => {
    if (host.hidden()) stopTimer();
    else comeBack();
  });
  const offFocus = host.onFocus(comeBack);
  if (!host.hidden()) startTimer();

  return () => {
    stopped = true;
    stopTimer();
    offVisibility();
    offFocus();
  };
}

/** The browser's tab and window (only in the browser). */
export function browserPollHost(): PollHost {
  return {
    hidden: () => document.visibilityState === 'hidden',
    onVisibility: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    onFocus: (listener) => {
      window.addEventListener('focus', listener);
      return () => window.removeEventListener('focus', listener);
    },
    now: () => Date.now(),
    setInterval: (run, ms) => window.setInterval(run, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  };
}
