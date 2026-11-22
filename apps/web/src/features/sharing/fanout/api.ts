import {
  FanoutAddJobAnswerSchema,
  FanoutAutoSaveRuleAnswerSchema,
  FanoutBulkAnswerSchema,
  FanoutCopySavedAnswerSchema,
  FanoutFiltersAnswerSchema,
  FanoutPrepareSettingsAnswerSchema,
  FanoutSaveAllAnswerSchema,
  FanoutSaveAllPreviewAnswerSchema,
  FanoutSaveJobsAnswerSchema,
  FanoutSavedOnSchema,
  FanoutSettingsSummarySchema,
  PROFILE_SELF,
  type AutoSaveRulePatch,
  type FanoutAddJobAnswer,
  type FanoutAutoSaveRuleAnswer,
  type FanoutBulkAnswer,
  type FanoutBulkBody,
  type FanoutCopySavedAnswer,
  type FanoutFiltersAnswer,
  type FanoutItem,
  type FanoutPrepareSettingsAnswer,
  type FanoutSaveAllAnswer,
  type FanoutSaveAllPreviewAnswer,
  type FanoutSaveJobsAnswer,
  type FanoutSavedOn,
  type FanoutSettingsPart,
  type FanoutSettingsSummary,
  type FanoutTargets,
  type PrepareFiltersPatch,
} from '@tailorit/shared/sharing';
import type { JobAddDetails } from '@tailorit/shared';
import type { PrepareSettingsBody } from '@tailorit/shared/prepare';
// Relative, not '@/': the web tests read these.
import { api } from '../../../lib/api';

// v34 FANWEB (PLAN G2-G4; SP v34 build FANOUT.md "Contracts"): the web's calls to FANOUT's routes under /api/profiles,
// one request for an action on several profiles, answered per profile ({results, left}). Each route is `self`: it is
// always the signed-in person's, whatever profile the tab works on, and `'me'` is ALWAYS that person (a tab working on
// Ana's profile names Ana's key for "this profile"). So every call here names no profile (`profile: 'me'`: apiFetch
// sends no profile header), and a refused profile is only ever a per-profile result, never the shell's "profile ended".
//   POST  /api/profiles/jobs/save                → FanoutSaveJobsAnswer
//   GET   /api/profiles/jobs/save-all/preview    → FanoutSaveAllPreviewAnswer
//   POST  /api/profiles/jobs/save-all            → FanoutSaveAllAnswer
//   POST  /api/profiles/jobs/add                 → FanoutAddJobAnswer
//   GET   /api/profiles/jobs/saved-on?jobIds=    → FanoutSavedOn
//   POST  /api/profiles/applications/copy        → FanoutCopySavedAnswer
//   POST  /api/profiles/applications/bulk        → FanoutBulkAnswer
//   PATCH /api/profiles/prepare/filters          → FanoutFiltersAnswer
//   PATCH /api/profiles/prepare/settings         → FanoutPrepareSettingsAnswer
//   PATCH /api/profiles/auto-apply/rule          → FanoutAutoSaveRuleAnswer
//   GET   /api/profiles/settings?targets=&parts= → FanoutSettingsSummary

/** The person's own route: no profile header (see above). */
const OWN = { profile: PROFILE_SELF } as const;

/** React Query keys. Saved-on sits under 'jobs' (every Jobs refresh reaches it); the summary under 'sharing'. */
export const fanoutKeys = {
  savedOnAll: ['jobs', 'saved-on'] as const,
  savedOn: (ids: readonly number[]) => ['jobs', 'saved-on', ids.join(',')] as const,
  settings: (parts: readonly FanoutSettingsPart[]) => ['sharing', 'fanout-settings', parts.join(',')] as const,
  settingsAll: ['sharing', 'fanout-settings'] as const,
};

/** A target list as a query parameter: `all`, or `me,pKey...`. */
export function targetsParam(targets: FanoutTargets): string {
  return targets === 'all' ? 'all' : targets.join(',');
}

export function saveJobsTo(targets: FanoutTargets, jobIds: readonly number[], occurredOn: string): Promise<FanoutSaveJobsAnswer> {
  return api.post('/api/profiles/jobs/save', { targets, jobIds: [...jobIds], occurredOn }, { ...OWN, schema: FanoutSaveJobsAnswerSchema });
}

export function previewSaveAllOn(targets: FanoutTargets, search: string, signal?: AbortSignal): Promise<FanoutSaveAllPreviewAnswer> {
  return api.get('/api/profiles/jobs/save-all/preview', {
    ...OWN,
    signal,
    query: { targets: targetsParam(targets), search },
    schema: FanoutSaveAllPreviewAnswerSchema,
  });
}

export function saveAllTo(targets: FanoutTargets, search: string, occurredOn: string): Promise<FanoutSaveAllAnswer> {
  return api.post('/api/profiles/jobs/save-all', { targets, search, occurredOn }, { ...OWN, schema: FanoutSaveAllAnswerSchema });
}

export function addJobTo(targets: FanoutTargets, url: string, details?: JobAddDetails): Promise<FanoutAddJobAnswer> {
  return api.post('/api/profiles/jobs/add', { targets, url, ...(details ? { details } : {}) }, { ...OWN, schema: FanoutAddJobAnswerSchema });
}

export function fetchSavedOn(jobIds: readonly number[], signal?: AbortSignal): Promise<FanoutSavedOn> {
  return api.get('/api/profiles/jobs/saved-on', { ...OWN, signal, query: { jobIds: jobIds.join(',') }, schema: FanoutSavedOnSchema });
}

export function copySavedTo(items: readonly FanoutItem[], targets: FanoutTargets, occurredOn: string): Promise<FanoutCopySavedAnswer> {
  return api.post('/api/profiles/applications/copy', { items: [...items], targets, occurredOn }, { ...OWN, schema: FanoutCopySavedAnswerSchema });
}

export function bulkOnProfiles(body: FanoutBulkBody): Promise<FanoutBulkAnswer> {
  return api.post('/api/profiles/applications/bulk', body, { ...OWN, schema: FanoutBulkAnswerSchema });
}

export function patchFiltersOn(targets: FanoutTargets, filters: PrepareFiltersPatch): Promise<FanoutFiltersAnswer> {
  return api.patch('/api/profiles/prepare/filters', { targets, filters }, { ...OWN, schema: FanoutFiltersAnswerSchema });
}

export function patchPrepareSettingsOn(targets: FanoutTargets, settings: PrepareSettingsBody): Promise<FanoutPrepareSettingsAnswer> {
  return api.patch('/api/profiles/prepare/settings', { targets, settings }, { ...OWN, schema: FanoutPrepareSettingsAnswerSchema });
}

export function patchRuleOn(targets: FanoutTargets, rule: AutoSaveRulePatch): Promise<FanoutAutoSaveRuleAnswer> {
  return api.patch('/api/profiles/auto-apply/rule', { targets, rule }, { ...OWN, schema: FanoutAutoSaveRuleAnswerSchema });
}

export function fetchSettingsSummary(parts: readonly FanoutSettingsPart[], signal?: AbortSignal): Promise<FanoutSettingsSummary> {
  return api.get('/api/profiles/settings', { ...OWN, signal, query: { targets: 'all', parts: parts.join(',') }, schema: FanoutSettingsSummarySchema });
}
