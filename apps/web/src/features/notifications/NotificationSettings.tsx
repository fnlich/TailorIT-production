'use client';

import type { NotificationGroup, NotificationPrefs } from '@tailorit/shared/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { userMessage } from '../../lib/api';
import { Section, SwitchRow } from '../settings/parts';
import { fetchNotificationPrefs, PREFS_QUERY_KEY, saveNotificationPref, withPref } from './api';
import { GROUP_SETTINGS, SETTINGS_COPY } from './copy';

// v3.1 HEADER (D8; docs/design/v3.1/24-notifications-usage.md §2, §5): Settings › Notification settings
// (/settings#notifications), one switch per group of kinds (Admin for administrators: the API lists it for them
// only). A switch saves at once (PUT /api/notifications/prefs, that group alone) and goes back if the server refuses.
// Off stops new notifications of the group; the ones already written stay.

/** The section's anchor (the bell's settings link: /settings#notifications). */
export const NOTIFICATION_SETTINGS_ANCHOR = 'notifications';

export function NotificationSettings({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const prefs = useQuery({ queryKey: PREFS_QUERY_KEY, queryFn: ({ signal }) => fetchNotificationPrefs(signal) });
  const save = useMutation({
    mutationFn: ({ group, enabled }: { group: NotificationGroup; enabled: boolean }) => saveNotificationPref({ group, enabled }),
    onMutate: ({ group, enabled }) => {
      const before = queryClient.getQueryData<NotificationPrefs>(PREFS_QUERY_KEY);
      if (before) queryClient.setQueryData<NotificationPrefs>(PREFS_QUERY_KEY, withPref(before, group, enabled));
      return { before };
    },
    onSuccess: (saved) => queryClient.setQueryData(PREFS_QUERY_KEY, saved),
    onError: (error, _change, context) => {
      if (context?.before) queryClient.setQueryData(PREFS_QUERY_KEY, context.before);
      toast.error(userMessage(error, SETTINGS_COPY.saveFailed));
    },
  });
  // The page opens behind the sign-in check, so the browser's own jump to #notifications finds nothing yet.
  useScrollToAnchor(NOTIFICATION_SETTINGS_ANCHOR, prefs.isSuccess);

  return (
    <Section id={NOTIFICATION_SETTINGS_ANCHOR} title={SETTINGS_COPY.title} description={SETTINGS_COPY.description} className={className}>
      {prefs.data ? (
        <NotificationSwitches prefs={prefs.data} onChange={(group, enabled) => save.mutate({ group, enabled })} />
      ) : prefs.isError ? (
        <Notice
          tone="error"
          title={SETTINGS_COPY.loadFailed}
          action={
            <Button variant="outline" size="sm" loading={prefs.isFetching} onClick={() => void prefs.refetch()}>
              {SETTINGS_COPY.tryAgain}
            </Button>
          }
        >
          {userMessage(prefs.error, 'Please try again in a moment.')}
        </Notice>
      ) : (
        <div className="flex flex-col gap-5" aria-busy="true">
          <span className="sr-only">{SETTINGS_COPY.loading}</span>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} aria-hidden="true" className="flex items-start justify-between gap-4">
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
              <Skeleton className="h-5 w-9" rounded="full" />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** The switches, one per group the person may get (drawn statically by the tests). */
export function NotificationSwitches({
  prefs,
  onChange,
}: {
  prefs: NotificationPrefs;
  onChange: (group: NotificationGroup, enabled: boolean) => void;
}) {
  return (
    <div className="flex flex-col divide-y divide-divider-soft" data-notification-prefs="">
      {prefs.groups.map((pref) => (
        <div key={pref.group} className="py-3.5 first:pt-0 last:pb-0" data-pref={pref.group}>
          <SwitchRow
            title={GROUP_SETTINGS[pref.group].title}
            hint={GROUP_SETTINGS[pref.group].hint}
            checked={pref.enabled}
            onCheckedChange={(enabled) => onChange(pref.group, enabled)}
          />
        </div>
      ))}
    </div>
  );
}

/** How long the section is kept in view while the sections above it fill in (unless the person scrolls first). */
const ANCHOR_SETTLE_MS = 3_000;
const PERSON_SCROLLS = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;

/**
 * Scrolls to #`anchor` once its content is in, and keeps it there while the page grows above it (the account, the
 * profile and Prepare & Queue load on their own) for a moment, until the person scrolls, types or clicks.
 */
function useScrollToAnchor(anchor: string, ready: boolean) {
  useEffect(() => {
    if (!ready || window.location.hash !== `#${anchor}`) return undefined;
    const align = () => document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
    align();
    const observer = new ResizeObserver(align);
    observer.observe(document.body);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const event of PERSON_SCROLLS) window.removeEventListener(event, stop);
    };
    const timer = window.setTimeout(stop, ANCHOR_SETTLE_MS);
    for (const event of PERSON_SCROLLS) window.addEventListener(event, stop, { passive: true });
    return stop;
  }, [anchor, ready]);
}
