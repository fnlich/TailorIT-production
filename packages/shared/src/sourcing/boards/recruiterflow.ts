import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, boardUrlOf, configWords } from './url';

// v38 ATS-B: Recruiterflow job boards (SP v38 REQUEST.md 14, EVIDENCE.md §14; the API's adapters/recruiterflow.ts). A
// board is one company's (mostly a recruiting agency's) page, recruiterflow.com/<company>/jobs (its path); a job is
// /<company>/jobs/<id>, <id> a number.
// v38 FIX-A (SP v38 FIXES-38 D5, REVIEW38-beh M8): the company's path keeps its case as written (whether Recruiterflow
// reads it in any case was never checked): it is read so, and its sources are looked up in any case.

/** Recruiterflow's host. */
export const RECRUITERFLOW_HOST = 'recruiterflow.com';
const RECRUITERFLOW_HOSTS = String.raw`^(?:www\.)?recruiterflow\.com$`;
const COMPANY = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
export const RECRUITERFLOW_JOB_ID = /^\d{1,12}$/;
/** Recruiterflow's own first path segments (its site's pages), never a company's. */
const OWN_PATHS: ReadonlySet<string> = new Set(['api', 'static', 'blog', 'pricing', 'features', 'login', 'signup', 'integrations', 'resources', 'legal', 'about']);

const isRecruiterflowHost = (host: string) => new RegExp(RECRUITERFLOW_HOSTS).test(host);

/** A company's path as written, when it is one (never one of Recruiterflow's own pages, in any case); '' for none. */
const companyPath = (segment: string | undefined) => {
  const company = segment?.trim() ?? '';
  return COMPANY.test(company) && !OWN_PATHS.has(company.toLowerCase()) ? company : '';
};

/** The company a typed name or any address of its board names ("acme", https://recruiterflow.com/acme/jobs/12); '' for none. */
export function recruiterflowCompanyOf(input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (!text.includes('/') && !text.includes('.')) return companyPath(text);
  const url = boardUrlOf(text);
  if (!url || !isRecruiterflowHost(boardHostOf(url))) return '';
  const [company, jobs] = boardSegmentsOf(url);
  return jobs === 'jobs' ? companyPath(company) : '';
}

/** The job a link names: /<company>/jobs/<id>; null for any other page. */
export function recruiterflowJobOf(url: BoardUrl): { company: string; id: string } | null {
  if (!isRecruiterflowHost(boardHostOf(url))) return null;
  const [company, jobs, id, ...rest] = boardSegmentsOf(url);
  const name = companyPath(company);
  return name && jobs === 'jobs' && id && RECRUITERFLOW_JOB_ID.test(id) && rest.length === 0 ? { company: name, id } : null;
}

/** A job's clean link: https://recruiterflow.com/<company>/jobs/<id>. */
export const recruiterflowJobUrl = (company: string, id: string) => `https://${RECRUITERFLOW_HOST}/${company}/jobs/${id}`;

export const RECRUITERFLOW_BOARD = defineBoard({
  kind: 'recruiterflow',
  label: 'Recruiterflow',
  row: { access: 'structured_data', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'recruiterflow',
  hosts: RECRUITERFLOW_HOSTS,
  domains: ['recruiterflow.com'],
  configKey: 'company',
  boardWords: 'Recruiterflow board',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  keepsCase: true, // v38 FIX-A (D5): read as written, looked up in any case
  boardOf: recruiterflowCompanyOf,
  configOfBoard: (board) => ({ company: board }),
  // One host for every company.
  hostOf: (config) => (recruiterflowCompanyOf(typeof config.company === 'string' ? config.company : '') ? RECRUITERFLOW_HOST : null),
  // v38 FIX-A (SP v38 FIXES-38 D4, REVIEW38-beh M12): one request at a time to recruiterflow.com, at the lanes' pace
  // (LANE_DEFAULT_MIN_INTERVAL_MS), as every v3.8 platform.
  lane: { key: 'recruiterflow.lane', label: 'Recruiterflow (all boards)', name: 'Recruiterflow' },
  boardOfUrl: (url, parts) => (isRecruiterflowHost(boardHostOf(url)) && parts[1] === 'jobs' ? companyPath(parts[0]) || null : null),
  parseLink: (url) => {
    const job = recruiterflowJobOf(url);
    return job ? { board: job.company, externalId: job.id, canonical: [recruiterflowJobUrl(job.company, job.id)] } : null;
  },
  // REQUEST.md 14: /<company>/jobs/<id>, no query.
  cleanLink: (url) => {
    const job = recruiterflowJobOf(url);
    return job ? recruiterflowJobUrl(job.company, job.id) : null;
  },
  addSource: {
    field: 'company',
    label: 'Company on Recruiterflow',
    hint: "The name in recruiterflow.com/<name>/jobs, or its jobs page's address.",
    placeholder: 'https://recruiterflow.com/acme/jobs',
    help: "Reads the board's job list and each job's page on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in recruiterflow.com/<name>/jobs, or an address on it.',
    required: "Enter the company's Recruiterflow name or jobs page address.",
    refusal: "Enter the company's name on Recruiterflow, or its jobs page's address (recruiterflow.com/<name>/jobs).",
    refusalField: 'Enter the name in recruiterflow.com/<name>/jobs.',
    what: 'Recruiterflow board',
  },
  detail: (config) => (configWords(config, 'company') ? `Board ${configWords(config, 'company')} (recruiterflow.com/${configWords(config, 'company')}/jobs)` : null),
  examples: [
    {
      link: 'https://recruiterflow.com/acmetalent/jobs/4321?jr_id=6af000000000000000000001&ref=board',
      clean: 'https://recruiterflow.com/acmetalent/jobs/4321',
      board: 'acmetalent',
      externalId: '4321',
      found: 'acmetalent',
    },
  ],
});
