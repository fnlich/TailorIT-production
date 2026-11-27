import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { feedCompanyOf } from './feeds';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped, tenantLabelOf, tenantLabelOfHost } from './url';

// v38 FRAME: Recruitee's careers API (<company>.recruitee.com/api/offers/; the API's adapters/recruitee.ts).
// v38 ATS-A (SP v38 PLAN "Final coverage" row 9; REQUEST.md 9, EVIDENCE.md 9): an offer's link (/o/<slug>) names its
// offer, read on its own (/api/offers/<slug>); its clean link; the lane; Add source's field.

/** The company's name on Recruitee as typed: a name or an address on recruitee.com. */
export const recruiteeCompany = (input: string) => tenantLabelOf(input, ['recruitee.com']);

/** v38 ATS-A: Add source's check under the field (the web's): the company a name or an address names, or null. */
export function recruiteeCompanyOfTyped(input: string): string | null {
  const host = hostOfTyped(input);
  const label = host.includes('.') ? (tenantLabelOfHost(host, '.recruitee.com') ?? '') : host;
  return DNS_LABEL.test(label) ? label : null;
}

/** v38 ATS-A: an offer's slug as Recruitee writes it. */
const RECRUITEE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/**
 * v38 ATS-A: the offer a Recruitee address names, /o/<slug>, or its form /o/<slug>/c/new (REQUEST.md 9): its company and
 * slug; null for any other address.
 */
export function recruiteeOfferOf(url: BoardUrl): { company: string; slug: string } | null {
  const company = tenantLabelOfHost(boardHostOf(url), '.recruitee.com');
  const [o, slug, ...rest] = boardSegmentsOf(url);
  const tail = rest.join('/');
  if (!company || o !== 'o' || slug === undefined || !RECRUITEE_SLUG.test(slug) || (tail !== '' && tail !== 'c/new')) return null;
  return { company, slug };
}

export const RECRUITEE_BOARD = defineBoard({
  kind: 'recruitee',
  label: 'Recruitee',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'recruitee',
  hosts: String.raw`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.recruitee\.com$`,
  domains: ['recruitee.com'],
  configKey: 'company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: recruiteeCompany,
  configOfBoard: (board) => ({ company: board }),
  hostOf: (config) => {
    const company = feedCompanyOf(config);
    return company ? `${company}.recruitee.com` : null;
  },
  boardOfUrl: (url) => tenantLabelOfHost(boardHostOf(url), '.recruitee.com'),
  // v38 ATS-A: an offer's link names its slug (the shared lookup does not know Recruitee).
  parseLink: (url) => {
    const offer = recruiteeOfferOf(url);
    return offer ? { board: offer.company, externalId: offer.slug, canonical: [`https://${offer.company}.recruitee.com/o/${offer.slug}`] } : null;
  },
  // v38 ATS-A (REQUEST.md 9): https://<company>.recruitee.com/o/<slug>, the query and the form's /c/new dropped.
  cleanLink: (url) => {
    const offer = recruiteeOfferOf(url);
    return offer ? `https://${offer.company}.recruitee.com/o/${offer.slug}` : null;
  },
  // v38 ATS-A (SP v38 PLAN A4): every company's host is Recruitee's one service: one request at a time to all of it.
  lane: {
    key: 'recruitee.lane',
    label: 'Recruitee (all companies)',
    name: 'Recruitee',
  },
  // v38 ATS-A (SP v38 PLAN A10): added by hand, by its name or any address of it.
  addSource: {
    field: 'company',
    label: 'Company on Recruitee',
    hint: "The name in <name>.recruitee.com, or its careers page's address.",
    placeholder: 'https://acme.recruitee.com',
    help: "Reads the company's published offers, each with its full text, on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in <name>.recruitee.com, or an address on it.',
    required: "Enter the company's Recruitee name or careers address.",
    refusal: "Enter the company's name on Recruitee, or an address on <company>.recruitee.com.",
    refusalField: 'Enter the name in <name>.recruitee.com, or its address.',
    what: 'Recruitee company',
    boardOfInput: recruiteeCompanyOfTyped,
  },
  detail: (config) =>
    configWords(config, 'company') ? `Company ${configWords(config, 'company')} (${configWords(config, 'company')}.recruitee.com)` : null,
  examples: [
    {
      link: 'https://acme-robotics.recruitee.com/o/senior-robotics-engineer?jr_id=0a1b2c3d',
      clean: 'https://acme-robotics.recruitee.com/o/senior-robotics-engineer',
      board: 'acme-robotics', // v38 ATS-A: an offer's link names its offer
      externalId: 'senior-robotics-engineer',
      found: 'acme-robotics',
    },
    {
      // v38 ATS-A (REQUEST.md 9): the apply form's address is the offer's.
      link: 'https://acme-robotics.recruitee.com/o/senior-robotics-engineer/c/new',
      clean: 'https://acme-robotics.recruitee.com/o/senior-robotics-engineer',
      board: 'acme-robotics',
      externalId: 'senior-robotics-engineer',
      found: 'acme-robotics',
    },
  ],
});
