import type { Feature } from '../../core/feature';
import { APPLICATIONS_ACTING } from './acting'; // v33 SHARE-9
import { createApplicationsRouter } from './router';

// Job tracker applications. Owned by work package T.
export const applicationsFeature: Feature = {
  name: 'applications',
  routes: [
    { path: '/api/applications', router: createApplicationsRouter, acting: APPLICATIONS_ACTING /* v33 SHARE-9 */ },
  ],
};
