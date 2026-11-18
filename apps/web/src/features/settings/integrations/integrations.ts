import { APP_NAME } from '@tailorit/shared/core';
import {
  CHATGPT_PLUGINS_URL,
  claudeConnectorLink,
  connectorsReachable,
  knownClientName,
  type OAuthClientKind,
  type OAuthGrantItem,
} from '@tailorit/shared/oauth';

// v3.1 INTEG: the Integrations page's words and choices, apart from the views so a test reads them. The page is laid
// out like a settings page of connected apps: "AI assistants" (TailorIT's MCP server: its address, the connected
// assistants with Disconnect, Claude and ChatGPT with Connect, the personal tokens under Advanced) and "Connections"
// (the apps TailorIT will connect to: Gmail and Google Calendar, coming soon). Decisions D6, D7 and D11 of the v3.1
// plan; the OAuth side is docs/design/v3.1/23-mcp-oauth.md.

// ------------------------------------------------------------------------------------------------------------ tabs

export const INTEGRATIONS_TABS = [
  { value: 'ai-assistants', label: 'AI assistants' },
  { value: 'connections', label: 'Connections' },
] as const;

export type IntegrationsTab = (typeof INTEGRATIONS_TABS)[number]['value'];

/** `?tab=connections`; anything else (missing, a typo) is AI assistants. */
export function readIntegrationsTab(value: string | null | undefined): IntegrationsTab {
  return INTEGRATIONS_TABS.some((tab) => tab.value === value) ? (value as IntegrationsTab) : 'ai-assistants';
}

export const INTEGRATIONS_PATH = '/settings/integrations';

export function integrationsHref(tab: IntegrationsTab): string {
  return tab === 'ai-assistants' ? INTEGRATIONS_PATH : `${INTEGRATIONS_PATH}?tab=${tab}`;
}

export const PAGE_COPY = {
  title: 'Integrations',
  description: `Connect ${APP_NAME} to your AI assistant and, soon, to the other apps you use.`,
  tabsLabel: 'Integrations',
} as const;

// ------------------------------------------------------------------------------------------------- AI assistants

export type AiClientKind = Exclude<OAuthClientKind, 'other'>;

export interface AiClient {
  kind: AiClientKind;
  name: string;
  summary: string;
}

/** The assistants that connect with a few clicks (D6): their names are the shared list's (OAUTH_KNOWN_CLIENTS). */
export const AI_CLIENTS: readonly AiClient[] = [
  {
    kind: 'claude',
    name: knownClientName('claude') ?? 'Claude',
    summary: `Use ${APP_NAME} in Claude on the web, the desktop app and your phone. Claude opens with ${APP_NAME} filled in.`,
  },
  {
    kind: 'chatgpt',
    name: knownClientName('chatgpt') ?? 'ChatGPT',
    summary: `Use ${APP_NAME} in ChatGPT. You paste ${APP_NAME}'s address into ChatGPT once.`,
  },
];

export const AI_COPY = {
  serverTitle: `${APP_NAME} MCP`,
  serverDescription: `AI assistants work with your ${APP_NAME} account through this address: they search and save jobs, prepare applications and read your Job Tracker.`,
  addressLabel: 'MCP server address',
  addressHint: 'Claude and ChatGPT ask for this address when you connect them. Connect below fills it in for you.',
  addressLoading: `Loading ${APP_NAME}'s address`,
  addressFailed: `${APP_NAME}'s address could not be loaded`,
  copyAddress: 'Copy the MCP server address',
  connectedTitle: 'Connected',
  connectedLoading: 'Loading your connected assistants',
  connectedFailed: 'Your connected assistants could not be loaded',
  connectedEmpty: 'No AI assistant is connected yet',
  connectedEmptyHint: `Choose Connect on Claude or ChatGPT below, then Allow on ${APP_NAME}'s page.`,
  connectedList: 'Connected AI assistants',
  clientsTitle: `Assistants to use with ${APP_NAME}`,
  clientsList: 'AI assistants you can connect',
  connectedBadge: 'Connected',
  connect: 'Connect',
  // v31 FIX-WEB (REV-UX UX-6): a connected assistant's card manages its connection instead of offering a second one.
  manage: 'Manage',
  manageName: (name: string) => `Manage ${name}'s connection`,
  disconnect: 'Disconnect',
  disconnectTitle: (name: string) => `Disconnect ${name}?`,
  disconnectBody: (name: string) =>
    `${name} can no longer reach your ${APP_NAME} account. What it saved stays. You can connect it again at any time.`,
  disconnecting: 'Disconnecting...',
  disconnected: (name: string) => `${name} disconnected`,
  settingsTitle: `How your AI works with ${APP_NAME}`,
  settingsDescription:
    `Prepare your saved jobs with an AI you run on your own plan, such as Claude, ChatGPT or Claude Code, instead of ${APP_NAME}'s AI. These settings apply to every AI you connect.`,
  advancedToggle: 'Advanced: personal access tokens',
  advancedHint: 'For Claude Code, Claude Desktop and other MCP clients you run yourself',
  tokensTitle: 'Personal access tokens',
  tokensDescription: `An AI client you run yourself, such as Claude Code or Claude Desktop, connects to ${APP_NAME}'s MCP server with a token you make here. A token also works on this computer's own address (http://localhost).`,
} as const;

/** The line under a connected assistant: when it was connected and last used. */
export function grantLine(item: Pick<OAuthGrantItem, 'createdAt' | 'lastUsedAt'>, formatDate: (value: string) => string, ago: (value: string) => string) {
  return `Connected ${formatDate(item.createdAt)} · Last used ${item.lastUsedAt ? ago(item.lastUsedAt) : 'never'}`;
}

/** Where an app TailorIT does not know comes from (its document's host, else where it sends people back). */
export function grantHost(item: Pick<OAuthGrantItem, 'clientKind' | 'clientHost' | 'redirectHost'>): string | null {
  return item.clientKind === 'other' ? (item.clientHost ?? item.redirectHost) : null;
}

/** The toggle's count of personal tokens ("2 tokens"), or nothing without any. */
export function tokenCount(count: number): string | null {
  return count > 0 ? `${count} ${count === 1 ? 'token' : 'tokens'}` : null;
}

// -------------------------------------------------------------------------------------------------- connecting

/** The origin of an address ("https://jobs.example.com" of ".../mcp"), or the address itself when it is none. */
export function originOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return address;
  }
}

export interface ConnectReadiness {
  /** Claude's and ChatGPT's servers can reach TailorIT: its address and its MCP endpoint are public https. */
  reachable: boolean;
  /** The address they cannot reach (TailorIT's own, else the MCP endpoint's origin), when not reachable. */
  blockedAt: string | null;
}

/**
 * Whether Claude and ChatGPT can connect (D6): both call TailorIT from the internet, the MCP endpoint and the OAuth
 * server at `appOrigin` (the authorization server's issuer, APP_ORIGIN), so both must be public https addresses
 * (`connectorsReachable`). On a local or plain http address the Connect dialog explains this instead.
 */
export function connectReadiness(endpoint: string, appOrigin: string): ConnectReadiness {
  if (!connectorsReachable(appOrigin)) return { reachable: false, blockedAt: originOf(appOrigin) };
  if (!connectorsReachable(endpoint)) return { reachable: false, blockedAt: originOf(endpoint) };
  return { reachable: true, blockedAt: null };
}

export interface ConnectStep {
  title: string;
  body: string;
}

/** Claude's "Add custom connector" window, prefilled; `owner`: the organization-wide one (Team, Enterprise). */
export function claudeLinks(endpoint: string) {
  return {
    personal: claudeConnectorLink(APP_NAME, endpoint),
    owner: claudeConnectorLink(APP_NAME, endpoint, { owner: true }),
  };
}

export { CHATGPT_PLUGINS_URL };

export const CONNECT_COPY = {
  claude: {
    title: 'Connect Claude',
    description: `Claude opens its "Add custom connector" window with ${APP_NAME}'s name and address filled in.`,
    steps: [
      // v31 FIX-WEB (REV-UX UX-5): the address box is above the steps; the words name it instead of placing it.
      { title: 'Open Claude', body: `Claude shows "Add custom connector" with ${APP_NAME}'s name and address filled in.` },
      { title: 'Choose Add', body: `Claude then sends you to ${APP_NAME}. Sign in if it asks.` },
      {
        title: `Choose Allow on ${APP_NAME}'s page`,
        body: `It names Claude and what it can do with your account. Back in Claude, ${APP_NAME}'s tools are ready in your chats.`,
      },
    ] satisfies ConnectStep[],
    action: 'Open Claude',
    teamTitle: 'Claude for Team or Enterprise',
    teamBody: `Only an owner can add a connector there: they add ${APP_NAME} once in the organization's settings, then each member chooses Connect in Claude.`,
    teamLink: "Open the organization's connector settings",
    opened: `Claude opened in a new tab. Finish there: once you choose Allow, Claude shows up under Connected here.`,
  },
  chatgpt: {
    title: 'Connect ChatGPT',
    description: `ChatGPT has no link that fills ${APP_NAME} in, so you paste ${APP_NAME}'s address once.`,
    steps: [
      { title: "Open ChatGPT's plugins page", body: 'Choose + and then "Add custom MCP server".' },
      {
        title: 'Paste the address',
        body: `Name it ${APP_NAME}, paste ${APP_NAME}'s address (copied for you), choose OAuth, accept the warning and choose Create. Then install it.`,
      },
      {
        title: `Choose Allow on ${APP_NAME}'s page`,
        body: `ChatGPT sends you there to sign in. Then, in a chat, type @ and choose ${APP_NAME}.`,
      },
    ] satisfies ConnectStep[],
    action: 'Copy address and open ChatGPT',
    planNote: 'Your ChatGPT plan, or your workspace admin, must allow custom MCP servers.',
    opened: `The address is copied and ChatGPT opened in a new tab: paste it there. Once you choose Allow, ChatGPT shows up under Connected here.`,
    notCopied: `Your browser did not let ${APP_NAME} copy the address: copy it from the box above, then paste it in ChatGPT.`,
    openAgain: "ChatGPT's plugins page did not open? Open it here",
  },
  stepsLabel: (client: string) => `Steps to connect ${client}`,
  addressLabel: `${APP_NAME}'s address`,
  copy: 'Copy',
  copied: 'Address copied',
  cancel: 'Cancel',
  close: 'Close',
  // v31 FIX-WEB (as REV-UX UX-15): plain words, never "this TailorIT".
  unreachableTitle: (client: string) => `${client} can't reach ${APP_NAME} yet`,
  unreachableBody: (client: string, address: string) =>
    `${client} connects to ${APP_NAME} from the internet, and only to a public https address. Right now ${APP_NAME} runs at ${address}.`,
  /** The deployment guide: the words before its file name, the file, and the words after it. */
  unreachableFix: {
    before: `Whoever runs ${APP_NAME} can give it a public https address with the deployment guide:`,
    file: 'DEPLOYMENT.md',
    after: `in ${APP_NAME}'s folder, section 8, "Put HTTPS in front".`,
  },
  meanwhile: 'Meanwhile, AI clients on this computer, such as Claude Code and Claude Desktop, can connect with a personal access token.',
  useToken: 'Use a personal token',
} as const;

// ------------------------------------------------------------------------------------------------- Connections

export const CONNECTION_CATEGORIES = [
  { value: 'all', label: 'All categories' },
  { value: 'email', label: 'Email' },
  { value: 'calendar', label: 'Calendar' },
] as const;

export type ConnectionCategory = Exclude<(typeof CONNECTION_CATEGORIES)[number]['value'], 'all'>;
export type ConnectionCategoryFilter = (typeof CONNECTION_CATEGORIES)[number]['value'];

export interface Connection {
  id: 'gmail' | 'google-calendar';
  name: string;
  category: ConnectionCategory;
  summary: string;
}

/** The apps TailorIT will connect to in a later release (D11): each card's Connect says it is coming soon. */
export const CONNECTIONS: readonly Connection[] = [
  { id: 'gmail', name: 'Gmail', category: 'email', summary: "Follow employers' replies to your applications from your inbox." },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'calendar',
    summary: 'Keep your interviews and follow-ups on your calendar.',
  },
];

export const CONNECTIONS_COPY = {
  search: 'Search connections',
  category: 'Category',
  list: 'Apps to connect',
  comingSoon: 'Coming soon',
  connect: 'Connect',
  ok: 'OK',
  noMatchTitle: (query: string) => `No connection matches "${query}"`,
  noMatchHint: 'Try another name, or clear the search.',
  clear: 'Clear search',
  aiTitle: `Use ${APP_NAME} in Claude and ChatGPT`,
  aiBody: `Connect your AI assistant to ${APP_NAME}'s MCP server.`,
  aiLink: 'AI assistants',
} as const;

const CATEGORY_LABEL = Object.fromEntries(CONNECTION_CATEGORIES.map((entry) => [entry.value, entry.label])) as Record<
  ConnectionCategoryFilter,
  string
>;

export function categoryLabel(category: ConnectionCategory): string {
  return CATEGORY_LABEL[category];
}

/** The connections a search and a category leave: by name, summary or category, whatever the case. */
export function filterConnections(
  items: readonly Connection[],
  query: string,
  category: ConnectionCategoryFilter,
): Connection[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    const haystack = `${item.name} ${item.summary} ${categoryLabel(item.category)}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// ---------------------------------------------------------------------------------------------------- copying

/** Copies `text`; false when the browser refuses (no permission, an insecure page, an old browser). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
