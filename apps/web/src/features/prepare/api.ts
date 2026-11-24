import {
  ApplicationDraftResponseSchema,
  PrepareAllPlanSchema,
  PrepareAllResponseSchema,
  PrepareJobSchema,
  PrepareSettingsSchema,
  PrepareStartResponseSchema,
  type ApplicationDraftResponse,
  type PrepareAllPlan,
  type PrepareAllResponse,
  type PrepareJob,
  type PrepareSettings,
  type PrepareSettingsBody,
  type PrepareStartResponse,
} from '@tailorit/shared/prepare';
import { PROFILE_SELF, type ProfileKey } from '@tailorit/shared/sharing';
import { api } from '../../lib/api';

// v2.0: Prepare's session routes (docs/design/v2.0/05-prepare-flow.md), as the Auto-apply page, the Tracker's
// "Prepare jobs" and its "Prepared" tab use them. Settings › Prepare (P8) can read and save the same
// settings through fetchPrepareSettings / savePrepareSettings under prepareKeys.settings.

export const prepareKeys = {
  all: ['prepare'] as const,
  settings: ['prepare', 'settings'] as const,
  /**
   * v34 FIX-WEB (final review share M1): the signed-in person's OWN Prepare settings, read in a document that works on a
   * profile someone shared (its `settings` are that owner's). See ownPrepareSettingsKey.
   */
  ownSettings: ['prepare', 'settings', 'own'] as const,
  drafts: ['prepare', 'draft'] as const,
  draft: (applicationId: string) => ['prepare', 'draft', applicationId] as const,
};

/** POST /api/prepare: Prepare the saved jobs (Tracker entries), each once. 202 with each job's outcome. */
export function startPrepare(applicationIds: readonly string[], rebuild = false) {
  return api.post<PrepareStartResponse>(
    '/api/prepare',
    { applicationIds, ...(rebuild ? { rebuild: true } : {}) },
    { schema: PrepareStartResponseSchema },
  );
}

/** v31 AUTO (D10): GET /api/prepare/all, what Prepare All would take now and today's AI use (nothing starts). */
export function fetchPrepareAllPlan(signal?: AbortSignal) {
  return api.get<PrepareAllPlan>('/api/prepare/all', { signal, schema: PrepareAllPlanSchema });
}

/**
 * v31 AUTO (D10): POST /api/prepare/all, every saved job in To prepare that passes the filters (the server chooses).
 * v31 FIX-AUTH (BEH-8): of the jobs the confirm named (its plan's applicationIds) only.
 */
export function startPrepareAll(applicationIds: readonly string[]) {
  return api.post<PrepareAllResponse>('/api/prepare/all', { applicationIds }, { schema: PrepareAllResponseSchema });
}

/** POST /api/prepare/:id/cancel: a waiting Prepare ends at once; an active one when the runner sees it. */
export function cancelPrepare(prepareId: string) {
  return api.post<PrepareJob>(`/api/prepare/${encodeURIComponent(prepareId)}/cancel`, {}, { schema: PrepareJobSchema });
}

/** GET /api/prepare/settings: the letter mode, the resume mode and the confirm's "Don't show this again". */
export function fetchPrepareSettings(signal?: AbortSignal) {
  return api.get<PrepareSettings>('/api/prepare/settings', { signal, schema: PrepareSettingsSchema });
}

/** PUT /api/prepare/settings: any of the fields (the confirm sends `{skipConfirm: true}` alone). */
export function savePrepareSettings(body: PrepareSettingsBody) {
  return api.put<PrepareSettings>('/api/prepare/settings', body, { schema: PrepareSettingsSchema });
}

// v34 FIX-WEB (final review share M1, decided: the payer's own) -------------------------------------------------------
// "Ask before using AI" (skipConfirm) is the PAYER's: whoever starts a Prepare pays for it with their AI use, on their
// own profile and on any profile shared with them, so whether they are asked first is their own setting, never the
// profile owner's. The confirm reads it, and "Don't show this again" saves it, on the person's own profile ('me': no
// profile header), whatever profile the tab works on: the fourth exception to "every /api request names its page's
// profile" (after /api/auth/*, /api/profiles/* and the own-filters read of the form over every profile). The server
// never writes it on someone else's profile (FIX-API).

/** GET /api/prepare/settings on the person's own profile ('me'), whatever profile the tab works on. */
export function fetchOwnPrepareSettings(signal?: AbortSignal) {
  return api.get<PrepareSettings>('/api/prepare/settings', { signal, profile: PROFILE_SELF, schema: PrepareSettingsSchema });
}

/** PUT /api/prepare/settings on the person's own profile ('me'): the confirm's `{skipConfirm}`. */
export function saveOwnPrepareSettings(body: PrepareSettingsBody) {
  return api.put<PrepareSettings>('/api/prepare/settings', body, { profile: PROFILE_SELF, schema: PrepareSettingsSchema });
}

/**
 * Where the person's own Prepare settings sit in this document's cache: on their own profile the tab's settings key (so
 * Settings › Prepare and the confirm share one copy), on a shared profile `ownSettings` (the tab's key holds the
 * owner's). A document's profile never changes (lib/profile.ts), so the key is fixed for its life.
 */
export function ownPrepareSettingsKey(documentProfile: ProfileKey | null): readonly string[] {
  return documentProfile === null ? prepareKeys.settings : prepareKeys.ownSettings;
}

/** GET /api/applications/:id/draft: the application's kit (the Tracker's "Prepared" tab). */
export function fetchApplicationDraft(applicationId: string, signal?: AbortSignal) {
  return api.get<ApplicationDraftResponse>(`/api/applications/${encodeURIComponent(applicationId)}/draft`, {
    signal,
    schema: ApplicationDraftResponseSchema,
  });
}
