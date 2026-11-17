// v30 FIX-C (W5 review SEC-5, SP\p2\DECISIONS.md P6.2): the one named list of the addresses TailorIT reads without
// asking their host's robots.txt first. robots.txt is for crawlers of a site's pages; each entry here is an API whose
// own published policy governs automated use (named with its address), or robots.txt itself. Every other read asks
// robots.txt (the ingest client's robots hook, the site reader's check).
//
// The list is enforced by the clients: a read skips robots.txt only for an address `isRobotsExempt` answers true for
// (the Wikidata lookups ask it, companies/refdata/lookup.ts). The literal `robots: false` appears nowhere else in
// product code but the ingest client's own robots.txt read and the USAJOBS adapter (both entries below), which a scan
// test proves (apps/api/test/structure-robots-exemptions.test.ts).

export interface RobotsExemption {
  /** A short name. */
  name: string;
  /** The hosts (lower case), and the paths read there (the whole path). */
  hosts: readonly string[];
  path: RegExp;
  /** Why robots.txt is not asked, and the policy that governs automated use instead. */
  why: string;
  policy: string;
}

export const ROBOTS_EXEMPTIONS: readonly RobotsExemption[] = [
  {
    name: 'robots_txt',
    hosts: ['*'],
    path: /^\/robots\.txt$/,
    why: 'robots.txt itself: reading it is how a crawler asks.',
    policy: 'https://www.rfc-editor.org/rfc/rfc9309',
  },
  {
    name: 'usajobs',
    hosts: ['data.usajobs.gov'],
    path: /^\/api\/search$/,
    why: "A keyed API for registered applications (12 §1: robots_status not_applicable); its terms govern automated use.",
    policy: 'https://developer.usajobs.gov/',
  },
  {
    name: 'wikidata_sparql',
    hosts: ['query.wikidata.org'],
    path: /^\/sparql$/,
    why: "Wikidata's query API (13 §3.2): its User-Agent policy and request rates govern automated use.",
    policy: 'https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual',
  },
  {
    name: 'wikidata_entity',
    hosts: ['www.wikidata.org'],
    path: /^\/wiki\/Special:EntityData\/Q[1-9]\d{0,11}\.json$/,
    why: "Wikidata's entity data API (13 §3.2): the same JSON as the dumps, under Wikimedia's User-Agent policy.",
    policy: 'https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy',
  },
];

/** The exemption an https address is on, or null (an http address, another host or another path is on none). */
export function robotsExemptionOf(address: string | URL): RobotsExemption | null {
  let url: URL;
  try {
    url = typeof address === 'string' ? new URL(address) : address;
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  return ROBOTS_EXEMPTIONS.find((entry) => (entry.hosts.includes('*') || entry.hosts.includes(host)) && entry.path.test(url.pathname)) ?? null;
}

/** Whether a read of this address may skip robots.txt (see the module's note). */
export const isRobotsExempt = (address: string | URL): boolean => robotsExemptionOf(address) !== null;
