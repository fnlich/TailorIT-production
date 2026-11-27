import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardLinkParts, BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped } from './url';

// v38 ATS-D: Phenom's hosted career sites (<company>.phenompro.com; parseAtsUrl does not know Phenom, so the descriptor
// reads its links): https://<host>/<country>/<lang>/job/<req id>/<slug>. Every request to such a host meets an AWS WAF bot
// challenge (SP v38 EVIDENCE.md §23: even robots.txt answered 202 with `x-amzn-waf-action: challenge`), so TailorIT never
// reads them: a link is recognised, cleaned, and its verdict is can't read (`bot_check`), with no request (the API
// part). Phenom sites on an employer's own domain are career sites as before (their checks hold the host when met).

const PHENOM_HOSTS = String.raw`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.phenompro\.com$`;
const PHENOM_HOST = new RegExp(PHENOM_HOSTS);
/** A locale's two parts in the path (us/en, gb/en-gb) and a requisition's id ("R-106726", "JR12345"). */
const COUNTRY = /^[A-Za-z]{2}$/;
const LANG = /^[A-Za-z]{2}(?:[-_][A-Za-z]{2})?$/;
const REQ_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A posting's slug: words, as written (it is free text; the posting is its req id). */
const SLUG = /^[^/?#]{1,300}$/;

/** A Phenom site's tenant: its host's first label. */
const tenantOfHost = (host: string): string | null => (PHENOM_HOST.test(host) ? host.slice(0, -'.phenompro.com'.length) : null);

/** The posting a Phenom address names: its locale, req id and slug as written; null for any other page. */
export function phenomPostingOf(url: BoardUrl): { country: string; lang: string; id: string; slug: string | null } | null {
  if (!tenantOfHost(boardHostOf(url))) return null;
  const [country, lang, job, id, slug, ...rest] = boardSegmentsOf(url);
  if (!country || !lang || !COUNTRY.test(country) || !LANG.test(lang) || job !== 'job' || !id || !REQ_ID.test(id) || rest.length > 0) return null;
  if (slug !== undefined && !SLUG.test(slug)) return null;
  return { country, lang, id, slug: slug ?? null };
}

/** A posting's clean link (REQUEST.md #23): its page without the query. */
function phenomPostingUrl(host: string, posting: NonNullable<ReturnType<typeof phenomPostingOf>>): string {
  const slug = posting.slug === null ? '' : `/${encodeURIComponent(posting.slug)}`;
  return `https://${host}/${posting.country}/${posting.lang}/job/${encodeURIComponent(posting.id)}${slug}`;
}

/** The posting a Phenom link names (the API's link reader: parseAtsUrl does not know Phenom). */
function phenomLink(url: BoardUrl): BoardLinkParts | null {
  const host = boardHostOf(url);
  const posting = phenomPostingOf(url);
  return posting ? { board: tenantOfHost(host), externalId: posting.id, canonical: [phenomPostingUrl(host, posting)] } : null;
}

/** A Phenom site's tenant from a typed name ("acme") or any address on <name>.phenompro.com; '' for none. */
export function phenomTenant(input: string): string {
  const host = hostOfTyped(input);
  if (!host.includes('.')) return DNS_LABEL.test(host) ? host : '';
  return tenantOfHost(host) ?? '';
}

export const PHENOM_BOARD = defineBoard({
  kind: 'phenom',
  label: 'Phenom',
  row: { access: 'structured_data', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'phenom',
  hosts: PHENOM_HOSTS,
  domains: ['phenompro.com'],
  configKey: 'tenant',
  boardWords: 'Phenom site',
  configSchema: z.strictObject({ tenant: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: phenomTenant,
  configOfBoard: (board) => ({ tenant: board }),
  hostOf: (config) => {
    const tenant = phenomTenant(typeof config.tenant === 'string' ? config.tenant : '');
    return tenant ? `${tenant}.phenompro.com` : null;
  },
  parseLink: phenomLink,
  cleanLink: (url) => {
    const posting = phenomPostingOf(url);
    return posting ? phenomPostingUrl(boardHostOf(url), posting) : null;
  },
  // Phenom's hosted sites share Phenom's servers: one request at a time to all of them (none is read in v3.8).
  lane: {
    key: 'phenom.lane',
    label: 'Phenom (all sites)',
    name: 'Phenom',
  },
  detail: (config) => (configWords(config, 'tenant') ? `Phenom site ${configWords(config, 'tenant')}.phenompro.com` : null),
  examples: [
    {
      link: 'https://acmerobotics.phenompro.com/us/en/job/R-204811/Senior-Robotics-Engineer-Remote-US?utm_source=LinkedIn&src=JB-10120',
      clean: 'https://acmerobotics.phenompro.com/us/en/job/R-204811/Senior-Robotics-Engineer-Remote-US',
      board: 'acmerobotics',
      externalId: 'R-204811',
      found: null,
    },
  ],
});
