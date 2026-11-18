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
import { api } from '../../lib/api';

// v2.0: Prepare & Queue's session routes (docs/design/v2.0/05-prepare-flow.md), as the Auto-apply page, the Tracker's
// "Prepare & Queue jobs" and its "Prepared" tab use them. Settings › Prepare & Queue (P8) can read and save the same
// settings through fetchPrepareSettings / savePrepareSettings under prepareKeys.settings.

export const prepareKeys = {
  all: ['prepare'] as const,
  settings: ['prepare', 'settings'] as const,
  drafts: ['prepare', 'draft'] as const,
  draft: (applicationId: string) => ['prepare', 'draft', applicationId] as const,
};

/** POST /api/prepare: Prepare & Queue the saved jobs (Tracker entries), each once. 202 with each job's outcome. */
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

/** GET /api/applications/:id/draft: the application's kit (the Tracker's "Prepared" tab). */
export function fetchApplicationDraft(applicationId: string, signal?: AbortSignal) {
  return api.get<ApplicationDraftResponse>(`/api/applications/${encodeURIComponent(applicationId)}/draft`, {
    signal,
    schema: ApplicationDraftResponseSchema,
  });
}
