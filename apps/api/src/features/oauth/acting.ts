import type { ActingSpec } from '../../core/feature';

// v33 SHARE-8 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3 "OAuth apps"): connecting an AI app is the signed-in
// person's own business: the consent page's calls and the list of connected apps are refused while a request names a
// shared profile (own_profile_only), so nobody connects their app to someone else's account or disconnects theirs. The
// web switches such pages back to the person's own profile first (SHARE-4's OWN_ONLY_PATHS: /oauth/consent). The
// OAuth endpoints and the discovery documents (/oauth, /.well-known) are early routes: no session, no profile.

/** /api/oauth: the consent page's request and decision, the connected apps and their removal. */
export const OAUTH_ACTING: ActingSpec = 'never';
