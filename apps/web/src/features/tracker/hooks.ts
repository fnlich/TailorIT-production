'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  COLUMN_PREFS_STORAGE_KEY,
  TrackerLanesAnswerSchema,
  readColumnPrefs,
  type ColumnMode,
  type ColumnPrefs,
  type TrackerLanes,
  type TrackerLanesAnswer,
} from '@tailorit/shared';
import { api } from '@/lib/api';
import { readStored, useStoredValue, writeStored } from '@/lib/storage';
import { DRAFT_COLUMN_DEFAULT, DRAFT_COLUMN_STORAGE_KEY, readDraftColumnMode } from './draft';
import { readTrackerUrl, trackerSearch, type TrackerUrlState } from './state';

/** `value`, once it has stopped changing for `delay` ms (the search box's 500 ms). */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * The tracker's URL state. Changes replace the current history entry through the History API, which Next's router
 * follows (no server round trip).
 */
export function useTrackerUrl(): [TrackerUrlState, (next: TrackerUrlState) => void] {
  const params = useSearchParams();
  const state = useMemo(() => readTrackerUrl(params), [params]);
  const setState = useCallback((next: TrackerUrlState) => {
    const search = trackerSearch(next, new URLSearchParams(window.location.search));
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  }, []);
  return [state, setState];
}

/** Board column visibility (forced / default / hidden): the person's Lanes shown (useTrackerLanes). */
export function useColumnPrefs(): [ColumnPrefs, (next: ColumnPrefs) => void] {
  const { lanes, update } = useTrackerLanes();
  const prefs = useMemo(() => readColumnPrefs(lanes.columns), [lanes.columns]);
  const setPrefs = useCallback((next: ColumnPrefs) => update({ columns: columnsOf(next) }), [update]);
  return [prefs, setPrefs];
}

const ARCHIVED_COLUMN_KEY = 'tailorit.tracker.archivedColumn';

/** Whether the board shows the Archived column (off by default): the person's Lanes shown. */
export function useArchivedColumn(): [boolean, (shown: boolean) => void] {
  const { lanes, update } = useTrackerLanes();
  const set = useCallback((shown: boolean) => update({ archived: shown }), [update]);
  return [lanes.archived, set];
}

/** v20 A30: the Draft column's mode (shown by default, between Saved and Applied): the person's Lanes shown. */
export function useDraftColumn(): [ColumnMode, (mode: ColumnMode) => void] {
  const { lanes, update } = useTrackerLanes();
  const set = useCallback((next: ColumnMode) => update({ draft: next }), [update]);
  return [lanes.draft, set];
}

// ------------------------------------------------------------------------------------------------- lanes shown

/** GET / PUT /api/me/tracker-lanes. */
export const TRACKER_LANES_QUERY_KEY = ['me', 'tracker-lanes'] as const;
/** Set once a browser's own pre-v3.2 choice went to its first person's account (it is never sent for another). */
export const LANES_MOVED_KEY = 'tailorit.tracker.lanesMoved';

/** A key the browser does not hold (useStoredValue's text for it). */
const UNSET = '\u0000';
const storedOrUnset = (raw: string | null) => raw ?? UNSET;
const unsetAsNull = (text: string) => (text === UNSET ? null : text);

/** The lanes shown of a person who never chose: the statuses' own defaults, Draft shown, Archived not. */
const DEFAULT_LANES: TrackerLanes = { columns: {}, draft: DRAFT_COLUMN_DEFAULT, archived: false };

/** The record of a ColumnPrefs as the contract keys it (a status's number as text). */
function columnsOf(prefs: ColumnPrefs): TrackerLanes['columns'] {
  return Object.fromEntries(Object.entries(prefs).filter(([, mode]) => Boolean(mode))) as TrackerLanes['columns'];
}

/** The browser's copy (v3.1's three keys): the first paint's lanes, and a pre-v3.2 choice to move once. */
export function lanesOfBrowser(raw: { columns: string | null; draft: string | null; archived: string | null }): TrackerLanes {
  return {
    columns: columnsOf(readColumnPrefs(raw.columns ?? '')),
    draft: readDraftColumnMode(raw.draft),
    archived: raw.archived === '1',
  };
}

/** Whether the browser holds a choice of its own (any of the three keys set). */
export function browserHasChoice(raw: { columns: string | null; draft: string | null; archived: string | null }): boolean {
  return raw.columns !== null || raw.draft !== null || raw.archived !== null;
}

/** Writes the browser's copy, so the next first paint shows the person's lanes at once. */
function writeBrowserCopy(lanes: TrackerLanes): void {
  writeStored(COLUMN_PREFS_STORAGE_KEY, JSON.stringify(lanes.columns));
  writeStored(DRAFT_COLUMN_STORAGE_KEY, lanes.draft);
  writeStored(ARCHIVED_COLUMN_KEY, lanes.archived ? '1' : null);
}

function fetchTrackerLanes(signal?: AbortSignal): Promise<TrackerLanesAnswer> {
  return api.get<TrackerLanesAnswer>('/api/me/tracker-lanes', { schema: TrackerLanesAnswerSchema, signal });
}

function saveTrackerLanes(lanes: TrackerLanes): Promise<TrackerLanesAnswer> {
  return api.put<TrackerLanesAnswer>('/api/me/tracker-lanes', lanes, { schema: TrackerLanesAnswerSchema });
}

/**
 * v32 FIX-UX (UXREQ-15; PLAN E11 "saved per person"): the board's Lanes shown is the person's, kept on the server, so
 * another browser or device of theirs shows the same, and two people sharing a browser keep their own. The browser keeps
 * a copy for the first paint (the board never jumps from the defaults once the person has chosen). A browser that kept
 * a choice before v3.2 sends it once, when the account has none yet; after that the account's choice wins everywhere.
 * A change shows at once and is saved in the background (a save that fails reads the account's choice back).
 */
export function useTrackerLanes(): { lanes: TrackerLanes; update: (patch: Partial<TrackerLanes>) => void } {
  const queryClient = useQueryClient();
  const [rawColumns] = useStoredValue<string>(COLUMN_PREFS_STORAGE_KEY, storedOrUnset);
  const [rawDraft] = useStoredValue<string>(DRAFT_COLUMN_STORAGE_KEY, storedOrUnset);
  const [rawArchived] = useStoredValue<string>(ARCHIVED_COLUMN_KEY, storedOrUnset);
  const raw = useMemo(
    () => ({ columns: unsetAsNull(rawColumns), draft: unsetAsNull(rawDraft), archived: unsetAsNull(rawArchived) }),
    [rawColumns, rawDraft, rawArchived],
  );
  const browser = useMemo(() => lanesOfBrowser(raw), [raw]);
  const query = useQuery({ queryKey: TRACKER_LANES_QUERY_KEY, queryFn: ({ signal }) => fetchTrackerLanes(signal), staleTime: 60_000 });
  const saved = query.data?.lanes ?? null;
  // Until the account answers, the browser's copy; an account with no choice of its own gets the defaults, not the
  // copy another account of this browser left (once a browser's choice moved to an account, it is that account's).
  const lanes = saved ?? (query.isSuccess && readStored(LANES_MOVED_KEY) !== null ? DEFAULT_LANES : browser);

  // The account's choice, once read, is the browser's copy too; an account with none takes the browser's pre-v3.2
  // choice once (the first person to open the board in this browser).
  const moved = useRef(false);
  useEffect(() => {
    if (!query.isSuccess) return;
    if (saved) {
      writeBrowserCopy(saved);
      return;
    }
    if (moved.current || readStored(LANES_MOVED_KEY) !== null || !browserHasChoice(raw)) return;
    moved.current = true;
    writeStored(LANES_MOVED_KEY, '1');
    queryClient.setQueryData<TrackerLanesAnswer>(TRACKER_LANES_QUERY_KEY, { lanes: browser });
    void saveTrackerLanes(browser).catch(() => undefined);
  }, [query.isSuccess, saved, raw, browser, queryClient]);

  const update = useCallback(
    (patch: Partial<TrackerLanes>) => {
      const current = queryClient.getQueryData<TrackerLanesAnswer>(TRACKER_LANES_QUERY_KEY)?.lanes ?? lanesOfBrowser({
        columns: readStored(COLUMN_PREFS_STORAGE_KEY),
        draft: readStored(DRAFT_COLUMN_STORAGE_KEY),
        archived: readStored(ARCHIVED_COLUMN_KEY),
      });
      const next: TrackerLanes = { ...current, ...patch };
      queryClient.setQueryData<TrackerLanesAnswer>(TRACKER_LANES_QUERY_KEY, { lanes: next });
      writeBrowserCopy(next);
      writeStored(LANES_MOVED_KEY, '1');
      void saveTrackerLanes(next).catch(() => queryClient.invalidateQueries({ queryKey: TRACKER_LANES_QUERY_KEY }));
    },
    [queryClient],
  );
  return { lanes, update };
}

/**
 * A mouse press held for `delay` ms without moving opens the card's menu (touch long-press is the context menu's own).
 * `consumeClick` tells the click that ends a long press not to open the application.
 */
export function useLongPress(onLongPress: () => void, delay = 500) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const handlers = useMemo(
    () => ({
      onPointerDown(event: PointerEvent) {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        fired.current = false;
        origin.current = { x: event.clientX, y: event.clientY };
        clear();
        timer.current = window.setTimeout(() => {
          timer.current = null;
          fired.current = true;
          onLongPress();
        }, delay);
      },
      onPointerMove(event: PointerEvent) {
        if (timer.current === null || !origin.current) return;
        if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 6) clear();
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
    }),
    [clear, delay, onLongPress],
  );

  const consumeClick = useCallback(() => {
    if (!fired.current) return false;
    fired.current = false;
    return true;
  }, []);

  return { handlers, consumeClick, cancel: clear };
}
