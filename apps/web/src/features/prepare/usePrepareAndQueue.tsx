'use client';

import type { PrepareSettings } from '@tailorit/shared/prepare';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { useLimitDialog } from '@/components/limits';
import { useToast } from '@/components/ui/Toast';
import { invalidateAccount } from '@/lib/account';
import { ApiError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { redirectToLogin } from '@/lib/navigation';
import { invalidateApplications } from '../tracker/data';
import { fetchPrepareSettings, prepareKeys, savePrepareSettings, startPrepare } from './api';
import { announcement, FILTERS_HREF, prepareResultCopy, type PreparedJobName } from './copy';
import { PrepareConfirmDialog } from './PrepareConfirmDialog';

// v2.0: Prepare & Queue as one action every screen shares (the Auto-apply page's Saved pane and Queue pane, the
// Tracker's "Prepare & Queue jobs" and its card menu): the first-time confirm (unless "Don't show this again" was
// ticked, stored on the server), POST /api/prepare, the result toast and live line, the limit and refusal dialog
// (useLimitDialog), and the reads it changes: the Auto-apply panes, the Tracker, the kits and the account
// (invalidateAccount after every Prepare).

/** The Auto-apply page's queries (the Saved and Queue panes, the kits): all start with this. */
export const AUTO_APPLY_QUERY_ROOT = ['auto-apply'] as const;
/** The result toast stays this long, so "Change filters" can be reached. */
const RESULT_TOAST_MS = 8_000;

export interface PrepareRequest {
  applicationIds: readonly string[];
  /** Each job's title and company, for the toast's words. */
  names?: ReadonlyMap<string, PreparedJobName>;
  /** Make the kits again ("Prepare again"). */
  rebuild?: boolean;
  /** Runs once the server answered (not on a refusal): the caller clears its selection, for one. */
  onDone?: () => void;
}

export interface PrepareAndQueue {
  /** Starts Prepare & Queue for the saved jobs (the confirm first, unless the person turned it off). */
  prepare: (request: PrepareRequest) => void;
  /** The saved jobs a request is in flight for (their buttons show the spinner). */
  pending: ReadonlySet<string>;
  /** The confirm, the limit dialog and the live line: render once. */
  elements: ReactElement;
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Where a Prepare & Queue was pressed: the button, and its row (a Saved or a Queue row) when it has one, with the
 * saved job (application) a Queue row is for.
 */
interface FocusOrigin {
  element: HTMLElement;
  row: string | null;
  application: string | null;
}

/** The element that has focus now, and the row it is in. */
export function focusOrigin(): FocusOrigin | null {
  const element = typeof document === 'undefined' ? null : document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  const row = element.closest<HTMLElement>('[data-saved-row], [data-queue-row]');
  const selector = row
    ? row.hasAttribute('data-saved-row')
      ? `[data-saved-row="${CSS.escape(row.getAttribute('data-saved-row') ?? '')}"]`
      : `[data-queue-row="${CSS.escape(row.getAttribute('data-queue-row') ?? '')}"]`
    : null;
  const application = row?.hasAttribute('data-queue-row') ? row.getAttribute('data-application') : null;
  return { element, row: selector, application };
}

/**
 * v2.0 fix (UX-3): where focus goes back to after the confirm: the pressed button while it is still there, else its
 * row's action now (Prepare & Queue became Cancel), else Base UI's default. v2.0 FIX-INT (UX-3's tail): a Queue row's
 * Try again starts a new Prepare whose row has another key; when the pressed row is gone, focus goes to the new
 * Preparing row of the same saved job.
 */
export function focusBack(origin: FocusOrigin | null): HTMLElement | true {
  if (!origin) return true;
  if (origin.element.isConnected && !origin.element.closest('[aria-hidden="true"]')) return origin.element;
  let row = origin.row ? document.querySelector<HTMLElement>(origin.row) : null;
  if (!row && origin.application) {
    const application = CSS.escape(origin.application);
    row =
      document.querySelector<HTMLElement>(`[data-queue-row^="p:"][data-application="${application}"]`) ??
      document.querySelector<HTMLElement>(`[data-queue-row][data-application="${application}"]`);
  }
  return row?.querySelector<HTMLElement>('[data-row-action]') ?? row?.querySelector<HTMLElement>('button') ?? true;
}

export function usePrepareAndQueue(): PrepareAndQueue {
  const queryClient = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const limits = useLimitDialog();
  const { t } = usePublicConstants();
  const [pending, setPending] = useState<ReadonlySet<string>>(NO_IDS);
  const busy = useRef(false);
  /** Continue was pressed: the dialog's close must not end the request it started. */
  const continuing = useRef(false);
  const [asking, setAsking] = useState<PrepareRequest | null>(null);
  const [live, setLive] = useState('');
  /** The pressed button and its row, for the confirm's final focus. */
  const origin = useRef<FocusOrigin | null>(null);

  const refreshAfter = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: AUTO_APPLY_QUERY_ROOT });
    void queryClient.invalidateQueries({ queryKey: prepareKeys.drafts });
    void invalidateApplications(queryClient);
    void invalidateAccount(queryClient);
  }, [queryClient]);

  const send = useCallback(
    async (request: PrepareRequest) => {
      const ids = [...request.applicationIds];
      setPending(new Set(ids));
      try {
        const answer = await startPrepare(ids, request.rebuild ?? false);
        const copy = prepareResultCopy(answer, (id) => request.names?.get(id), (reason) => t('MSG_FILTERED', { reason }));
        toast.toast({
          type: copy.tone,
          title: copy.title,
          description: copy.description,
          timeout: RESULT_TOAST_MS,
          action: copy.filtered ? { label: 'Change filters', onClick: () => router.push(FILTERS_HREF) } : undefined,
        });
        setLive(announcement(copy));
        request.onDone?.();
      } catch (error) {
        if (error instanceof ApiError && error.isSessionExpired) {
          redirectToLogin();
          return;
        }
        // A refusal (the AI usage, the server AI, the resume limit) opens the limit dialog; anything else, a toast.
        if (!limits.show(error)) toast.error('Prepare & Queue did not start', userMessage(error, 'Please try again.'));
      } finally {
        busy.current = false;
        continuing.current = false;
        setPending(NO_IDS);
        refreshAfter();
      }
    },
    [limits, refreshAfter, router, t, toast],
  );

  const prepare = useCallback(
    (request: PrepareRequest) => {
      if (busy.current || request.applicationIds.length === 0) return;
      busy.current = true;
      origin.current = focusOrigin();
      setPending(new Set(request.applicationIds));
      void (async () => {
        let settings: PrepareSettings | null = null;
        try {
          settings = await queryClient.fetchQuery({
            queryKey: prepareKeys.settings,
            queryFn: ({ signal }) => fetchPrepareSettings(signal),
            staleTime: 30_000,
          });
        } catch {
          // Unknown: ask, as for a person who never turned the confirm off.
        }
        if (settings?.skipConfirm) {
          await send(request);
          return;
        }
        setPending(NO_IDS);
        setAsking(request);
      })();
    },
    [queryClient, send],
  );

  const elements = (
    <>
      <PrepareConfirmDialog
        open={asking !== null}
        count={asking?.applicationIds.length ?? 0}
        finalFocus={() => focusBack(origin.current)}
        onOpenChange={(open) => {
          if (open) return;
          setAsking(null);
          if (!continuing.current) busy.current = false;
        }}
        onContinue={async (dontShowAgain) => {
          const request = asking;
          if (!request) return;
          if (dontShowAgain) {
            const saved = await savePrepareSettings({ skipConfirm: true });
            queryClient.setQueryData(prepareKeys.settings, saved);
          }
          // The dialog closes now; the request runs with the pressed button's spinner.
          continuing.current = true;
          setAsking(null);
          void send(request);
        }}
      />
      {limits.dialog}
      <p className="sr-only" role="status" aria-live="polite" data-prepare-live="">
        {live}
      </p>
    </>
  );

  return { prepare, pending, elements };
}
