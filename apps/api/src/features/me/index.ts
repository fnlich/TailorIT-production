import type { Feature } from '../../core/feature';
import { ME_ACTING } from './acting'; // v33 SHARE-1
import { createMeRouter } from './router';

// The signed-in account: name, preferences, default resume. Owned by work package F3.
export const meFeature: Feature = {
  name: 'me',
  routes: [
    { path: '/api/me', router: createMeRouter, acting: ME_ACTING /* v33 SHARE-1 */ },
  ],
};
