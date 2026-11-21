import type { Feature } from '../../core/feature';
import { SHARING_ACTING } from './acting';
import { ACTIVITY_FLUSH_EVERY_MS, createActivityService, flushActivity, pruneActivity } from './activity';
import { createSharingRouter } from './router';
import { startSweep } from './sweep';

// v33 SHARE-2 (PLAN F9 "Shared profiles"; SP v33 PLAN-sharing.md §2, §6, §8, §10): the sharing API. A person (A, the
// owner) shares their profile with another account (B, the grantee): A invites B's address with the boxes ticked
// (@tailorit/shared/sharing permissions), B accepts or declines, A changes the boxes or the end date, A stops or B leaves,
// the hourly sweep ends what passed its date. The module map:
// - router.ts: /api/sharing (reads `self`, writes `never`: ./acting.ts);
// - grants.ts: A's side (list, invite, change, stop); invites.ts: B's side (profiles, invites, accept, decline, leave)
//   and the header's invite count with its lazy notice (features/notifications/header.ts);
// - end-grant.ts: endGrant, the steps that stop a grant's work, registered by the features that own the work
//   (registerEndGrantStep), and endGrantsOfAccount (the admin's disable, features/admin-users/router.ts);
// - sweep.ts: the hourly sweep; activity.ts: the activity's counts (flushed every minute and at shutdown), the guard's
//   trackActingRequest, the retention, the reads; overview.ts: every profile at once; notices.ts: the notifications.
// Whether a grant is live is core/auth/grants.ts's (the one predicate); this feature is the one other module that reads
// profile_grants, and the only one that writes it.
export { endGrant, endGrantsOfAccount, endGrantStepNames, registerEndGrantStep, END_GRANT_STEP_ORDER } from './end-grant';
export type { EndGrantCause, EndGrantResult, EndGrantScope, EndGrantStepFn, EndGrantStepName } from './end-grant';
export { areaOfPermission, countActivity, flushActivity, trackActingRequest, type ActivityEvent } from './activity';
export { headerInviteParams, noticeInvites } from './invites';
export { HEADER_INVITE_COLUMNS } from './header-sql';
export { runSharingSweep } from './sweep';

export const sharingFeature: Feature = {
  name: 'sharing',
  services: (deps) => {
    deps.services.sharingActivity = createActivityService();
  },
  routes: [{ path: '/api/sharing', router: createSharingRouter, acting: SHARING_ACTING }],
  daily: [pruneActivity],
  // The hourly sweep, and the activity's minute flush (and a last one at shutdown).
  start: (deps) => {
    const stopSweep = startSweep(deps);
    const timer = setInterval(() => void flushActivity(deps), ACTIVITY_FLUSH_EVERY_MS);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      stopSweep();
      await flushActivity(deps);
    };
  },
};
