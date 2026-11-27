import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { feedCompanyOf } from './feeds';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped, tenantLabelOf, tenantLabelOfHost } from './url';

// v38 FRAME: Breezy HR's public list (<company>.breezy.hr/json; the API's adapters/breezy.ts).
// v38 ATS-A (SP v38 PLAN "Final coverage" row 1; REQUEST.md 1, EVIDENCE.md 1): its clean link, its lane and Add source's
// field; the list is read with each position's text (/json?verbose=true) and a position's link is read from it.

/** The company's name on Breezy as typed: a name or an address on breezy.hr. */
export const breezyCompany = (input: string) => tenantLabelOf(input, ['breezy.hr']);

/** v38 ATS-A: Add source's check under the field (the web's): the company a name or an address on breezy.hr names, or null. */
export function breezyCompanyOfTyped(input: string): string | null {
  const host = hostOfTyped(input);
  const label = host.includes('.') ? (tenantLabelOfHost(host, '.breezy.hr') ?? '') : host;
  return DNS_LABEL.test(label) ? label : null;
}

/** v38 ATS-A: a position's segment, <12 hex digits>[-<slug>] (the shared lookup's id). */
const BREEZY_POSITION = /^([0-9a-f]{12})(?:-[^/]*)?$/i;

/**
 * v38 ATS-A (REQUEST.md 1): a position's clean link, https://<company>.breezy.hr/p/<id>-<slug>: /apply and the query
 * dropped; null for any other address.
 */
function breezyPositionLink(url: BoardUrl): string | null {
  return breezyPositionOf(url)?.link ?? null;
}

/**
 * v38 FIX-A (SP v38 FIXES-38 item 12, REVIEW38-beh L4): the position an address names (with or without its slug, its
 * id in any case, /apply or not): its company, its id in lower case and its clean link; null for any other address.
 */
function breezyPositionOf(url: BoardUrl): { company: string; id: string; link: string } | null {
  const company = tenantLabelOfHost(boardHostOf(url), '.breezy.hr');
  const [p, position, ...rest] = boardSegmentsOf(url);
  const tail = rest.join('/');
  const match = position === undefined ? null : BREEZY_POSITION.exec(position);
  if (!company || p !== 'p' || !match || (tail !== '' && tail !== 'apply')) return null;
  // The position's segment as the address wrote it (its encoding kept).
  return { company, id: match[1]!.toLowerCase(), link: `https://${company}.breezy.hr/p/${url.pathname.split('/').filter(Boolean)[1]}` };
}

export const BREEZY_BOARD = defineBoard({
  kind: 'breezy',
  label: 'Breezy HR',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'breezy',
  hosts: String.raw`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.breezy\.hr$`,
  domains: ['breezy.hr'],
  atsKind: 'breezy',
  configKey: 'company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: breezyCompany,
  configOfBoard: (board) => ({ company: board }),
  hostOf: (config) => {
    const company = feedCompanyOf(config);
    return company ? `${company}.breezy.hr` : null;
  },
  boardOfUrl: (url) => tenantLabelOfHost(boardHostOf(url), '.breezy.hr'),
  // v38 FIX-A (L4): a position link the shared lookup does not read (no slug, an id in capitals) is still Breezy's.
  parseLink: (url) => {
    const position = breezyPositionOf(url);
    return position ? { board: position.company, externalId: position.id, canonical: [position.link] } : null;
  },
  cleanLink: breezyPositionLink, // v38 ATS-A
  // v38 ATS-A (SP v38 PLAN A4): every company's host is Breezy's one service: one request at a time to all of it.
  lane: {
    key: 'breezy.lane',
    label: 'Breezy HR (all companies)',
    name: 'Breezy HR',
  },
  // v38 ATS-A (SP v38 PLAN A10): added by hand, by its name or any address of it.
  addSource: {
    field: 'company',
    label: 'Company on Breezy HR',
    hint: "The name in <name>.breezy.hr, or its careers page's address.",
    placeholder: 'https://acme.breezy.hr',
    help: "Reads the company's open positions, each with its full text, on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in <name>.breezy.hr, or an address on it.',
    required: "Enter the company's Breezy HR name or careers address.",
    refusal: "Enter the company's name on Breezy HR, or an address on <company>.breezy.hr.",
    refusalField: 'Enter the name in <name>.breezy.hr, or its address.',
    what: 'Breezy HR company',
    boardOfInput: breezyCompanyOfTyped,
  },
  detail: (config) => (configWords(config, 'company') ? `Company ${configWords(config, 'company')} (${configWords(config, 'company')}.breezy.hr)` : null),
  examples: [
    {
      link: 'https://acme-robotics.breezy.hr/p/0a1b2c3d4e5f-senior-robotics-engineer?source=LinkedIn',
      clean: 'https://acme-robotics.breezy.hr/p/0a1b2c3d4e5f-senior-robotics-engineer',
      board: 'acme-robotics',
      externalId: '0a1b2c3d4e5f',
      found: 'acme-robotics',
    },
    {
      // v38 ATS-A: its form's address is the position's.
      link: 'https://acme-robotics.breezy.hr/p/0a1b2c3d4e5f-senior-robotics-engineer/apply?jr_id=6a1b2c3d',
      clean: 'https://acme-robotics.breezy.hr/p/0a1b2c3d4e5f-senior-robotics-engineer',
      board: 'acme-robotics',
      externalId: '0a1b2c3d4e5f',
      found: 'acme-robotics',
    },
  ],
});
