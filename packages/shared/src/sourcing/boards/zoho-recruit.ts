import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped, SERVICE_LABELS } from './url';

// v38 ATS-B: Zoho Recruit careers sites (SP v38 REQUEST.md 12, EVIDENCE.md §12; the API's adapters/zohoRecruit.ts). A
// board is one company's careers host, <company>.zohorecruit.com or a regional one (.eu, .in, .com.au), in lower case;
// its jobs are at /jobs/<portal>/<id>/<slug> (the portal is "Careers" on most sites; <id> a long number). A company's own
// domain in front of Zoho Recruit is not recognised (nothing in its address says it is Zoho's).

/** Zoho Recruit's careers hosts: one DNS label under zohorecruit.com and its regional domains. */
export const ZOHO_RECRUIT_HOSTS = String.raw`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.zohorecruit\.(?:com|eu|in|com\.au)$`;
const ZOHO_HOST = new RegExp(ZOHO_RECRUIT_HOSTS);
/** The portal a board's list is read from (its careers site's own: /jobs/Careers). */
export const ZOHO_RECRUIT_PORTAL = 'Careers';
/** A job's id as its address writes it. */
export const ZOHO_JOB_ID = /^\d{6,25}$/;
const PORTAL = /^[A-Za-z0-9_-]{1,60}$/;

/** Whether a host (lower case) is a company's Zoho Recruit careers host (never Zoho's own www, recruit, ... hosts). */
export function isZohoRecruitHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  return ZOHO_HOST.test(name) && !SERVICE_LABELS.has(name.split('.')[0]!) && name.split('.')[0] !== 'recruit';
}

/**
 * The careers host a typed name or any address names ("acme", "acme.zohorecruit.eu", https://acme.zohorecruit.com/jobs/
 * Careers): a bare name is on zohorecruit.com; '' for none.
 */
export function zohoRecruitHostOf(input: string): string {
  const typed = hostOfTyped(input);
  if (!typed) return '';
  const host = typed.includes('.') ? typed : DNS_LABEL.test(typed) ? `${typed}.zohorecruit.com` : '';
  return host && isZohoRecruitHost(host) ? host : '';
}

/** The job a link names: /jobs/<portal>/<id>[/<slug>], with its portal and slug as written; null for any other page. */
export function zohoRecruitJobOf(url: BoardUrl): { host: string; portal: string; id: string; slug: string | null } | null {
  const host = boardHostOf(url);
  if (!isZohoRecruitHost(host)) return null;
  const [jobs, portal, id, slug] = boardSegmentsOf(url);
  if (jobs !== 'jobs' || !portal || !PORTAL.test(portal) || !id || !ZOHO_JOB_ID.test(id)) return null;
  return { host, portal, id, slug: slug && /^[^/?#\s]{1,300}$/.test(slug) ? slug : null };
}

/** A job's clean link: https://<host>/jobs/<portal>/<id>/<slug> (its slug when it has one). */
export function zohoRecruitJobUrl(host: string, portal: string, id: string, slug: string | null): string {
  return `https://${host}/jobs/${encodeURIComponent(portal)}/${id}${slug ? `/${encodeURIComponent(slug)}` : ''}`;
}

export const ZOHO_RECRUIT_BOARD = defineBoard({
  kind: 'zoho_recruit',
  label: 'Zoho Recruit',
  row: { access: 'structured_data', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'zohorecruit',
  hosts: ZOHO_RECRUIT_HOSTS,
  domains: ['zohorecruit.com', 'zohorecruit.eu', 'zohorecruit.in', 'zohorecruit.com.au'],
  // { site: "<company>.zohorecruit.com" }: the careers site's host.
  configKey: 'site',
  boardWords: 'Zoho Recruit careers site',
  configSchema: z.strictObject({ site: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: zohoRecruitHostOf,
  configOfBoard: (board) => ({ site: board }),
  hostOf: (config) => zohoRecruitHostOf(typeof config.site === 'string' ? config.site : '') || null,
  // A careers host's jobs pages name it (its other pages are the company's staff's).
  boardOfUrl: (url, parts) => {
    const host = boardHostOf(url);
    return isZohoRecruitHost(host) && ['jobs', 'careers'].includes(parts[0]?.toLowerCase() ?? '') ? host : null;
  },
  parseLink: (url) => {
    const job = zohoRecruitJobOf(url);
    return job ? { board: job.host, externalId: job.id, canonical: [zohoRecruitJobUrl(job.host, job.portal, job.id, job.slug)] } : null;
  },
  // REQUEST.md 12: /jobs/<portal>/<id>/<slug>, no query (and nothing after the slug).
  cleanLink: (url) => {
    const job = zohoRecruitJobOf(url);
    return job ? zohoRecruitJobUrl(job.host, job.portal, job.id, job.slug) : null;
  },
  // Every company's site answers from Zoho's servers: one request at a time to all of Zoho Recruit.
  lane: { key: 'zohorecruit.lane', label: 'Zoho Recruit (all companies)', name: 'Zoho Recruit' },
  addSource: {
    field: 'site',
    label: 'Zoho Recruit careers site',
    hint: "The careers site's address, such as acme.zohorecruit.com (or .eu, .in, .com.au).",
    placeholder: 'acme.zohorecruit.com',
    help: "Reads the careers site's job list (and a job's own page when the list leaves out its text) on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter an address on <name>.zohorecruit.com (or .eu, .in, .com.au).',
    required: "Enter the careers site's address (acme.zohorecruit.com).",
    refusal: "Enter the Zoho Recruit careers site's address, such as acme.zohorecruit.com.",
    refusalField: 'Enter an address on <name>.zohorecruit.com.',
    what: 'Zoho Recruit careers site',
    inputMode: 'url',
  },
  detail: (config) => (configWords(config, 'site') ? `Careers site ${configWords(config, 'site')}` : null),
  examples: [
    {
      link: 'https://acme-robotics.zohorecruit.com/jobs/Careers/700000000001234567/Robotics-Engineer?source=CareerSite',
      clean: 'https://acme-robotics.zohorecruit.com/jobs/Careers/700000000001234567/Robotics-Engineer',
      board: 'acme-robotics.zohorecruit.com',
      externalId: '700000000001234567',
      found: 'acme-robotics.zohorecruit.com',
    },
    {
      link: 'https://globex.zohorecruit.eu/jobs/Careers/600000000000004242/Data-Analyst/?utm_source=x',
      clean: 'https://globex.zohorecruit.eu/jobs/Careers/600000000000004242/Data-Analyst',
      board: 'globex.zohorecruit.eu',
      externalId: '600000000000004242',
      found: 'globex.zohorecruit.eu',
    },
  ],
});
