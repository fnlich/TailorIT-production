import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9 "Per-person, self", "Always locked"; SP v33 PLAN-sharing.md §3): the announcement banner is the
// signed-in person's own wherever they work (what TailorIT tells everyone, and what they dismissed: their own rows), so a
// tab acting on a shared profile reads and dismisses the person's own. Writing announcements is Admin's: never.

/** /api/announcements: the banner and its Dismiss. */
export const ANNOUNCEMENTS_ACTING: ActingSpec = 'self';

/** /api/admin/announcements: Admin › Announcements. */
export const ADMIN_ANNOUNCEMENTS_ACTING: ActingSpec = 'never';
