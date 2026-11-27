import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { boardHostOf, configWords } from './url';
import { isWorkdayHost, WORKDAY_HOSTS, WORKDAY_LANE } from './workday';

// v38 FRAME: Workday career sites (v30 S3: each listed by its own sitemap, each posting read on its own; the API's
// adapters/workdaySite.ts). A board is <host>/<site> or <host>/recruiting/<tenant>/<site>: the host in lower case, the
// tenant and the site as written (v30 FIX-A: a site path's case is kept).

/**
 * A Workday career site's name: <host>/<site> or <host>/recruiting/<tenant>/<site>; '' when none. Lookups of a board
 * compare names in any case.
 */
export function workdaySiteName(input: string): string {
  const text = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const own = /^([a-z0-9-]+\.(?:wd\d{1,3}\.)?myworkdayjobs\.com)\/([a-z0-9_-]{1,100})$/i.exec(text);
  if (own && !/^(?:www|wd\d{1,3})\./i.test(own[1]!)) return `${own[1]!.toLowerCase()}/${own[2]}`;
  const shared = /^(wd\d{1,3}\.myworkdaysite\.com)\/recruiting\/([a-z0-9_-]{1,100})\/([a-z0-9_-]{1,100})$/i.exec(text);
  return shared ? `${shared[1]!.toLowerCase()}/recruiting/${shared[2]}/${shared[3]}` : '';
}

/**
 * A Workday career site's source config from its name: its host, tenant and site, as the API's adapters/workdaySite.ts
 * reads them (`careerSite` as written; the tenant is the host's first label on a tenant host, in lower case as the
 * adapter checks it against the host).
 */
export function workdaySiteConfig(name: string): Record<string, unknown> {
  const [host, ...path] = name.split('/');
  const careerSite = path[path.length - 1]!;
  const tenant = path[0] === 'recruiting' ? path[1]! : host!.split('.')[0]!.toLowerCase();
  return { host, tenant, careerSite };
}

/** Workday's own words where a site would stand. */
const WORKDAY_NOT_A_SITE: ReadonlySet<string> = new Set([
  'job', 'jobs', 'login', 'userhome', 'wday', 'details', 'apply', 'recruiting', 'search', 'jobalerts', 'robots.txt', 'sitemap.xml',
]);
/** A locale segment before a Workday site (en-US, fr-FR, de). */
const WORKDAY_LOCALE = /^[a-z]{2}(?:-[a-z0-9]{2,4})?$/i;

/** The Workday career site an address names: <host>/<site> or <host>/recruiting/<tenant>/<site>. */
export function workdaySiteOfAddress(host: string, parts: readonly string[]): string | null {
  const own = /^([a-z0-9-]+)\.(?:wd\d{1,3}\.)?myworkdayjobs\.com$/.exec(host);
  const shared = /^wd\d{1,3}\.myworkdaysite\.com$/.test(host);
  if ((!own || /^(?:www|wd\d{1,3})$/.test(own[1]!)) && !shared) return null;
  let rest = parts;
  if (shared) {
    // /[<locale>/]recruiting/<tenant>/<site>/...
    if (rest.length >= 2 && WORKDAY_LOCALE.test(rest[0]!) && rest[1]!.toLowerCase() === 'recruiting') rest = rest.slice(1);
    if (rest[0]?.toLowerCase() !== 'recruiting' || !rest[1] || !rest[2] || WORKDAY_NOT_A_SITE.has(rest[2].toLowerCase())) return null;
    return `${host}/recruiting/${rest[1]}/${rest[2]}`;
  }
  // /[<locale>/]<site>/...: a locale goes first only where a site follows it (a site named "de" before /job is none).
  if (rest.length >= 2 && WORKDAY_LOCALE.test(rest[0]!) && !WORKDAY_NOT_A_SITE.has(rest[1]!.toLowerCase())) rest = rest.slice(1);
  const site = rest[0];
  if (!site || WORKDAY_NOT_A_SITE.has(site.toLowerCase())) return null;
  return `${host}/${site}`;
}

export const WORKDAY_SITE_BOARD = defineBoard({
  kind: 'workday_site',
  label: 'Workday career site',
  row: { access: 'sitemap', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'workday',
  hosts: WORKDAY_HOSTS,
  domains: ['myworkdayjobs.com', 'myworkdaysite.com'],
  configKey: 'careerSite',
  configSchema: z.strictObject({ host: z.string().min(1), tenant: z.string().min(1), careerSite: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  keepsCase: true,
  boardOf: workdaySiteName,
  configOfBoard: workdaySiteConfig,
  // Its `careerSite` names no board alone: the host (and on myworkdaysite.com the tenant) with it.
  boardOfConfig: (config) => {
    const { host, careerSite: site, tenant } = config;
    if (typeof host !== 'string' || typeof site !== 'string') return null;
    const shared = /\.myworkdaysite\.com$/i.test(host) && typeof tenant === 'string';
    return shared ? `${host}/recruiting/${tenant}/${site}` : `${host}/${site}`;
  },
  hostOf: (config) => {
    const host = typeof config.host === 'string' ? config.host.trim().toLowerCase() : '';
    return isWorkdayHost(host) ? host : null;
  },
  boardOfUrl: (url, parts) => workdaySiteOfAddress(boardHostOf(url), parts),
  lane: WORKDAY_LANE,
  detail: (config) =>
    configWords(config, 'host') && configWords(config, 'careerSite')
      ? `Career site ${configWords(config, 'host')}, site ${configWords(config, 'careerSite')}`
      : null,
  examples: [
    {
      link: 'https://wd3.myworkdaysite.com/en-US/recruiting/acme/Careers_US/job/Remote/Data-Analyst_JR-0042?utm_source=x',
      clean: 'https://wd3.myworkdaysite.com/en-US/recruiting/acme/Careers_US/job/Remote/Data-Analyst_JR-0042',
      board: 'acme',
      externalId: 'JR-0042',
      found: 'wd3.myworkdaysite.com/recruiting/acme/Careers_US',
    },
  ],
});
