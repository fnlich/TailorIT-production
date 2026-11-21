import type { ActingSpec } from '../../core/feature';

// v33 SHARE-1 (PLAN F9 "Per-person, self"; SP v33 PLAN-sharing.md §3, §4): the bell and the header are the signed-in
// person's own wherever they work. A tab acting on A's profile reads B's notifications, B's switches (Settings ›
// Notifications) and B's header summary (B's usage chip: B pays); A's notifications and A's switches are never read or
// changed through a shared profile.

/** /api/notifications: the list, the count, marks read, the switches. */
export const NOTIFICATIONS_ACTING: ActingSpec = 'self';

/** /api/me/header: the header's summary (polled by every page). */
export const HEADER_ACTING: ActingSpec = 'self';
