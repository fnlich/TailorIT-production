'use client';

import type { Announcement, AnnouncementList } from '@tailorit/shared/announcements';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
// Relative, not '@/': the web tests draw these views.
import { PAGE_GUTTER } from '../../components/shell/layout';
import { InfoIcon, WarningCircleIcon, XIcon } from '../../components/ui/icons';
import { useToast } from '../../components/ui/Toast';
import { userMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useNow } from '../../lib/useNow';
import { ANNOUNCEMENTS_STALE_MS, announcementKeys, dismissAnnouncement, fetchAnnouncements } from './api';
import { BANNER_COPY, SEVERITY_LABEL, SEVERITY_TONE, announcesAsAlert, bannerItems } from './banner';

// v2.0: the announcement banner (docs/design/v2.0/08-ui.md, "The announcement banner"; A19), the slot between the
// header and the page in app/(app)/layout.tsx. Every signed-in person sees the admin's active announcements, most
// severe first, as full-width strips in plain text. Each is dismissed for this person alone: at once on the page, then
// on the server. Never on the sign-in page (it is outside the (app) layout).

// v3.1: each strip is a full-width notice: the tone's soft background, its ink for the words, and a 3 px bar of the
// full tone on the leading edge (the kit's Notice, as a strip).
const TONE_CLASSES = {
  info: 'border-l-info bg-info-soft text-info-ink',
  warning: 'border-l-warning bg-warning-soft text-warning-ink',
  error: 'border-l-danger bg-danger-soft text-danger-ink',
} as const;

const ICON_CLASSES = { info: 'text-info', warning: 'text-warning', error: 'text-danger' } as const;

/** The critical announcements this tab has shown: each is an alert once, never again (a re-render, a new page). */
const announcedInThisTab = new Set<string>();

/** The banner for the signed-in person; nothing while signed out or with nothing to show. */
export function AnnouncementBanner() {
  const { account } = useAuth();
  if (!account) return null;
  return <SignedInBanner />;
}

function SignedInBanner() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const query = useQuery({
    queryKey: announcementKeys.active,
    queryFn: ({ signal }) => fetchAnnouncements(signal),
    staleTime: ANNOUNCEMENTS_STALE_MS,
    refetchOnWindowFocus: true,
  });
  // Dismissed here: hidden at once, and kept hidden while the request is on its way (a read in between may still
  // return them).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dismiss = useMutation({
    mutationFn: (item: Announcement) => dismissAnnouncement(item.id),
    onMutate: (item) => setDismissed((current) => new Set(current).add(item.id)),
    onSuccess: (_answer, item) => {
      queryClient.setQueryData<AnnouncementList>(announcementKeys.active, (current) =>
        current ? { items: current.items.filter((entry) => entry.id !== item.id) } : current,
      );
    },
    onError: (error, item) => {
      setDismissed((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      toast.error(BANNER_COPY.dismissFailed, userMessage(error));
    },
  });

  const items = useMemo(() => bannerItems(query.data?.items ?? [], dismissed, now), [query.data, dismissed, now]);
  // A critical announcement is an alert the first time this tab shows it, never again.
  const alertIds = new Set(items.filter((item) => announcesAsAlert(item, announcedInThisTab)).map((item) => item.id));
  useEffect(() => {
    for (const item of items) if (item.severity === 'critical') announcedInThisTab.add(item.id);
  }, [items]);

  if (items.length === 0) return null;
  return (
    <AnnouncementList
      items={items}
      alertIds={alertIds}
      onDismiss={(item) => dismiss.mutate(item)}
    />
  );
}

/** The strips themselves (drawn statically by the tests). */
export function AnnouncementList({
  items,
  alertIds,
  onDismiss,
  preview = false,
}: {
  items: readonly Announcement[];
  /** The ones that announce themselves (role="alert") on this render. */
  alertIds: ReadonlySet<string>;
  onDismiss: (item: Announcement) => void;
  /** Admin › Announcements' preview: no landmark, and its dismiss button does nothing. */
  preview?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * v2.0 fix (UX-9): the dismissed strip and its × go at once, and focus fell to <body>. It moves to the next strip's ×
   * (else the one before), else to the page's <main>.
   */
  const dismissAndMoveFocus = (item: Announcement, button: HTMLButtonElement) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-announcement-dismiss]') ?? []);
    const at = buttons.indexOf(button);
    const next = buttons[at + 1] ?? buttons[at - 1] ?? null;
    onDismiss(item);
    window.requestAnimationFrame(() => {
      if (next?.isConnected) next.focus();
      else document.querySelector<HTMLElement>('main')?.focus();
    });
  };
  return (
    <div
      ref={listRef}
      role={preview ? undefined : 'region'}
      aria-label={preview ? undefined : BANNER_COPY.region}
      data-announcements={preview ? 'preview' : ''}
      className="flex flex-col"
    >
      {items.map((item) => {
        const tone = SEVERITY_TONE[item.severity];
        return (
          <div
            key={item.id}
            data-announcement={item.severity}
            role={alertIds.has(item.id) ? 'alert' : undefined}
            className={clsx('border-b border-l-[3px] border-b-border', TONE_CLASSES[tone])}
          >
            <div className={clsx('flex items-start gap-2.5 py-2.5', PAGE_GUTTER)}>
              <span className={clsx('mt-0.5 flex shrink-0', ICON_CLASSES[tone])} aria-hidden="true">
                {tone === 'info' ? <InfoIcon size={18} weight="fill" /> : <WarningCircleIcon size={18} weight="fill" />}
              </span>
              <div className="min-w-0 flex-1 text-sm leading-5 break-words">
                <p className="font-semibold">
                  <span className="sr-only">{SEVERITY_LABEL[item.severity]}: </span>
                  {item.title}
                </p>
                {item.body.trim() && <p className="mt-0.5 whitespace-pre-line">{item.body}</p>}
              </div>
              <button
                type="button"
                aria-label={BANNER_COPY.dismiss(item.title)}
                aria-hidden={preview || undefined}
                tabIndex={preview ? -1 : undefined}
                disabled={preview}
                onClick={(event) => dismissAndMoveFocus(item, event.currentTarget)}
                data-announcement-dismiss=""
                className="-my-1 -mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-control transition-colors duration-150 hover:bg-hover active:bg-pressed max-sm:-my-2.5 max-sm:size-11"
              >
                <XIcon size={16} weight="bold" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
