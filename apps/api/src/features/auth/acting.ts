import type { ActingSpec } from '../../core/feature';

// v33 SHARE-1 (PLAN F9 "Per-person, self"; SP v33 PLAN-sharing.md §3, §4): what /api/auth does when a request names a
// shared profile. Signing in, signing out and "who am I" always serve the signed-in person (B), never the profile they
// work on: a tab that acts on A's profile still signs B out, and GET /me answers B's own account. (The web never sends
// the profile to /api/auth; a stale tab that does is served as B.)
export const AUTH_ACTING: ActingSpec = 'self';
