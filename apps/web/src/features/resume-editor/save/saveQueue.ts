// Autosave for the on-page resume editor. The editor hands over the whole document after every change; the queue saves
// it a second after the typing pauses (at most ten seconds into a long run of typing), one save at a time, always the
// latest document. A new resume is created by its first save and every later one is an update made from the revision
// the last save returned, so a save from a stale tab is refused instead of overwriting another. A save's answer moves
// only the revision: the document the person is editing is never replaced by what the server sent back.
//
// Pure: the clock and the calls are injected, so every rule below is tested without a browser.

export const SAVE_DEBOUNCE_MS = 1_000;
export const SAVE_MAX_WAIT_MS = 10_000;
/** The waits before each retry of a failed save; after the last, every RETRY_STEADY_MS. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
export const RETRY_STEADY_MS = 60_000;

export interface SaveClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SaveCallOptions {
  /** The page is going away: the request must outlive it (fetch keepalive). */
  keepalive?: boolean;
}

export interface SaveTransport<D> {
  create(document: D, options: SaveCallOptions): Promise<{ id: string; documentRevision: number }>;
  update(id: string, document: D, baseRevision: number, options: SaveCallOptions): Promise<{ documentRevision: number }>;
}

/** What a failed call looks like (the web's ApiError has these). */
export interface SaveFailure {
  status: number;
  code?: string;
  message?: string;
}

export type SaveStatus =
  /** Nothing to save: no change yet, or every change is saved. */
  | { state: 'idle' }
  | { state: 'unsaved' }
  | { state: 'saving' }
  | { state: 'saved'; at: number }
  /** The server could not be reached; the save is tried again on its own (or with Retry). */
  | { state: 'offline'; retryAt: number }
  /** The server answered with an error worth trying again (busy, a hiccup). */
  | { state: 'failed'; message: string; retryAt: number }
  /** Saves stopped for good: another tab saved first, the account is full, the resume is gone, or signed out. */
  | { state: 'conflict' }
  | { state: 'stopped'; message: string }
  /**
   * v20 P8: the account is at its plan's resume limit (403 resume_limit_reached): saves stop, and the editor turns
   * read-only with the limit's message. Trying again would only fail again.
   */
  | { state: 'limited'; message: string }
  | { state: 'gone' }
  | { state: 'signed-out' };

export interface SaveQueueOptions<D> {
  transport: SaveTransport<D>;
  clock: SaveClock;
  /** The resume being edited; null for a new one, created by its first save. */
  resumeId: string | null;
  /** The stored document's revision (0 for a new resume). */
  revision: number;
  onStatus?(status: SaveStatus): void;
  /** The first save created the resume. */
  onCreated?(id: string): void;
  /** A save is stored; `revision` is what the next one is made from. */
  onSaved?(revision: number): void;
  /** Another tab saved this resume since it was loaded: load the latest version. */
  onConflict?(): void;
  /** The session is gone: keep the local copy and send the person to sign in. */
  onSignedOut?(): void;
}

export interface SaveQueue<D> {
  /** The document as it now is, after a change. */
  change(document: D): void;
  /** Saves what is not saved yet now (leaving the page), and settles once nothing is in flight. */
  flush(options?: SaveCallOptions): Promise<void>;
  /** Tries a failed save again now (Retry, or the browser is back online). */
  retry(): void;
  /** Whether a change is not stored yet. */
  hasUnsaved(): boolean;
  status(): SaveStatus;
  resumeId(): string | null;
  revision(): number;
  /** Stops every timer; nothing more is saved. */
  dispose(): void;
}

function failureOf(error: unknown): SaveFailure {
  if (error && typeof error === 'object' && typeof (error as SaveFailure).status === 'number') return error as SaveFailure;
  return { status: 0 };
}

const NOT_SAVED = 'Your latest changes are not saved yet.';

export function createSaveQueue<D>(options: SaveQueueOptions<D>): SaveQueue<D> {
  const { transport, clock } = options;
  let id = options.resumeId;
  let revision = options.revision;
  let latest: D | null = null;
  /** Counts changes; a save stores the change it was made from. */
  let changes = 0;
  let saved = 0;
  /** When the oldest change no save has started on was made (for the ten-second cap). */
  let unsavedSince: number | null = null;
  /** When the last change was made (a save waits for a pause of SAVE_DEBOUNCE_MS after it). */
  let lastChangeAt = 0;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let waitingRetry = false;
  let finished = false;
  let disposed = false;
  let current: SaveStatus = { state: 'idle' };

  const dirty = () => changes !== saved;
  const setStatus = (status: SaveStatus) => {
    // Said only when it changes: typing on is "unsaved" once, not once a keystroke (each would redraw the page).
    if (JSON.stringify(status) === JSON.stringify(current)) return;
    current = status;
    options.onStatus?.(status);
  };
  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  function schedule(): void {
    if (finished || disposed || inFlight || waitingRetry || !dirty()) return;
    clearTimer();
    const due = Math.min(lastChangeAt + SAVE_DEBOUNCE_MS, (unsavedSince ?? Infinity) + SAVE_MAX_WAIT_MS);
    timer = clock.setTimeout(() => {
      timer = null;
      void save({});
    }, Math.max(0, due - clock.now()));
  }

  function retryLater(status: (retryAt: number) => SaveStatus): void {
    const wait = RETRY_DELAYS_MS[failures] ?? RETRY_STEADY_MS;
    failures += 1;
    waitingRetry = true;
    const retryAt = clock.now() + wait;
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      waitingRetry = false;
      void save({});
    }, wait);
    setStatus(status(retryAt));
  }

  function stop(status: SaveStatus): void {
    finished = true;
    clearTimer();
    setStatus(status);
  }

  async function attempt(callOptions: SaveCallOptions): Promise<void> {
    const document = latest as D;
    const change = changes;
    // Every change so far rides on this save; a failure puts them back.
    const since = unsavedSince;
    unsavedSince = null;
    setStatus({ state: 'saving' });
    try {
      if (id === null) {
        const created = await transport.create(document, callOptions);
        id = created.id;
        revision = created.documentRevision;
        options.onCreated?.(created.id);
      } else {
        revision = (await transport.update(id, document, revision, callOptions)).documentRevision;
      }
      saved = change;
      failures = 0;
      options.onSaved?.(revision);
      setStatus(dirty() ? { state: 'unsaved' } : { state: 'saved', at: clock.now() });
    } catch (error) {
      unsavedSince = since ?? unsavedSince;
      const failure = failureOf(error);
      if (failure.status === 0) retryLater((retryAt) => ({ state: 'offline', retryAt }));
      else if (failure.status === 401) {
        stop({ state: 'signed-out' });
        options.onSignedOut?.();
      } else if (failure.code === 'revision_conflict') {
        stop({ state: 'conflict' });
        options.onConflict?.();
      } else if (failure.status === 404) stop({ state: 'gone' });
      else if (failure.code === 'resume_limit_reached') stop({ state: 'limited', message: failure.message || NOT_SAVED }); // v20 P8
      else if (failure.status === 409 || failure.status === 400 || failure.status === 413) {
        // The account is full, or the server refuses this document: trying again would only fail again.
        stop({ state: 'stopped', message: failure.message || NOT_SAVED });
      } else retryLater((retryAt) => ({ state: 'failed', message: failure.message || NOT_SAVED, retryAt }));
    }
  }

  function save(callOptions: SaveCallOptions): Promise<void> {
    if (finished || disposed || !dirty()) return inFlight ?? Promise.resolve();
    if (inFlight) return inFlight;
    clearTimer();
    inFlight = attempt(callOptions).finally(() => {
      inFlight = null;
      // Typing that went on during the save is saved next.
      schedule();
    });
    return inFlight;
  }

  return {
    change(document) {
      if (finished || disposed) return;
      latest = document;
      changes += 1;
      lastChangeAt = clock.now();
      unsavedSince ??= lastChangeAt;
      if (!inFlight && !waitingRetry) setStatus({ state: 'unsaved' });
      schedule();
    },
    async flush(callOptions = {}) {
      waitingRetry = false;
      if (inFlight) await inFlight;
      if (dirty()) await save(callOptions);
    },
    retry() {
      if (finished || disposed || !waitingRetry) return;
      waitingRetry = false;
      void save({});
    },
    hasUnsaved: () => dirty(),
    status: () => current,
    resumeId: () => id,
    revision: () => revision,
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
