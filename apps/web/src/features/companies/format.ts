import {
  COMPANY_FOUNDED_LABEL,
  COMPANY_SIZES,
  LINKEDIN_COMPANY_URL_PATTERN,
  companyStageLabel,
  formatLocation,
  industryLabel,
  NOT_SPECIFIED_INDUSTRY,
  type CompanyFoundedKind,
  type CompanyProfile,
  type CompanySourceLine,
  type CompanySummaryOrigin,
} from '@tailorit/shared';

// v30 E0-WEB: the company's words, shared by the job detail's Company section (features/jobs/detail/company) and the
// company page (/companies/:id): the sources line, the summary's origin label, "Founded" or "Incorporated", the stage
// with its ticker, the head count, the headquarters and the links (13-company-enrichment.md §2, §6.3, §10; 00-overview
// §1). Pure: no React, no clock.

/** "a", "a and b", "a, b and c". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The sources once each, in their order: two kinds may read alike ("the company's website"); the first link wins. */
export function sourceNames(sources: readonly CompanySourceLine[] | null | undefined): CompanySourceLine[] {
  const seen = new Map<string, CompanySourceLine>();
  for (const source of sources ?? []) {
    const label = source.label.trim();
    if (!label) continue;
    const known = seen.get(label.toLowerCase());
    if (!known) seen.set(label.toLowerCase(), { label, ...(source.url ? { url: source.url } : {}) });
    else if (!known.url && source.url) known.url = source.url;
  }
  return [...seen.values()];
}

/** "November 2026", or null for no date. Read in UTC, so every viewer sees the same month. */
export function updatedMonth(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The sources line under the stats (13 §6.3): "Sources: the company's website, Wikidata, SEC EDGAR. Updated November
 * 2026." Null when there is neither a source nor a date.
 */
export function sourcesLineText(sources: readonly CompanySourceLine[] | null | undefined, updatedAt: string | null | undefined): string | null {
  const names = sourceNames(sources).map((source) => source.label);
  const month = updatedMonth(updatedAt);
  const parts = [names.length > 0 ? `Sources: ${names.join(', ')}.` : null, month ? `Updated ${month}.` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * The line under the description that says where it came from (13 §8; owner question 22): the AI's summary is
 * labelled "Summary written by AI from …", the company's own words are labelled as such; an admin's text needs none.
 */
export function summaryOriginLine(
  origin: CompanySummaryOrigin | null | undefined,
  sources: readonly CompanySourceLine[] | null | undefined,
): string | null {
  const names = sourceNames(sources).map((source) => source.label);
  if (origin === 'ai') return names.length > 0 ? `Summary written by AI from ${joinWords(names)}.` : 'Summary written by AI.';
  if (origin === 'source_text') return names.length > 0 ? `In the company's own words, from ${joinWords(names)}.` : "In the company's own words.";
  return null;
}

/** "Founded" or "Incorporated" (a registry's year is an incorporation, 13 §2); "Founded" when the kind is unknown. */
export function foundedLabel(kind: CompanyFoundedKind | null | undefined): string {
  return COMPANY_FOUNDED_LABEL[kind ?? 'founded'];
}

/** "Public (NASDAQ: AAPL)", "Subsidiary", or a stage from before v3.0 as written; '' for none. */
export function stageWords(stage: string | null | undefined, ticker?: string | null, exchange?: string | null): string {
  const label = companyStageLabel(stage);
  if (!label) return '';
  if (stage === 'public' && ticker) return `${label} (${exchange ? `${exchange}: ` : ''}${ticker})`;
  return label;
}

const SIZE_LABEL = new Map<string, string>(COMPANY_SIZES.map((size) => [size.id, size.label]));

/** "1,001-5,000 employees" from the bucket, else "1,234 employees" from a count; '' for neither. */
export function sizeWords(sizeBucket: string | null | undefined, employees?: number | null): string {
  if (sizeBucket) return `${SIZE_LABEL.get(sizeBucket) ?? sizeBucket} employees`;
  if (typeof employees === 'number' && employees > 0) return `${employees.toLocaleString('en-US')} ${employees === 1 ? 'employee' : 'employees'}`;
  return '';
}

/** "Cupertino, CA, USA" from the profile's parts; '' for none. */
export function headquartersOf(profile: Pick<CompanyProfile, 'hqCity' | 'hqRegion' | 'hqCountryCode'>): string {
  if (!profile.hqCity && !profile.hqRegion && !profile.hqCountryCode) return '';
  return formatLocation({ raw: '', city: profile.hqCity, region: profile.hqRegion, countryCode: profile.hqCountryCode, isRemote: false });
}

/** An industry's words, '' for none or "not specified". */
export function industryWords(industry: string | null | undefined): string {
  return industry && industry !== NOT_SPECIFIED_INDUSTRY ? industryLabel(industry) : '';
}

/** One stat of the Company section's grid. */
export interface CompanyFact {
  key: 'size' | 'stage' | 'headquarters' | 'founded' | 'industry' | 'legalName';
  label: string;
  value: string;
}

export interface CompanyFactsInput {
  sizeBucket: string | null;
  employees?: number | null;
  stage: string | null;
  ticker?: string | null;
  exchange?: string | null;
  headquarters: string | null;
  foundedYear: number | null;
  foundedKind?: CompanyFoundedKind | null;
  industry: string | null;
  /** The company page also shows the legal name when it differs from the name people know. */
  legalName?: string | null;
  name?: string;
}

/**
 * The stats in the grid's order: Company Size, Company Stage, Headquarters, Founded (or Incorporated), Industry, and on
 * the company page the legal name. Never "Total Funding": only a licensed source may give it, and v3.0 has none (owner
 * question 19), so it stays hidden whatever an old row holds.
 */
export function companyFacts(input: CompanyFactsInput): CompanyFact[] {
  const facts: CompanyFact[] = [];
  const size = sizeWords(input.sizeBucket, input.employees);
  if (size) facts.push({ key: 'size', label: 'Company Size', value: size });
  const stage = stageWords(input.stage, input.ticker, input.exchange);
  if (stage) facts.push({ key: 'stage', label: 'Company Stage', value: stage });
  if (input.headquarters) facts.push({ key: 'headquarters', label: 'Headquarters', value: input.headquarters });
  if (input.foundedYear) facts.push({ key: 'founded', label: foundedLabel(input.foundedKind), value: String(input.foundedYear) });
  const industry = industryWords(input.industry);
  if (industry) facts.push({ key: 'industry', label: 'Industry', value: industry });
  const legal = input.legalName?.trim();
  if (legal && legal.toLowerCase() !== input.name?.trim().toLowerCase()) facts.push({ key: 'legalName', label: 'Legal name', value: legal });
  return facts;
}

/** One link of the links row. */
export interface CompanyLinkItem {
  kind: 'website' | 'linkedin' | 'other';
  label: string;
  url: string;
}

function urlOf(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** A LinkedIn address (linkedin.com or a subdomain, lnkd.in): shown only as `linkedinUrl`, never from `links`. */
export function isLinkedInUrl(value: string): boolean {
  const host = urlOf(value)?.hostname.toLowerCase() ?? '';
  return host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in';
}

/** The host people read for a website ("acme.com"). */
export function hostLabel(value: string): string {
  return urlOf(value)?.hostname.replace(/^www\./, '') ?? value;
}

/**
 * The links row: the website first, then the LinkedIn page, then the other links, each address once and only http(s).
 * The LinkedIn page shows only as `linkedinUrl`, which the API fills only when an allowed source names it (13 §3.5:
 * TailorIT never reads LinkedIn); a LinkedIn address among the other links, which carry no source, is left out.
 */
export function companyLinks(input: {
  website: string | null | undefined;
  linkedinUrl?: string | null;
  links?: readonly { label: string; url: string }[];
}): CompanyLinkItem[] {
  const items: CompanyLinkItem[] = [];
  if (urlOf(input.website)) items.push({ kind: 'website', label: hostLabel(input.website!), url: input.website! });
  if (input.linkedinUrl && LINKEDIN_COMPANY_URL_PATTERN.test(input.linkedinUrl)) {
    items.push({ kind: 'linkedin', label: 'LinkedIn', url: input.linkedinUrl });
  }
  for (const link of input.links ?? []) {
    if (!urlOf(link.url) || isLinkedInUrl(link.url)) continue;
    items.push({ kind: 'other', label: link.label.trim() || hostLabel(link.url), url: link.url });
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
