import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, configWords, hostOfTyped } from './url';

// v38 ATS-C (SP v38 PLAN A2, "Final coverage" row 11): a company's Taleo (Enterprise) portal, <tenant>.taleo.net, links
// only. A posting's link is /careersection/<section>/jobdetail.ftl?job=<requisition>&lang=<lang> (and its application's
// pages jobapply.ftl, flow.jsf, application.jss with the same job=); its clean link is the posting's page keeping only
// job and lang (REQUEST.md). The API reads the page's own data (its api.fillList call, the API's adapters/taleo.ts). No
// board list in v3.8 (Taleo's job search is a POST, out of v3.8): the kind never runs, has no Add source field, and
// discovery finds no Taleo board; a career site on a Taleo host made before v3.8 stays as it is.

/** A company's Taleo host: <tenant>.taleo.net, never www; Taleo Business Edition (<co>.tbe.taleo.net) is another product. */
export const TALEO_HOSTS = String.raw`^(?!(?:www|tbe)\.)[a-z0-9-]+\.taleo\.net$`;
const TALEO_HOST = new RegExp(TALEO_HOSTS);
const SECTION = /^[A-Za-z0-9_-]{1,40}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,40}$/;
const LANG = /^[A-Za-z]{2}(?:[_-][A-Za-z]{2})?$/;
/** A career section's pages that name a posting in ?job= (the extension's: autofill lookup.ts). */
const POSTING_PAGES: ReadonlySet<string> = new Set(['jobdetail.ftl', 'jobapply.ftl', 'flow.jsf', 'application.jss']);

/** The one value of a query parameter, or null when it is absent or given more than once. */
function onlyValue(url: BoardUrl, name: string): string | null {
  const values = [...url.searchParams].filter(([key]) => key === name).map(([, value]) => value);
  return values.length === 1 ? values[0]! : null;
}

/** A Taleo posting a career section's page names: its tenant, section, requisition, language and clean link; or null. */
export function taleoLinkOf(url: BoardUrl): { tenant: string; section: string; job: string; lang: string | null; clean: string } | null {
  const host = boardHostOf(url);
  if (!TALEO_HOST.test(host)) return null;
  const parts = url.pathname.split('/').slice(1);
  if (parts.length !== 3 || parts[0] !== 'careersection' || !SECTION.test(parts[1]!) || !POSTING_PAGES.has(parts[2]!)) return null;
  const job = onlyValue(url, 'job');
  if (job === null || !JOB_ID.test(job)) return null;
  const given = onlyValue(url, 'lang');
  const lang = given !== null && LANG.test(given) ? given : null;
  const clean = `https://${host}/careersection/${parts[1]}/jobdetail.ftl?job=${job}${lang ? `&lang=${lang}` : ''}`;
  return { tenant: host.slice(0, -'.taleo.net'.length), section: parts[1]!, job, lang, clean };
}

/** The tenant a typed name, host or address names (its host's first label, lower case); '' for none. */
export function taleoTenant(input: string): string {
  const host = hostOfTyped(input);
  const full = host.includes('.') ? host : host ? `${host}.taleo.net` : '';
  return TALEO_HOST.test(full) ? full.slice(0, -'.taleo.net'.length) : '';
}

export const TALEO_BOARD = defineBoard({
  kind: 'taleo',
  label: 'Taleo',
  row: { access: 'structured_data', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'taleo',
  hosts: TALEO_HOSTS,
  domains: ['taleo.net'],
  atsKind: 'taleo',
  configKey: 'tenant',
  boardWords: 'Taleo portal',
  configSchema: z.strictObject({ tenant: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: taleoTenant,
  configOfBoard: (board) => ({ tenant: board }),
  hostOf: (config) => {
    const tenant = typeof config.tenant === 'string' ? taleoTenant(config.tenant) : '';
    return tenant ? `${tenant}.taleo.net` : null;
  },
  cleanLink: (url) => taleoLinkOf(url)?.clean ?? null,
  // SP v38 PLAN A4: one request at a time to all of Taleo (every tenant's host is Oracle's).
  lane: { key: 'taleo.lane', label: 'Taleo (all portals)', name: 'Taleo' },
  detail: (config) => (configWords(config, 'tenant') ? `Portal ${configWords(config, 'tenant')}.taleo.net` : null),
  examples: [
    {
      link: 'https://acmehealth.taleo.net/careersection/acme_external/jobapply.ftl?job=2600417X&lang=en&src=JB-10120&utm_source=Newsletter',
      clean: 'https://acmehealth.taleo.net/careersection/acme_external/jobdetail.ftl?job=2600417X&lang=en',
      board: 'acmehealth',
      externalId: '2600417X',
      found: null, // links only: discovery finds no Taleo portal
    },
  ],
});
