import type { ActingSpec, ActingTable } from '../../core/feature';

// v33 SHARE-6 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3 "Autofill info", "Sensitive answers"; §4 "Sensitive
// facts", "Where applications go"): what each autofill router (each mounted at /api/autofill) does when a request names a
// shared profile. The auto-apply agent's routes are SHARE-5's (agent/acting.ts AGENT_ACTING); tailoring's are the tailor
// feature's (tailor/acting.ts).
//
// Settings › Autofill on a shared profile (the Profile and Saved answers tabs):
// - the non-sensitive profile, the saved answers and the resumes the Profile tab offers are Autofill info's See; saving
//   them is its Change (a save keeps the owner's contact email and phone, and leaves the sensitive part alone without
//   Sensitive answers' Change: profile/router.ts); "Fill from my resume" is part of editing (Change);
// - the sensitive part (work authorization, self-identification, age, pay) is Sensitive answers' See;
// - Settings' AI help (pick, classify, draft, answer) is Autofill info's Change (B pays: autofillPayerOf -> payerOf).
//
// Always locked: pairing the extension and its connections, and the job-site sign-ins (a sign-in B controls would send
// the owner's applications into B's ATS account).
//
// The extension's own routes (the lookup, adding the job a page shows, Applied and a submitted form, the known form, a
// closed link, a letter for a form, a resume's file for a form, the sites asked for) are called with its token, which is
// always its owner's own profile (a token naming a profile is refused before any route): no page of a shared profile
// sends them, and their writes (a job added, Applied, the answers a form was sent with, a report) are the extension's on
// its owner's own profile: never while acting.

/** connect-router.ts: POST /connect, POST /connect/redeem, GET/DELETE /session, GET /tokens, DELETE /tokens/:id. */
export const AUTOFILL_CONNECT_ACTING: ActingSpec = 'never';

/** profile/router.ts. */
export const AUTOFILL_PROFILE_ACTING = {
  'GET /profile': 'autofill:view',
  'GET /profile/sensitive': 'sensitive:view',
  'PUT /profile': 'autofill:edit',
  'GET /profile/seed': 'autofill:edit',
  'POST /profile/seed': 'autofill:edit',
} as const satisfies ActingTable;

/** lookup-router.ts: POST /lookup (the extension's). */
export const AUTOFILL_LOOKUP_ACTING: ActingSpec = 'never';

/** jobs-router.ts: POST /jobs, POST /jobs/from-page, GET /jobs/search, POST /applied, POST /submissions (the extension's). */
export const AUTOFILL_JOBS_ACTING: ActingSpec = 'never';

/** resumes-router.ts: the Profile tab's resume choices; a resume's file for a form is the extension's. */
export const AUTOFILL_RESUMES_ACTING = {
  'GET /resumes': 'autofill:view',
  'GET /resumes/:id/file': 'never',
} as const satisfies ActingTable;

/** ai/router.ts: Settings' AI help. */
export const AUTOFILL_AI_ACTING = {
  'POST /ai/pick': 'autofill:edit',
  'POST /ai/classify': 'autofill:edit',
  'POST /ai/draft': 'autofill:edit',
  'POST /ai/answer': 'autofill:edit',
} as const satisfies ActingTable;

/** answers/router.ts: the saved answers (never a sensitive one: the save refuses them). */
export const AUTOFILL_ANSWERS_ACTING = {
  'GET /answers': 'autofill:view',
  'PUT /answers': 'autofill:edit',
  'DELETE /answers/:id': 'autofill:edit',
} as const satisfies ActingTable;

/** cover-letters-router.ts: the letter a form uploads (the extension's). */
export const AUTOFILL_COVER_LETTERS_ACTING: ActingSpec = 'never';

/** site-requests.ts: the sites asked for (the extension's; Settings' Extension tab, the owner's own). */
export const AUTOFILL_SITE_REQUESTS_ACTING: ActingSpec = 'never';

/** credentials/router.ts: the job-site sign-ins, the list and every write (always locked). */
export const AUTOFILL_CREDENTIALS_ACTING: ActingSpec = 'never';

/** forms/router.ts: POST /forms/known (the extension's). */
export const AUTOFILL_FORMS_ACTING: ActingSpec = 'never';

/** closed-router.ts: POST /jobs/:jobId/closed (the extension's). */
export const AUTOFILL_CLOSED_ACTING: ActingSpec = 'never';
