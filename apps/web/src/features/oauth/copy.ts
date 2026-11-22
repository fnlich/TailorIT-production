import { OAUTH_SCOPE_MCP, OAUTH_SCOPE_OFFLINE, type OAuthPageError, type OAuthRequestView } from '@tailorit/shared/oauth';

// v3.1 OAUTH: the consent page's words (plain, from the person's side). What a connected app can and cannot do follows
// the MCP tools (apps/api/src/features/mcp): search and save jobs, prepare applications, read the tracker and the
// auto-apply queue. It never gets the password, sign-in codes or the browser extension.
// v34 ORIGIN (PLAN G8): the scopes in plain words; an app described by a document at an address is named by that
// address's host (what Claude's connector rules ask for: its own words could say anything); the list names archiving,
// removing and settings changes, and says who applies (the person's AI queues prepared jobs, the extension applies).
// The ORIGIN spec review: "Stay connected" always (a refresh token is always issued); it reads resumes and profile.

export const CONSENT_COPY = {
  pageTitle: 'Connect an AI app',
  title: (asker: string) => `${asker} wants to use your TailorIT account`,
  intro: 'If you allow it, it works with your account from inside that app.',
  asksLabel: 'Asks to',
  can: 'It will be able to',
  canItems: [
    'Search jobs and save them to your Job Tracker',
    // v34 ORIGIN (spec review 3): it reads them to prepare (prepare_job_context, own_ai_context).
    'Read your resumes and profile to prepare applications: tailored resumes, cover letters and answers',
    'Queue prepared jobs to apply; your browser extension sends the applications',
    'Archive saved jobs, remove jobs from your queue and change your settings',
    'Read your Job Tracker, its statistics and your auto-apply queue',
    'Do the same on profiles others share with you, as far as they allow',
  ],
  cannot: 'It will not be able to',
  cannotItems: ['See your password or sign-in codes', 'Use your browser extension or send an application itself'],
  clientLabel: 'App',
  documentAt: (host: string) => `Described at ${host}`,
  registered: 'Registered itself with TailorIT',
  returnLabel: 'Sends you back to',
  // v31 FIX-AUTH (SEC-5): an app that is not Claude or ChatGPT by their own exact addresses.
  unverifiedLabel: 'Not verified by TailorIT',
  unverifiedTitle: 'TailorIT could not verify this app',
  unverified: (host: string) =>
    `Its name is only what it says about itself. It sends you back to ${host}. Allow it only if you started this.`,
  loopbackTitle: 'This app runs on your computer',
  loopback: (host: string) =>
    `You go next to ${host}, where any program on this computer can listen. Allow it only if you started this.`,
  disconnect: 'Disconnect it any time in Integrations.',
  // v34 FIX-COPY (final review dir D4 = ux U-L8): the page a person reads before Allow links the public pages, under
  // the buttons: "Read TailorIT's Privacy policy and Terms of use." (the two names are links, the pages' own titles).
  policiesLead: "Read TailorIT's",
  privacy: 'Privacy policy',
  terms: 'Terms of use',
  allow: 'Allow',
  cancel: 'Cancel',
  allowing: 'Allowing...',
  leaving: (client: string) => `Taking you back to ${client}...`,
  loading: 'Loading the connection request...',
  integrations: 'Go to Integrations',
} as const;

/** v34 ORIGIN: each scope TailorIT grants, in plain words (a grant never holds another: the API leaves others out). */
export const SCOPE_WORDS: Readonly<Record<string, string>> = {
  [OAUTH_SCOPE_MCP]: 'Use your TailorIT data',
  [OAUTH_SCOPE_OFFLINE]: 'Stay connected',
};

/**
 * v34 ORIGIN: what every connection is given, in plain words, whatever scopes the app asked for: `mcp` (the API puts it
 * in every grant) and a refresh token (TailorIT always issues one, so the app stays connected even when it did not ask
 * for offline_access: the spec review, finding 2).
 */
export const ASKS: readonly string[] = [SCOPE_WORDS[OAUTH_SCOPE_MCP]!, SCOPE_WORDS[OAUTH_SCOPE_OFFLINE]!];

/** The page's words when no request can be shown (/oauth/consent?error=..., or a request that ended). */
export const CONSENT_ERRORS: Record<OAuthPageError | 'missing', { title: string; body: string }> = {
  invalid_client: {
    title: 'TailorIT does not know this app',
    body: 'Go back to the app and connect TailorIT again.',
  },
  invalid_redirect: {
    title: 'This app asked to send you somewhere it did not register',
    body: 'Stopped to keep your account safe. Connect again from the app.',
  },
  invalid_request: {
    title: 'This connection request is incomplete',
    body: 'Start the connection again from your AI app.',
  },
  temporarily_unavailable: {
    title: 'TailorIT is busy',
    body: 'Wait a minute, then connect again from your AI app.',
  },
  missing: {
    title: 'There is no connection request here',
    body: 'Connect TailorIT from your AI app to come here.',
  },
};

/** The name to show for a client: its own name, never empty. */
export function clientName(view: OAuthRequestView): string {
  return view.client.name.trim() || view.redirectHost;
}

/**
 * v34 ORIGIN: who asks, as the page names it: the host of the address a document client is described at (its client
 * id), else the client's name.
 */
export function askerOf(view: OAuthRequestView): string {
  return view.client.registration === 'cimd' && view.client.host ? view.client.host : clientName(view);
}
