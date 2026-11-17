import { normalizeCompanyName, US_STATES } from '@tailorit/shared';
import { cikOf } from './wikidata';

// v30 E1: SEC EDGAR's submissions (docs/design/part2/13-company-enrichment.md §3.2): one JSON file a filer
// (`CIK##########.json`, as the nightly submissions.zip holds them; its `CIK##########-submissions-NNN.json` files are
// older filings' pages and are skipped). Kept: operating companies and any filer with a ticker, with the name, tickers,
// exchanges, the SIC code and its words, the business address and the former names. EDGAR's `website` is usually empty
// (Apple's is ""), so a company finds its filer only by a CIK (Wikidata's P5531, or an admin's key).

export interface SecFiler {
  cik: string;
  name: string;
  nameKey: string;
  tickers: string[];
  exchanges: string[];
  sic: string | null;
  sicDescription: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  entityType: string | null;
  formerNames: string[];
}

/** Whether a file of submissions.zip (or of an unpacked folder) is a filer's main record. */
export function isFilerFile(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return /^CIK\d{10}\.json$/i.test(base);
}

const text = (value: unknown, max = 300): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const texts = (value: unknown, max = 40): string[] =>
  Array.isArray(value) ? value.map((item) => text(item, max)).filter((item): item is string => item !== null) : [];

/** "CUPERTINO" -> "Cupertino", "SAN FRANCISCO" -> "San Francisco"; a mixed-case name as it is. */
export function cityCase(value: string | null): string | null {
  if (!value) return null;
  if (value !== value.toUpperCase()) return value;
  return value.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_all, before: string, letter: string) => before + letter.toUpperCase());
}

/** A filer of one submissions record, or null when it is not kept (not an operating company and no ticker). */
export function filerOf(json: unknown): SecFiler | null {
  const data = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  if (!data) return null;
  const cik = cikOf(data.cik);
  const name = text(data.name);
  if (!cik || !name) return null;
  const tickers = texts(data.tickers, 20);
  const entityType = text(data.entityType, 40);
  if (entityType !== 'operating' && tickers.length === 0) return null;
  const addresses = data.addresses && typeof data.addresses === 'object' ? (data.addresses as Record<string, unknown>) : {};
  const business = addresses.business && typeof addresses.business === 'object' ? (addresses.business as Record<string, unknown>) : {};
  const state = text(business.stateOrCountry, 10)?.toUpperCase() ?? null;
  const usState = state && Object.hasOwn(US_STATES, state) ? state : null;
  const formerNames = Array.isArray(data.formerNames)
    ? data.formerNames
        .map((item) => (item && typeof item === 'object' ? text((item as Record<string, unknown>).name) : null))
        .filter((item): item is string => item !== null)
        .slice(0, 20)
    : [];
  return {
    cik,
    name,
    nameKey: normalizeCompanyName(name),
    tickers,
    exchanges: texts(data.exchanges, 40),
    sic: text(data.sic, 10),
    sicDescription: text(data.sicDescription, 200),
    city: cityCase(text(business.city, 120)),
    // EDGAR's codes outside the United States (A0-Z4) name a province or a country by code only: kept as nothing.
    region: usState,
    country: usState ? 'US' : null,
    entityType,
    formerNames,
  };
}
