import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardUrlOf, configWords } from './url';

// v38 ATS-C (SP v38 PLAN A2, "Final coverage" row 22): a company's Avature careers site, <tenant>.avature.net/<locale>/
// <portal> (the portal differs by site: "careers", "CollegeRecruiting"...). A posting's link is
// /<locale>/<portal>/JobDetail/<slug>/<jobId>; its clean link drops the query (REQUEST.md). The site's list is its
// SearchJobs page, followed by its "next" links; each posting's page is server-rendered (the API's adapters/avature.ts).
// The extension's contract does not know Avature: its links are read by parseLink here.
//
// A board is named `<host>/<locale>/<portal>` (or `<host>/<portal>` for a site without a locale), its host in lower case,
// its locale and portal as written: the source's `site`.

/** A company's Avature host: <tenant>.avature.net, never www. */
export const AVATURE_HOSTS = String.raw`^(?!www\.)[a-z0-9-]+\.avature\.net$`;
const AVATURE_HOST = new RegExp(AVATURE_HOSTS);
const LOCALE = /^[a-z]{2}[_-][A-Za-z]{2}$/;
const PORTAL = /^[A-Za-z0-9_-]{1,60}$/;
const JOB_ID = /^\d{1,12}$/;
/** A site's own pages after its portal: a posting's, the job search. */
const SITE_PAGES: ReadonlySet<string> = new Set(['jobdetail', 'searchjobs']);

/** A path's segments as written (still encoded). */
const rawSegments = (url: Pick<BoardUrl, 'pathname'>) => url.pathname.split('/').filter(Boolean);

/** The site a path's segments before its page name (`[locale, portal]` or `[portal]`), or null. */
function siteOfPrefix(host: string, prefix: readonly string[]): string | null {
  if (prefix.length === 1 && PORTAL.test(prefix[0]!) && !SITE_PAGES.has(prefix[0]!.toLowerCase())) return `${host}/${prefix[0]}`;
  if (prefix.length === 2 && LOCALE.test(prefix[0]!) && PORTAL.test(prefix[1]!) && !SITE_PAGES.has(prefix[1]!.toLowerCase())) {
    return `${host}/${prefix[0]}/${prefix[1]}`;
  }
  return null;
}

/** An Avature posting a link names: its site (the board), its id and its clean link; or null. */
export function avatureLinkOf(url: BoardUrl): { site: string; id: string; clean: string } | null {
  const host = boardHostOf(url);
  if (!AVATURE_HOST.test(host)) return null;
  const parts = rawSegments(url);
  const at = parts.findIndex((part) => part.toLowerCase() === 'jobdetail');
  if (at < 1 || at > 2) return null;
  const site = siteOfPrefix(host, parts.slice(0, at));
  const rest = parts.slice(at + 1);
  const id = rest.at(-1);
  if (!site || !id || !JOB_ID.test(id) || rest.length > 2) return null;
  return { site, id, clean: `https://${site}/JobDetail/${rest.join('/')}` };
}

/** The site an address on an Avature host names (a posting's page, its job search, the portal's own page), or null. */
function siteOfUrl(url: BoardUrl): string | null {
  const host = boardHostOf(url);
  if (!AVATURE_HOST.test(host)) return null;
  const parts = rawSegments(url);
  const at = parts.findIndex((part) => SITE_PAGES.has(part.toLowerCase()));
  if (at < 0) return null;
  return siteOfPrefix(host, parts.slice(0, at));
}

/**
 * The site a typed address or name names (`acme.avature.net/en_US/careers`, any page of it: its job search, a posting);
 * '' for none (a host alone names no portal).
 */
export function avatureSite(input: string): string {
  const text = input.trim();
  if (!text.includes('/')) return '';
  const url = boardUrlOf(text);
  if (!url) return '';
  const known = siteOfUrl(url);
  if (known) return known;
  const host = boardHostOf(url);
  return AVATURE_HOST.test(host) ? (siteOfPrefix(host, rawSegments(url)) ?? '') : '';
}

/** A site's host (`acme.avature.net/en_US/careers`: acme.avature.net), or null. */
export function avatureHostOf(site: string): string | null {
  const host = site.split('/')[0]?.toLowerCase() ?? '';
  return AVATURE_HOST.test(host) ? host : null;
}

export const AVATURE_BOARD = defineBoard({
  kind: 'avature',
  label: 'Avature',
  row: { access: 'structured_data', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'avature',
  hosts: AVATURE_HOSTS,
  domains: ['avature.net'],
  configKey: 'site',
  boardWords: 'Avature careers site',
  configSchema: z.strictObject({ site: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  keepsCase: true, // the locale and the portal as written
  boardOf: avatureSite,
  configOfBoard: (board) => ({ site: board }),
  hostOf: (config) => (typeof config.site === 'string' && avatureSite(config.site) ? avatureHostOf(config.site) : null),
  boardOfUrl: (url) => siteOfUrl(url),
  parseLink: (url) => {
    const found = avatureLinkOf(url);
    return found ? { board: found.site, externalId: found.id, canonical: [found.clean] } : null;
  },
  cleanLink: (url) => avatureLinkOf(url)?.clean ?? null,
  // SP v38 PLAN A4: one request at a time to all of Avature (every site's host is Avature's).
  lane: { key: 'avature.lane', label: 'Avature (all sites)', name: 'Avature' },
  addSource: {
    field: 'site',
    label: 'Avature careers site',
    hint: "Its job search page's address, such as acme.avature.net/en_US/careers/SearchJobs.",
    placeholder: 'https://acme.avature.net/en_US/careers/SearchJobs',
    help: "Reads the site's job search pages and each job's page on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter an address on <name>.avature.net that names the site, such as its job search page.',
    required: "Enter the Avature site's job search address.",
    refusal: "Enter the Avature site's job search address, such as acme.avature.net/en_US/careers/SearchJobs.",
    refusalField: 'Enter its job search address on <name>.avature.net.',
    what: 'Avature careers site',
    inputMode: 'url',
    boardOfInput: (input) => avatureSite(input) || null,
  },
  detail: (config) => (configWords(config, 'site') ? `Careers site ${configWords(config, 'site')}` : null),
  examples: [
    {
      link: 'https://acmeworks.avature.net/en_US/careers/JobDetail/Austin-Texas-United-States-Robotics-Engineer/204417?jr_id=0a1b2c3d&utm_source=Newsletter',
      clean: 'https://acmeworks.avature.net/en_US/careers/JobDetail/Austin-Texas-United-States-Robotics-Engineer/204417',
      board: 'acmeworks.avature.net/en_US/careers',
      externalId: '204417',
      found: 'acmeworks.avature.net/en_US/careers',
    },
  ],
});
