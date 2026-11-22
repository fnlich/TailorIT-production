import type { DailyStep, Feature } from '../../core/feature';
import { ACCOUNT_DELETION_ACTING } from './acting';
import { removeOrphanFiles } from './files';
import { createAccountDeletionRouter } from './router';
import { finishDeletions } from './service';

// v34 ACCTDEL (PLAN G10): deleting an account. The person's own route (POST /api/account/delete, Settings › Account ›
// Delete my account) is here; an administrator's (POST /api/admin/users/:id/delete, Admin › Users) is admin-users',
// on the same service (./service.ts deleteAccount). The daily steps (the first pass runs at start: the boot step) finish
// the deletions that stopped part way (an account left off with its request), then remove the files a deletion could
// not (./files.ts).
export {
  deleteAccount,
  DELETED_FIRST,
  deletionRequestOf,
  finishDeletions,
  UNLINKED_PERSON_COLUMNS,
  type AccountDeleted,
  type DeletedVia,
} from './service';

/** The daily step that finishes the deletions that stopped part way (service.ts finishDeletions). */
export const finishDeletionsStep: DailyStep = { name: 'finishDeletions', run: finishDeletions };

export const accountDeletionFeature: Feature = {
  name: 'account-deletion',
  routes: [{ path: '/api/account/delete', router: createAccountDeletionRouter, acting: ACCOUNT_DELETION_ACTING }],
  daily: [finishDeletionsStep, removeOrphanFiles],
};
