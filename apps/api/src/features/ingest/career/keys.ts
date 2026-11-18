import type { DbQueries } from '../../../core/db/types';
import { companyDomainsOf, registrableDomain } from '../../companies/domain';
import { atsKeyOf, ghjidKeyOf, ldKeyOf, tidyKeys, type JobKey } from '../keys';
import type { HiringOrganizationData, JobPostingData } from './jsonld';

// v30 S5: the identity keys a career-page posting carries beside its address's own (docs/design/part2/12-job-sourcing.md
// §7.1; ingest/keys.ts holds the builders, DB-INGEST's). The store matches a posting by every key it carries (12 §7.2
// step 2), so a career page's posting lands on the job its ATS copy already made, and later reads of it find it again:
// - `ats`: the ATS posting the JSON-LD `url` names (a career page that points at its Greenhouse, Lever, Ashby,
//   Workable or Workday posting): that posting's identity, the strongest key;
// - `ghjid`: a company page's `?gh_jid=<id>` (Greenhouse's embed on the company's own site): `<domain>:<id>`, and,
//   when the database aliases that domain to exactly one Greenhouse board (company_aliases: the domain's company has one
//   `greenhouse:<board>` board alias), the `ats` key `greenhouse:<board>:<id>` it resolves to;
// - `ld`: the JSON-LD identifier on the hiring organisation's domain (`<domain>:<identifier>`), only when it reads as a
//   posting's own number (a digit in it, not the company's name or domain) and no other page of the run carries the
//   same one (run.ts): a site that writes one identifier on every posting would otherwise merge them all.
// The `link` key of a JSON-LD url is never added: a site's url may be its careers home, shared by every posting.

/** A Greenhouse posting id as a company page writes it: ?gh_jid=<digits> (any case). */
export function ghJobIdOf(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    for (const [name, value] of new URL(address).searchParams) {
      if (name.toLowerCase() === 'gh_jid' && /^\d{1,20}$/.test(value.trim())) return value.trim();
    }
  } catch {
    return null;
  }
  return null;
}

/** The hiring organisation's own registrable domain (its sameAs, then its url), or null. */
export function organizationDomainOf(org: HiringOrganizationData | null): string | null {
  if (!org) return null;
  return companyDomainsOf([...org.sameAs, org.url])[0] ?? null;
}

/** Whether a JSON-LD identifier reads as one posting's number (see the top). */
export function postingIdentifierUsable(identifier: string | null, org: HiringOrganizationData | null, domain: string): identifier is string {
  if (!identifier || identifier.length > 200 || !/\d/.test(identifier)) return false;
  const text = identifier.trim().toLowerCase();
  return text !== domain && text !== (org?.name ?? '').trim().toLowerCase();
}

/** The one Greenhouse board a domain's company has (`greenhouse:<board>` board alias), or null (none, or several). */
export async function greenhouseBoardOfDomain(db: DbQueries, domain: string): Promise<string | null> {
  const rows = await db.all<{ value: string }>(
    `SELECT DISTINCT b.value FROM company_aliases d JOIN company_aliases b ON b.company_id = d.company_id
     WHERE d.kind = 'domain' AND d.value = ? AND b.kind = 'board' AND b.value LIKE 'greenhouse:%' ORDER BY b.value LIMIT 2`,
    [domain],
  );
  return rows.length === 1 ? rows[0]!.value.slice('greenhouse:'.length) : null;
}

export interface CareerKeys {
  keys: JobKey[];
  /** The `ld` key among them (run.ts drops it when another page of the run carries it too). */
  ld: string | null;
}

/** The host of an address, lower case, or null. */
function hostOf(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The keys of one career page's posting (see the top). Reads company_aliases for a ?gh_jid='s board.
 *
 * v31 FIX-LINK (SEC-1): `ownSiteOnly` (a page an add read: its JSON-LD is whatever the page's owner wrote) keeps only
 * the keys tied to the page's own address: an `ats` key of the JSON-LD `url` only when that url is on the page's own
 * host; a `ghjid` key only of an address on the page's own registrable domain; an `ld` key only on the page's own
 * registrable domain (the organisation's claimed domain must be it, when it claims one). So a page on another site
 * never names, and so never lands on, a posting of an ATS, of another company's domain or of another site.
 */
export async function careerKeysOf(
  db: DbQueries,
  pageUrl: string,
  posting: JobPostingData,
  options: { ownSiteOnly?: boolean } = {},
): Promise<CareerKeys> {
  const own = options.ownSiteOnly === true;
  const pageHost = hostOf(pageUrl);
  const pageDomain = registrableDomain(pageUrl);
  const keys: Array<JobKey | null> = [];
  const ats = !own || (pageHost !== null && hostOf(posting.url) === pageHost) ? atsKeyOf(posting.url) : null;
  if (ats) keys.push({ kind: 'ats', key: ats });
  for (const address of [pageUrl, posting.url]) {
    const jobId = ghJobIdOf(address);
    const domain = jobId ? registrableDomain(address) : null;
    if (!jobId || !domain) continue;
    if (own && domain !== pageDomain) continue;
    const ghjid = ghjidKeyOf(domain, jobId);
    if (ghjid) keys.push({ kind: 'ghjid', key: ghjid });
    const board = await greenhouseBoardOfDomain(db, domain);
    if (board) keys.push({ kind: 'ats', key: `greenhouse:${board}:${jobId}`.toLowerCase() });
  }
  const claimed = organizationDomainOf(posting.hiringOrganization);
  const domain = own ? (claimed === null || claimed === pageDomain ? pageDomain : null) : (claimed ?? pageDomain);
  const identifier = posting.identifier;
  const ld = domain && postingIdentifierUsable(identifier, posting.hiringOrganization, domain) ? ldKeyOf(domain, identifier) : null;
  if (ld) keys.push({ kind: 'ld', key: ld });
  return { keys: tidyKeys(keys), ld };
}
