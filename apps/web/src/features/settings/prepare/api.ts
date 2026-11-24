import {
  PrepareFiltersPreviewSchema,
  PrepareFiltersResponseSchema,
  type PrepareFilters,
  type PrepareFiltersPreview,
  type PrepareFiltersResponse,
} from '@tailorit/shared/filters';
import {
  PrepareSettingsSchema,
  type PrepareSettings,
  type PrepareSettingsBody,
} from '@tailorit/shared/prepare';
import {
  PROFILE_SELF,
  PrepareFiltersPatchResponseSchema,
  type PrepareFiltersPatch,
  type PrepareFiltersPatchResponse,
} from '@tailorit/shared/sharing';
// Relative, not '@/': the web tests read these.
import { api } from '../../../lib/api';
import { prepareKeys } from '../../prepare/api';

// v2.0: Settings › Prepare's routes (docs/design/v2.0/05-prepare-flow.md, "Settings"; 06-filters-analysis.md,
// "The filter routes"). Their keys sit under ['prepare'], so whatever marks Prepare's reads stale reads these again.

export const prepareSettingsKeys = {
  /**
   * P7's prepareKeys.settings itself (features/prepare/api.ts, v2.0 INT): a save here is set there at once, so the
   * Prepare confirm sees "Ask before using AI" and the modes without a read.
   */
  settings: prepareKeys.settings,
  filters: ['prepare', 'filters'] as const,
  /** v34 FANWEB: the signed-in person's own filters, whatever profile the tab works on (Change filters for all profiles). */
  ownFilters: ['prepare', 'filters', 'own'] as const,
  preview: (filters: PrepareFilters) => ['prepare', 'filters', 'preview', filters] as const,
};

/** GET /api/prepare/settings: the letter mode, the resume mode (A29) and the confirm's "Don't show this again". */
export function fetchPrepareSettings(signal?: AbortSignal): Promise<PrepareSettings> {
  return api.get<PrepareSettings>('/api/prepare/settings', { signal, schema: PrepareSettingsSchema });
}

/** PUT /api/prepare/settings: the fields given, answered as saved. */
export function savePrepareSettings(body: PrepareSettingsBody): Promise<PrepareSettings> {
  return api.put<PrepareSettings>('/api/prepare/settings', body, { schema: PrepareSettingsSchema });
}

/** GET /api/prepare/filters: the saved filters, and whether the person's location and time zone are known. */
export function fetchPrepareFilters(signal?: AbortSignal): Promise<PrepareFiltersResponse> {
  return api.get<PrepareFiltersResponse>('/api/prepare/filters', { signal, schema: PrepareFiltersResponseSchema });
}

/** v34 FANWEB: the person's own filters (no profile header), for the form over every profile. */
export function fetchOwnPrepareFilters(signal?: AbortSignal): Promise<PrepareFiltersResponse> {
  return api.get<PrepareFiltersResponse>('/api/prepare/filters', { signal, profile: PROFILE_SELF, schema: PrepareFiltersResponseSchema });
}

/**
 * v34 FANWEB (PLAN G3; FANOUT's PATCH): only the filters given change, on the tab's profile. The answer names what was
 * applied and the eligibility switches kept (no Sensitive answers' Change there); the filters as saved come back only
 * with Prepare's See there.
 */
export function patchPrepareFilters(filters: PrepareFiltersPatch): Promise<PrepareFiltersPatchResponse> {
  return api.patch<PrepareFiltersPatchResponse>('/api/prepare/filters', { filters }, { schema: PrepareFiltersPatchResponseSchema });
}

/** PUT /api/prepare/filters: saved whole. */
export function savePrepareFilters(filters: PrepareFilters): Promise<PrepareFiltersResponse> {
  return api.put<PrepareFiltersResponse>('/api/prepare/filters', { filters }, { schema: PrepareFiltersResponseSchema });
}

/** POST /api/prepare/filters/preview: how many saved jobs these filters let through (no AI, nothing saved). */
export function previewPrepareFilters(filters: PrepareFilters, signal?: AbortSignal): Promise<PrepareFiltersPreview> {
  return api.post<PrepareFiltersPreview>('/api/prepare/filters/preview', { filters }, { signal, schema: PrepareFiltersPreviewSchema });
}
