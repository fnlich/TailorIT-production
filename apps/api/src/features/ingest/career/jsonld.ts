import { decodeHtmlEntities, htmlToText, linkKey } from '@tailorit/shared';
import type { RawSalary } from '../types';
import { isRecord, num, periodOf, str, type Json } from '../adapters/common';
import { countryNameOf, regionReadAsCountry } from './countries'; // v37 FIX-37A

// v30 S5: a career page's schema.org JobPosting (docs/design/part2/12-job-sourcing.md §3.4 step 4). Only the page's
// `<script type="application/ld+json">` blocks are parsed: no guessing from the HTML around them, no scripts run, no AI
// reading of pages. A page with no JobPosting of its own is no posting. Google's fields (its JobPosting guidance, [G23]):
// required title, description, datePosted, hiringOrganization, jobLocation; recommended validThrough, employmentType,
// baseSalary, identifier, applicantLocationRequirements, jobLocationType TELECOMMUTE, directApply.
//
// Which JobPosting is the page's: one at a block's top level (or in its @graph, or a WebPage's mainEntity). Postings
// nested anywhere else ("similar jobs" lists) are other pages' and are never read here. When a page carries several,
// the one whose `url` is the page's own address is the page's; with none, the page names no posting of its own.

/** The JSON-LD blocks read from one page. */
export const JSON_LD_MAX_BLOCKS = 30;
/** How deep a block's @graph / mainEntity are followed. */
export const JSON_LD_MAX_DEPTH = 4;
/** The longest title kept. */
export const JOB_TITLE_MAX_CHARS = 300;
/** The places one posting names (jobLocation, applicantLocationRequirements). */
export const JOB_PLACES_MAX = 20;

/** What a page's JobPosting says, read and checked. */
export interface JobPostingData {
  title: string;
  /** HTML (entity-decoded, not yet sanitised: the store sanitises it). */
  descriptionHtml: string | null;
  /** ISO times, or null when absent or unreadable. */
  datePosted: string | null;
  validThrough: string | null;
  /** The posting's own address as the page states it. */
  url: string | null;
  /** The posting's identifier (a requisition number), as text. */
  identifier: string | null;
  hiringOrganization: HiringOrganizationData | null;
  /** Places as "City, Region, Country" lines (the shared place parser reads them). */
  locations: string[];
  /** jobLocationType TELECOMMUTE. */
  remote: boolean;
  /** applicantLocationRequirements' names (where a remote applicant may live). */
  applicantLocations: string[];
  /** employmentType as words ("FULL TIME, CONTRACTOR"). */
  employmentText: string | null;
  salary: RawSalary | null;
  industry: string | null;
}

/** JobPosting.hiringOrganization as the hand-off takes it (companies/hiring-org.ts HiringOrganization). */
export interface HiringOrganizationData {
  name: string | null;
  sameAs: string[];
  url: string | null;
  logo: string | null;
}

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LD_JSON_TYPE = /\btype\s*=\s*["']?\s*application\/ld\+json\b/i;

/** The text of a JSON-LD block as JSON, read leniently (HTML comment or CDATA wrappers, raw line breaks, a trailing comma). */
function parseBlock(text: string): unknown {
  const body = text
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, '')
    .replace(/\/\*\s*\]\]>\s*\*\/$/, '')
    .trim();
  if (!body) return undefined;
  const attempts = [
    body,
    // eslint-disable-next-line no-control-regex
    body.replace(/[\u0000-\u001f]+/g, ' '),
    // eslint-disable-next-line no-control-regex
    body.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1'),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      /* the next, more lenient reading */
    }
  }
  return undefined;
}

/** The parsed JSON-LD blocks of a page (unreadable blocks skipped). */
export function jsonLdBlocksOf(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    if (blocks.length >= JSON_LD_MAX_BLOCKS) break;
    if (!LD_JSON_TYPE.test(match[1] ?? '')) continue;
    const parsed = parseBlock(match[2] ?? '');
    if (parsed !== undefined) blocks.push(parsed);
  }
  return blocks;
}

/** Whether a node's @type names JobPosting (a string or a list; "https://schema.org/JobPosting" too). */
function isType(node: Json, wanted: string): boolean {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some((type) => typeof type === 'string' && type.replace(/^https?:\/\/schema\.org\//i, '').trim() === wanted);
}

/** The JobPosting nodes at a block's top level, in its @graph, or as a page's mainEntity (see the top). */
function topPostings(value: unknown, depth: number, out: Json[]): void {
  if (depth > JSON_LD_MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) topPostings(item, depth + 1, out);
    return;
  }
  if (!isRecord(value)) return;
  if (isType(value, 'JobPosting')) {
    out.push(value);
    return;
  }
  if (value['@graph'] !== undefined) topPostings(value['@graph'], depth + 1, out);
  if (value.mainEntity !== undefined) topPostings(value.mainEntity, depth + 1, out);
}

/** Text of a JSON-LD value: entities decoded, tags dropped, spaces folded. */
function plain(value: unknown, max = 2000): string | null {
  const text = str(value);
  if (!text) return null;
  const clean = htmlToText(decodeHtmlEntities(text)).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** An ISO time of a schema.org date or date-time; null when unreadable. */
export function isoOf(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An absolute http(s) address, or null. */
function addressOf(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

// v37 FIX-37A (SP v37 FIXES-37 E5, review H1): a place's parts are cleaned before the places reader sees them. iCIMS
// writes "UNAVAILABLE" in an empty field and its country as an ISO code ("Vught, UNAVAILABLE, NL" read as a second
// place in Canada; "Bangalore, KA, IN" as Indiana): a placeholder is dropped, a country code becomes the country's name
// (career/countries.ts), a region with a digit in it (a postal code, a numeric code) is dropped, and so is a locality
// that is only a postal code. Every career page's JSON-LD is read alike, and BambooHR's places too (placeOfParts).

/** Words a field holds when it holds nothing ("UNAVAILABLE", "N/A", "-"). */
const PLACEHOLDER = /^(?:unavailable|not available|not applicable|n\/a|n\.a\.?|none|null|nil|undefined|unknown|not specified|unspecified|tbd|tba|-+|\.+|\?+)$/i;

/** A place's part as text (null for a placeholder); `bareNa` also drops a bare "NA" (not in a country: Namibia's code). */
function placePart(value: string | null, bareNa = true): string | null {
  const text = value?.trim() ?? '';
  if (!text || PLACEHOLDER.test(text) || (bareNa && /^na$/i.test(text))) return null;
  return text;
}

/** A country as a place's part: a placeholder dropped, an ISO code as its name ("NL" -> "Netherlands"). */
export function countryPart(value: string | null): string | null {
  const text = placePart(value, false);
  return text ? countryNameOf(text) : null;
}

/**
 * One place's line from its parts, cleaned (see above): "Vught, UNAVAILABLE, NL" -> "Vught, Netherlands",
 * "Bangalore, KA, IN" -> "Bangalore, KA, India"; null when nothing is left.
 */
export function placeOfParts(locality: string | null, region: string | null, country: string | null): string | null {
  const city = placePart(locality);
  const state = placePart(region);
  const nation = countryPart(country);
  const parts = [
    city && !/^\d[\d\s-]*$/.test(city) ? city : null,
    // A postal code (or any numeric code) is never a region; nor, before a country, a code the places reader would read
    // as a country of its own ("Gurgaon, HR, India": Haryana's code is Croatia's).
    state && !/\d/.test(state) && !(nation && regionReadAsCountry(state)) ? state : null,
    nation,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Whether a node's @type names a schema.org Country. */
const isCountryNode = (value: Json) => isType(value, 'Country');

/** A Country / State / Place's name ("United States", {"@type":"Country","name":"US"}: a Country's code as its name). */
function placeName(value: unknown): string | null {
  if (isRecord(value)) {
    const name = placePart(plain(value.name, 200), !isCountryNode(value));
    if (name) return isCountryNode(value) ? countryNameOf(name) : name;
    return countryPart(plain(value.addressCountry, 200));
  }
  return placePart(plain(value, 200));
}

/** One jobLocation as a place line: "Austin, TX, United States" (locality, region, country; postal address or text). */
function placeLine(value: unknown): string | null {
  if (!isRecord(value)) return placePart(plain(value, 300));
  const address = isRecord(value.address) ? value.address : value.address === undefined ? value : null;
  if (!address) return placePart(plain(value.address, 300)) ?? placePart(plain(value.name, 300));
  const country = isRecord(address.addressCountry) ? placeName(address.addressCountry) : plain(address.addressCountry, 100);
  return (
    placeOfParts(plain(address.addressLocality, 100), plain(address.addressRegion, 100), country) ?? placePart(plain(value.name, 300))
  );
}

/** baseSalary (MonetaryAmount; its value a QuantitativeValue or a number) as a RawSalary. */
function salaryOf(value: unknown): RawSalary | null {
  const amount = listOf(value).find(isRecord) ?? null;
  if (!amount) {
    const single = num(value);
    return single === null ? null : { min: single, max: single, currency: null, period: null };
  }
  const quantity = isRecord(amount.value) ? amount.value : null;
  const exact = quantity ? num(quantity.value) : num(amount.value);
  const min = (quantity ? num(quantity.minValue) : null) ?? exact;
  const max = (quantity ? num(quantity.maxValue) : null) ?? exact;
  if (min === null && max === null) return null;
  const currency = str(amount.currency)?.toUpperCase() ?? null;
  return {
    min,
    max,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    period: periodOf(quantity?.unitText ?? amount.unitText),
  };
}

/** identifier: text, a number, or a PropertyValue ({"value": "R-123", "name": "Acme"}); the first usable one. */
function identifierOf(value: unknown): string | null {
  for (const item of listOf(value)) {
    const text = isRecord(item) ? str(item.value) : str(item);
    if (text && text.length <= 200) return text;
  }
  return null;
}

/** hiringOrganization: an Organization, or its name as text. */
function organizationOf(value: unknown): HiringOrganizationData | null {
  const org = listOf(value)[0];
  if (org === undefined) return null;
  if (!isRecord(org)) {
    const name = plain(org, 200);
    return name ? { name, sameAs: [], url: null, logo: null } : null;
  }
  const logo = isRecord(org.logo) ? (addressOf(org.logo.url) ?? addressOf(org.logo.contentUrl)) : addressOf(org.logo);
  const sameAs = listOf(org.sameAs)
    .map(addressOf)
    .filter((link): link is string => link !== null)
    .slice(0, 10);
  const result = { name: plain(org.name, 200), sameAs, url: addressOf(org.url), logo };
  return result.name || result.sameAs.length > 0 || result.url ? result : null;
}

/** One JobPosting node read and checked; null without a title. */
export function jobPostingOf(node: Json): JobPostingData | null {
  const title = plain(node.title, JOB_TITLE_MAX_CHARS) ?? plain(node.name, JOB_TITLE_MAX_CHARS);
  if (!title) return null;
  const raw = str(node.description);
  // JSON-LD descriptions come as HTML, often entity-escaped ("&lt;p&gt;"): decoded once when no tag is left raw.
  const descriptionHtml = raw ? (!/<[a-z!/]/i.test(raw) && /&lt;|&#60;|&#x3c;/i.test(raw) ? decodeHtmlEntities(raw) : raw) : null;
  const locationType = listOf(node.jobLocationType).map((value) => str(value)?.toUpperCase());
  const employment = listOf(node.employmentType)
    .map((value) => str(value)?.replace(/_/g, ' '))
    .filter((value): value is string => Boolean(value));
  return {
    title,
    descriptionHtml,
    datePosted: isoOf(node.datePosted),
    validThrough: isoOf(node.validThrough),
    url: addressOf(node.url),
    identifier: identifierOf(node.identifier),
    hiringOrganization: organizationOf(node.hiringOrganization),
    locations: listOf(node.jobLocation)
      .map(placeLine)
      .filter((line): line is string => Boolean(line))
      .slice(0, JOB_PLACES_MAX),
    remote: locationType.includes('TELECOMMUTE'),
    applicantLocations: listOf(node.applicantLocationRequirements)
      .map(placeName)
      .filter((name): name is string => Boolean(name))
      .slice(0, JOB_PLACES_MAX),
    employmentText: employment.length > 0 ? employment.join(', ') : null,
    salary: salaryOf(node.baseSalary),
    industry: plain(node.industry, 200),
  };
}

/**
 * The page's own JobPosting (see the top), or null: the one at a block's top level, or, of several, the one whose url
 * is the page's address. Copies of one posting (the same title, identifier and url) count once.
 */
export function pageJobPosting(html: string, pageUrl: string): JobPostingData | null {
  const nodes: Json[] = [];
  for (const block of jsonLdBlocksOf(html)) topPostings(block, 0, nodes);
  const unique = new Map<string, JobPostingData>();
  for (const node of nodes) {
    const posting = jobPostingOf(node);
    if (!posting) continue;
    const key = JSON.stringify([posting.title, posting.identifier, posting.url ? linkKey(posting.url) : null]);
    if (!unique.has(key)) unique.set(key, posting);
  }
  const postings = [...unique.values()];
  if (postings.length <= 1) return postings[0] ?? null;
  const page = linkKey(pageUrl);
  const own = postings.filter((posting) => posting.url !== null && linkKey(posting.url) === page);
  return own.length === 1 ? own[0]! : null;
}

/** Whether a posting's validThrough is past at `now` (12 §8.1: the posting has closed). */
export function expiredAt(posting: Pick<JobPostingData, 'validThrough'>, now: Date): boolean {
  return posting.validThrough !== null && Date.parse(posting.validThrough) < now.getTime();
}
