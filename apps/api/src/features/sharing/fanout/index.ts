import type { Feature } from '../../../core/feature';
import { PROFILES_ACTING } from './acting';
import { createProfilesRouter } from './router';

// v34 FANOUT (PLAN G1, G2, G3): one action on several profiles, /api/profiles (router.ts; every route `self`: acting.ts).
// The module map:
// - targets.ts: the targets ('me', keys, 'all'), each checked through core/auth/grants.ts; fanOut / runOn run the work
//   once per target (A's own first) and answer per profile; a key A may not use answers as an unknown key; each
//   shared profile's call is counted in its activity;
// - jobs.ts: save jobs, Save all (and its preview), add by link, copy saved jobs, where each job is saved;
// - bulk.ts: the Tracker's All profiles bulk (a move, Archive, Restore, Prepare & Queue), each card on its own profile;
// - settings.ts: the Prepare filters, the Prepare settings and the Auto-save rule on several profiles, and the Profiles
//   page's summary.
// The shared contracts are @tailorit/shared/sharing's fanout.ts. MCP (v34 MCPFAN) calls the services below directly,
// with its own options (via 'mcp', its tool's name as the action, the `mcp` box on each grant).
export { bulkOnProfiles, BULK_PERMISSION, type BulkOnTarget, type BulkPayers } from './bulk';
export {
  addByLinkOnProfiles,
  copySavedJobs,
  saveAllOnProfiles,
  saveAllPreviewOnProfiles,
  saveJobsOn,
  saveJobsOnProfiles,
  savedOnProfiles,
  type SavedOnTarget,
} from './jobs';
export { autoSaveRuleOnProfiles, filtersOnProfiles, prepareSettingsOnProfiles, settingsSummary, type SettingsSummaryOptions } from './settings';
export {
  countOn,
  fanOut,
  fanoutTargetsMax,
  isTarget,
  lockGrantIn,
  refusedAsUnknown,
  resolveTargets,
  runOn,
  targetHolds,
  type FanoutActor,
  type FanoutAnswer,
  type FanoutOptions,
  type FanoutOutcome,
  type FanoutResolved,
  type FanoutTarget,
  type RunOptions,
} from './targets';

export const profilesFeature: Feature = {
  name: 'profiles',
  routes: [{ path: '/api/profiles', router: createProfilesRouter, acting: PROFILES_ACTING }],
};
