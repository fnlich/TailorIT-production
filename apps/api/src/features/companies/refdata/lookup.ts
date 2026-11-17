import type { AppDeps } from '../../../core/context';
import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { isRobotsExempt } from '../../../core/http/robots-exemptions';
import { createHostGate } from '../../ingest/hosts';
import { createIngestHttp, type IngestHttp } from '../../ingest/http';
import { orgOf, type WdOrg } from './dumps/wikidata';
import type { OrgLookup } from './match';

// v30 E1: live Wikidata lookups for the companies a build has not seen (docs/design/part2/13-company-enrichment.md
// §3.2: "new companies only, a few hundred a day"): the items whose official website (P856) is on a company's domain,
// by one SPARQL query, then each item's entity (the same JSON the dump holds, read with the same code), at most
// LIVE_ITEMS of them.
//
// A NEW kind of outside read (PLAN §5): every request first calls assertNewReadAllowed(deps, 'refdata_lookup'), which
// refuses while BOT_USER_AGENT is the placeholder (DECISIONS P1, owner question 7), and is sent with BOT_USER_AGENT
// (Wikimedia asks for a named bot with a contact). It goes through the ingest client (features/ingest/http.ts): the
// outbound guard, the per-host pace and holds shared by every process (crawl_hosts: one request per
// max(INGEST_HOST_MIN_INTERVAL_MS, a minute / WIKIMEDIA_REQUESTS_PER_MINUTE) to each of Wikidata's two hosts),
// Retry-After and the bot-check hold, and an answer cap. These are Wikimedia's documented APIs, whose own rules (the
// User-Agent policy and the request rates, 13 §3.2 [S3][S4][S5]) govern automated use; the sites' robots.txt is for
// crawlers of their pages, so the client's robots.txt check is not asked for these two addresses.
//
// v30 FIX-C (W5 review SEC-5, DECISIONS P6.2): those two addresses are entries of the one named robots exemption list
// (core/http/robots-exemptions.ts), and a read skips robots.txt only for an address on it: any other address asks
// robots.txt as every read does. The lookups run only while the admin switch REFDATA_LIVE_LOOKUPS is on (step.ts),
// off by default: setting BOT_USER_AGENT alone does not start them.

export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
export const WIKIDATA_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData/';
/** The most items one domain's lookup reads. */
const LIVE_ITEMS = 3;
/** A registrable domain as a SPARQL address may hold it (nothing that could close the IRI). */
const SAFE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const QID = /^Q[1-9]\d{0,11}$/;

type LookupDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The client the lookups read with: BOT_USER_AGENT, the shared per-host pace at Wikimedia's rate (see the note). */
export function wikidataHttp(deps: LookupDeps, options: { fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void> } = {}): IngestHttp {
  const constants = () => constantsOf(deps);
  return createIngestHttp({
    userAgent: deps.config.outside.botUserAgent,
    timeoutMs: deps.config.ingest.httpTimeoutMs,
    minIntervalMs: () => Math.max(constants().get('INGEST_HOST_MIN_INTERVAL_MS'), Math.ceil(60_000 / constants().get('WIKIMEDIA_REQUESTS_PER_MINUTE'))),
    maxBytes: () => constants().get('INGEST_ANSWER_MAX_BYTES'),
    now: () => deps.now().getTime(),
    gate: createHostGate(deps, { sleep: options.sleep }),
    fetch: options.fetch,
    sleep: options.sleep,
  });
}

/** The SPARQL query for the items whose official website is on `domain` (its usual spellings). */
export function domainQuery(domain: string): string {
  const sites = ['https', 'http']
    .flatMap((scheme) => [`${scheme}://${domain}`, `${scheme}://www.${domain}`])
    .flatMap((site) => [`<${site}>`, `<${site}/>`]);
  return `SELECT DISTINCT ?item WHERE { VALUES ?site { ${sites.join(' ')} } ?item wdt:P856 ?site . } LIMIT ${LIVE_ITEMS + 2}`;
}

/** The QIDs of a SPARQL answer (results.bindings[].item.value = 'http://www.wikidata.org/entity/Q95'). */
export function qidsOfSparql(data: unknown): string[] {
  const bindings = (data as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  if (!Array.isArray(bindings)) return [];
  const out: string[] = [];
  for (const binding of bindings) {
    const value = (binding as { item?: { value?: unknown } } | null)?.item?.value;
    const match = typeof value === 'string' ? /\/entity\/(Q[1-9]\d{0,11})$/.exec(value) : null;
    if (match && !out.includes(match[1]!)) out.push(match[1]!);
  }
  return out;
}

/** The entity of an entity-data answer ({entities: {Q95: {...}}}; a redirected id answers under its new id). */
export function entityOfAnswer(data: unknown): Record<string, unknown> | null {
  const entities = (data as { entities?: unknown } | null)?.entities;
  if (!entities || typeof entities !== 'object') return null;
  const first = Object.values(entities as Record<string, unknown>)[0];
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
}

/** Live lookups (see the module's note). Each call refuses (NewReadRefusedError) while BOT_USER_AGENT is a placeholder. */
export function createWikidataLookup(deps: LookupDeps, http: IngestHttp = wikidataHttp(deps)): OrgLookup {
  const read = async (url: string) => {
    assertNewReadAllowed(deps, 'refdata_lookup');
    return http.getJson(url, { robots: !isRobotsExempt(url), allow: [404] });
  };
  const byQid = async (qid: string): Promise<WdOrg | null> => {
    if (!QID.test(qid)) return null;
    const answer = await read(`${WIKIDATA_ENTITY}${qid}.json`);
    if (answer.status !== 200) return null;
    const entity = entityOfAnswer(answer.data);
    return entity ? orgOf(entity, { anyItem: true }) : null;
  };
  return {
    byQid,
    async byDomain(domain) {
      if (!SAFE_DOMAIN.test(domain)) return [];
      const answer = await read(`${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(domainQuery(domain))}`);
      if (answer.status !== 200) return [];
      const orgs: WdOrg[] = [];
      for (const qid of qidsOfSparql(answer.data).slice(0, LIVE_ITEMS)) {
        const org = await byQid(qid);
        if (org) orgs.push(org);
      }
      return orgs;
    },
  };
}
