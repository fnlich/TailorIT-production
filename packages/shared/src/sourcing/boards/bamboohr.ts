import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { feedCompanyOf } from './feeds';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped, tenantLabelOf, tenantLabelOfHost } from './url';

// v38 FRAME: BambooHR careers lists (v37 BOARDS: <company>.bamboohr.com/careers/list, each opening's /careers/<id>/detail;
// the API's adapters/bamboohr.ts).

/**
 * v37 FIX-37A (REVIEW37-ux L1): the labels of BambooHR's own hosts, never a company's (the API's normaliser and Add
 * source's check under the field read this one list).
 */
export const BAMBOOHR_OWN_LABELS: ReadonlySet<string> = new Set([
  'www', 'app', 'api', 'help', 'marketing', 'partners', 'status', 'support', 'blog', 'developers', 'login', 'marketplace', 'docs', 'static', 'cdn',
]);

/** The company's name on BambooHR as typed: a name or an address on bamboohr.com ('' for none, or BambooHR's own host). */
export const bamboohrCompany = (input: string) => {
  const company = tenantLabelOf(input, ['bamboohr.com']);
  return BAMBOOHR_OWN_LABELS.has(company) ? '' : company;
};

/**
 * Add source's check under the field (the web's, v37 BOARDS): a BambooHR company from what an admin typed, its name
 * ("acme") or an address on <name>.bamboohr.com; null when it names none (v37 FIX-37B: or one of BambooHR's own hosts).
 */
export function bamboohrCompanyOfTyped(input: string): string | null {
  const host = hostOfTyped(input);
  const label = host.includes('.') ? (host.endsWith('.bamboohr.com') ? host.slice(0, -'.bamboohr.com'.length) : '') : host;
  return DNS_LABEL.test(label) && !BAMBOOHR_OWN_LABELS.has(label) ? label : null;
}

/** Every company's careers host, <company>.bamboohr.com (one DNS label; the list, each opening's detail, the careers page). */
const BAMBOOHR_HOSTS = String.raw`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.bamboohr\.com$`;

/** An opening's id in its addresses. */
const OPENING_ID = /^\d{1,20}$/;

/**
 * v38 ATS-D (REQUEST.md #6): the opening a careers address names, /careers/<id> or its detail's /careers/<id>/detail (the
 * JSON the careers page loads; parseAtsUrl reads /careers/<id> alone), on a company's host; null for any other page.
 */
function bamboohrOpeningOf(url: BoardUrl): { company: string; id: string } | null {
  const company = tenantLabelOfHost(boardHostOf(url), '.bamboohr.com');
  if (!company || BAMBOOHR_OWN_LABELS.has(company)) return null;
  const [careers, id, detail, ...rest] = boardSegmentsOf(url);
  if (careers !== 'careers' || !id || !OPENING_ID.test(id) || rest.length > 0 || (detail !== undefined && detail !== 'detail')) return null;
  return { company, id };
}

/** v38 ATS-D: an opening's clean link, https://<company>.bamboohr.com/careers/<id> (no /detail, no query). */
const bamboohrOpeningUrl = (url: BoardUrl, id: string) => `https://${boardHostOf(url)}/careers/${id}`;

export const BAMBOOHR_BOARD = defineBoard({
  kind: 'bamboohr',
  label: 'BambooHR',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'bamboohr',
  hosts: BAMBOOHR_HOSTS,
  domains: ['bamboohr.com'],
  atsKind: 'bamboohr',
  configKey: 'company',
  boardWords: 'BambooHR company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: bamboohrCompany,
  configOfBoard: (board) => ({ company: board }),
  hostOf: (config) => {
    const company = feedCompanyOf(config);
    return company ? `${company}.bamboohr.com` : null;
  },
  // A BambooHR tenant's own host serves its staff too: only its careers pages name a board.
  boardOfUrl: (url, parts) => {
    const company = tenantLabelOfHost(boardHostOf(url), '.bamboohr.com');
    return company && ['careers', 'jobs'].includes(parts[0]?.toLowerCase() ?? '') ? company : null;
  },
  // v38 ATS-D (REQUEST.md #6): an opening's detail address names it too (parseAtsUrl reads /careers/<id> alone), and
  // its clean link drops the query and a trailing /detail.
  parseLink: (url) => {
    const opening = bamboohrOpeningOf(url);
    return opening ? { board: opening.company, externalId: opening.id, canonical: [bamboohrOpeningUrl(url, opening.id)] } : null;
  },
  cleanLink: (url) => {
    const opening = bamboohrOpeningOf(url);
    return opening ? bamboohrOpeningUrl(url, opening.id) : null;
  },
  // v37 INT-2b (E1): each answers all its companies from one limit: one request at a time to all of BambooHR.
  lane: {
    key: 'bamboohr.lane',
    label: 'BambooHR (all companies)',
    name: 'BambooHR',
  },
  addSource: {
    field: 'company',
    label: 'Company on BambooHR',
    hint: "The name in <name>.bamboohr.com, or its careers page's address.",
    placeholder: 'https://acme.bamboohr.com/careers',
    help: "Reads the company's openings and each one's full posting on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in <name>.bamboohr.com, or an address on it.',
    required: "Enter the company's BambooHR name or careers address.",
    refusal: "Enter the company's name on BambooHR, or an address on <company>.bamboohr.com.",
    refusalField: 'Enter the name in <name>.bamboohr.com, or its address.',
    // v37 FIX-37A (E6, REVIEW37-ux M4): a BambooHR board never names its company.
    companyHint:
      "BambooHR doesn't name the company: TailorIT reads it from the company's careers page once. Type it to choose it yourself.",
    boardOfInput: bamboohrCompanyOfTyped,
  },
  detail: (config) =>
    configWords(config, 'company') ? `Company ${configWords(config, 'company')} (${configWords(config, 'company')}.bamboohr.com)` : null,
  examples: [
    {
      link: 'https://acme-robotics.bamboohr.com/careers/41?source=aWQ9MTA%3D',
      clean: 'https://acme-robotics.bamboohr.com/careers/41',
      board: 'acme-robotics',
      externalId: '41',
      found: 'acme-robotics',
    },
    {
      // v38 ATS-D: the detail's address (the JSON the careers page loads) and a query of its own.
      link: 'https://acme-robotics.bamboohr.com/careers/57/detail?lang=en&utm_source=x',
      clean: 'https://acme-robotics.bamboohr.com/careers/57',
      board: 'acme-robotics',
      externalId: '57',
      found: 'acme-robotics',
    },
  ],
});
