'use client';

import { initialsOf, type Account } from '@tailorit/shared/auth';
import {
  PROFILE_SELF,
  SharedProfilesSchema,
  type ProfileChoice,
  type ProfileKey,
  type SharedProfile,
  type SharedProfiles,
  type SharePermission,
  type SharingInvite,
} from '@tailorit/shared/sharing';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
// Relative, not '@/': the web tests draw the shell.
import { apiFetch } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { documentProfile, switchProfile, type SwitchOptions, type SwitchResult } from '../../../lib/profile';
import { useHeaderPreview } from '../header/preview';
import { PROFILE_COPY } from './copy';

// v33 SHARE-4 (PLAN F9; SP v33 PLAN-sharing.md §9): the hooks the shell and the sharing pages read the tab's profile
// through. The profiles shared with the person come from GET /api/sharing/profiles (SHARE-2; a `self` route, so it
// always lists the signed-in person's, whichever profile the tab names). An API without it (or with sharing off)
// answers none: the shell then shows no profile parts at all.
//
// Consumed by SHARE-7 (Settings › Sharing, the Profiles page, permission-aware pages: useProfile().can, switchTo) and
// SHARE-9 (the Tracker's All profiles view: useSharedProfiles, profileCan, apiFetch's `profile`).

/** React Query key of GET /api/sharing/profiles. */
export const SHARING_PROFILES_QUERY_KEY = ['sharing', 'profiles'] as const;

/** No shared profiles: sharing off, an API without sharing, or the list not read yet. */
export const NO_SHARED_PROFILES: SharedProfiles = { enabled: false, profiles: [], invites: [] };

/** GET /api/sharing/profiles. */
export function fetchSharedProfiles(signal?: AbortSignal): Promise<SharedProfiles> {
  return apiFetch<SharedProfiles>('/api/sharing/profiles', { schema: SharedProfilesSchema, signal });
}

export interface SharedProfilesRead {
  /** The list (NO_SHARED_PROFILES until it is read, and when it fails). */
  data: SharedProfiles;
  /** Read, or failed: what the shell shows no longer changes by waiting. */
  settled: boolean;
  /** The read failed (an API without sharing answers 404): nothing is shown, nothing is pruned. */
  failed: boolean;
  refetch: () => void;
}

/** A fixed profile and list with no API behind them: the dev kit and the shell's tests (as HeaderPreview is the header's). */
export interface ProfilePreviewData {
  /** The tab's profile (null: the person's own). */
  key: ProfileKey | null;
  list: SharedProfiles;
}

const ProfilePreviewContext = createContext<ProfilePreviewData | null>(null);
/** Draws everything below on `value` (the dev kit, the tests); nothing is read from the API. */
export const ProfilePreview = ProfilePreviewContext.Provider;

/**
 * The profiles shared with the signed-in person and their invites (read once the account is known). Under a
 * ProfilePreview its list; under the header's HeaderPreview alone (the dev kit, which makes no request at all) none.
 */
export function useSharedProfiles(): SharedProfilesRead {
  const { account } = useAuth();
  const preview = useContext(ProfilePreviewContext);
  const header = useHeaderPreview();
  const query = useQuery({
    queryKey: SHARING_PROFILES_QUERY_KEY,
    queryFn: ({ signal }) => fetchSharedProfiles(signal),
    enabled: account !== null && preview === null && header === null,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    // A 404 (an API without sharing) or any refusal: none, and no retries.
    retry: false,
  });
  const { refetch } = query;
  const again = useCallback(() => void refetch(), [refetch]);
  if (preview) return { data: preview.list, settled: true, failed: false, refetch: again };
  if (header) return { data: NO_SHARED_PROFILES, settled: true, failed: false, refetch: again };
  return {
    data: query.data ?? NO_SHARED_PROFILES,
    settled: query.isSuccess || query.isError,
    failed: query.isError,
    refetch: again,
  };
}

const noSubscribe = () => () => undefined;
const serverProfile = () => null;

/**
 * The document's profile for a component: null on the server and while hydrating (the server drew the person's own),
 * then the profile the page loaded with. It never changes afterwards (a switch loads a new document).
 */
export function useDocumentProfile(): ProfileKey | null {
  const preview = useContext(ProfilePreviewContext);
  const key = useSyncExternalStore(noSubscribe, documentProfile, serverProfile);
  return preview ? preview.key : key;
}

/**
 * How a shared profile is named: its owner's name; their email when they set none; "Shared: <email>" when the name is
 * the signed-in person's own (two "Ana"s in one menu are told apart).
 */
export function profileName(profile: Pick<SharedProfile, 'name' | 'email'>, account: Pick<Account, 'name'> | null): string {
  const name = profile.name.trim();
  if (!name) return profile.email;
  if (account && name.toLocaleLowerCase() === account.name.trim().toLocaleLowerCase()) return PROFILE_COPY.sharedBy(profile.email);
  return name;
}

/** How long the alert of an ended profile waits for the list to name it, at most. */
export const ENDED_NAME_WAIT_MS = 2_000;

/**
 * v33 INT-D: the name the "<name>'s profile isn't available" alert gives an ended profile: the page's own view when it
 * drew the profile; else the list as it is read (an answer can come before the list: awaited `waitMs` at most); null
 * when the list has no such profile, fails, or is slow.
 */
export async function endedProfileName(
  view: Pick<ProfileView, 'profile' | 'label'>,
  key: string,
  readList: () => Promise<SharedProfiles>,
  account: Pick<Account, 'name'> | null,
  waitMs = ENDED_NAME_WAIT_MS,
): Promise<string | null> {
  if (view.profile) return view.label;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const list = await Promise.race([
      readList(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      }),
    ]);
    const row = list?.profiles.find((profile) => profile.key === key);
    return row ? profileName(row, account) : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A shared profile's initials (the chip on a phone, the account menu's overlay). */
export function profileInitials(profile: Pick<SharedProfile, 'name' | 'email'>): string {
  return initialsOf(profile.name, profile.email);
}

/** Whether `choice` may do `perm`: the person's own profile may do anything; a shared one what its owner ticked. */
export function profileCan(profiles: readonly SharedProfile[], choice: ProfileChoice, perm: SharePermission): boolean {
  if (choice === PROFILE_SELF) return true;
  return profiles.find((profile) => profile.key === choice)?.permissions.includes(perm) ?? false;
}

export interface ProfileView {
  /** The tab's profile: null on the person's own. */
  key: ProfileKey | null;
  /** The tab works on a profile shared with the person. */
  acting: boolean;
  /** The shared profile's row, once the list is read (null on the person's own, or a key the list does not have). */
  profile: SharedProfile | null;
  /** "You" on the person's own; the owner's name ("Shared: <email>" for a name like theirs) on a shared one. */
  label: string;
  /** The profiles shared with the person (none until read, on failure, or with sharing off). */
  profiles: SharedProfile[];
  /** Invites waiting for the person's answer. */
  invites: SharingInvite[];
  /** Sharing is on (the list said so). */
  enabled: boolean;
  /** The list is read (or failed). */
  settled: boolean;
  /** The list could not be read (an API without sharing answers 404): no profile is known. */
  failed: boolean;
  /** The person has a shared profile, an invite, or the tab works on one: the shell shows its profile parts. */
  hasProfiles: boolean;
  /** The shared profile's boxes (null on the person's own: everything). */
  permissions: readonly SharePermission[] | null;
  /** Whether the tab may do `perm` here: always on the person's own; on a shared one, only what was ticked (false until read). */
  can: (perm: SharePermission) => boolean;
  /** Switches the tab (the editors' saves first; then a new document on the section's list page). */
  switchTo: (choice: ProfileChoice, options?: SwitchOptions) => Promise<SwitchResult>;
}

/** The tab's profile, the person's shared profiles, `can(perm)` and `switchTo`. */
export function useProfile(): ProfileView {
  const { account } = useAuth();
  const list = useSharedProfiles();
  const key = useDocumentProfile();
  const accountId = account?.id ?? null;
  const switchTo = useCallback(
    (choice: ProfileChoice, options: SwitchOptions = {}) => switchProfile(choice, { accountId, ...options }),
    [accountId],
  );
  return useMemo<ProfileView>(() => {
    const { profiles, invites, enabled } = list.data;
    const profile = key === null ? null : (profiles.find((row) => row.key === key) ?? null);
    const label = key === null ? PROFILE_COPY.you : profile ? profileName(profile, account) : '';
    const permissions = key === null ? null : (profile?.permissions ?? []);
    return {
      key,
      acting: key !== null,
      profile,
      label,
      profiles,
      invites,
      enabled,
      settled: list.settled,
      failed: list.failed,
      hasProfiles: key !== null || profiles.length > 0 || invites.length > 0,
      permissions,
      can: (perm) => permissions === null || permissions.includes(perm),
      switchTo,
    };
  }, [key, list.data, list.settled, list.failed, account, switchTo]);
}

/**
 * The page header's small line above the title while the tab works on a shared profile ("Ana's profile"); undefined on
 * the person's own (PageHeader's `eyebrow`; see SHARE-4's handoff for the kit's one-line edit).
 */
export function useProfileEyebrow(): string | undefined {
  const { acting, label } = useProfile();
  return acting && label ? PROFILE_COPY.eyebrow(label) : undefined;
}
