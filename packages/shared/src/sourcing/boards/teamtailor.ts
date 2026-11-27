import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { feedCompanyOf } from './feeds';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped } from './url';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 24; REQUEST.md 24, EVIDENCE.md 24): a company's Teamtailor careers site,
// <company>.teamtailor.com, read from its public JSON Feed (/jobs.json: each job's schema.org JobPosting, the company's
// name among it) and, for a job the feed does not list (an unlisted job is still open), the job's own page's JSON-LD.
// A company's own domain in front of Teamtailor stays a career site. The API's part:
// apps/api/src/features/ingest/boards/teamtailor.ts.

/** Teamtailor's own hosts' first labels (its app, API, help and marketing pages), never a company's. */
const TEAMTAILOR_OWN_LABELS: ReadonlySet<string> = new Set([
  'www', 'app', 'api', 'support', 'status', 'cdn', 'static', 'help', 'blog', 'docs', 'developer', 'developers', 'partner',
  'partners', 'assets', 'images', 'login', 'mail', 'marketplace', 'go', 'info',
]);

/** A job's path: /jobs/<number>[-<slug>], after an optional locale segment (/en/, /sv-SE/). */
const TEAMTAILOR_JOB_ID = /^(\d{1,12})(?:-[^/]*)?$/;
const TEAMTAILOR_LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

/** The company's name on Teamtailor as typed: a name or an address on <company>.teamtailor.com ('' for none). */
export function teamtailorCompany(input: string): string {
  const host = hostOfTyped(input);
  const label = host.includes('.') ? (host.endsWith('.teamtailor.com') ? host.slice(0, -'.teamtailor.com'.length) : '') : host;
  return label && DNS_LABEL.test(label) && !TEAMTAILOR_OWN_LABELS.has(label) ? label : '';
}

/** Add source's check under the field (the web's): the company a name or an address names, or null. */
export const teamtailorCompanyOfTyped = (input: string): string | null => teamtailorCompany(input) || null;

/** The job a Teamtailor address names: its company, its path (as written, no query) and its number; null for none. */
function teamtailorJobOf(url: BoardUrl): { company: string; path: string; id: string } | null {
  const company = teamtailorCompany(boardHostOf(url));
  if (!company) return null;
  const parts = boardSegmentsOf(url);
  const localized = parts.length === 3 && TEAMTAILOR_LOCALE.test(parts[0]!);
  const [jobs, job, ...rest] = localized ? parts.slice(1) : parts;
  const match = jobs === 'jobs' && job !== undefined && rest.length === 0 ? TEAMTAILOR_JOB_ID.exec(job) : null;
  if (!match) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return { company, path, id: match[1]! };
}

export const TEAMTAILOR_BOARD = defineBoard({
  kind: 'teamtailor',
  label: 'Teamtailor',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'teamtailor',
  hosts: String.raw`^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$`,
  domains: ['teamtailor.com'],
  configKey: 'company',
  boardWords: 'Teamtailor company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: teamtailorCompany,
  configOfBoard: (board) => ({ company: board }),
  hostOf: (config) => {
    const company = feedCompanyOf(config);
    return company && teamtailorCompany(company) ? `${company}.teamtailor.com` : null;
  },
  boardOfUrl: (url) => teamtailorCompany(boardHostOf(url)) || null,
  parseLink: (url) => {
    const job = teamtailorJobOf(url);
    return job ? { board: job.company, externalId: job.id, canonical: [`https://${job.company}.teamtailor.com${job.path}`] } : null;
  },
  // REQUEST.md: https://<host>/jobs/<number>-<slug>, the query dropped (the path kept as written: the number alone loads
  // the same job).
  cleanLink: (url) => {
    const job = teamtailorJobOf(url);
    return job ? `https://${job.company}.teamtailor.com${job.path}` : null;
  },
  // Every company's site is on Teamtailor's one service: one request at a time to all of it.
  lane: {
    key: 'teamtailor.lane',
    label: 'Teamtailor (all companies)',
    name: 'Teamtailor',
  },
  // v3.7's career sites on these hosts (migration 0065 converts the ones no admin turned on): one source per host.
  adoptsCareerSites: true,
  addSource: {
    field: 'company',
    label: 'Company on Teamtailor',
    hint: "The name in <name>.teamtailor.com, or its careers page's address.",
    placeholder: 'https://acme.teamtailor.com/jobs',
    help: "Reads the company's job feed, each job with its full text, on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in <name>.teamtailor.com, or an address on it.',
    required: "Enter the company's Teamtailor name or careers address.",
    refusal: "Enter the company's name on Teamtailor, or an address on <company>.teamtailor.com.",
    refusalField: 'Enter the name in <name>.teamtailor.com, or its address.',
    what: 'Teamtailor company',
    boardOfInput: teamtailorCompanyOfTyped,
  },
  detail: (config) =>
    configWords(config, 'company') ? `Company ${configWords(config, 'company')} (${configWords(config, 'company')}.teamtailor.com)` : null,
  examples: [
    {
      link: 'https://acme-robotics.teamtailor.com/jobs/1234567-senior-robotics-engineer?promotion=876543-linkedin',
      clean: 'https://acme-robotics.teamtailor.com/jobs/1234567-senior-robotics-engineer',
      board: 'acme-robotics',
      externalId: '1234567',
      found: 'acme-robotics',
    },
    {
      link: 'https://acme-robotics.teamtailor.com/jobs/1234567',
      clean: 'https://acme-robotics.teamtailor.com/jobs/1234567',
      board: 'acme-robotics',
      externalId: '1234567',
      found: 'acme-robotics',
    },
  ],
});
