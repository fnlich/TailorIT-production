'use client';

import type { Account } from '@tailorit/shared/auth';
import { PROFILE_AS_PARAM, PROFILE_SELF, type ProfileChoice } from '@tailorit/shared/sharing';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
// Relative, not '@/': the web tests draw the shell.
import { useAuth } from '../../../lib/auth';
import { usePublicConstants } from '../../../lib/constants';
import {
  documentProfile,
  keyOfChoice,
  newTabHref,
  onProfileEvent,
  parseChoice,
  readStoredProfile,
  switchProfile,
  takeProfileNotice,
  withoutAs,
  type ProfileEvent,
} from '../../../lib/profile';
import { clearProfileCopies, pruneProfileCopies } from '../../../features/resume-editor/save/localCopy';
import { useGateAlert } from '../../ui/AlertDialog';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { HEADER_QUERY_KEY, fetchHeaderSummary } from '../header/api';
import { PROFILE_COPY } from './copy';
import { SHARING_PROFILES_QUERY_KEY, endedProfileName, fetchSharedProfiles, profileName, useProfile, type ProfileView } from './useProfile';

// v33 SHARE-4 (PLAN F9; SP v33 PLAN-sharing.md §9): what the shell does about the tab's profile once the signed-in
// account is known (AuthGate draws this beside the page, in every signed-in layout):
// - the notice the last document left (the shared profile ended: an alert; the tab went back to its own: a toast);
// - what answers say (lib/profile.ts' events): an ended profile takes the tab back to the person's own (its local
//   copies go); a refused write is one alert (a GET's refusal is the page's to show inline); a switch that stayed put
//   for unsaved changes says so;
// - ?as=: taken out of the address once the page has hydrated; one naming another profile than the tab's (an outside
//   link, or a page that came to it without a load) is asked about first (ConfirmDialog, Cancel focused);
// - new tabs: while the tab works on a shared profile, a link opened in a new tab or window (Ctrl/Cmd/Shift-click,
//   the middle button, the context menu, target=_blank) carries ?as=<key>, so the new tab works on the same profile;
// - the tab's title starts with the profile's name ("Ana · Job Tracker · TailorIT");
// - a page brought back from the back-forward cache after the tab switched loads again;
// - the person's list is read: local copies of profiles it no longer has go; a tab on a key it does not have is on an
//   ended profile; a new invite (the header's count moved) reads the list again.

function browserLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The address as the page shows it, without ?as=. */
function currentAddress(): string {
  return withoutAs(`${window.location.pathname}${window.location.search}${window.location.hash}`);
}

export function ProfileRuntime({ account }: { account: Account }) {
  const view = useProfile();
  const viewRef = useRef<ProfileView>(view);
  const { t } = usePublicConstants();
  const toast = useToast();
  const gate = useGateAlert();
  const gateOpen = useRef(false);
  const queryClient = useQueryClient();
  const ended = useRef(false);
  const [asking, setAsking] = useState<ProfileChoice | null>(null);
  const askDone = useCallback(() => setAsking(null), []);
  const askUnavailable = useCallback(() => toast.info(PROFILE_COPY.unavailable), [toast]);

  useEffect(() => {
    viewRef.current = view;
    gateOpen.current = gate.open;
  });

  const { show } = gate;
  const accountId = account.id;

  /** The tab's shared profile is not live: back to the person's own, its local copies gone, an alert after the load. */
  const leaveEnded = useCallback(
    (key: string) => {
      if (ended.current) return;
      ended.current = true;
      clearProfileCopies(browserLocalStorage(), accountId, key);
      // v33 INT-D: named from the list even when the answer came before the page drew it (the list being read is
      // awaited, a moment at most), so the alert after the load says whose profile it was.
      const readList = () =>
        queryClient.fetchQuery({ queryKey: SHARING_PROFILES_QUERY_KEY, queryFn: ({ signal }) => fetchSharedProfiles(signal), staleTime: 60_000 });
      void endedProfileName(viewRef.current, key, readList, account).then((name) =>
        switchProfile(PROFILE_SELF, { force: true, accountId, notice: { kind: 'ended', name } }),
      );
    },
    [accountId, account, queryClient],
  );

  // The word the last document left for this one.
  useEffect(() => {
    const notice = takeProfileNotice();
    if (!notice) return;
    if (notice.kind === 'back') {
      toast.info(PROFILE_COPY.backOnYours);
      return;
    }
    show({
      title: PROFILE_COPY.endedTitle(notice.name),
      message: t('MSG_SHARING_PROFILE_ENDED'),
      tone: 'info',
      dataAttributes: { 'data-profile-alert': 'ended' },
    });
    // Once per document: the notice is taken.
  }, [toast, show, t]);

  // What answers say.
  useEffect(
    () =>
      onProfileEvent((event: ProfileEvent) => {
        switch (event.kind) {
          case 'ended':
            leaveEnded(event.key);
            return;
          case 'gone':
            void queryClient.invalidateQueries({ queryKey: SHARING_PROFILES_QUERY_KEY });
            return;
          case 'unsaved':
            show({
              title: PROFILE_COPY.unsavedTitle,
              message: PROFILE_COPY.unsavedMessage,
              tone: 'warning',
              dataAttributes: { 'data-profile-alert': 'unsaved' },
            });
            return;
          case 'refused': {
            // A read's refusal is the page's to show where the data would be ("Not shared with you.").
            if (event.method === 'GET' || event.method === 'HEAD' || gateOpen.current) return;
            // v33 SHARE-7 (SHARE-4's edit 2): a refusal of another profile than the tab's (a combined view's per-call
            // profile: the Profiles page's Prepare all profiles, the Tracker's All profiles) is that view's to show.
            if (event.key !== documentProfile()) return;
            gateOpen.current = true;
            if (event.code === 'own_profile_only') {
              show({
                title: PROFILE_COPY.ownOnlyTitle,
                message: t('MSG_SHARING_OWN_PROFILE_ONLY'),
                tone: 'locked',
                action: { label: PROFILE_COPY.switchBack, onAction: () => void switchProfile(PROFILE_SELF, { accountId }) },
                dataAttributes: { 'data-profile-alert': 'own_profile_only' },
              });
            } else {
              const current = viewRef.current;
              show({
                title: PROFILE_COPY.notSharedTitle,
                message: current.profile ? PROFILE_COPY.notSharedBy(current.label) : event.message || t('MSG_SHARING_NOT_SHARED'),
                tone: 'locked',
                dataAttributes: { 'data-profile-alert': 'profile_not_shared' },
              });
            }
            return;
          }
        }
      }),
    [leaveEnded, queryClient, show, t, accountId],
  );

  // The person's list: copies of profiles it no longer has go; a tab on a key it does not have is on an ended profile.
  const { settled, failed, profiles, profile, acting, key } = view;
  useEffect(() => {
    if (!settled || failed) return;
    pruneProfileCopies(
      browserLocalStorage(),
      accountId,
      profiles.map((row) => row.key),
    );
    if (acting && key && !profile) leaveEnded(key);
  }, [settled, failed, profiles, profile, acting, key, accountId, leaveEnded]);

  // A new invite (the header's count moved): the list is read again.
  const header = useQuery({ queryKey: HEADER_QUERY_KEY, queryFn: ({ signal }) => fetchHeaderSummary(signal), enabled: false });
  const invites = header.data?.invites;
  const seenInvites = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (invites === undefined) return;
    if (seenInvites.current !== undefined && seenInvites.current !== invites) {
      void queryClient.invalidateQueries({ queryKey: SHARING_PROFILES_QUERY_KEY });
    }
    seenInvites.current = invites;
  }, [invites, queryClient]);

  // New tabs opened from a tab on a shared profile keep it.
  useEffect(() => {
    const profileKey = documentProfile();
    if (!profileKey) return undefined;
    const decorate = (target: EventTarget | null) => {
      const anchor = target instanceof Element ? target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
      const next = newTabHref(anchor.getAttribute('href') ?? '', profileKey, window.location.origin);
      if (next) anchor.setAttribute('href', next);
    };
    const opensElsewhere = (event: MouseEvent) =>
      event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey;
    const onPress = (event: MouseEvent) => {
      if (opensElsewhere(event)) decorate(event.target);
    };
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const blank = anchor instanceof HTMLAnchorElement && anchor.target !== '' && anchor.target !== '_self';
      if (opensElsewhere(event) || blank) decorate(event.target);
    };
    const always = (event: MouseEvent) => decorate(event.target);
    document.addEventListener('mousedown', onPress, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', always, true);
    document.addEventListener('contextmenu', always, true);
    return () => {
      document.removeEventListener('mousedown', onPress, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', always, true);
      document.removeEventListener('contextmenu', always, true);
    };
  }, []);

  // The tab's title names the profile.
  const label = view.acting ? view.label : '';
  useEffect(() => {
    if (!label) return undefined;
    const prefix = PROFILE_COPY.titlePrefix(label);
    const apply = () => {
      if (!document.title.startsWith(prefix)) document.title = `${prefix}${document.title}`;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);
    };
  }, [label]);

  // A page brought back from the back-forward cache after the tab switched loads again on the tab's profile.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      const stored = readStoredProfile();
      if (stored && stored.key !== documentProfile()) window.location.reload();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  return (
    <>
      {gate.alert}
      <Suspense fallback={null}>
        <AsLinkWatcher onAsk={setAsking} />
      </Suspense>
      <AskDialog view={view} asking={asking} accountId={accountId} onDone={askDone} onUnavailable={askUnavailable} />
    </>
  );
}

/**
 * ?as= in the address: taken out once the page has hydrated (the tab, not the address, holds the profile). One naming
 * another profile than the tab's is asked about: a same-origin link was taken when the document loaded already
 * (lib/profile.ts bootProfile), so what is left here came from outside, or reached the page without a load.
 */
function AsLinkWatcher({ onAsk }: { onAsk: (choice: ProfileChoice) => void }) {
  const params = useSearchParams();
  const has = params.has(PROFILE_AS_PARAM);
  const raw = params.get(PROFILE_AS_PARAM);
  useEffect(() => {
    if (!has) return;
    window.history.replaceState(null, '', currentAddress());
    const asked = parseChoice(raw);
    if (asked && keyOfChoice(asked) !== documentProfile()) onAsk(asked);
  }, [has, raw, onAsk]);
  return null;
}

/** "Open Ana's profile?" for an outside ?as= link (Cancel first: a quick Enter keeps the tab where it is). */
function AskDialog({
  view,
  asking,
  accountId,
  onDone,
  onUnavailable,
}: {
  view: ProfileView;
  asking: ProfileChoice | null;
  accountId: string;
  onDone: () => void;
  onUnavailable: () => void;
}) {
  const { account } = useAuth();
  const target = asking && asking !== PROFILE_SELF ? (view.profiles.find((row) => row.key === asking) ?? null) : null;
  const unknown = asking !== null && asking !== PROFILE_SELF && view.settled && !target;
  useEffect(() => {
    if (!unknown) return;
    onUnavailable();
    onDone();
  }, [unknown, onUnavailable, onDone]);
  const own = asking === PROFILE_SELF;
  const open = asking !== null && (own || target !== null);
  const name = target ? profileName(target, account) : '';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDone();
      }}
      title={own ? PROFILE_COPY.askOwnTitle : PROFILE_COPY.askTitle(name)}
      description={own ? PROFILE_COPY.askOwnDescription : PROFILE_COPY.askDescription(target?.email ?? '')}
      confirmLabel={own ? PROFILE_COPY.askOwnConfirm : PROFILE_COPY.askConfirm}
      cancelLabel={PROFILE_COPY.askCancel}
      tone="primary"
      focusCancel
      onConfirm={async () => {
        if (!asking) return;
        // The page the link named, on the profile it named (its ids are that profile's).
        await switchProfile(asking, { to: currentAddress(), accountId });
      }}
    />
  );
}
