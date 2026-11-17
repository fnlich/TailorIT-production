'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { startTransition, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseSingleDate, type DatePart, type Period, type ResumeDocument } from '@tailorit/shared';
import { useToast } from '@/components/ui/Toast';
import { usePublicConstants } from '@/lib/constants';
import { resumeKeys } from '../api';
import { RESUME_DEPENDENT_KEYS } from '../cache';
import type { DateTarget } from '../dates/DatePickerPopover';
import type { FieldBridge } from '../fields/bridge';
import { copyOffer, createLocalCopy, type CopyOffer, type CopyStorage, type LocalCopyRecord } from '../save/localCopy';
import { createSaveQueue, type SaveClock, type SaveStatus } from '../save/saveQueue';
import { MAX_EDITOR_BULLETS, valueAt } from '../store/actions';
import type { Caret } from '../store/paths';
import { createEditorStore, type EditorStore } from '../store/store';
import { editorSaveTransport, type EditorResume } from './api';

// One editing session of one resume: the store holding the document and its history, autosave and the browser copy
// fed from every change, and the bridge the page's fields report through. A structural edit (a new entry typed into
// the placeholder row, a split bullet) or an undo hands back where the caret belongs, and it is put there after the
// page has redrawn. Each save leaves what reads stored resumes (the Resumes list, the scores read off a resume) stale,
// read again when next shown; leaving the editor reads them again once its last save is in.

/**
 * Marks the Resumes list and what is scored against a resume as stale; with `refetch`, those on screen are read again
 * now. Never the editor's own read: a newer revision from it would start the editor over.
 */
function staleResumeReads(client: QueryClient, refetch: boolean): void {
  const refetchType = refetch ? 'active' : 'none';
  void client.invalidateQueries({ queryKey: resumeKeys.list(), refetchType });
  for (const queryKey of RESUME_DEPENDENT_KEYS) void client.invalidateQueries({ queryKey, refetchType });
}

const BROWSER_CLOCK: SaveClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

function browserStorage(): CopyStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The text offset `offset` (or the end) of a field, as a DOM position. */
function placeCaret(element: HTMLElement, offset: number | 'end'): void {
  element.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  if (offset === 'end') {
    range.selectNodeContents(element);
    range.collapse(false);
  } else {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let left = offset;
    let node = walker.nextNode();
    let placed = false;
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (left <= length) {
        range.setStart(node, left);
        placed = true;
        break;
      }
      left -= length;
      node = walker.nextNode();
    }
    if (!placed) {
      range.selectNodeContents(element);
      range.collapse(offset <= 0);
    }
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

let pickerOpenings = 0;

/** What the date picker opens on for the period or date at `path` (stored as `value`), under `anchor`. */
export function dateTargetOf(path: string, value: unknown, anchor: HTMLElement): DateTarget {
  pickerOpenings += 1;
  const opened = pickerOpenings;
  if (path.endsWith('.period')) return { kind: 'range', path, anchor, opened, period: (value as Period | undefined) ?? {} };
  const single = typeof value === 'string' ? parseSingleDate(value) : (value as { y?: number; m?: number } | undefined);
  const date = single?.y ? { y: single.y, ...(single.m ? { m: single.m } : {}) } : undefined;
  return { kind: 'single', path, anchor, opened, date };
}

const bulletOf = (path: string) => {
  const match = /^(.*)\.achievements\.(\d+)$/.exec(path);
  return match ? { entry: match[1]!, index: Number(match[2]) } : null;
};

export interface EditorSession {
  store: EditorStore;
  document: ResumeDocument;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  status: SaveStatus;
  bridge: FieldBridge;
  undo(): void;
  redo(): void;
  retrySave(): void;
  /** Saves what is not saved yet now (before a download, which prints what is stored). */
  flush(): Promise<void>;
  /** The resume's id; null until the first change of a new resume has created it. */
  resumeId(): string | null;
  /** The last thing done or undone, for the polite live region. */
  announcement: string;
  /** Says `text` in the live region (the toolbars: "Entry added", "Moved up, 2 of 4"). */
  announce(text: string): void;
  date: { target: DateTarget | null; onPeriod(path: string, period: Period): void; onDate(path: string, date: DatePart | null): void; close(): void };
  photo: { open: boolean; close(): void; accept(photoId: string): void };
  /** Changes this browser kept that were never saved, offered back on open. */
  restore: { offer: Extract<CopyOffer, { offer: true }>; accept(): void; discard(): void } | null;
}

/** What a session opens: a stored resume, or a new one its first change creates (kept locally under `draftId`). */
export type EditorStart =
  | Pick<EditorResume, 'id' | 'documentRevision' | 'document'>
  | { id: null; draftId: string; documentRevision: 0; document: ResumeDocument };

export function useEditorSession(
  resume: EditorStart,
  accountId: string,
  handlers: { onConflict(): void; onSignedOut(): void; onCreated?(id: string): void },
): EditorSession {
  const toast = useToast();
  const { t } = usePublicConstants();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>({ state: 'idle' });
  const [dateTarget, setDateTarget] = useState<DateTarget | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const caret = useRef<{ path: string; offset: number | 'end' } | null>(null);
  const focused = useRef<string | null>(null);

  // A picker opened on a section's empty row writes into the entry the row became (its target moved to `path`), and
  // stays by that entry's field, the row's own being gone: found once the page has drawn it.
  const followDateTarget = (path: string) => {
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLElement>(`[data-resume-canvas] [data-edit-path="${CSS.escape(path)}"]`);
      if (!field) return;
      setDateTarget((target) => (target?.path === path && !target.anchor.isConnected ? { ...target, anchor: field } : target));
    });
  };

  // One store, queue and copy for the life of this session (the workspace remounts for another resume or a reload).
  // The queue's stops reach the page as events, heard by whatever handlers the page has at the time.
  const [parts] = useState(() => {
    const events = new EventTarget();
    const copy = createLocalCopy<ResumeDocument>({
      storage: browserStorage(),
      clock: BROWSER_CLOCK,
      accountId,
      target: resume.id === null ? { draftId: resume.draftId } : { resumeId: resume.id },
    });
    const found = copy.read();
    const queue = createSaveQueue<ResumeDocument>({
      transport: editorSaveTransport,
      clock: BROWSER_CLOCK,
      resumeId: resume.id,
      revision: resume.documentRevision,
      onStatus: setStatus,
      onCreated: (id) => {
        copy.retarget(id);
        staleResumeReads(queryClient, false);
        events.dispatchEvent(new CustomEvent('created', { detail: id }));
      },
      onSaved: () => {
        if (!queue.hasUnsaved()) copy.clear();
        staleResumeReads(queryClient, false);
      },
      onConflict: () => events.dispatchEvent(new Event('conflict')),
      onSignedOut: () => {
        copy.writeNow();
        events.dispatchEvent(new Event('signed-out'));
      },
    });
    const store = createEditorStore(resume.document, {
      onChange: (document) => {
        queue.change(document);
        copy.write(document, queue.revision());
      },
    });
    return { copy, queue, store, found, events };
  });
  const { store, queue, copy, events } = parts;
  const { onConflict, onSignedOut, onCreated } = handlers;

  useEffect(() => {
    const created = (event: Event) => onCreated?.((event as CustomEvent<string>).detail);
    events.addEventListener('conflict', onConflict);
    events.addEventListener('signed-out', onSignedOut);
    events.addEventListener('created', created);
    return () => {
      events.removeEventListener('conflict', onConflict);
      events.removeEventListener('signed-out', onSignedOut);
      events.removeEventListener('created', created);
    };
  }, [events, onConflict, onSignedOut, onCreated]);
  // The store's state for React. Typing in a field the page has already is drawn in the background (a transition):
  // the browser shows the text at once, and no keystroke waits for the page, its toolbars and its checks to be drawn
  // again. Anything else (a new bullet or entry, Undo) is drawn at once, for the caret to go into what it made.
  const [state, setState] = useState(store.getState);
  // The document of the draw being committed, for the fields to tell a draw the typing overtook (bridge.isBehind). An
  // insertion effect runs before any layout effect of the same commit, so it is set before a field compares.
  const drawn = useRef(state.document);
  useInsertionEffect(() => {
    drawn.current = state.document;
  }, [state.document]);
  useEffect(() => {
    const follow = () => {
      const next = store.getState();
      if (next.typing) startTransition(() => setState(next));
      else setState(next);
    };
    // A change made before this subscribed (a restored copy) is drawn too.
    follow();
    return store.subscribe(follow);
  }, [store]);

  const [restoreRecord, setRestoreRecord] = useState<LocalCopyRecord<ResumeDocument> | null>(parts.found);
  const offer = copyOffer(restoreRecord, resume.id ? resume.documentRevision : null);

  // Saving what is left when the page goes, and keeping the copy when it is hidden.
  useEffect(() => {
    const onPageHide = () => {
      copy.writeNow();
      void queue.flush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') copy.writeNow();
    };
    const onOnline = () => queue.retry();
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      // Leaving the editor saves what is left, then what reads the resume is read again. Nothing is disposed here: in
      // development React runs this cleanup and the effect again on the same session, which must still save afterwards.
      copy.writeNow();
      void queue.flush().finally(() => staleResumeReads(queryClient, true));
    };
  }, [copy, queue, queryClient]);

  // The caret, once the page shows the field it belongs in (a phone's entry form, while one is open, before the page).
  useLayoutEffect(() => {
    const target = caret.current;
    if (!target) return;
    const field = `[data-edit-path="${CSS.escape(target.path)}"]`;
    const element =
      document.querySelector<HTMLElement>(`[data-edit-form] ${field}`) ??
      document.querySelector<HTMLElement>(`[data-resume-canvas] ${field}`);
    if (!element) return;
    caret.current = null;
    placeCaret(element, target.offset);
  });

  const moveCaret = useCallback((next: Caret | null | undefined, fallback?: string) => {
    if (next) caret.current = { path: next.path, offset: next.offset };
    else if (fallback) caret.current = { path: fallback, offset: 'end' };
  }, []);

  // The same words twice in a row still change the region, so they are read again.
  const announce = useCallback((text: string) => {
    setAnnouncement((previous) => (previous === text ? `${text} ` : text));
  }, []);

  const undo = useCallback(() => {
    const move = store.undo();
    if (!move) return;
    moveCaret(move.selection);
    setAnnouncement(`Undone: ${move.label}`);
  }, [store, moveCaret]);
  const redo = useCallback(() => {
    const move = store.redo();
    if (!move) return;
    moveCaret(move.selection);
    setAnnouncement(`Redone: ${move.label}`);
  }, [store, moveCaret]);

  // Ctrl+Z and Ctrl+Y (or Shift+Ctrl+Z) undo the editor's steps, never the browser's own per-field history.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo]);

  const bridge = useMemo<FieldBridge>(
    () => ({
      setText(path, value) {
        const result = store.setText(path, value);
        if (result.path !== path) moveCaret(null, result.path);
      },
      setRich(path, markup) {
        const result = store.setRich(path, markup);
        if (result.path !== path) moveCaret(null, result.path);
      },
      splitBullet(path, before, after) {
        const bullet = bulletOf(path);
        if (!bullet) return;
        const result = store.splitBullet(bullet.entry, bullet.index, before, after);
        if (result.capped) toast.info(t('MSG_ENTRY_BULLETS_MAX', { max: MAX_EDITOR_BULLETS }));
        else moveCaret(result.caret);
      },
      mergeBullet(path) {
        const bullet = bulletOf(path);
        if (!bullet || bullet.index === 0) return;
        moveCaret(store.mergeBulletWithPrevious(bullet.entry, bullet.index).caret);
      },
      insertBulletsAfter(path, lines) {
        const bullet = bulletOf(path);
        if (!bullet) return;
        const result = store.insertBullets(bullet.entry, bullet.index + 1, lines);
        if (result.capped) toast.info(t('MSG_ENTRY_BULLETS_MAX', { max: MAX_EDITOR_BULLETS }), 'Only the lines that fit were added.');
      },
      focusField(path) {
        // Typing in another field starts a step of its own.
        if (focused.current !== path) store.seal();
        focused.current = path;
      },
      isBehind(path) {
        return !Object.is(valueAt(drawn.current, path), store.select(path));
      },
      openDate(path, anchor) {
        setDateTarget(dateTargetOf(path, store.select(path), anchor));
      },
      setLevel(path, level) {
        store.setLevel(path, level);
      },
      openPhoto() {
        setPhotoOpen(true);
      },
    }),
    [store, moveCaret, toast, t],
  );

  return {
    store,
    document: state.document,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    undoLabel: state.undoLabel,
    redoLabel: state.redoLabel,

    status,
    bridge,
    undo,
    redo,
    retrySave: () => queue.retry(),
    flush: () => queue.flush(),
    resumeId: () => queue.resumeId(),
    announcement,
    announce,
    date: {
      target: dateTarget,
      onPeriod(path, period) {
        const written = store.setPeriod(path, period).path;
        setDateTarget((target) => (target?.kind === 'range' && target.path === path ? { ...target, path: written, period } : target));
        if (written !== path) followDateTarget(written);
      },
      onDate(path, date) {
        const written = store.setDate(path, date).path;
        setDateTarget((target) =>
          target?.kind === 'single' && target.path === path ? { ...target, path: written, date: date ?? undefined } : target,
        );
        if (written !== path) followDateTarget(written);
      },
      close: () => setDateTarget(null),
    },
    photo: {
      open: photoOpen,
      close: () => setPhotoOpen(false),
      accept: (photoId) => store.setPhoto({ photoId, shape: state.document.header?.photo?.shape ?? 'round' }),
    },
    restore: offer.offer
      ? {
          offer,
          accept() {
            const record = restoreRecord;
            if (!record) return;
            store.apply('Restored unsaved changes', () => ({ document: record.document }));
            setRestoreRecord(null);
          },
          discard() {
            copy.clear();
            setRestoreRecord(null);
          },
        }
      : null,
  };
}
