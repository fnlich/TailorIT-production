import { PrepareAllPlanSchema, PrepareAllResponseSchema, type PrepareAllPlan, type PrepareAllResponse } from '@tailorit/shared/prepare';
import {
  GrantCreatedSchema,
  GrantViewSchema,
  SharingActivitySchema,
  SharingGrantsSchema,
  SharingOverviewSchema,
  type GrantCreateBodyInput,
  type GrantCreated,
  type GrantPatchBodyInput,
  type GrantView,
  type ProfileChoice,
  type SharingActivity,
  type SharingGrants,
  type SharingOverview,
} from '@tailorit/shared/sharing';
import type { QueryClient } from '@tanstack/react-query';
// Relative, not '@/': the web tests draw these views.
import { SHARING_PROFILES_QUERY_KEY } from '../../components/shell/profile/useProfile';
import { api } from '../../lib/api';

// v33 SHARE-7 (PLAN F9; SP v33 PLAN-sharing.md §2, §8, §10): the sharing routes the pages call (SHARE-2's, mounted at
// /api/sharing). Reads are `self` (always the signed-in person's own sharing, whichever profile the tab works on);
// writes are `never` while the tab works on a shared profile, and Settings › Sharing only opens on the person's own
// (AuthGate switches the tab back first). The Profiles page also reads and starts Prepare All on each profile with the
// per-call `profile` (SHARE-4's apiFetch), the way the Tracker's All profiles view reads.
//   GET   /api/sharing/grants                → SharingGrants
//   POST  /api/sharing/grants                → 202 GrantCreated (the same answer for every address)
//   PATCH /api/sharing/grants/:key           → GrantView
//   POST  /api/sharing/grants/:key/stop      → 204
//   POST  /api/sharing/profiles/:key/accept | /decline | /leave → 204
//   GET   /api/sharing/activity?cursor&limit → SharingActivity
//   GET   /api/sharing/overview              → SharingOverview

export const sharingKeys = {
  all: ['sharing'] as const,
  grants: ['sharing', 'grants'] as const,
  activity: ['sharing', 'activity'] as const,
  overview: ['sharing', 'overview'] as const,
  /** SHARE-4's list of the profiles shared with the person and their invites (the switcher's). */
  profiles: SHARING_PROFILES_QUERY_KEY,
};

/** The page of activity rows one read asks for. */
export const ACTIVITY_PAGE = 50;

export function fetchGrants(signal?: AbortSignal): Promise<SharingGrants> {
  return api.get<SharingGrants>('/api/sharing/grants', { signal, schema: SharingGrantsSchema });
}

export function createGrant(body: GrantCreateBodyInput): Promise<GrantCreated> {
  return api.post<GrantCreated>('/api/sharing/grants', body, { schema: GrantCreatedSchema });
}

export function changeGrant(key: string, body: GrantPatchBodyInput): Promise<GrantView> {
  return api.patch<GrantView>(`/api/sharing/grants/${encodeURIComponent(key)}`, body, { schema: GrantViewSchema });
}

/** Stops sharing (an active share) or cancels an invite (a pending one). */
export function stopGrant(key: string, removeQueued: boolean): Promise<void> {
  return api.post<void>(`/api/sharing/grants/${encodeURIComponent(key)}/stop`, { removeQueued });
}

export function acceptInvite(key: string): Promise<void> {
  return api.post<void>(`/api/sharing/profiles/${encodeURIComponent(key)}/accept`, {});
}

export function declineInvite(key: string): Promise<void> {
  return api.post<void>(`/api/sharing/profiles/${encodeURIComponent(key)}/decline`, {});
}

export function leaveProfile(key: string): Promise<void> {
  return api.post<void>(`/api/sharing/profiles/${encodeURIComponent(key)}/leave`, {});
}

export function fetchActivity(cursor: string | undefined, signal?: AbortSignal): Promise<SharingActivity> {
  return api.get<SharingActivity>('/api/sharing/activity', {
    query: { cursor, limit: ACTIVITY_PAGE },
    signal,
    schema: SharingActivitySchema,
  });
}

export function fetchOverview(signal?: AbortSignal): Promise<SharingOverview> {
  return api.get<SharingOverview>('/api/sharing/overview', { signal, schema: SharingOverviewSchema });
}

/** GET /api/prepare/all on one profile ('me' or a key): what Prepare All would take there now. */
export function fetchPrepareAllPlanOf(profile: ProfileChoice, signal?: AbortSignal): Promise<PrepareAllPlan> {
  return api.get<PrepareAllPlan>('/api/prepare/all', { signal, profile, schema: PrepareAllPlanSchema });
}

/** POST /api/prepare/all on one profile, of the jobs its plan named. */
export function startPrepareAllOf(profile: ProfileChoice, applicationIds: readonly string[]): Promise<PrepareAllResponse> {
  return api.post<PrepareAllResponse>('/api/prepare/all', { applicationIds }, { profile, schema: PrepareAllResponseSchema });
}

/** After a change to sharing: the lists, the switcher's profiles and the overview read again. */
export function invalidateSharing(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: sharingKeys.all });
}
