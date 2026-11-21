import type { AppDeps } from '../../core/context';
import type { Feature } from '../../core/feature';
import { PREPARE_FILTERS_ACTING } from './acting'; // v33 SHARE-5
import { customFilterTask } from './custom';
import { pruneCustomVerdicts } from './housekeeping';
import { createPrepareFiltersRouter } from './router';
import { createPrepareFilterService, type PrepareFilterServiceInternals } from './service';

// v2.0 P4 (06-filters-analysis.md): the prepare filters. `services` puts the PrepareFilterService on
// deps.services.prepareFilters (core/seams.ts); the `custom_filter` AI task is listed on `aiTasks` (v30 ST2: setupServices
// registers it); the routes are the filter settings at /api/prepare/filters (mounted before features/prepare's
// /api/prepare, so they take that path first).

// For other features: a change of what the filters compare with (the person's location, features/me) bumps the filters
// revision, so the stored verdicts are computed again; P3's Saved list reads the labels through resultsOf.
export { touchFilterRevision, ensureUserSettingsRow } from './settings';
export type { PrepareFilterServiceInternals } from './service';

const services = new WeakMap<AppDeps, PrepareFilterServiceInternals>();

/** v3.0 D2-F: the async prepare filter service of these deps (the routes, prepare, the tests). */
export function serviceOf(deps: AppDeps): PrepareFilterServiceInternals {
  let service = services.get(deps);
  if (!service) {
    service = createPrepareFilterService(deps);
    services.set(deps, service);
  }
  return service;
}

export const prepareFiltersFeature: Feature = {
  name: 'prepare-filters',
  services(deps) {
    deps.services.prepareFilters = serviceOf(deps);
  },
  aiTasks: [customFilterTask],
  routes: [
    {
      path: '/api/prepare/filters',
      router: (deps) => createPrepareFiltersRouter(deps, serviceOf(deps)),
      acting: PREPARE_FILTERS_ACTING, // v33 SHARE-5
    },
  ],
  // v30 INT-0: old Custom filter verdicts pruned (housekeeping.ts).
  daily: [pruneCustomVerdicts],
};
