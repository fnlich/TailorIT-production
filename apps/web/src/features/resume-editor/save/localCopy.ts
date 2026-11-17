import type { SaveClock } from './saveQueue';

// The editor's copy of unsaved changes in this browser: while a save is waiting or failing, the latest document is kept
// in localStorage, so a closed tab, a crash or a dropped connection loses nothing. It is keyed by account and by
// resume (or by the draft id of a resume not created yet), written at most every two seconds and at once when the page
// is hidden, and removed after a save succeeds and at sign-out; at sign-in, any other account's copies go. Storage
// that refuses to work (a private window, blocked site data, a full quota) only means there is no copy.

export const LOCAL_COPY_PREFIX = 'tailorit.resume-copy.v1.';
export const LOCAL_COPY_THROTTLE_MS = 2_000;

/** The part of Storage the copy uses (window.localStorage, or a fake in tests). */
export interface CopyStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalCopyRecord<D> {
  /** When it was written (the clock's ms). */
  savedAt: number;
  /** The stored revision the changes were made from; null for a resume not created yet. */
  baseRevision: number | null;
  document: D;
}

export type CopyTarget = { resumeId: string } | { draftId: string };

const keyOf = (accountId: string, target: CopyTarget) =>
  `${LOCAL_COPY_PREFIX}${accountId}.${'resumeId' in target ? `resume.${target.resumeId}` : `draft.${target.draftId}`}`;

function attempt<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

function keys(storage: CopyStorage): string[] {
  return attempt(() => {
    const out: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LOCAL_COPY_PREFIX)) out.push(key);
    }
    return out;
  }, []);
}

export interface LocalCopy<D> {
  /** Keeps `document` (at most every LOCAL_COPY_THROTTLE_MS; the last one always lands). */
  write(document: D, baseRevision: number | null): void;
  /** Writes a pending copy now (the page is being hidden). */
  writeNow(): void;
  read(): LocalCopyRecord<D> | null;
  /** The changes are saved: the copy goes. */
  clear(): void;
  /** The draft became a resume: its copy moves to the resume's key. */
  retarget(resumeId: string): void;
  dispose(): void;
}

export function createLocalCopy<D>(options: {
  storage: CopyStorage | null;
  clock: SaveClock;
  accountId: string;
  target: CopyTarget;
}): LocalCopy<D> {
  const { storage, clock, accountId } = options;
  let key = keyOf(accountId, options.target);
  let pending: LocalCopyRecord<D> | null = null;
  let lastWrite = -Infinity;
  let timer: unknown = null;

  const store = (record: LocalCopyRecord<D>) => {
    if (!storage) return;
    attempt(() => storage.setItem(key, JSON.stringify(record)), undefined);
    lastWrite = clock.now();
  };
  const cancel = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const writePending = () => {
    cancel();
    if (pending) store(pending);
    pending = null;
  };

  return {
    write(document, baseRevision) {
      pending = { savedAt: clock.now(), baseRevision, document };
      const wait = lastWrite + LOCAL_COPY_THROTTLE_MS - clock.now();
      if (wait <= 0) writePending();
      else if (timer === null) timer = clock.setTimeout(writePending, wait);
    },
    writeNow: writePending,
    read() {
      if (!storage) return null;
      const text = attempt(() => storage.getItem(key), null);
      if (!text) return null;
      const record = attempt(() => JSON.parse(text) as LocalCopyRecord<D>, null);
      return record && typeof record === 'object' && 'document' in record && typeof record.savedAt === 'number' ? record : null;
    },
    clear() {
      cancel();
      pending = null;
      if (storage) attempt(() => storage.removeItem(key), undefined);
    },
    retarget(resumeId) {
      const next = keyOf(accountId, { resumeId });
      if (next === key) return;
      const text = storage ? attempt(() => storage.getItem(key), null) : null;
      if (storage) attempt(() => storage.removeItem(key), undefined);
      key = next;
      if (text && storage) attempt(() => storage.setItem(key, text), undefined);
    },
    dispose: cancel,
  };
}

/** Sign-out: this account's copies go with the session. */
export function clearAccountCopies(storage: CopyStorage | null, accountId: string): void {
  if (!storage) return;
  const prefix = `${LOCAL_COPY_PREFIX}${accountId}.`;
  for (const key of keys(storage)) if (key.startsWith(prefix)) attempt(() => storage.removeItem(key), undefined);
}

/** Sign-in: copies another account left in this browser are never offered to this one, so they go. */
export function clearOtherAccountCopies(storage: CopyStorage | null, accountId: string): void {
  if (!storage) return;
  const prefix = `${LOCAL_COPY_PREFIX}${accountId}.`;
  for (const key of keys(storage)) if (!key.startsWith(prefix)) attempt(() => storage.removeItem(key), undefined);
}

export type CopyOffer =
  | { offer: false }
  /** `stale`: the resume was saved elsewhere after the copy's changes began; restoring would overwrite that. */
  | { offer: true; stale: boolean; savedAt: number };

/** Whether to offer the copy back when the resume opens at `storedRevision` (null: a draft never created). */
export function copyOffer(record: LocalCopyRecord<unknown> | null, storedRevision: number | null): CopyOffer {
  if (!record) return { offer: false };
  const stale = record.baseRevision !== null && storedRevision !== null && storedRevision > record.baseRevision;
  return { offer: true, stale, savedAt: record.savedAt };
}
