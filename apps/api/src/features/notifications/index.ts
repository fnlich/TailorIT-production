import type { Feature } from '../../core/feature';
import { pruneNotifications, startHourlyPass } from './housekeeping';
import { createHeaderRouter, createNotificationsRouter } from './router';

// v3.1 NOTIFY (docs/design/v3.1/24-notifications-usage.md; D8, D9): in-app notifications, their switches, and the
// header's summary. Other features write notifications through the functions exported here, where their events happen:
//   notify(deps, userId, { kind, params?, body?, bodyExtra?, title?, link?, dedupeKey? }) → 'written' | 'skipped' | 'failed'
//   notifyAdmins(deps, { kind, ..., exceptUserId? }) → how many admins got it (-1: failed)
//   notifyJobVerification(deps, { userId, jobId, state, reason }) → NotifyOutcome  (LINK calls it)
//   the event emitters of ./emitters.ts (Prepare, auto-apply, money, extension, ingest, RUNS's pause and continue)
// None of them ever throws or aborts the caller's transaction (service.ts).

export {
  clampText,
  guarded,
  notify,
  notifyAdmins,
  notifyStats,
  NOTIFICATION_WORDS,
  renderNotification,
  safeLink,
  type NotifyDeps,
  type NotifyInput,
  type NotifyOutcome,
} from './service';
export { notifyJobVerification, type JobVerificationEvent, type JobVerificationState } from './jobs';
export {
  notifyAutoApplyResult,
  notifyChargeCrossings,
  notifyExtensionDisconnected,
  notifyPrepareBatch,
  notifyRunFinished,
  notifyRunsControl,
  type ChargeCrossing,
  type RunsControlScope,
} from './emitters';
export { notifyPaidEnding } from './housekeeping';

export const notificationsFeature: Feature = {
  name: 'notifications',
  routes: [
    { path: '/api/notifications', router: createNotificationsRouter },
    // After /api/me (features/me), whose router has no /header: GET /api/me/header falls through to this one.
    { path: '/api/me/header', router: createHeaderRouter },
  ],
  daily: [pruneNotifications],
  // The hourly pass: Review's new items for the admins, extension connections that ran out.
  start: (deps) => startHourlyPass(deps),
};
