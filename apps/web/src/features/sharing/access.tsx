'use client';

import type { ProfileKey, SharedProfile, SharePermission } from '@tailorit/shared/sharing';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
// Relative, not '@/': the web tests draw these views.
import {
  SHARING_PROFILES_QUERY_KEY,
  fetchSharedProfiles,
  useDocumentProfile,
  type ProfileView,
} from '../../components/shell/profile/useProfile';
import { LockSimpleIcon } from '../../components/ui/icons';
import { isProfileRefusal } from '../../lib/api';

// v33 SHARE-7 (PLAN F9 "Acting", SP v33 PLAN-sharing.md §9 "Permission-aware UI"): what a page part may do on the tab's
// profile. On the person's own profile everything; on a shared one what its owner ticked (useProfile().can), and
// nothing until the list of profiles is read. A part the owner did not share is not asked for at all and says "Not
// shared with you." in its place; a GET refused anyway (the owner changed the boxes meanwhile) says the same.
// Change controls are disabled or hidden without the Change box. The page computes it (useProfile) and hands it down,
// so the parts still draw without the shell (the tests).

export interface ProfileAccess {
  /** The tab works on a profile shared with the person. */
  acting: boolean;
  /** The boxes are known (always on the person's own profile). */
  ready: boolean;
  /** The part may be read. */
  see: boolean;
  /** The part may be changed. */
  change: boolean;
  /** The profile's owner as the switcher names them (null on the person's own, or before the list is read). */
  owner: string | null;
}

/** The person's own profile: everything. */
export const OWN_ACCESS: ProfileAccess = { acting: false, ready: true, see: true, change: true, owner: null };

/** What a part needing `see` to read and `change` to change may do on the tab's profile. */
export function accessOf(
  view: Pick<ProfileView, 'acting' | 'settled' | 'can' | 'profile' | 'label'>,
  see: SharePermission,
  change?: SharePermission,
): ProfileAccess {
  if (!view.acting) return OWN_ACCESS;
  const ready = view.settled;
  return {
    acting: true,
    ready,
    see: ready && view.can(see),
    change: ready && change !== undefined && view.can(change),
    owner: view.profile ? view.label : null,
  };
}

/** Whether a read was refused because of the shared profile (show "Not shared with you." there). */
export const refusedRead = (error: unknown): boolean => isProfileRefusal(error);

/** The tab's shared profile and its owner's name, for parts drawn without the signed-in account (the tests). */
export interface TabProfile {
  /** Null on the person's own profile. */
  key: ProfileKey | null;
  /** The shared profile's row once the shell's list is read (it reads it; this only follows it). */
  profile: SharedProfile | null;
  /** The owner's name (their email when they set none); null on the person's own, or before the list is read. */
  ownerName: string | null;
}

/**
 * The tab's profile without useAuth: the document's key, and the shell's list of shared profiles as it is in the cache
 * (never asked for here). For parts the tests draw without a signed-in account (the Auto-apply page).
 */
export function useTabProfile(): TabProfile {
  const key = useDocumentProfile();
  const list = useQuery({
    queryKey: SHARING_PROFILES_QUERY_KEY,
    queryFn: ({ signal }) => fetchSharedProfiles(signal),
    enabled: false,
  });
  const profile = key === null ? null : (list.data?.profiles.find((row) => row.key === key) ?? null);
  return { key, profile, ownerName: profile ? profile.name.trim() || profile.email : null };
}

/**
 * v33 FIX-1: whether the tab may do `perm`: always on the person's own profile; on a shared one only what its owner
 * ticked, and nothing before the list of profiles is read. For parts drawn without the signed-in account (the tests):
 * the Jobs page, Documents, the resume editor and the Field select.
 */
export function tabCan(tab: Pick<TabProfile, 'key' | 'profile'>, perm: SharePermission): boolean {
  return tab.key === null || (tab.profile?.permissions.includes(perm) ?? false);
}

/**
 * v33 FIX-2 (final review, sharing 3; a decision for the owner): whether the tab may delete the profile's documents
 * (resumes, cover letters, letter templates): on the person's own profile only. On a shared one Documents' Change edits,
 * uploads, tailors and copies but never deletes, as the Job Tracker's Change archives but never deletes (the API
 * refuses it: own_profile_only).
 */
export function tabDeletes(tab: Pick<TabProfile, 'key'>): boolean {
  return tab.key === null;
}

/** v33 FIX-2: tabDeletes for the editors (without reading the list of shared profiles). */
export function useDeletesDocuments(): boolean {
  return useDocumentProfile() === null;
}

/**
 * v33 FIX-1: whether the tab may change `perm`'s part, for the editors: on the person's own profile always, and
 * without reading the list of shared profiles (so an editor never redraws while its first keystrokes land); on a shared
 * one once its boxes are read (`ready`) and only with the box. The list is asked for on a shared profile only.
 */
export function useChangeAccess(perm: SharePermission): { ready: boolean; change: boolean } {
  const key = useDocumentProfile();
  const allowed = useQuery({
    queryKey: SHARING_PROFILES_QUERY_KEY,
    queryFn: ({ signal }) => fetchSharedProfiles(signal),
    enabled: key !== null,
    staleTime: 60_000,
    retry: false,
    select: (list) => list.profiles.find((row) => row.key === key)?.permissions.includes(perm) ?? false,
  });
  if (key === null) return { ready: true, change: true };
  return { ready: allowed.data !== undefined || allowed.isError, change: allowed.data === true };
}

/** v33 FIX-1: the line beside "Read-only" in an editor on a profile shared without Documents' Change. */
export const SHARED_READ_ONLY_NOTE = "Changing it isn't shared with you. You can still download it.";

export const NOT_SHARED_COPY = {
  title: 'Not shared with you.',
  by: (owner: string) => `${owner} hasn't shared this with you.`,
} as const;

/** "Not shared with you." where a part the owner did not share would be. */
export function NotShared({ owner, className }: { owner?: string | null; className?: string }) {
  return (
    <div
      role="status"
      className={clsx('flex items-start gap-2.5 rounded-control border border-border bg-surface-low px-3.5 py-3 text-sm leading-5', className)}
      data-not-shared=""
    >
      <LockSimpleIcon size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0">
        <span className="font-medium text-foreground">{NOT_SHARED_COPY.title}</span>
        {owner ? <span className="text-muted-foreground">{` ${NOT_SHARED_COPY.by(owner)}`}</span> : null}
      </p>
    </div>
  );
}
