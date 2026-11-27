import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardUrlOf, configWords } from './url';

// v38 ATS-C (SP v38 PLAN A2, "Final coverage" row 2): SmartRecruiters, links only. A posting's link is
// jobs.smartrecruiters.com/<Company>/<postingId>-<slug> (the company case-sensitive, the posting id the digits before the
// first dash) or its one-click application, jobs.smartrecruiters.com/oneclick-ui/company/<Company>/publication/<uuid>;
// its clean link drops the query (REQUEST.md). The API reads a numeric link's own page (its schema.org microdata); the
// one-click page answers a bot check and api.smartrecruiters.com is disallowed by its robots.txt, so neither is ever
// asked (the API's boards/smartrecruiters.ts). No board list in v3.8: the kind never runs, has no Add source field and
// discovery finds no SmartRecruiters board (its links are kept under the company's source, off).

/** SmartRecruiters' candidate host (the one its links name). */
export const SMARTRECRUITERS_HOST = 'jobs.smartrecruiters.com';
/** A company's name as its links write it (the extension's rule: @tailorit/shared/autofill lookup.ts). */
const COMPANY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
/** A posting's own segment: its number, then its slug after a hyphen. */
const POSTING = /^(\d{6,20})(?:-.*)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The host's own first segments, which are no company. */
const RESERVED: ReadonlySet<string> = new Set(['oneclick-ui', 'external-referrals']);

/** A SmartRecruiters posting a link names: its company (as written), its id and its clean link. */
export interface SmartRecruitersLink {
  company: string;
  /** The posting's number, or (a one-click link) its publication's uuid in lower case. */
  id: string;
  /** The one-click application's link (no keyless read: a bot check answers it). */
  oneClick: boolean;
  clean: string;
}

/** A path's segments as written (still encoded), and decoded. */
function segments(url: Pick<BoardUrl, 'pathname'>): { raw: string[]; decoded: string[] } {
  const raw = url.pathname.split('/').filter(Boolean);
  const decoded = raw.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return { raw, decoded };
}

/** The posting a link on jobs.smartrecruiters.com names (either form; a one-click link's screening step too), or null. */
export function smartRecruitersLinkOf(url: BoardUrl): SmartRecruitersLink | null {
  if (boardHostOf(url) !== SMARTRECRUITERS_HOST) return null;
  const { raw, decoded } = segments(url);
  if (decoded[0] === 'oneclick-ui') {
    const [, word, company, publication, id, ...tail] = decoded;
    if (word !== 'company' || publication !== 'publication' || !company || !id || !COMPANY.test(company) || !UUID.test(id)) return null;
    if (tail.length > 1 || (tail.length === 1 && tail[0] !== 'screening')) return null;
    const uuid = id.toLowerCase();
    return { company, id: uuid, oneClick: true, clean: `https://${SMARTRECRUITERS_HOST}/oneclick-ui/company/${company}/publication/${uuid}` };
  }
  if (decoded.length !== 2) return null;
  const [company, segment] = decoded as [string, string];
  const posting = POSTING.exec(segment);
  if (!COMPANY.test(company) || RESERVED.has(company) || !posting) return null;
  return { company, id: posting[1]!, oneClick: false, clean: `https://${SMARTRECRUITERS_HOST}/${company}/${raw[1]}` };
}

/** The company a typed name or an address on jobs.smartrecruiters.com names, as written; '' for none. */
export function smartRecruitersCompany(input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (!text.includes('/') && !text.includes('.')) return COMPANY.test(text) && !RESERVED.has(text) ? text : '';
  const url = boardUrlOf(text);
  if (!url || boardHostOf(url) !== SMARTRECRUITERS_HOST) return '';
  const posting = smartRecruitersLinkOf(url);
  if (posting) return posting.company;
  const first = segments(url).decoded[0] ?? '';
  return COMPANY.test(first) && !RESERVED.has(first) ? first : '';
}

export const SMARTRECRUITERS_BOARD = defineBoard({
  kind: 'smartrecruiters',
  label: 'SmartRecruiters',
  row: { access: 'structured_data', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'smartrecruiters',
  hosts: String.raw`^jobs\.smartrecruiters\.com$`,
  domains: ['smartrecruiters.com'],
  atsKind: 'smartrecruiters',
  configKey: 'company',
  boardWords: 'SmartRecruiters company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  keepsCase: true, // {company} is case-sensitive
  boardOf: smartRecruitersCompany,
  configOfBoard: (board) => ({ company: board }),
  hostOf: (config) => (typeof config.company === 'string' && smartRecruitersCompany(config.company) ? SMARTRECRUITERS_HOST : null),
  cleanLink: (url) => smartRecruitersLinkOf(url)?.clean ?? null,
  // SP v38 PLAN A4: one request at a time to SmartRecruiters (its one host is the lane's).
  lane: { key: 'smartrecruiters.lane', label: 'SmartRecruiters (all companies)', name: 'SmartRecruiters' },
  detail: (config) => (configWords(config, 'company') ? `Company ${configWords(config, 'company')}` : null),
  examples: [
    {
      link: 'https://jobs.smartrecruiters.com/AcmeRobotics1/744000100000001-robotics-engineer?oga=true&jr_id=0a1b2c3d4e5f',
      clean: 'https://jobs.smartrecruiters.com/AcmeRobotics1/744000100000001-robotics-engineer',
      board: 'AcmeRobotics1',
      externalId: '744000100000001',
      found: null, // links only: discovery finds no SmartRecruiters board
    },
    {
      link: 'https://jobs.smartrecruiters.com/oneclick-ui/company/AcmeRobotics1/publication/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d?dcr_ci=AcmeRobotics1&jr_id=0a1b',
      clean: 'https://jobs.smartrecruiters.com/oneclick-ui/company/AcmeRobotics1/publication/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      board: 'AcmeRobotics1',
      externalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      found: null,
    },
  ],
});
