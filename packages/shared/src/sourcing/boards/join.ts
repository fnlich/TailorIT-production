import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, boardUrlOf, configWords } from './url';

// v38 ATS-B: Join.com companies (SP v38 REQUEST.md 13, EVIDENCE.md §13; the API's adapters/join.ts). A board is one
// company's page, join.com/companies/<company> (its slug, lower case); a job is /companies/<company>/<id>-<slug>, <id> a
// number. The short form join.com/jobs/<id> loads the same job but names no company: it reads as the job's page.

/** Join.com's host. */
export const JOIN_HOST = 'join.com';
const JOIN_HOSTS = String.raw`^(?:www\.)?join\.com$`;
const COMPANY = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** A job's segment: its id, then its slug. */
const JOB_SEGMENT = /^(\d{1,15})(?:-[^/?#\s]{0,300})?$/;

/** The company a typed name or any address on join.com names ("acme", https://join.com/companies/acme/123-x); '' for none. */
export function joinCompanyOf(input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (!text.includes('/') && !text.includes('.')) return COMPANY.test(text.toLowerCase()) ? text.toLowerCase() : '';
  const url = boardUrlOf(text);
  if (!url || !new RegExp(JOIN_HOSTS).test(boardHostOf(url))) return '';
  const [companies, company] = boardSegmentsOf(url);
  return companies === 'companies' && company && COMPANY.test(company.toLowerCase()) ? company.toLowerCase() : '';
}

/** The job a link names: /companies/<company>/<id>-<slug> (or the short /jobs/<id>, which names no company); null for none. */
export function joinJobOf(url: BoardUrl): { company: string | null; id: string; segment: string } | null {
  if (!new RegExp(JOIN_HOSTS).test(boardHostOf(url))) return null;
  const parts = boardSegmentsOf(url);
  if (parts[0] === 'companies' && parts.length === 3) {
    const company = parts[1]!.toLowerCase();
    const job = JOB_SEGMENT.exec(parts[2]!);
    return COMPANY.test(company) && job ? { company, id: job[1]!, segment: parts[2]! } : null;
  }
  if (parts[0] === 'jobs' && parts.length === 2) {
    const job = JOB_SEGMENT.exec(parts[1]!);
    return job ? { company: null, id: job[1]!, segment: parts[1]! } : null;
  }
  return null;
}

/** A job's clean link: https://join.com/companies/<company>/<id>-<slug> (or https://join.com/jobs/<id> for the short form). */
export function joinJobUrl(company: string | null, segment: string): string {
  return company ? `https://${JOIN_HOST}/companies/${company}/${encodeURIComponent(segment)}` : `https://${JOIN_HOST}/jobs/${encodeURIComponent(segment)}`;
}

export const JOIN_BOARD = defineBoard({
  kind: 'join',
  label: 'Join.com',
  row: { access: 'structured_data', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'join',
  hosts: JOIN_HOSTS,
  domains: ['join.com'],
  configKey: 'company',
  boardWords: 'Join.com company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: joinCompanyOf,
  configOfBoard: (board) => ({ company: board }),
  // One host for every company.
  hostOf: (config) => (joinCompanyOf(typeof config.company === 'string' ? config.company : '') ? JOIN_HOST : null),
  // v38 FIX-A (SP v38 FIXES-38 D4, REVIEW38-beh M12): one request at a time to join.com, at the lanes' pace
  // (LANE_DEFAULT_MIN_INTERVAL_MS), as every v3.8 platform.
  lane: { key: 'join.lane', label: 'Join.com (all companies)', name: 'Join.com' },
  boardOfUrl: (url, parts) => (parts[0] === 'companies' && parts[1] ? joinCompanyOf(`https://${JOIN_HOST}/companies/${parts[1]}`) || null : null),
  parseLink: (url) => {
    const job = joinJobOf(url);
    return job ? { board: job.company, externalId: job.id, canonical: [joinJobUrl(job.company, job.segment)] } : null;
  },
  // REQUEST.md 13: /companies/<company>/<id>-<slug>, no query (its ?pid= mark); the short form keeps its own path.
  cleanLink: (url) => {
    const job = joinJobOf(url);
    return job ? joinJobUrl(job.company, job.segment) : null;
  },
  addSource: {
    field: 'company',
    label: 'Company on Join.com',
    hint: "The name in join.com/companies/<name>, or its page's address.",
    placeholder: 'https://join.com/companies/acme',
    help: "Reads the company's job list and each job's page on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in join.com/companies/<name>, or an address on it.',
    required: "Enter the company's Join.com name or page address.",
    refusal: "Enter the company's name on Join.com, or its page's address (join.com/companies/<name>).",
    refusalField: 'Enter the name in join.com/companies/<name>.',
    what: 'Join.com company',
  },
  detail: (config) => (configWords(config, 'company') ? `Company ${configWords(config, 'company')} (join.com/companies/${configWords(config, 'company')})` : null),
  examples: [
    {
      link: 'https://join.com/companies/acme-robotics/12345678-senior-robotics-engineer?pid=0a0000000000000000aa',
      clean: 'https://join.com/companies/acme-robotics/12345678-senior-robotics-engineer',
      board: 'acme-robotics',
      externalId: '12345678',
      found: 'acme-robotics',
    },
    {
      link: 'https://join.com/jobs/12345679?utm_source=newsletter',
      clean: 'https://join.com/jobs/12345679',
      board: null,
      externalId: '12345679',
      found: null,
    },
  ],
});
