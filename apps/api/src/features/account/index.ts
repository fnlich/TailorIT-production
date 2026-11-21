import type { Feature } from '../../core/feature';
import { ACCOUNT_DAILY } from './housekeeping';
import { ACCOUNT_ACTING, PUBLIC_CONSTANTS_ACTING } from './acting'; // v33 SHARE-1, SHARE-3: ACCOUNT_ACTING
import { createAccountRouter, createPublicConstantsRouter } from './router';

// v2.0 (P6b; docs/design/v2.0/04-accounts-limits.md, 02-constants.md, 01-data-model.md "Retention and housekeeping"):
// GET /api/account, the person's account summary (never the AI budget, the spend or the server's state); GET
// /api/constants/public, the constants the web shows; and the daily housekeeping (v30 ST4: Feature.daily steps).
export const accountFeature: Feature = {
  name: 'account',
  routes: [
    { path: '/api/account', router: createAccountRouter, acting: ACCOUNT_ACTING /* v33 SHARE-3 */ },
    { path: '/api/constants', router: createPublicConstantsRouter, acting: PUBLIC_CONSTANTS_ACTING /* v33 SHARE-1 */ },
  ],
  daily: ACCOUNT_DAILY,
};
