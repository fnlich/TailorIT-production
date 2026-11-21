import type { ActingTable } from '../../core/feature';

// v33 SHARE-1 (PLAN F9 "Per-person, self", "Always locked"; SP v33 PLAN-sharing.md §3, §4): /api/me on a shared profile.
// The Job Tracker's lanes are saved per person (migration 0046), so a tab acting on A's profile shows B's own lanes.
// A's name is always locked.
// v33 SHARE-6 (§3 "Job settings": "preferences, Prepare settings, the auto-apply rule and the default resume"; §4
// "Explicit changes"): the owner's preferences are Job settings' See to read and Change to save (a save on a shared
// profile keeps the owner's contact details: router.ts); choosing the owner's default resume is Job settings' Change,
// answered with the resume's id alone (never the owner's account).
export const ME_ACTING: ActingTable = {
  'GET /tracker-lanes': 'self',
  'PUT /tracker-lanes': 'self',
  'PATCH /': 'never',
  'GET /preferences': 'settings:view', // v33 SHARE-6
  'PUT /preferences': 'settings:edit', // v33 SHARE-6
  'PUT /default-resume': 'settings:edit', // v33 SHARE-6
};
