import {
  AutofillAgentClearedSchema,
  AutofillAgentSettingsSchema,
  type AutofillAgentCleared,
  type AutofillAgentSettings,
} from '@tailorit/shared/autofill';
import { PrepareFiltersResponseSchema, type PrepareFiltersResponse } from '@tailorit/shared/filters';
import {
  PreparedKitSchema,
  QueuePaneSchema,
  SavedJobListSchema,
  type PreparedKit,
  type QueuePane,
  type SavedJobFilter,
  type SavedJobList,
} from '@tailorit/shared/prepare';
import { api } from '../../lib/api';

// v2.0: the Auto-apply page's session routes (docs/design/v2.0/05-prepare-flow.md, "Read models for the web"): the
// Saved Jobs pane, the Queue pane, a queue row's copy-ready kit, Mark as applied, Remove and Clear finished, the
// prepare filters' count and the rule's settings. The extension's worker takes and reports jobs with its own token,
// never through these. No route here queues a job: only Prepare & Queue does (features/prepare).

export const autoApplyKeys = {
  all: ['auto-apply'] as const,
  saved: (filter: SavedJobFilter) => ['auto-apply', 'saved', filter] as const,
  savedAll: ['auto-apply', 'saved'] as const,
  queue: ['auto-apply', 'queue'] as const,
  kit: (queueId: string) => ['auto-apply', 'kit', queueId] as const,
  settings: ['auto-apply', 'settings'] as const,
  filters: ['auto-apply', 'filters'] as const,
};

/** GET /api/auto-apply/saved: one page of the saved jobs, newest first, each with its marker. */
export function fetchSavedJobs(filter: SavedJobFilter, cursor: string | undefined, signal?: AbortSignal) {
  return api.get<SavedJobList>('/api/auto-apply/saved', {
    query: { filter, cursor, limit: 50 },
    signal,
    schema: SavedJobListSchema,
  });
}

/** GET /api/auto-apply/queue: the active and failed Prepares, the queue rows in the extension's order, the usage. */
export function fetchQueuePane(signal?: AbortSignal) {
  return api.get<QueuePane>('/api/auto-apply/queue', { query: { limit: 100 }, signal, schema: QueuePaneSchema });
}

/** GET /api/auto-apply/items/:queueId/kit: the manual flow's resume, letter and answers. */
export function fetchKit(queueId: string, signal?: AbortSignal) {
  return api.get<PreparedKit>(`/api/auto-apply/items/${encodeURIComponent(queueId)}/kit`, { signal, schema: PreparedKitSchema });
}

/** POST /api/autofill/agent/queue/:id/applied: Mark as applied (by hand; never counts toward the daily limit). */
export function markApplied(queueId: string) {
  return api.post<void>(`/api/autofill/agent/queue/${encodeURIComponent(queueId)}/applied`, {});
}

/** DELETE /api/autofill/agent/queue/:id */
export function removeQueueItem(queueId: string) {
  return api.delete<void>(`/api/autofill/agent/queue/${encodeURIComponent(queueId)}`);
}

/** POST /api/autofill/agent/queue/clear-finished: removes the submitted, skipped, needs-you and failed rows. */
export function clearFinished() {
  return api.post<AutofillAgentCleared>('/api/autofill/agent/queue/clear-finished', {}, { schema: AutofillAgentClearedSchema });
}

/** GET /api/prepare/filters: the saved prepare filters (the Saved pane's "Filters" count). */
export function fetchPrepareFilters(signal?: AbortSignal) {
  return api.get<PrepareFiltersResponse>('/api/prepare/filters', { signal, schema: PrepareFiltersResponseSchema });
}

/** GET /api/autofill/agent/settings: the rule, off until turned on. */
export function fetchAgentSettings(signal?: AbortSignal) {
  return api.get<AutofillAgentSettings>('/api/autofill/agent/settings', { signal, schema: AutofillAgentSettingsSchema });
}

/** PUT /api/autofill/agent/settings */
export function saveAgentSettings(settings: AutofillAgentSettings) {
  return api.put<AutofillAgentSettings>('/api/autofill/agent/settings', settings, { schema: AutofillAgentSettingsSchema });
}
