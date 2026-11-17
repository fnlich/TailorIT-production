import { companySizeBucket, normalizeCompanyName } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import type { DbQueries, DbTx } from '../../../core/db/types';
import { constantsOf } from '../../../core/constants/index';
import { addAlias, companyOfAlias } from '../aliases';
import { cleanFields, minConfidenceOf, recomputeProfile, upsertSource, type ProfileFields, type SourceKey } from '../profile';
import { refreshCompanySearch, type CompanySearchChange } from '../search-refresh';
import { cikOf, leiOf, type WdOrg } from './dumps/wikidata';
import { REFDATA_SCHEMA } from './format';
import { industryOfLabels, industryOfSic, stageOfWikidata } from './industries';

// v30 E1: a company and the open reference data (docs/design/part2/13-company-enrichment.md §5.3, §5.5, §6). A
// Wikidata, SEC or GLEIF record attaches to a company by a strong key only:
//   1. the company's own `wikidata` key (an admin's, an accepted review's, an earlier match's): that item;
//   2. its `cik` or `lei` key: the one Wikidata item with that CIK or LEI;
//   3. its strong `domain` key: the one item on that registrable domain whose names agree with the company's;
//   then the SEC filer of the company's (or the item's) CIK and the GLEIF entity of its LEI.
// A weaker candidate is a review an admin decides (company_match_reviews, kind `wikidata`; accepting it adds the
// item's key, and the next match attaches it): an item on the domain whose name differs, several items on one domain,
// and (in a build's pass, for the companies with the most open jobs) the one item of the company's name. A name alone
// never attaches anything. A score of COMPANY_MATCH_AUTO_MIN or more attaches; under it, a review.
//
// Each source's answer is one company_sources row (kind wikidata / sec / gleif, ref the QID / CIK / LEI, licence cc0 /
// us_gov_public / cc0, the match's confidence) written with upsertSource (unchanged answers write nothing), the item's
// keys become the company's (`wikidata`, `cik`, `lei`; a key another company holds opens a `merge` review instead),
// the parents become company_relations (Wikidata P749, GLEIF's consolidation) when the parent is a company too, and the
// profile is recomputed (13 §6.1's priority decides which source shows each field; an admin's locks stay). A change the
// search copies (the industry, the size) re-projects the company's open jobs in the same transaction.
//
// Never matched: an account's own company, a merged row, an opted-out company (13 §5.6, §4).

/** Match scores (13 §6.2). */
const SCORE = {
  /** The company's own wikidata key. */
  confirmed: 95,
  /** A registry key (CIK, LEI) the company holds, or the item's when it attached. */
  registry: 90,
  /** One item on the company's domain, its names agreeing. */
  domainAndName: 90,
  /** One item on the domain, another name. */
  domainOnly: 80,
  /** Several items on the domain. */
  domainShared: 70,
  /** The one item of the company's name, nothing else. */
  nameOnly: 60,
} as const;
/** The most items a lookup by a domain or a name reads. */
const CANDIDATES = 5;
/** The most levels from a headquarters up to the region with an ISO code. */
const PLACE_LEVELS = 6;

/** An organisation as a company's source reads it: the item's words resolved (labels of its places, industries, types). */
export interface OrgRecord {
  qid: string;
  label: string | null;
  description: string | null;
  officialName: string | null;
  nameKeys: string[];
  website: string | null;
  domain: string | null;
  linkedinId: string | null;
  cik: string | null;
  lei: string | null;
  industryLabels: string[];
  employees: number | null;
  employeesAsOf: string | null;
  inceptionYear: number | null;
  hq: { city: string | null; region: string | null; country: string | null } | null;
  exchange: { label: string | null; ticker: string | null } | null;
  parentQid: string | null;
  typeLabels: string[];
}

interface OrgRow {
  qid: string;
  label: string | null;
  description: string | null;
  official_name: string | null;
  name_keys: string[] | string | null;
  website: string | null;
  domain: string | null;
  linkedin_id: string | null;
  cik: string | null;
  lei: string | null;
  industry_qids: string[] | string | null;
  employees: number | null;
  employees_as_of: string | null;
  inception_year: number | null;
  hq_qid: string | null;
  country_qid: string | null;
  exchanges: string | null;
  parent_qid: string | null;
  owner_qid: string | null;
  type_qids: string[] | string | null;
}

/** A text[] as the driver gives it (an array, or PostgreSQL's '{a,b}' text). */
function list(value: string[] | string | null): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '{}' || value === '') return [];
  return value
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((item) => item.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

const ORG_COLUMNS = `qid, label, description, official_name, name_keys, website, domain, linkedin_id, cik, lei, industry_qids, employees,
  employees_as_of::text AS employees_as_of, inception_year, hq_qid, country_qid, exchanges::text AS exchanges, parent_qid, owner_qid, type_qids`;

function orgOfRow(row: OrgRow): WdOrg {
  let exchanges: WdOrg['exchanges'] = [];
  try {
    const parsed: unknown = row.exchanges ? JSON.parse(row.exchanges) : [];
    if (Array.isArray(parsed)) exchanges = parsed.filter((item): item is WdOrg['exchanges'][number] => !!item && typeof item.qid === 'string');
  } catch {
    exchanges = [];
  }
  return {
    qid: row.qid,
    label: row.label,
    description: row.description,
    officialName: row.official_name,
    nameKeys: list(row.name_keys),
    website: row.website,
    domain: row.domain,
    linkedinId: row.linkedin_id,
    cik: row.cik,
    lei: row.lei,
    industryQids: list(row.industry_qids),
    employees: row.employees,
    employeesAsOf: row.employees_as_of,
    inceptionYear: row.inception_year,
    hqQid: row.hq_qid,
    countryQid: row.country_qid,
    exchanges,
    parentQid: row.parent_qid,
    ownerQid: row.owner_qid,
    typeQids: list(row.type_qids),
  };
}

interface ItemRow {
  qid: string;
  label: string | null;
  parent_qid: string | null;
  country_qid: string | null;
  iso_country: string | null;
  iso_region: string | null;
}

/** The refdata reads: by key, and the labels of the items an organisation points at. */
export class RefdataReader {
  constructor(
    private readonly db: DbQueries,
    /** False: no build is in place (or one of other files): every lookup finds nothing. */
    readonly ready: boolean,
  ) {}

  private async orgs(where: string, value: string): Promise<WdOrg[]> {
    if (!this.ready) return [];
    const rows = await this.db.all<OrgRow>(`SELECT ${ORG_COLUMNS} FROM ${REFDATA_SCHEMA}.wd_orgs WHERE ${where} ORDER BY qid LIMIT ${CANDIDATES}`, [value]);
    return rows.map(orgOfRow);
  }

  byQid(qid: string) {
    return this.orgs('qid = ?', qid);
  }
  byCik(cik: string) {
    return this.orgs('cik = ?', cik);
  }
  byLei(lei: string) {
    return this.orgs('lei = ?', lei);
  }
  byDomain(domain: string) {
    return this.orgs('domain = ?', domain);
  }
  /** The items of a name key that carry a strong key of their own (a website's domain, a CIK, an LEI). */
  byNameKey(nameKey: string) {
    return this.orgs('name_keys @> ARRAY[CAST(? AS text)] AND (domain IS NOT NULL OR cik IS NOT NULL OR lei IS NOT NULL)', nameKey);
  }
  /** The items whose parent (P749) is this item. */
  async childrenOf(qid: string): Promise<string[]> {
    if (!this.ready) return [];
    const rows = await this.db.all<{ qid: string }>(`SELECT qid FROM ${REFDATA_SCHEMA}.wd_orgs WHERE parent_qid = ? ORDER BY qid LIMIT 200`, [qid]);
    return rows.map((row) => row.qid);
  }

  async items(qids: readonly string[]): Promise<Map<string, ItemRow>> {
    const unique = [...new Set(qids)];
    if (!this.ready || unique.length === 0) return new Map();
    const rows = await this.db.all<ItemRow>(
      `SELECT qid, label, parent_qid, country_qid, iso_country, iso_region FROM ${REFDATA_SCHEMA}.wd_items WHERE qid IN (${this.db.dialect.list(unique.length)})`,
      unique,
    );
    return new Map(rows.map((row) => [row.qid, row]));
  }

  async filer(cik: string) {
    if (!this.ready) return undefined;
    return this.db.one<{
      cik: string;
      name: string;
      tickers: string[] | string;
      exchanges: string[] | string;
      sic: string | null;
      sic_description: string | null;
      city: string | null;
      region: string | null;
      country: string | null;
    }>(`SELECT cik, name, tickers, exchanges, sic, sic_description, city, region, country FROM ${REFDATA_SCHEMA}.sec_filers WHERE cik = ?`, [cik]);
  }

  async entity(lei: string) {
    if (!this.ready) return undefined;
    return this.db.one<{
      lei: string;
      legal_name: string;
      hq_city: string | null;
      hq_region: string | null;
      hq_country: string | null;
      created_on: string | null;
    }>(
      `SELECT lei, legal_name, hq_city, hq_region, hq_country, created_on::text AS created_on FROM ${REFDATA_SCHEMA}.gleif_entities WHERE lei = ?`,
      [lei],
    );
  }

  async parentsOf(lei: string): Promise<string[]> {
    if (!this.ready) return [];
    const rows = await this.db.all<{ parent_lei: string }>(
      `SELECT parent_lei FROM ${REFDATA_SCHEMA}.gleif_relations WHERE child_lei = ? AND kind = 'direct' ORDER BY parent_lei`,
      [lei],
    );
    return rows.map((row) => row.parent_lei);
  }

  async childrenOfLei(lei: string): Promise<string[]> {
    if (!this.ready) return [];
    const rows = await this.db.all<{ child_lei: string }>(
      `SELECT child_lei FROM ${REFDATA_SCHEMA}.gleif_relations WHERE parent_lei = ? AND kind = 'direct' ORDER BY child_lei LIMIT 200`,
      [lei],
    );
    return rows.map((row) => row.child_lei);
  }

  /** An organisation with its words resolved through wd_items (labels nothing resolves stay out). */
  async resolve(org: WdOrg): Promise<OrgRecord> {
    const first = await this.items([...org.industryQids, ...org.exchanges.map((exchange) => exchange.qid), ...org.typeQids, org.hqQid ?? '', org.countryQid ?? '']);
    // The headquarters' region: up the places it lies in until one has an ISO 3166-2 code.
    const chain: ItemRow[] = [];
    let at = org.hqQid ? first.get(org.hqQid) : undefined;
    for (let level = 0; at && level < PLACE_LEVELS; level += 1) {
      chain.push(at);
      if (at.iso_region || at.iso_country || !at.parent_qid) break;
      const parent: ItemRow | undefined = first.get(at.parent_qid) ?? (await this.items([at.parent_qid])).get(at.parent_qid);
      at = parent;
    }
    const regionItem = chain.find((item) => item.iso_region) ?? null;
    const countryOf = async (qid: string | null | undefined): Promise<string | null> => {
      if (!qid) return null;
      const item = first.get(qid) ?? (await this.items([qid])).get(qid);
      return item?.iso_country ?? null;
    };
    const hqItem = chain[0] ?? null;
    const country =
      (await countryOf(org.countryQid)) ??
      hqItem?.iso_country ??
      (await countryOf(hqItem?.country_qid)) ??
      (regionItem ? regionItem.iso_region!.slice(0, 2) : null);
    const isPlaceCode = (item: ItemRow | null) => !!item && (!!item.iso_region || !!item.iso_country);
    const city = hqItem && !isPlaceCode(hqItem) ? hqItem.label : null;
    const region = regionItem
      ? ['US', 'CA'].includes(regionItem.iso_region!.slice(0, 2))
        ? regionItem.iso_region!.slice(3)
        : regionItem.label
      : null;
    const listed = org.exchanges[0] ?? null;
    return {
      qid: org.qid,
      label: org.label,
      description: org.description,
      officialName: org.officialName,
      nameKeys: org.nameKeys,
      website: org.website,
      domain: org.domain,
      linkedinId: org.linkedinId,
      cik: org.cik,
      lei: org.lei,
      industryLabels: org.industryQids.map((qid) => first.get(qid)?.label ?? null).filter((label): label is string => !!label),
      employees: org.employees,
      employeesAsOf: org.employeesAsOf,
      inceptionYear: org.inceptionYear,
      hq: city || region || country ? { city, region, country } : null,
      exchange: listed ? { label: first.get(listed.qid)?.label ?? null, ticker: listed.ticker } : null,
      parentQid: org.parentQid,
      typeLabels: org.typeQids.map((qid) => first.get(qid)?.label ?? null).filter((label): label is string => !!label),
    };
  }
}

// ── The company's side ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CompanyKeys {
  id: number;
  /** The company's own names as keys (its name key, its shown and legal names). */
  nameKeys: Set<string>;
  nameKey: string;
  wikidata: string[];
  cik: string[];
  lei: string[];
  domains: string[];
}

/** The keys of a company that may be matched; null for one never matched (own, merged, opted out, gone). */
export async function companyKeysOf(db: DbQueries, companyId: number): Promise<CompanyKeys | null> {
  const company = await db.one<{
    id: number;
    name_key: string;
    owner_user_id: string | null;
    merged_into_id: number | null;
    do_not_fetch: boolean;
    display_name: string | null;
    legal_name: string | null;
  }>(
    `SELECT c.id, c.name_key, c.owner_user_id, c.merged_into_id, c.do_not_fetch, p.display_name, p.legal_name
     FROM companies c LEFT JOIN company_profiles p ON p.company_id = c.id WHERE c.id = ?`,
    [companyId],
  );
  if (!company || company.owner_user_id !== null || company.merged_into_id !== null || company.do_not_fetch) return null;
  const aliases = await db.all<{ kind: string; value: string }>(
    `SELECT kind, value FROM company_aliases WHERE company_id = ? AND kind IN ('wikidata', 'cik', 'lei', 'domain', 'name_key', 'legal_name_key')
     ORDER BY confidence DESC, created_at, value`,
    [companyId],
  );
  const of = (kind: string) => aliases.filter((alias) => alias.kind === kind).map((alias) => alias.value);
  const nameKeys = new Set<string>(
    [company.name_key, normalizeCompanyName(company.display_name), normalizeCompanyName(company.legal_name), ...of('name_key'), ...of('legal_name_key')].filter(
      (key) => key !== '',
    ),
  );
  return {
    id: company.id,
    nameKey: company.name_key,
    nameKeys,
    wikidata: of('wikidata'),
    cik: of('cik').map(cikOf).filter((cik): cik is string => cik !== null),
    lei: of('lei').map(leiOf).filter((lei): lei is string => lei !== null),
    domains: of('domain'),
  };
}

const namesAgree = (keys: CompanyKeys, org: Pick<WdOrg, 'nameKeys'>) => org.nameKeys.some((key) => keys.nameKeys.has(key));

/** What the match found for a company's Wikidata item. */
export type WikidataDecision =
  | { kind: 'attach'; org: WdOrg; score: number; via: 'wikidata' | 'cik' | 'lei' | 'domain' | 'live' }
  | { kind: 'review'; orgs: WdOrg[]; score: number; via: 'domain' | 'name' | 'live' }
  | { kind: 'none' };

/** Live lookups between builds (lookup.ts): the items on a domain, one item by its QID. */
export interface OrgLookup {
  byDomain(domain: string): Promise<WdOrg[]>;
  byQid(qid: string): Promise<WdOrg | null>;
}

/** The domain rule over a domain's items (13 §5.3: a strong key and the name agreeing attach; anything less is a review). */
function byDomainRule(keys: CompanyKeys, orgs: readonly WdOrg[], via: 'domain' | 'live'): WikidataDecision | null {
  if (orgs.length === 0) return null;
  const agreeing = orgs.filter((org) => namesAgree(keys, org));
  if (agreeing.length === 1) return { kind: 'attach', org: agreeing[0]!, score: SCORE.domainAndName, via };
  if (orgs.length === 1) return { kind: 'review', orgs: [orgs[0]!], score: SCORE.domainOnly, via };
  return { kind: 'review', orgs: orgs.slice(0, 3), score: SCORE.domainShared, via };
}

/**
 * The company's Wikidata item: its own keys first, then its domains (the refdata build's, then a live lookup's when
 * one is given), then, when `byName`, the one item of its name (a review only).
 */
export async function decideWikidata(
  reader: RefdataReader,
  keys: CompanyKeys,
  options: { lookup?: OrgLookup | null; byName?: boolean } = {},
): Promise<WikidataDecision> {
  for (const qid of keys.wikidata) {
    const [org] = await reader.byQid(qid);
    if (org) return { kind: 'attach', org, score: SCORE.confirmed, via: 'wikidata' };
    const live = options.lookup ? await options.lookup.byQid(qid) : null;
    if (live) return { kind: 'attach', org: live, score: SCORE.confirmed, via: 'live' };
  }
  // A confirmed item the data lacks now (a build before it, an item merged away): nothing else is tried in its place.
  if (keys.wikidata.length > 0) return { kind: 'none' };
  for (const cik of keys.cik) {
    const orgs = await reader.byCik(cik);
    if (orgs.length === 1) return { kind: 'attach', org: orgs[0]!, score: SCORE.registry, via: 'cik' };
  }
  for (const lei of keys.lei) {
    const orgs = await reader.byLei(lei);
    if (orgs.length === 1) return { kind: 'attach', org: orgs[0]!, score: SCORE.registry, via: 'lei' };
  }
  let review: WikidataDecision | null = null;
  for (const domain of keys.domains) {
    const decided = byDomainRule(keys, await reader.byDomain(domain), 'domain');
    if (decided?.kind === 'attach') return decided;
    review ??= decided;
  }
  if (!review && options.lookup) {
    for (const domain of keys.domains) {
      const decided = byDomainRule(keys, (await options.lookup.byDomain(domain)).filter((org) => org.domain === domain), 'live');
      if (decided?.kind === 'attach') return decided;
      review ??= decided;
    }
  }
  if (review) return review;
  if (options.byName && keys.nameKey && keys.domains.length === 0) {
    const orgs = await reader.byNameKey(keys.nameKey);
    if (orgs.length === 1) return { kind: 'review', orgs, score: SCORE.nameOnly, via: 'name' };
  }
  return { kind: 'none' };
}

// ── The fields each source gives ───────────────────────────────────────────────────────────────────────────────────

/** A Wikidata item's values for a company's profile (13 §6.1). */
export function wikidataFields(org: OrgRecord): ProfileFields {
  const listed = org.exchange !== null;
  return cleanFields({
    displayName: org.label,
    legalName: org.officialName,
    tagline: org.description,
    website: org.website,
    domain: org.domain,
    linkedinUrl: org.linkedinId ? `https://www.linkedin.com/company/${org.linkedinId}/` : null,
    industry: industryOfLabels(org.industryLabels),
    industryDetail: org.industryLabels.length > 0 ? org.industryLabels.join(', ') : null,
    employees: org.employees,
    employeesAsOf: org.employees === null ? null : org.employeesAsOf,
    sizeBucket: companySizeBucket(org.employees),
    stage: stageOfWikidata({ listed, hasParent: org.parentQid !== null, typeLabels: org.typeLabels }),
    ticker: listed ? org.exchange!.ticker : null,
    exchange: listed ? org.exchange!.label : null,
    hqCity: org.hq?.city ?? null,
    hqRegion: org.hq?.region ?? null,
    hqCountryCode: org.hq?.country ?? null,
    foundedYear: org.inceptionYear,
    foundedKind: org.inceptionYear === null ? null : 'founded',
  });
}

/** An SEC filer's values: its name, its listing, its industry (SIC), its business address. */
export function secFields(filer: NonNullable<Awaited<ReturnType<RefdataReader['filer']>>>): ProfileFields {
  const tickers = list(filer.tickers);
  const exchanges = list(filer.exchanges);
  const listed = tickers.length > 0 && exchanges.length > 0;
  return cleanFields({
    legalName: filer.name,
    stage: listed ? 'public' : null,
    ticker: listed ? tickers[0] : null,
    exchange: listed ? exchanges[0] : null,
    industry: industryOfSic(filer.sic),
    industryDetail: filer.sic_description,
    hqCity: filer.city,
    hqRegion: filer.region,
    hqCountryCode: filer.country,
  });
}

/** A GLEIF entity's values: its legal name, its headquarters, its creation year (an incorporation, never "founded"). */
export function gleifFields(entity: NonNullable<Awaited<ReturnType<RefdataReader['entity']>>>, hasParent: boolean): ProfileFields {
  const country = entity.hq_country;
  const region = entity.hq_region && country && ['US', 'CA'].includes(country) && entity.hq_region.startsWith(`${country}-`) ? entity.hq_region.slice(3) : null;
  const year = entity.created_on ? Number(entity.created_on.slice(0, 4)) : null;
  return cleanFields({
    legalName: entity.legal_name,
    hqCity: entity.hq_city,
    hqRegion: region,
    hqCountryCode: country,
    foundedYear: year,
    foundedKind: year === null ? null : 'incorporated',
    stage: hasParent ? 'subsidiary' : null,
  });
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MatchResult {
  companyId: number;
  /** The Wikidata item attached (its QID), or null. */
  wikidata: string | null;
  sec: string | null;
  gleif: string | null;
  /** Reviews opened (or found open) by kind. */
  reviews: Partial<Record<'wikidata' | 'merge', number>>;
  /** A source row changed (and the profile was recomputed). */
  changed: boolean;
  /** Open jobs re-projected. */
  projected: number;
}

export interface MatchOptions {
  at: string;
  reader: RefdataReader;
  lookup?: OrgLookup | null;
  /** Open a review for the one item of the company's name (a build's pass, the most-viewed companies only). */
  byName?: boolean;
}

const SOURCE_KEYS = {
  wikidata: (ref: string, score: number): SourceKey => ({ kind: 'wikidata', ref, licence: 'cc0', matchConfidence: score }),
  sec: (ref: string, score: number): SourceKey => ({ kind: 'sec', ref, licence: 'us_gov_public', matchConfidence: score }),
  gleif: (ref: string, score: number): SourceKey => ({ kind: 'gleif', ref, licence: 'cc0', matchConfidence: score }),
} as const;

/** Adds a strong key unless another company holds it; answers that company's id when one does (a merge to review). */
async function claimKey(t: DbTx, companyId: number, kind: string, value: string, score: number, at: string, sourceId: number | null): Promise<number | null> {
  const holder = await companyOfAlias(t, kind, value);
  if (holder && holder.id !== companyId) return holder.id;
  if (!holder) await addAlias(t, companyId, kind, value, score, at, { sourceId });
  return null;
}

/**
 * A `wikidata` review of one candidate item for a company, unless one about the same item is open or was rejected (a
 * rejected candidate is never asked again; reviews.ts' openMatchReview keeps one open review per company and kind,
 * and a domain may give several candidates). Answers whether it was opened.
 */
async function reviewCandidate(t: DbTx, companyId: number, candidate: Record<string, unknown> & { alias: { kind: string; value: string } }, score: number, at: string): Promise<boolean> {
  const known = await t.one<{ id: number }>(
    `SELECT id FROM company_match_reviews WHERE company_id = ? AND kind = 'wikidata' AND status IN ('open', 'rejected')
       AND candidate->'alias'->>'value' = ? LIMIT 1`,
    [companyId, candidate.alias.value],
  );
  if (known) return false;
  await t.run(
    "INSERT INTO company_match_reviews(kind, company_id, other_company_id, candidate, score, created_at) VALUES ('wikidata', ?, NULL, CAST(? AS jsonb), ?, ?)",
    [companyId, JSON.stringify(candidate), score, at],
  );
  return true;
}

/** A `merge` review of two companies that share a strong key, unless one about the pair (either way) is open or was rejected. */
async function reviewMerge(t: DbTx, companyId: number, otherId: number, candidate: Record<string, unknown>, score: number, at: string): Promise<boolean> {
  const known = await t.one<{ id: number }>(
    `SELECT id FROM company_match_reviews WHERE kind = 'merge' AND status IN ('open', 'rejected')
       AND ((company_id = ? AND other_company_id = ?) OR (company_id = ? AND other_company_id = ?)) LIMIT 1`,
    [companyId, otherId, otherId, companyId],
  );
  if (known) return false;
  await t.run(
    "INSERT INTO company_match_reviews(kind, company_id, other_company_id, candidate, score, created_at) VALUES ('merge', ?, ?, CAST(? AS jsonb), ?, ?)",
    [companyId, otherId, JSON.stringify(candidate), score, at],
  );
  return true;
}

/** The company's parent: a relation to a company that holds the parent's key (never itself). */
async function relate(t: DbTx, parentId: number | undefined, childId: number | undefined, sourceId: number, score: number): Promise<void> {
  if (parentId === undefined || childId === undefined || parentId === childId) return;
  await t.run(
    `INSERT INTO company_relations(parent_id, child_id, kind, source_id, confidence) VALUES (?, ?, 'subsidiary', ?, ?)
     ON CONFLICT (parent_id, child_id) DO UPDATE SET source_id = excluded.source_id, confidence = GREATEST(company_relations.confidence, excluded.confidence)`,
    [parentId, childId, sourceId, score],
  );
}

/**
 * Matches one company against the reference data and writes what it found (see the module's note). Reads first, then
 * one transaction of writes (no outside read inside it: the live lookup runs before). Answers null for a company
 * never matched.
 */
export async function matchCompany(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, companyId: number, options: MatchOptions): Promise<MatchResult | null> {
  const db = deps.db;
  const keys = await companyKeysOf(db, companyId);
  if (!keys) return null;
  const { reader, at } = options;
  const decision = await decideWikidata(reader, keys, { lookup: options.lookup, byName: options.byName });
  const autoMin = constantsOf(deps).get('COMPANY_MATCH_AUTO_MIN');
  // A strong match under the automatic score is a review; a review of one item by a strong key (a domain) attaches
  // when the score allows it. Several items on one domain, or a name alone, are never attached automatically.
  const attach =
    decision.kind === 'attach' && decision.score >= autoMin
      ? decision
      : decision.kind === 'review' && decision.orgs.length === 1 && decision.via !== 'name' && decision.score >= autoMin
        ? { kind: 'attach' as const, org: decision.orgs[0]!, score: decision.score, via: decision.via }
        : null;
  const reviewOrgs = attach ? [] : decision.kind === 'review' ? decision.orgs : decision.kind === 'attach' ? [decision.org] : [];
  const reviewScore = decision.kind === 'none' ? 0 : decision.score;
  const reviewVia = decision.kind === 'none' ? 'none' : decision.via;
  const org = attach ? await reader.resolve(attach.org) : null;

  const ciks = [...new Set([...keys.cik, ...(org?.cik ? [org.cik] : [])])];
  const leis = [...new Set([...keys.lei, ...(org?.lei ? [org.lei] : [])])];
  const filer = ciks.length > 0 ? await reader.filer(ciks[0]!) : undefined;
  const entity = leis.length > 0 ? await reader.entity(leis[0]!) : undefined;
  const gleifParents = entity ? await reader.parentsOf(entity.lei) : [];
  const gleifChildren = entity ? await reader.childrenOfLei(entity.lei) : [];
  const wdChildren = org ? await reader.childrenOf(org.qid) : [];
  const score = attach?.score ?? SCORE.registry;
  const minConfidence = minConfidenceOf(deps);

  // v30 FIX-PERF (PGL-19): the search rows of the company's open jobs follow its profile after the match's transaction,
  // a batch per transaction (search-refresh.ts), never inside it.
  const pending: { search?: CompanySearchChange } = {};
  const matched = await db.tx(
    async (t) => {
      const result: MatchResult = { companyId, wikidata: null, sec: null, gleif: null, reviews: {}, changed: false, projected: 0 };
      const company = await t.one<{ owner_user_id: string | null; merged_into_id: number | null; do_not_fetch: boolean }>(
        'SELECT owner_user_id, merged_into_id, do_not_fetch FROM companies WHERE id = ? FOR UPDATE',
        [companyId],
      );
      // Merged, opted out or made an own row since the reads: nothing is written.
      if (!company || company.owner_user_id !== null || company.merged_into_id !== null || company.do_not_fetch) return null;
      const counted = (kind: 'wikidata' | 'merge') => {
        result.reviews[kind] = (result.reviews[kind] ?? 0) + 1;
      };

      // Wikidata.
      let wikidataSourceId: number | null = null;
      /** The item's registry keys another company holds: their SEC or GLEIF record is that company's, not this one's. */
      const heldElsewhere = new Set<string>();
      if (org) {
        const holder = await companyOfAlias(t, 'wikidata', org.qid);
        if (holder && holder.id !== companyId) {
          const opened = await reviewMerge(t, companyId, holder.id, { alias: { kind: 'wikidata', value: org.qid }, label: org.label, via: attach!.via }, attach!.score, at);
          if (opened) counted('merge');
        } else {
          const source = await upsertSource(t, companyId, SOURCE_KEYS.wikidata(org.qid, attach!.score), wikidataFields(org), at);
          wikidataSourceId = source.sourceId;
          result.changed ||= source.changed;
          result.wikidata = org.qid;
          await claimKey(t, companyId, 'wikidata', org.qid, attach!.score, at, source.sourceId);
          // An item matched before and no longer: its row goes (the profile then shows the others).
          const stale = await t.run("DELETE FROM company_sources WHERE company_id = ? AND kind = 'wikidata' AND ref <> ?", [companyId, org.qid]);
          result.changed ||= stale.changes > 0;
          for (const [kind, value] of [
            ['cik', org.cik],
            ['lei', org.lei],
          ] as const) {
            if (!value) continue;
            const other = await claimKey(t, companyId, kind, value, attach!.score, at, source.sourceId);
            if (other !== null) {
              heldElsewhere.add(value);
              const opened = await reviewMerge(t, companyId, other, { alias: { kind, value }, label: org.label, via: 'wikidata' }, attach!.score, at);
              if (opened) counted('merge');
            }
          }
          if (org.parentQid) await relate(t, (await companyOfAlias(t, 'wikidata', org.parentQid))?.id, companyId, source.sourceId, attach!.score);
          for (const child of wdChildren) await relate(t, companyId, (await companyOfAlias(t, 'wikidata', child))?.id, source.sourceId, attach!.score);
        }
      }
      for (const candidate of reviewOrgs) {
        const opened = await reviewCandidate(
          t,
          companyId,
          {
            alias: { kind: 'wikidata', value: candidate.qid },
            label: candidate.label,
            description: candidate.description,
            website: candidate.website,
            domain: candidate.domain,
            via: reviewVia,
          },
          reviewScore,
          at,
        );
        if (opened) counted('wikidata');
      }

      // SEC, by the company's CIK (or the item's, when the item attached here).
      const secAllowed = filer && (keys.cik.includes(filer.cik) || (wikidataSourceId !== null && !heldElsewhere.has(filer.cik)));
      if (filer && secAllowed) {
        const source = await upsertSource(t, companyId, SOURCE_KEYS.sec(filer.cik, score), secFields(filer), at);
        result.sec = filer.cik;
        result.changed ||= source.changed;
        const stale = await t.run("DELETE FROM company_sources WHERE company_id = ? AND kind = 'sec' AND ref <> ?", [companyId, filer.cik]);
        result.changed ||= stale.changes > 0;
      }

      // GLEIF, by the LEI.
      const gleifAllowed = entity && (keys.lei.includes(entity.lei) || (wikidataSourceId !== null && !heldElsewhere.has(entity.lei)));
      if (entity && gleifAllowed) {
        const source = await upsertSource(t, companyId, SOURCE_KEYS.gleif(entity.lei, score), gleifFields(entity, gleifParents.length > 0), at);
        result.gleif = entity.lei;
        result.changed ||= source.changed;
        const stale = await t.run("DELETE FROM company_sources WHERE company_id = ? AND kind = 'gleif' AND ref <> ?", [companyId, entity.lei]);
        result.changed ||= stale.changes > 0;
        for (const parent of gleifParents) await relate(t, (await companyOfAlias(t, 'lei', parent))?.id, companyId, source.sourceId, score);
        for (const child of gleifChildren) await relate(t, companyId, (await companyOfAlias(t, 'lei', child))?.id, source.sourceId, score);
      }

      if (result.changed) {
        const recomputed = await recomputeProfile(t, companyId, at, minConfidence);
        if (recomputed.searchChanged) pending.search = recomputed;
      }
      return result;
    },
    { label: 'refdata match' },
  );
  if (matched && pending.search) matched.projected = await refreshCompanySearch(deps, companyId, pending.search);
  return matched;
}
