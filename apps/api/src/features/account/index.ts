import type { Feature } from '../../core/feature';
import { ACCOUNT_DAILY } from './housekeeping';
import { createAccountRouter, createPublicConstantsRouter } from './router';

// v2.0 (P6b; docs/design/v2.0/04-accounts-limits.md, 02-constants.md, 01-data-model.md "Retention and housekeeping"):
// GET /api/account, the person's account summary (never the AI budget, the spend or the server's state); GET
// /api/constants/public, the constants the web shows; and the daily housekeeping (v30 ST4: Feature.daily steps).
export const accountFeature: Feature = {
  name: 'account',
  routes: [
    { path: '/api/account', router: createAccountRouter },
    { path: '/api/constants', router: createPublicConstantsRouter },
  ],
  daily: ACCOUNT_DAILY,
};
