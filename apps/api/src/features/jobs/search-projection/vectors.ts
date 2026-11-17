// v3.0 PG-SEARCH (11-database.md §5.6, §7.2): the parts of a job's search row the app computes. Words are folded by
// the app (NFKD, marks removed, lower case: the folding SQLite's `unicode61 remove_diacritics 2` tokenizer applied to
// jobs_fts) and split into the same tokens the search box's words become (letters and digits only), so a tsvector is
// written as its literal text (`'senior':1A 'data':2A`) and no text-search parser or dictionary of the database
// decides what a word is. Places and eligibility become keys, so "any of these places" is one GIN overlap.

/** What a job's words weigh: the title most, then the company, the places, the posting's text (bm25's 10, 6, 3, 1). */
export type Weight = 'A' | 'B' | 'C' | 'D';

/** ts_rank's weights, in its {D, C, B, A} order: bm25's 1, 3, 6, 10 over jobs_fts' columns, scaled to 1. */
export const RANK_WEIGHTS = '{0.1, 0.3, 0.6, 1.0}';

/**
 * How well a vector matches a tsquery (both SQL expressions), higher for a better match: ts_rank with RANK_WEIGHTS,
 * divided by 1 + the log of the vector's length (normalization 1), as bm25 favoured a shorter posting. On the parity
 * fixture it orders the pairs it tells apart as bm25 did in 81-93% (the Jobs page) and 88-100% (MCP) of cases.
 */
export function rankSql(vector: string, query: string): string {
  return `ts_rank('${RANK_WEIGHTS}', ${vector}, ${query}, 1)`;
}

/** PostgreSQL's limits on a tsvector: a lexeme's bytes, a position, the positions kept for one lexeme. */
const LEXEME_MAX_BYTES = 2047;
const POSITION_MAX = 16_383;
const POSITIONS_PER_LEXEME = 256;

/** Lower case, accents removed (NFKD, then every combining mark dropped). */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The tokens of a text: "Node.js" -> ["node", "js"], "C++" -> ["c"], "Zürich" -> ["zurich"]. */
export function tokensOf(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || !text) return [];
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

const encoder = new TextEncoder();

/** A token a tsvector can hold (PostgreSQL refuses a lexeme of 2 KB or more). */
function storable(token: string): boolean {
  return token.length * 3 <= LEXEME_MAX_BYTES || encoder.encode(token).length <= LEXEME_MAX_BYTES;
}

/**
 * A tsvector's literal text from weighted fields, in order. Positions run on across fields with a gap of one between
 * two fields, so a phrase (`<->`) never joins the last word of one field to the first of the next (FTS5's columns
 * were separate). Tokens are letters and digits only: they need no escaping inside the quotes.
 */
export function tsvectorOf(fields: ReadonlyArray<{ text: string | null | undefined; weight: Weight }>): string {
  const positions = new Map<string, string[]>();
  let position = 1;
  for (const field of fields) {
    const tokens = tokensOf(field.text);
    if (tokens.length === 0) continue;
    for (const token of tokens) {
      if (storable(token)) {
        const list = positions.get(token) ?? [];
        if (list.length < POSITIONS_PER_LEXEME) {
          const at = Math.min(position, POSITION_MAX);
          const entry = `${at}${field.weight}`;
          // Past the last position every word sits on it: keep one entry each.
          if (list[list.length - 1] !== entry) list.push(entry);
        }
        positions.set(token, list);
      }
      position += 1;
    }
    position += 1;
  }
  return [...positions].map(([token, list]) => `'${token}':${list.join(',')}`).join(' ');
}

// ------------------------------------------------------------------------------------------------- places

export interface PlaceParts {
  city: string | null;
  region: string | null;
  countryCode: string | null;
}

export interface PlaceRow extends PlaceParts {
  isRemote: boolean;
}

const cityKey = (city: string) => fold(city.trim());
const codeKey = (code: string) => code.trim().toUpperCase();
const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * The key one parsed place of the Location filter reads: 'c:US' (a country), 'r:US-TX' (a region of a country),
 * 't:US-TX:austin' (a city of a region of a country); '*' stands for a part the place leaves out ('r:*-TX',
 * 't:US-*:paris', 't:*-*:springfield'). null when the place names no city, region or country.
 */
export function placeKeyOf(place: PlaceParts): string | null {
  const country = present(place.countryCode) ? codeKey(place.countryCode) : '*';
  const region = present(place.region) ? codeKey(place.region) : '*';
  if (present(place.city)) return `t:${country}-${region}:${cityKey(place.city)}`;
  if (region !== '*') return `r:${country}-${region}`;
  if (country !== '*') return `c:${country}`;
  return null;
}

/** "Remote" ('rm') or "Remote in {country}" ('rm:US'). */
export function remoteKeyOf(countryCode: string | null | undefined): string {
  return present(countryCode) ? `rm:${codeKey(countryCode)}` : 'rm';
}

/**
 * Every key a job's places answer. A place answers the key of each set of its parts, so a filter that names fewer
 * parts (a city and its country, no region) still finds it: one place of the posting must hold every part the filter
 * names, as v2.0's `EXISTS (... jl.city = ? AND jl.region = ? ...)` read. 'rm' when a place is remote or the job is,
 * and 'rm:<country>' for each country of a place that is remote, or of any place when the job is remote.
 */
export function placeKeysOf(rows: readonly PlaceRow[], jobRemote: boolean): string[] {
  const keys = new Set<string>();
  if (jobRemote) keys.add('rm');
  for (const row of rows) {
    if (row.isRemote) keys.add('rm');
    if ((row.isRemote || jobRemote) && present(row.countryCode)) keys.add(remoteKeyOf(row.countryCode));
    const parts: Array<keyof PlaceParts> = (['city', 'region', 'countryCode'] as const).filter((part) => present(row[part]));
    for (let mask = 1; mask < 1 << parts.length; mask += 1) {
      const subset: PlaceParts = { city: null, region: null, countryCode: null };
      parts.forEach((part, index) => {
        if (mask & (1 << index)) subset[part] = row[part];
      });
      const key = placeKeyOf(subset);
      if (key) keys.add(key);
    }
  }
  return [...keys].sort();
}

// ------------------------------------------------------------------------------------------------- eligibility

export interface Eligibility {
  /** 'c:*' or 'c:US'…, and 'o:*' or 'o:-0800'… (11 §5.6: "no rule, or my value" is one overlap). */
  keys: string[];
  /** Countries whose regions the rule lists ('US'). */
  regionCountries: string[];
  /** Those regions ('US-TX'). */
  regions: string[];
}

/** A job's candidate-eligibility keys from its job_facts_eligibility rows. A missing rule is the '*' key. */
export function eligibilityOf(rows: ReadonlyArray<{ kind: string; value: string }>): Eligibility {
  const countries = new Set<string>();
  const offsets = new Set<string>();
  const regions = new Set<string>();
  const regionCountries = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'country') countries.add(row.value);
    else if (row.kind === 'utc_offset') offsets.add(row.value);
    else if (row.kind === 'region') {
      regions.add(row.value);
      const country = row.value.slice(0, 2);
      regionCountries.add(country);
      // A region rule names its country too.
      countries.add(country);
    }
  }
  const keys = [
    ...(countries.size === 0 ? ['c:*'] : [...countries].sort().map((country) => `c:${country}`)),
    ...(offsets.size === 0 ? ['o:*'] : [...offsets].sort().map((offset) => `o:${offset}`)),
  ];
  return { keys, regionCountries: [...regionCountries].sort(), regions: [...regions].sort() };
}
