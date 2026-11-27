import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { feedCompanyOf } from './feeds';
import { boardHostOf, tenantLabelOf, tenantLabelOfHost } from './url';

// v38 FRAME: Personio's XML feed (<company>.jobs.personio.de/xml, or .com; the API's adapters/personio.ts).

/** The company's name on Personio as typed: a name or an address on jobs.personio.de / .com. */
export const personioCompany = (input: string) => tenantLabelOf(input, ['jobs.personio.de', 'jobs.personio.com']);

/** The suffix of a Personio board on the .com host. */
const PERSONIO_COM = '.jobs.personio.com';

/** v30 FIX-A (INT-4 open item 7): a Personio board's name: its tenant, or <tenant>.jobs.personio.com on the .com host. */
export function personioBoardName(input: string): string {
  const tenant = personioCompany(input);
  if (!tenant) return '';
  return /(?:^|[./])jobs\.personio\.com(?:[/:?#]|$)/i.test(input.trim()) ? `${tenant}${PERSONIO_COM}` : tenant;
}

export const PERSONIO_BOARD = defineBoard({
  kind: 'personio',
  label: 'Personio',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'personio',
  hosts: String.raw`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jobs\.personio\.(?:de|com)$`,
  domains: ['personio.de', 'personio.com'],
  configKey: 'company',
  configSchema: z.strictObject({
    company: z.string().min(1),
    domain: z.enum(['de', 'com']).optional(),
    language: z.string().optional(),
    ...BOARD_CONFIG_COMMON,
  }),
  boardOf: personioBoardName,
  // `{ company }`, and `domain: 'com'` for the .com host (adapters/personio.ts).
  configOfBoard: (board) => (board.endsWith(PERSONIO_COM) ? { company: board.slice(0, -PERSONIO_COM.length), domain: 'com' } : { company: board }),
  // v30 FIX-A: a Personio source on the .com host names its board <tenant>.jobs.personio.com.
  boardOfConfig: (config) =>
    typeof config.company === 'string' ? (config.domain === 'com' ? `${config.company}${PERSONIO_COM}` : config.company) : null,
  hostOf: (config) => {
    const company = feedCompanyOf(config);
    return company ? `${company}.jobs.personio.${config.domain === 'com' ? 'com' : 'de'}` : null;
  },
  boardOfUrl: (url) => {
    const host = boardHostOf(url);
    const tenant = tenantLabelOfHost(host, '.jobs.personio.de');
    if (tenant) return tenant;
    // v30 FIX-A: the .com host is kept (its feed is there, not on .de).
    return tenantLabelOfHost(host, PERSONIO_COM) ? host : null;
  },
  // v38 ATS-A (SP v38 WAVE2 item 2, PLAN A4): every company's feed is Personio's one service: one request at a time to
  // all of it, on the default lane constants.
  lane: {
    key: 'personio.lane',
    label: 'Personio (all companies)',
    name: 'Personio',
  },
  examples: [
    {
      link: 'https://acme-robotics.jobs.personio.de/job/1234567?language=en&utm_source=x',
      clean: 'https://acme-robotics.jobs.personio.de/job/1234567?language=en',
      board: null,
      externalId: null,
      found: 'acme-robotics',
    },
  ],
});
