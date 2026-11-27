import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { feedCompanyOf } from './feeds';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped, SERVICE_LABELS, tenantLabelOfHost } from './url';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 5; REQUEST.md 5, EVIDENCE.md 5): a company's Pinpoint careers site,
// <company>.pinpointhq.com, read from its public feeds: /postings.json (every open posting, with its text: no single-
// posting JSON exists) and /jobs.rss (the company's name in its channel title, each job's posted date). The API's part:
// apps/api/src/features/ingest/boards/pinpoint.ts.

/** Pinpoint's own hosts' first labels (its app, its API, its marketing and help pages), never a company's. */
const PINPOINT_OWN_LABELS: ReadonlySet<string> = new Set([...SERVICE_LABELS, 'app', 'developers', 'status', 'help']);

/** A posting's id: a UUID (any case in an address; kept in lower case). */
const PINPOINT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A locale segment before /postings/ ("en", "en-GB"); REQUEST.md: it may be absent. */
const PINPOINT_LOCALE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
/** What may follow a posting's id: its form, the form's post, the page after submitting (the shared lookup's). */
const PINPOINT_PAGES: ReadonlySet<string> = new Set(['', 'applications/new', 'applications/thanks', 'applications']);

/** The company's name on Pinpoint as typed: a name or an address on <company>.pinpointhq.com ('' for none). */
export function pinpointCompany(input: string): string {
  const host = hostOfTyped(input);
  const label = host.includes('.') ? tenantLabelOfHost(host, '.pinpointhq.com') : host;
  return label && DNS_LABEL.test(label) && !PINPOINT_OWN_LABELS.has(label) ? label : '';
}

/** Add source's check under the field (the web's): the company a name or an address names, or null. */
export const pinpointCompanyOfTyped = (input: string): string | null => pinpointCompany(input) || null;

/** A posting a Pinpoint address names: its company, its locale ('' for none) and its UUID in lower case; null for none. */
function pinpointPostingOf(url: BoardUrl): { company: string; locale: string; id: string } | null {
  const company = pinpointCompany(boardHostOf(url));
  if (!company) return null;
  const parts = boardSegmentsOf(url);
  const localized = parts[0] !== undefined && parts[0] !== 'postings' && PINPOINT_LOCALE.test(parts[0]);
  const [postings, id, ...rest] = localized ? parts.slice(1) : parts;
  if (postings !== 'postings' || id === undefined || !PINPOINT_UUID.test(id) || !PINPOINT_PAGES.has(rest.join('/'))) return null;
  return { company, locale: localized ? parts[0]! : '', id: id.toLowerCase() };
}

/** A posting's clean link: https://<company>.pinpointhq.com[/<locale>]/postings/<uuid> (REQUEST.md: no query, no form). */
function pinpointPostingLink(posting: { company: string; locale: string; id: string }): string {
  return `https://${posting.company}.pinpointhq.com${posting.locale ? `/${posting.locale}` : ''}/postings/${posting.id}`;
}

export const PINPOINT_BOARD = defineBoard({
  kind: 'pinpoint',
  label: 'Pinpoint',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'pinpoint',
  hosts: String.raw`^(?!(?:www|app|api|apply|help|support|docs|blog|status|login|developers|static|cdn)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pinpointhq\.com$`,
  domains: ['pinpointhq.com'],
  atsKind: 'pinpoint',
  configKey: 'company',
  boardWords: 'Pinpoint company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: pinpointCompany,
  configOfBoard: (board) => ({ company: board }),
  hostOf: (config) => {
    const company = feedCompanyOf(config);
    return company && pinpointCompany(company) ? `${company}.pinpointhq.com` : null;
  },
  boardOfUrl: (url) => pinpointCompany(boardHostOf(url)) || null,
  // A posting link the shared lookup does not read (no locale, another one, an upper-case UUID).
  parseLink: (url) => {
    const posting = pinpointPostingOf(url);
    return posting ? { board: posting.company, externalId: posting.id, canonical: [pinpointPostingLink(posting)] } : null;
  },
  cleanLink: (url) => {
    const posting = pinpointPostingOf(url);
    return posting ? pinpointPostingLink(posting) : null;
  },
  // Every company's site is on Pinpoint's one service: one request at a time to all of it.
  lane: {
    key: 'pinpoint.lane',
    label: 'Pinpoint (all companies)',
    name: 'Pinpoint',
  },
  addSource: {
    field: 'company',
    label: 'Company on Pinpoint',
    hint: "The name in <name>.pinpointhq.com, or its careers page's address.",
    placeholder: 'https://acme.pinpointhq.com',
    help: "Reads the company's open postings, each with its full text, on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in <name>.pinpointhq.com, or an address on it.',
    required: "Enter the company's Pinpoint name or careers address.",
    refusal: "Enter the company's name on Pinpoint, or an address on <company>.pinpointhq.com.",
    refusalField: 'Enter the name in <name>.pinpointhq.com, or its address.',
    what: 'Pinpoint company',
    boardOfInput: pinpointCompanyOfTyped,
  },
  detail: (config) => (configWords(config, 'company') ? `Company ${configWords(config, 'company')} (${configWords(config, 'company')}.pinpointhq.com)` : null),
  examples: [
    {
      link: 'https://acme-robotics.pinpointhq.com/en/postings/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b?jr_id=6a332ef129c9',
      clean: 'https://acme-robotics.pinpointhq.com/en/postings/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      board: 'acme-robotics',
      externalId: '0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      found: 'acme-robotics',
    },
    {
      link: 'https://acme-robotics.pinpointhq.com/postings/0B9A5F7E-1C2D-4E3F-8A9B-0C1D2E3F4A5B/applications/new',
      clean: 'https://acme-robotics.pinpointhq.com/postings/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      board: 'acme-robotics',
      externalId: '0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      found: 'acme-robotics',
    },
  ],
});
