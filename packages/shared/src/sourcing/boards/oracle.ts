import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, boardUrlOf, configWords } from './url';

// v38 ATS-B: Oracle Recruiting Cloud career sites (SP v38 REQUEST.md 19, EVIDENCE.md §19; the API's adapters/oracle.ts).
// A board is one career site of one tenant: <host>/<site>, the tenant's host (<tenant>.fa.<region>.oraclecloud.com, or
// Oracle's government cloud) in lower case and the site's code (CX_1). A posting's id is the number at its link's end.
// A source's config names it in one value, { site: "<host>/<SITE>" } (Add source's field and an edit read it whole).
// v38 FIX-A (SP v38 FIXES-38 D5, REVIEW38-beh M8): the site's code keeps its case as written (the extension's lookup
// writes it in capitals, as Oracle's pages do; whether Oracle's finder reads another case was never checked, and its
// `items: []` closes): it is read so, and its sources are looked up in any case.

/** Oracle Recruiting Cloud's tenant hosts (the extension's lookup's ORACLE_HOST; it reads the same in PostgreSQL). */
export const ORACLE_HOSTS = String.raw`^[a-z0-9-]+\.fa(?:(?:\.[a-z0-9-]+)?\.oraclecloud|\.ocs\.oraclegovcloud)\.com$`;
const ORACLE_HOST = new RegExp(ORACLE_HOSTS);

/** Whether a host (lower case, a trailing dot allowed) is an Oracle Recruiting Cloud tenant's. */
export const isOracleHost = (host: string) => ORACLE_HOST.test(host.toLowerCase().replace(/\.+$/, ''));

/** The Candidate Experience's path, a site's language, a site's code and a posting's id (the lookup's rules). */
const ROOT = ['hcmUI', 'CandidateExperience'] as const;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const SITE = /^[A-Za-z0-9_-]{1,40}$/;
export const ORACLE_POSTING_ID = /^\d{1,15}$/;
/** The pages after a posting's id that are its application (the apply flow, the quick apply's). */
const APPLY_TAILS: ReadonlySet<string> = new Set(['apply', 'easy-apply']);

/** One tenant's career site: its host (lower case) and its site code (as written: v38 FIX-A). */
export interface OracleSite {
  host: string;
  siteNumber: string;
}

/** The site a path names: /hcmUI/CandidateExperience/<lang>/sites/<site>/...; null for none. */
function sitePartsOf(parts: readonly string[]): { language: string; site: string; rest: string[] } | null {
  const [hcm, experience, language, sites, site, ...rest] = parts;
  if (hcm !== ROOT[0] || experience !== ROOT[1] || sites !== 'sites') return null;
  if (!language || !LANGUAGE.test(language) || !site || !SITE.test(site)) return null;
  return { language, site, rest };
}

/**
 * The career site a board's name ("<host>/<site>") or any address of it names (a posting, the site's search page...);
 * null for none (another host, an address naming no site).
 */
export function oracleSiteOf(input: string): OracleSite | null {
  const text = input.trim();
  if (!text) return null;
  const bare = /^([a-z0-9.-]+)\/([A-Za-z0-9_-]{1,40})$/i.exec(text);
  if (bare) {
    const host = bare[1]!.toLowerCase().replace(/\.+$/, '');
    return isOracleHost(host) ? { host, siteNumber: bare[2]! } : null; // v38 FIX-A (D5): as written
  }
  const url = boardUrlOf(text);
  if (!url) return null;
  const host = boardHostOf(url);
  const site = isOracleHost(host) ? sitePartsOf(boardSegmentsOf(url)) : null;
  return site ? { host, siteNumber: site.site } : null; // v38 FIX-A (D5): as written
}

/** A career site's board name, <host>/<SITE>; '' when the input names none. */
export function oracleBoardOf(input: string): string {
  const site = oracleSiteOf(input);
  return site ? `${site.host}/${site.siteNumber}` : '';
}

/** The career site a source's config names ({ site: "<host>/<SITE>" }), or null. */
export function oracleSiteOfConfig(config: Record<string, unknown>): OracleSite | null {
  return typeof config.site === 'string' ? oracleSiteOf(config.site) : null;
}

/** A posting's clean link: https://<host>/hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>. */
export const oraclePostingUrl = (host: string, language: string, site: string, id: string) =>
  `https://${host}/${ROOT.join('/')}/${language}/sites/${site}/job/${id}`;

/**
 * The posting a link names on a tenant's host (/…/sites/<site>/job/<id>, or /…/requisitions/preview/<id>, then nothing or
 * its application's pages), with its language and site as written; null for any other page.
 */
export function oraclePostingOf(url: BoardUrl): { host: string; language: string; site: string; id: string } | null {
  const host = boardHostOf(url);
  if (!isOracleHost(host)) return null;
  const site = sitePartsOf(boardSegmentsOf(url));
  if (!site) return null;
  const at = site.rest[0] === 'job' ? 1 : site.rest[0] === 'requisitions' && site.rest[1] === 'preview' ? 2 : 0;
  const id = at ? site.rest[at] : undefined;
  const tail = site.rest.slice(at + 1);
  if (!id || !ORACLE_POSTING_ID.test(id) || (tail.length > 0 && !APPLY_TAILS.has(tail[0]!))) return null;
  return { host, language: site.language, site: site.site, id };
}

export const ORACLE_BOARD = defineBoard({
  kind: 'oracle',
  label: 'Oracle Recruiting Cloud',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'oracle',
  hosts: ORACLE_HOSTS,
  domains: ['oraclecloud.com', 'oraclegovcloud.com'],
  atsKind: 'oracle',
  configKey: 'site',
  boardWords: 'Oracle career site',
  configSchema: z.strictObject({ site: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  // The site's code keeps its case (v38 FIX-A: as written; the API's finder reads it so).
  keepsCase: true,
  boardOf: oracleBoardOf,
  configOfBoard: (board) => ({ site: oracleBoardOf(board) || board }),
  hostOf: (config) => oracleSiteOfConfig(config)?.host ?? null,
  boardOfUrl: (url, parts) => {
    const host = boardHostOf(url);
    const site = isOracleHost(host) ? sitePartsOf(parts) : null;
    return site ? `${host}/${site.site}` : null; // v38 FIX-A (D5): as written
  },
  // REQUEST.md 19: /hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>, no query (a preview's or an application's
  // page is its posting's).
  cleanLink: (url) => {
    const posting = oraclePostingOf(url);
    return posting ? oraclePostingUrl(posting.host, posting.language, posting.site, posting.id) : null;
  },
  // Every tenant's pod answers from Oracle's cloud: one request at a time to all of Oracle Recruiting Cloud.
  lane: { key: 'oracle.lane', label: 'Oracle Recruiting Cloud (all sites)', name: 'Oracle Recruiting Cloud' },
  // A career site an admin turned on before v3.8 on a tenant's host stays its source (migration 0066 converts the rest).
  adoptsCareerSites: true,
  addSource: {
    field: 'site',
    label: 'Oracle career site',
    hint: 'Any page of the career site, with /sites/<site> in its address.',
    placeholder: 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1',
    help: "Reads the site's job list and each job's details on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter an address on <name>.fa.<region>.oraclecloud.com that names the site (/sites/CX_1).',
    required: "Enter the career site's address.",
    refusal: 'Enter a page of the Oracle career site: an address on <name>.fa.<region>.oraclecloud.com with /sites/<site> in it.',
    refusalField: 'Enter an address that names the site (/sites/CX_1).',
    what: 'Oracle career site',
    inputMode: 'url',
    companyHint: "Oracle's jobs rarely name the company: TailorIT reads it from the site's list when it can. Type it to choose it yourself.",
  },
  detail: (config) => {
    const site = oracleSiteOfConfig(config);
    return site ? `Site ${site.siteNumber} on ${site.host}` : configWords(config, 'site') || null;
  },
  examples: [
    {
      link: 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/104233?utm_source=linkedin&utm_medium=jobboard',
      clean: 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/104233',
      board: 'CX_1',
      externalId: '104233',
      found: 'acme.fa.us2.oraclecloud.com/CX_1',
    },
    {
      link: 'https://fa-acme-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/requisitions/preview/77/apply/section/1',
      clean: 'https://fa-acme-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/job/77',
      board: 'CX_2',
      externalId: '77',
      found: 'fa-acme-saasfaprod1.fa.ocs.oraclecloud.com/CX_2',
    },
  ],
});
