import type { OAuthPageError, OAuthRequestView } from '@tailorit/shared/oauth';

// v3.1 OAUTH: the consent page's words (plain, from the person's side). What a connected app can and cannot do follows
// the MCP tools (apps/api/src/features/mcp): search and save jobs, prepare applications, read the tracker and the
// auto-apply queue. It never gets the password, sign-in codes or the browser extension.

export const CONSENT_COPY = {
  pageTitle: 'Connect an AI app',
  title: (client: string) => `${client} wants to use your TailorIT account`,
  intro: 'If you allow it, it can work with your TailorIT account from inside that app.',
  can: 'It will be able to',
  canItems: [
    'Search jobs and save them to your Job Tracker',
    'Prepare applications: tailored resumes, cover letters and answers',
    'Read your Job Tracker, its statistics and your auto-apply queue',
  ],
  cannot: 'It will not be able to',
  cannotItems: ['See your password or sign-in codes', 'Use the TailorIT browser extension or apply for you'],
  clientLabel: 'App',
  documentAt: (host: string) => `Described at ${host}`,
  registered: 'Registered itself with TailorIT',
  returnLabel: 'Sends you back to',
  // v31 FIX-AUTH (SEC-5): an app that is not Claude or ChatGPT by their own exact addresses.
  unverifiedLabel: 'Not verified by TailorIT',
  unverifiedTitle: 'TailorIT could not verify this app',
  unverified: (host: string) =>
    `TailorIT knows Claude and ChatGPT by their own addresses, and this app is neither: its name is only what it says about itself. It sends you back to ${host}. Allow it only if you know that address and you started this connection yourself.`,
  loopbackTitle: 'This app runs on your computer',
  loopback: (host: string) =>
    `After you choose, TailorIT sends you to ${host}, a program on this computer. Any program can listen there, so allow it only if you just started this connection yourself.`,
  disconnect: 'You can disconnect it at any time in Integrations.',
  allow: 'Allow',
  cancel: 'Cancel',
  allowing: 'Allowing...',
  leaving: (client: string) => `Taking you back to ${client}...`,
  loading: 'Loading the connection request...',
  integrations: 'Go to Integrations',
} as const;

/** The page's words when no request can be shown (/oauth/consent?error=..., or a request that ended). */
export const CONSENT_ERRORS: Record<OAuthPageError | 'missing', { title: string; body: string }> = {
  invalid_client: {
    title: 'TailorIT does not know this app',
    body: 'The app that sent you here did not register with TailorIT, or its description could not be read. Go back to the app and connect TailorIT again.',
  },
  invalid_redirect: {
    title: 'This app asked to send you somewhere it did not register',
    body: 'TailorIT stopped here to keep your account safe. Go back to the app and connect TailorIT again, or tell its makers.',
  },
  invalid_request: {
    title: 'This connection request is incomplete',
    body: 'Part of it is missing. Start the connection again from your AI app.',
  },
  temporarily_unavailable: {
    title: 'TailorIT is busy',
    body: 'Too many connection requests came in at once. Wait a minute, then connect TailorIT again from your AI app.',
  },
  missing: {
    title: 'There is no connection request here',
    body: 'Connect TailorIT from Claude, ChatGPT or another AI app, and it will bring you to this page.',
  },
};

/** The name to show for a client: its own name, never empty. */
export function clientName(view: OAuthRequestView): string {
  return view.client.name.trim() || view.redirectHost;
}
