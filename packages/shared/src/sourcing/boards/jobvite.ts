import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, boardUrlOf, configWords } from './url';

// v38 ATS-C (SP v38 PLAN A2, "Final coverage" row 8): a company's Jobvite board, jobs.jobvite.com/<company>. A posting's
// link is /<company>/job/<jobId> (the id is 8 letters and digits, case-sensitive) and its application /.../apply; the
// clean link drops /apply and the query (REQUEST.md). The board's list is /<company>/jobs (HTML tables by category, no
// paging), each posting's page carries one schema.org JobPosting (the API's adapters/jobvite.ts).

/** Jobvite's candidate host. */
export const JOBVITE_HOST = 'jobs.jobvite.com';
/** A company's name and a posting's id as the links write them (the extension's rules: autofill lookup.ts). */
const COMPANY = /^[A-Za-z0-9-]{1,100}$/;
const JOB_ID = /^[A-Za-z0-9]{1,40}$/;
/** First segments of the host that are no company. */
const NOT_A_COMPANY: ReadonlySet<string> = new Set(['careers', 'api', 'static', 'assets', '__assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'jobvite']);

/** The posting a link on jobs.jobvite.com names: its company (as written), its id and its clean link; or null. */
export function jobviteLinkOf(url: BoardUrl): { company: string; id: string; clean: string } | null {
  if (boardHostOf(url) !== JOBVITE_HOST) return null;
  const [company, job, id, ...rest] = boardSegmentsOf(url);
  if (!company || job !== 'job' || !id || !COMPANY.test(company) || NOT_A_COMPANY.has(company.toLowerCase()) || !JOB_ID.test(id)) return null;
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== 'apply')) return null;
  return { company, id, clean: `https://${JOBVITE_HOST}/${company}/job/${id}` };
}

/** The company an address on jobs.jobvite.com names (/<company>/..., /careers/<company>/...), as written; null for none. */
function companyOfParts(parts: readonly string[]): string | null {
  const name = parts[0]?.toLowerCase() === 'careers' ? parts[1] : parts[0];
  return name && COMPANY.test(name) && !NOT_A_COMPANY.has(name.toLowerCase()) ? name : null;
}

/** The company a typed name or an address on jobs.jobvite.com names, in lower case; '' for none. */
export function jobviteCompany(input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (!text.includes('/') && !text.includes('.')) return COMPANY.test(text) && !NOT_A_COMPANY.has(text.toLowerCase()) ? text.toLowerCase() : '';
  const url = boardUrlOf(text);
  if (!url || boardHostOf(url) !== JOBVITE_HOST) return '';
  return companyOfParts(boardSegmentsOf(url))?.toLowerCase() ?? '';
}

export const JOBVITE_BOARD = defineBoard({
  kind: 'jobvite',
  label: 'Jobvite',
  row: { access: 'structured_data', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'jobvite',
  hosts: String.raw`^jobs\.jobvite\.com$`,
  domains: ['jobvite.com'],
  atsKind: 'jobvite',
  configKey: 'company',
  boardWords: 'Jobvite company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: jobviteCompany,
  configOfBoard: (board) => ({ company: board }),
  hostOf: (config) => (typeof config.company === 'string' && jobviteCompany(config.company) ? JOBVITE_HOST : null),
  // The company's own pages: its list (/<company>/jobs), a posting (/<company>/job/<id>), the error page Jobvite sends a
  // gone posting to (/careers/<company>/jobs).
  boardOfUrl: (url, parts) => {
    if (boardHostOf(url) !== JOBVITE_HOST) return null;
    const company = companyOfParts(parts);
    const at = parts[0]?.toLowerCase() === 'careers' ? 2 : 1;
    return company && (parts.length === at || ['job', 'jobs'].includes(parts[at] ?? '')) ? company : null;
  },
  cleanLink: (url) => jobviteLinkOf(url)?.clean ?? null,
  // SP v38 PLAN A4: one request at a time to Jobvite (its one host is the lane's).
  lane: { key: 'jobvite.lane', label: 'Jobvite (all companies)', name: 'Jobvite' },
  addSource: {
    field: 'company',
    label: 'Company on Jobvite',
    hint: 'The name in jobs.jobvite.com/<name>, or any page of its jobs.',
    placeholder: 'https://jobs.jobvite.com/acme/jobs',
    help: "Reads the company's job list and each job's page on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in jobs.jobvite.com/<name>, or an address on it.',
    required: "Enter the company's Jobvite name or its jobs page's address.",
    refusal: "Enter the company's name on Jobvite, or an address on jobs.jobvite.com/<name>.",
    refusalField: 'Enter the name in jobs.jobvite.com/<name>, or its address.',
    what: 'Jobvite company',
    boardOfInput: (input) => jobviteCompany(input) || null,
  },
  detail: (config) => (configWords(config, 'company') ? `Company ${configWords(config, 'company')} (jobs.jobvite.com/${configWords(config, 'company')})` : null),
  examples: [
    {
      link: 'https://jobs.jobvite.com/acme-robotics/job/oAb3Cd4E/apply?nl=1&nl=1&fr=false&utm_source=Newsletter',
      clean: 'https://jobs.jobvite.com/acme-robotics/job/oAb3Cd4E',
      board: 'acme-robotics',
      externalId: 'oAb3Cd4E',
      found: 'acme-robotics',
    },
  ],
});
