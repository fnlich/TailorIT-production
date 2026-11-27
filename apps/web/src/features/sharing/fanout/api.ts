import {
  FanoutAddJobAnswerSchema,
  FanoutAutoSaveRuleAnswerSchema,
  FanoutBulkAnswerSchema,
  FanoutCopySavedAnswerSchema,
  FanoutFiltersAnswerSchema,
  FanoutPrepareSettingsAnswerSchema,
  FanoutSaveJobsAnswerSchema,
  FanoutSavedOnSchema,
  FanoutSettingsSummarySchema,
  FanoutUnsaveJobsAnswerSchema, // v36 JOBS
  FanoutShareAllAnswerSchema, // v36 APPLYWEB
  FanoutShareAllPreviewAnswerSchema, // v36 APPLYWEB
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
  type FanoutSaveJobsAnswer,
  type FanoutSavedOn,
  type FanoutSettingsPart,
  type FanoutSettingsSummary,
  type FanoutTargets,
  type FanoutUnsaveJobsAnswer, // v36 JOBS
  type FanoutShareAllAnswer, // v36 APPLYWEB
  type FanoutShareAllPreviewAnswer, // v36 APPLYWEB
  type PrepareFiltersPatch,
  type ProfileChoice,
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
//   POST  /api/profiles/jobs/unsave              → FanoutUnsaveJobsAnswer (v36 JOBS)
//   POST  /api/profiles/jobs/add                 → FanoutAddJobAnswer
//   GET   /api/profiles/jobs/saved-on?jobIds=    → FanoutSavedOn
//   POST  /api/profiles/applications/copy        → FanoutCopySavedAnswer
//   POST  /api/profiles/applications/bulk        → FanoutBulkAnswer
//   PATCH /api/profiles/prepare/filters          → FanoutFiltersAnswer
//   PATCH /api/profiles/prepare/settings         → FanoutPrepareSettingsAnswer
//   PATCH /api/profiles/auto-apply/rule          → FanoutAutoSaveRuleAnswer
//   GET   /api/profiles/settings?targets=&parts= → FanoutSettingsSummary
//   GET   /api/profiles/saved/share-all/preview?source=&targets= → FanoutShareAllPreviewAnswer (v36 APPLYWEB)
//   POST  /api/profiles/saved/share-all          → FanoutShareAllAnswer (v36 APPLYWEB)

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

/** v36 JOBS (PLAN J5): removes the jobs from Saved on `targets` (Job Tracker › Change each; an applied job is left). */
export function unsaveJobsFrom(targets: FanoutTargets, jobIds: readonly number[]): Promise<FanoutUnsaveJobsAnswer> {
  return api.post('/api/profiles/jobs/unsave', { targets, jobIds: [...jobIds] }, { ...OWN, schema: FanoutUnsaveJobsAnswerSchema });
}

/**
 * v36 APPLYWEB (PLAN A3): Share All's preview: per target, what sharing every job in Saved on `source` would do, and the
 * source's entries the start takes (send them back as they are).
 */
export function previewShareAll(source: ProfileChoice, targets: FanoutTargets, signal?: AbortSignal): Promise<FanoutShareAllPreviewAnswer> {
  return api.get('/api/profiles/saved/share-all/preview', {
    ...OWN,
    signal,
    query: { source, targets: targetsParam(targets) },
    schema: FanoutShareAllPreviewAnswerSchema,
  });
}

/** v36 APPLYWEB (PLAN A3): Share All's start: exactly the entries its preview named, from `source` to `targets`. */
export function startShareAll(
  source: ProfileChoice,
  targets: FanoutTargets,
  applicationIds: readonly string[],
  occurredOn: string,
): Promise<FanoutShareAllAnswer> {
  return api.post(
    '/api/profiles/saved/share-all',
    { source, targets, applicationIds: [...applicationIds], occurredOn },
    { ...OWN, schema: FanoutShareAllAnswerSchema },
  );
}

// v38 FIX-APP (SP v38 FIXES-38 D1): `company`, Add job's company step (a posting TailorIT read names none).
export function addJobTo(targets: FanoutTargets, url: string, details?: JobAddDetails, company?: string): Promise<FanoutAddJobAnswer> {
  return api.post(
    '/api/profiles/jobs/add',
    { targets, url, ...(details ? { details } : {}), ...(company ? { company } : {}) },
    { ...OWN, schema: FanoutAddJobAnswerSchema },
  );
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
