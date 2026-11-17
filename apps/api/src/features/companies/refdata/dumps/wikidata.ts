import { normalizeCompanyName } from '@tailorit/shared';
import { isCompanyDomain, registrableDomain } from '../../domain';

// v30 E1: Wikidata's entities (docs/design/part2/13-company-enrichment.md §3.2), as the weekly JSON dump writes them
// (`latest-all.json.gz`: a JSON array with one entity a line, each line ending with a comma) and as the entity API
// answers one (`Special:EntityData/Q95.json`: {entities: {Q95: entity}}): the same object either way, so the monthly
// build and the live lookup read it with the same code.
//
// The properties read (Wikidata's own numbers): P31 instance of, P856 official website, P4264 LinkedIn company ID, P452
// industry, P1128 employees (its P585 point in time), P571 inception, P159 headquarters, P17 country, P414 stock
// exchange (its P249 ticker), P749 parent organization, P127 owned by, P1448 official name, P1278 LEI, P5531 SEC CIK;
// for the places and the other items they point at: P131 located in, P297 ISO 3166-1 alpha-2, P300 ISO 3166-2.
// A statement ranked `deprecated` is never read; a `preferred` one wins over `normal` ones; a statement with an end time
// (P582) is a past one and is skipped where the present is asked (the website, the headquarters, the exchange, the
// parent).

/** A dump entity, loosely typed: only the parts read below are looked at. */
export type WdEntity = Record<string, unknown>;

/** An organisation as wd_orgs keeps it. */
export interface WdOrg {
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
  industryQids: string[];
  employees: number | null;
  employeesAsOf: string | null;
  inceptionYear: number | null;
  hqQid: string | null;
  countryQid: string | null;
  exchanges: Array<{ qid: string; ticker: string | null }>;
  parentQid: string | null;
  ownerQid: string | null;
  typeQids: string[];
}

/** Another item (a place, an industry, an exchange, a type) as wd_items keeps it. */
export interface WdItem {
  qid: string;
  label: string | null;
  parentQid: string | null;
  countryQid: string | null;
  isoCountry: string | null;
  isoRegion: string | null;
}

const QID = /^Q[1-9]\d{0,11}$/;
/** Human: an item that is a person is never kept, whatever else it has. */
const HUMAN = 'Q5';

/** The entity of one dump line (the array's brackets and a line's trailing comma left out); null for none. */
export function parseEntityLine(line: string): WdEntity | null {
  let text = line.trim();
  if (text === '' || text === '[' || text === ']') return null;
  if (text.endsWith(',')) text = text.slice(0, -1);
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as WdEntity) : null;
  } catch {
    return null;
  }
}

/** A dump line's item id, read from its first characters without parsing the line (a pass that wants a few ids). */
export function lineItemId(line: string): string | null {
  const match = /"id":"(Q\d+)"/.exec(line.slice(0, 300));
  return match ? match[1]! : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The entity's id when it is an item. */
export function itemIdOf(entity: WdEntity): string | null {
  const id = entity.id;
  return entity.type === 'item' && typeof id === 'string' && QID.test(id) ? id : null;
}

/** A language map's English value ('mul', the default for all languages, next). */
function textIn(map: unknown): string | null {
  const values = record(map);
  if (!values) return null;
  for (const language of ['en', 'mul']) {
    const value = record(values[language])?.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function aliasesOf(entity: WdEntity): string[] {
  const map = record(entity.aliases);
  if (!map) return [];
  const out: string[] = [];
  for (const language of ['en', 'mul']) {
    const list = map[language];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const value = record(item)?.value;
      if (typeof value === 'string' && value.trim()) out.push(value.trim());
    }
  }
  return out;
}

interface Statement {
  rank: string;
  value: unknown;
  qualifiers: Record<string, unknown>;
}

/** A property's statements that count: never deprecated; the preferred ones when any, else the normal ones. */
function statementsOf(entity: WdEntity, property: string, options: { current?: boolean } = {}): Statement[] {
  const claims = record(entity.claims);
  const list = claims?.[property];
  if (!Array.isArray(list)) return [];
  const statements: Statement[] = [];
  for (const raw of list) {
    const claim = record(raw);
    const snak = record(claim?.mainsnak);
    if (!claim || !snak || snak.snaktype !== 'value') continue;
    const rank = typeof claim.rank === 'string' ? claim.rank : 'normal';
    if (rank === 'deprecated') continue;
    const qualifiers = record(claim.qualifiers) ?? {};
    // A statement that ended (P582) is not the present one.
    if (options.current && Array.isArray(qualifiers.P582) && qualifiers.P582.length > 0) continue;
    statements.push({ rank, value: record(snak.datavalue)?.value, qualifiers });
  }
  const preferred = statements.filter((statement) => statement.rank === 'preferred');
  return preferred.length > 0 ? preferred : statements;
}

const itemValue = (value: unknown): string | null => {
  const item = record(value);
  const id = typeof item?.id === 'string' ? item.id : typeof item?.['numeric-id'] === 'number' ? `Q${item['numeric-id']}` : null;
  return id && QID.test(id) ? id : null;
};
const stringValue = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

function firstItem(entity: WdEntity, property: string, current = false): string | null {
  for (const statement of statementsOf(entity, property, { current })) {
    const id = itemValue(statement.value);
    if (id) return id;
  }
  return null;
}

function items(entity: WdEntity, property: string, current = false): string[] {
  const out: string[] = [];
  for (const statement of statementsOf(entity, property, { current })) {
    const id = itemValue(statement.value);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function firstString(entity: WdEntity, property: string, current = false): string | null {
  for (const statement of statementsOf(entity, property, { current })) {
    const value = stringValue(statement.value);
    if (value) return value;
  }
  return null;
}

/** A time value's date ('YYYY-MM-DD', at day precision) and year (at year precision or finer). */
export function timeOf(value: unknown): { year: number; day: string | null } | null {
  const time = record(value);
  const text = typeof time?.time === 'string' ? time.time : null;
  const precision = typeof time?.precision === 'number' ? time.precision : 0;
  if (!text || precision < 9) return null;
  const match = /^([+-])(\d{1,16})-(\d{2})-(\d{2})T/.exec(text);
  if (!match || match[1] === '-') return null;
  const year = Number(match[2]);
  if (!Number.isSafeInteger(year)) return null;
  const day = precision >= 11 && match[3] !== '00' && match[4] !== '00' ? `${String(year).padStart(4, '0')}-${match[3]}-${match[4]}` : null;
  return { year, day };
}

/** The newest head count: the statement whose point in time (P585) is latest; else the first one. */
function employeesOf(entity: WdEntity): { count: number; asOf: string | null } | null {
  let best: { count: number; asOf: string | null; at: string } | null = null;
  for (const statement of statementsOf(entity, 'P1128')) {
    const amount = Number(String(record(statement.value)?.amount ?? '').replace(/^\+/, ''));
    if (!Number.isSafeInteger(amount) || amount < 0) continue;
    const point = Array.isArray(statement.qualifiers.P585) ? timeOf(record(record(statement.qualifiers.P585[0])?.datavalue)?.value) : null;
    const asOf = point?.day ?? (point ? `${String(point.year).padStart(4, '0')}-12-31` : null);
    const at = asOf ?? '';
    if (!best || at > best.at) best = { count: amount, asOf, at };
  }
  return best ? { count: best.count, asOf: best.asOf } : null;
}

/** The exchanges a company is listed on now, each with its ticker (the statement's P249). */
function exchangesOf(entity: WdEntity): Array<{ qid: string; ticker: string | null }> {
  const out: Array<{ qid: string; ticker: string | null }> = [];
  for (const statement of statementsOf(entity, 'P414', { current: true })) {
    const qid = itemValue(statement.value);
    if (!qid || out.some((exchange) => exchange.qid === qid)) continue;
    const ticker = Array.isArray(statement.qualifiers.P249) ? stringValue(record(record(statement.qualifiers.P249[0])?.datavalue)?.value) : null;
    out.push({ qid, ticker: ticker ? ticker.slice(0, 20) : null });
  }
  return out;
}

/** An SEC CIK as ten digits; null for anything else. */
export function cikOf(value: unknown): string | null {
  const digits = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return /^\d{1,10}$/.test(digits) ? digits.padStart(10, '0') : null;
}

/** An LEI (20 letters and digits, upper case); null for anything else. */
export function leiOf(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z0-9]{18}\d{2}$/.test(text) ? text : null;
}

/** A LinkedIn company ID as Wikidata's P4264 holds it (the part after /company/). */
function linkedinIdOf(value: string | null): string | null {
  return value && /^[\w%.-]{1,200}$/u.test(value) ? value : null;
}

function has(entity: WdEntity, property: string): boolean {
  return statementsOf(entity, property).length > 0;
}

/**
 * The entity as an organisation, or null when it is none: a person never; otherwise an item with an LEI, a CIK, an
 * exchange or a LinkedIn company ID, or with an official website and an industry, a head count, a headquarters or a
 * parent (13 §3.2: "organisations with any of P856, P4264, P1278, P5531 or P414"; a website alone also names a
 * person's page, a city or a piece of software). `anyItem` keeps any item but a person: a live lookup found it by its
 * website already.
 */
export function orgOf(entity: WdEntity, options: { anyItem?: boolean } = {}): WdOrg | null {
  const qid = itemIdOf(entity);
  if (!qid) return null;
  const typeQids = items(entity, 'P31');
  if (typeQids.includes(HUMAN)) return null;
  const strong = has(entity, 'P1278') || has(entity, 'P5531') || has(entity, 'P414') || has(entity, 'P4264');
  const orgish = has(entity, 'P856') && (has(entity, 'P452') || has(entity, 'P1128') || has(entity, 'P159') || has(entity, 'P749'));
  if (!strong && !orgish && !options.anyItem) return null;

  const label = textIn(entity.labels);
  const officialName = (() => {
    for (const statement of statementsOf(entity, 'P1448', { current: true })) {
      const text = record(statement.value);
      if (typeof text?.text === 'string' && text.text.trim() && (text.language === 'en' || text.language === 'mul')) return text.text.trim();
    }
    const first = statementsOf(entity, 'P1448', { current: true })[0];
    const text = record(first?.value)?.text;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  })();
  const nameKeys: string[] = [];
  for (const name of [label, officialName, ...aliasesOf(entity)]) {
    const key = normalizeCompanyName(name);
    if (key && !nameKeys.includes(key)) nameKeys.push(key);
  }
  const website = (() => {
    const url = firstString(entity, 'P856', true);
    return url && /^https?:\/\/\S+$/i.test(url) && url.length <= 2048 ? url : null;
  })();
  const domain = registrableDomain(website);
  const employees = employeesOf(entity);
  const inception = (() => {
    for (const statement of statementsOf(entity, 'P571')) {
      const time = timeOf(statement.value);
      if (time) return time.year;
    }
    return null;
  })();
  return {
    qid,
    label,
    description: textIn(entity.descriptions),
    officialName,
    nameKeys,
    website,
    domain: isCompanyDomain(domain) ? domain : null,
    linkedinId: linkedinIdOf(firstString(entity, 'P4264', true)),
    cik: cikOf(firstString(entity, 'P5531')),
    lei: leiOf(firstString(entity, 'P1278')),
    industryQids: items(entity, 'P452'),
    employees: employees?.count ?? null,
    employeesAsOf: employees?.asOf ?? null,
    inceptionYear: inception,
    hqQid: firstItem(entity, 'P159', true),
    countryQid: firstItem(entity, 'P17', true),
    exchanges: exchangesOf(entity),
    parentQid: firstItem(entity, 'P749', true),
    ownerQid: firstItem(entity, 'P127', true),
    typeQids,
  };
}

/** The entity as an item wd_items keeps (its label and where it lies). */
export function itemOf(entity: WdEntity): WdItem | null {
  const qid = itemIdOf(entity);
  if (!qid) return null;
  const isoCountry = firstString(entity, 'P297');
  const isoRegion = firstString(entity, 'P300');
  return {
    qid,
    label: textIn(entity.labels),
    parentQid: firstItem(entity, 'P131', true),
    countryQid: firstItem(entity, 'P17', true),
    isoCountry: isoCountry && /^[A-Z]{2}$/.test(isoCountry) ? isoCountry : null,
    isoRegion: isoRegion && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(isoRegion) ? isoRegion : null,
  };
}

/** Whether an item is a country or a first-level subdivision (kept by the first pass, whoever points at it). */
export function isPlaceCode(entity: WdEntity): boolean {
  return has(entity, 'P297') || has(entity, 'P300');
}

/** The items an organisation points at whose labels the matcher reads: its places, industries, exchanges and types. */
export function referencedOf(org: WdOrg): { places: string[]; others: string[] } {
  const places = [org.hqQid, org.countryQid].filter((qid): qid is string => qid !== null);
  const others = [...org.industryQids, ...org.exchanges.map((exchange) => exchange.qid), ...org.typeQids];
  return { places, others };
}
