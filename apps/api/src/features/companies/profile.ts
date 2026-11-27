import { createHash } from 'node:crypto';
import {
  COMPANY_FOUNDED_KINDS,
  COMPANY_FOUNDED_YEAR_MAX,
  COMPANY_FOUNDED_YEAR_MIN,
  COMPANY_PROFILE_FIELDS,
  COMPANY_SIZE_IDS,
  COMPANY_STAGES,
  COMPANY_SUMMARY_MAX,
  COMPANY_SUMMARY_ORIGINS,
  COMPANY_TAGLINE_MAX,
  CONSTANTS,
  INDUSTRY_IDS,
  LINKEDIN_COMPANY_URL_PATTERN,
  emptyCompanyProfile,
  normalizeIndustry,
  parseLocations,
  type CompanyLicence,
  type CompanyProfile,
  type CompanyProfileField,
  type CompanySourceStatus,
  type CompanyStage,
} from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { constantsOf } from '../../core/constants/service';
import type { DbQueries } from '../../core/db/types';
import type { NormalizedCompany } from '../ingest/normalize';
import { isCompanyDomain, registrableDomain } from './domain';

// v30 E0-API: a company's profile (docs/design/part2/13-company-enrichment.md §2, §6; 11-database.md §5.4).
//
// Every source's answer is one company_sources row (kind, ref, licence, match confidence, the values it gave in
// `fields`, keyed by COMPANY_PROFILE_FIELDS ids). The profile (company_profiles) is computed from them: per field, the
// best source by 13 §6.1's priority, then its confidence, then the oldest row (the first source to give a value keeps
// it, as v2.0's "fill only what is empty" did); a source below COMPANY_FIELD_MIN_CONFIDENCE is stored and never used
// (the editor lists it as a candidate). An admin's values are the `admin` source row, which every field ranks first:
// a key in it is a locked field (locked_fields lists them), a null in it locks the field empty. The fields of one
// group (the headquarters, founded, employees, funding) always come from one source together. The display name is an
// admin's, else the name its primary board gives now (the board the company was made from), else the company's own
// name (companies.name: the name it was made with, as v2.0 kept it); the other sources' names are the editor's
// candidates (a merge moves the other's boards as secondary ones, so it never renames the survivor).
//
// The profile holds only values in use, so every reader (the Company section, the company page, the search
// projection's size, industry and sponsorship) reads its columns as they are.

/** A source row's values, by profile field id (plus each group's companion: employeesAsOf, fundingAsOf). */
export type ProfileFields = Partial<Record<CompanyProfileField | 'employeesAsOf' | 'fundingAsOf', unknown>>;

/** The source kinds the priority knows; a licensed vendor's `vendor:<name>` ranks as `vendor`. */
type RankKind = 'admin' | 'ats_board' | 'job_posting' | 'company_site' | 'wikidata' | 'sec' | 'gleif' | 'vendor' | 'logo_dev' | 'ai' | 'legacy';

const DEFAULT_ORDER: readonly RankKind[] = ['admin', 'ats_board', 'job_posting', 'company_site', 'wikidata', 'sec', 'gleif', 'vendor', 'logo_dev', 'ai', 'legacy'];
const HQ_ORDER: readonly RankKind[] = ['admin', 'wikidata', 'gleif', 'sec', 'company_site', 'ats_board', 'job_posting', 'legacy'];
const FOUNDED_ORDER: readonly RankKind[] = ['admin', 'wikidata', 'company_site', 'gleif', 'sec', 'ats_board', 'job_posting', 'legacy'];
const WEBSITE_ORDER: readonly RankKind[] = ['admin', 'job_posting', 'ats_board', 'wikidata', 'company_site', 'vendor', 'legacy'];

/** 13 §6.1: the sources of each field, best first (a kind not listed never gives that field). */
const FIELD_ORDER: Partial<Record<CompanyProfileField, readonly RankKind[]>> = {
  legalName: ['admin', 'sec', 'gleif', 'wikidata', 'company_site', 'vendor', 'legacy'],
  website: WEBSITE_ORDER,
  domain: WEBSITE_ORDER,
  linkedinUrl: ['admin', 'company_site', 'wikidata', 'job_posting', 'vendor', 'ats_board', 'legacy'],
  otherLinks: ['admin', 'company_site', 'job_posting', 'ats_board', 'wikidata', 'vendor', 'legacy'],
  logoUrl: ['admin', 'company_site', 'logo_dev', 'wikidata', 'job_posting', 'legacy'],
  industry: ['admin', 'wikidata', 'sec', 'company_site', 'ai', 'vendor', 'ats_board', 'job_posting', 'legacy'],
  industryDetail: ['admin', 'wikidata', 'sec', 'company_site', 'vendor', 'legacy'],
  tagline: ['admin', 'ai', 'company_site', 'wikidata', 'ats_board', 'job_posting', 'legacy'],
  summary: ['admin', 'ai', 'company_site', 'ats_board', 'job_posting', 'legacy'],
  employees: ['admin', 'wikidata', 'company_site', 'vendor', 'legacy'],
  sizeBucket: ['admin', 'wikidata', 'company_site', 'vendor', 'ats_board', 'job_posting', 'legacy'],
  stage: ['admin', 'sec', 'wikidata', 'gleif', 'vendor', 'ats_board', 'job_posting', 'legacy'],
  ticker: ['admin', 'sec', 'wikidata', 'vendor', 'legacy'],
  exchange: ['admin', 'sec', 'wikidata', 'vendor', 'legacy'],
  hqCity: HQ_ORDER,
  hqRegion: HQ_ORDER,
  hqCountryCode: HQ_ORDER,
  foundedYear: FOUNDED_ORDER,
  foundedKind: FOUNDED_ORDER,
  // Funding only from a licensed source (13 §3.4, owner question 19: none in v3.0).
  fundingTotalUsd: ['admin', 'vendor'],
  sponsorsH1b: ['admin', 'ats_board', 'job_posting', 'legacy'],
};

/** Fields that come from one source together: the first is the group's lead (the others follow its source). */
const GROUPS: readonly (readonly CompanyProfileField[])[] = [
  ['hqCity', 'hqRegion', 'hqCountryCode'],
  ['foundedYear', 'foundedKind'],
];
/** Each field's companion, from the same source: a count's date. */
const COMPANIONS: Partial<Record<CompanyProfileField, 'employeesAsOf' | 'fundingAsOf'>> = {
  employees: 'employeesAsOf',
  fundingTotalUsd: 'fundingAsOf',
};

/** The group a field belongs to (itself alone when none). */
export function groupOf(field: CompanyProfileField): readonly CompanyProfileField[] {
  return GROUPS.find((group) => group.includes(field)) ?? [field];
}

/** The fields the search projection copies (11 §5.6): a change re-projects the company's open jobs. */
export const SEARCH_FIELDS: readonly CompanyProfileField[] = ['displayName', 'industry', 'sizeBucket', 'sponsorsH1b'];

/** company_profiles' column of each field. */
const COLUMN: Record<CompanyProfileField | 'employeesAsOf' | 'fundingAsOf', string> = {
  displayName: 'display_name',
  legalName: 'legal_name',
  tagline: 'tagline',
  summary: 'summary',
  website: 'website',
  domain: 'domain',
  linkedinUrl: 'linkedin_url',
  otherLinks: 'other_links',
  logoUrl: 'logo_path',
  industry: 'industry',
  industryDetail: 'industry_detail',
  employees: 'employees',
  employeesAsOf: 'employees_as_of',
  sizeBucket: 'size_bucket',
  stage: 'stage',
  ticker: 'ticker',
  exchange: 'exchange',
  hqCity: 'hq_city',
  hqRegion: 'hq_region',
  hqCountryCode: 'hq_country_code',
  foundedYear: 'founded_year',
  foundedKind: 'founded_kind',
  fundingTotalUsd: 'funding_total_usd',
  fundingAsOf: 'funding_as_of',
  sponsorsH1b: 'sponsors_h1b',
};
const ALL_KEYS = Object.keys(COLUMN) as Array<keyof typeof COLUMN>;

// ── Values ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Text cut to `max` characters at a word, with an ellipsis when cut; null when empty. */
export function clipText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * v30 FIX-C UX-18: a text whose paragraphs (a blank line apart) stay apart: the spaces within each collapse, the
 * paragraphs join with one blank line, cut to `max` as clipText cuts (the company page draws its line breaks). Null
 * when empty.
 */
export function clipParagraphs(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n?/g, '\n')
    .split(/\n[^\S\n]*\n\s*/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

const short = (max: number) => (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): T | null =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null;
const isoDay = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** An https address (an http one is asked for over https); null when it is none. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^https?:\/\/\S+$/i.test(text) || text.length > 2048) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
}

/** A company's LinkedIn page in the one form company_profiles keeps; null for any other address. */
export function linkedinCompanyUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/company\/([^/?#\s]+)\/?/i.exec(value.trim());
  if (!match) return null;
  const url = `https://www.linkedin.com/company/${match[1]}/`;
  return LINKEDIN_COMPANY_URL_PATTERN.test(url) ? url : null;
}

/** A same-origin path (TailorIT's stored copy); never a remote address ("//host" and "/\host" load from another site). */
export function sameOriginPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^\/(?![/\\])\S*$/.test(text) && text.length <= 2048 ? text : null;
}

/** A free-text stage (v2.0's, a posting's, a seed's) as a COMPANY_STAGES id; null when it names none (CT edit E). */
export function stageFromText(value: unknown): CompanyStage | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  if ((COMPANY_STAGES as readonly string[]).includes(text.replace(/ /g, '_'))) return text.replace(/ /g, '_') as CompanyStage;
  if (/^(public|listed|ipo|publicly (traded|listed))$/.test(text)) return 'public';
  if (/^(private|privately held|bootstrapped|self-funded|mutual)$/.test(text)) return 'private';
  if (/^non-?profit$/.test(text)) return 'nonprofit';
  if (/^(pre-?seed|seed)$/.test(text)) return 'seed';
  if (/^series [ab]$/.test(text)) return 'early';
  if (/^series [c-z]$/.test(text)) return 'growth';
  if (/^(private equity|pe-backed)$/.test(text)) return 'private_equity';
  return null;
}

function otherLinks(value: unknown): Array<{ label: string; url: string }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ label: string; url: string }> = [];
  for (const item of value) {
    if (out.length >= 20) break;
    const record = item && typeof item === 'object' ? (item as { label?: unknown; url?: unknown }) : null;
    const url = typeof item === 'string' ? item.trim() : typeof record?.url === 'string' ? record.url.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2048) continue;
    const label = typeof record?.label === 'string' && record.label.trim() ? record.label.trim().slice(0, 60) : linkLabel(url);
    if (!out.some((link) => link.url === url)) out.push({ label, url });
  }
  return out.length > 0 ? out : null;
}

function linkLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.endsWith('linkedin.com')) return 'LinkedIn';
    if (host === 'twitter.com' || host === 'x.com') return 'X';
    if (host.endsWith('github.com')) return 'GitHub';
    return host;
  } catch {
    return url;
  }
}

/** Each field's check: its value as the profile keeps it, or null (a value that fails is never kept). */
const CLEAN: Record<keyof typeof COLUMN, (value: unknown) => unknown> = {
  displayName: short(300),
  legalName: short(300),
  tagline: (value) => clipText(value, COMPANY_TAGLINE_MAX),
  summary: (value) => clipParagraphs(value, COMPANY_SUMMARY_MAX),
  website: httpsUrl,
  domain: (value) => {
    const domain = typeof value === 'string' ? registrableDomain(value) : null;
    return isCompanyDomain(domain) ? domain : null;
  },
  linkedinUrl: linkedinCompanyUrl,
  otherLinks,
  logoUrl: sameOriginPath,
  industry: (value) => (typeof value === 'string' ? normalizeIndustry(value) : null),
  industryDetail: short(200),
  employees: count,
  employeesAsOf: isoDay,
  sizeBucket: oneOf(COMPANY_SIZE_IDS),
  stage: (value) => stageFromText(value),
  ticker: short(20),
  exchange: short(40),
  hqCity: short(120),
  hqRegion: short(120),
  hqCountryCode: (value) => (typeof value === 'string' && /^[A-Z]{2}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null),
  foundedYear: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= COMPANY_FOUNDED_YEAR_MIN && value <= COMPANY_FOUNDED_YEAR_MAX ? value : null,
  foundedKind: oneOf(COMPANY_FOUNDED_KINDS),
  fundingTotalUsd: count,
  fundingAsOf: isoDay,
  sponsorsH1b: (value) => (typeof value === 'boolean' ? value : null),
};

/** A source's values, each checked: a value that fails its check is left out; `keepNulls` keeps an admin's empties. */
export function cleanFields(input: Readonly<Record<string, unknown>>, keepNulls = false): ProfileFields {
  const out: ProfileFields = {};
  for (const key of ALL_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key] === null ? null : CLEAN[key](input[key]);
    if (value !== null && value !== undefined) out[key] = value;
    else if (keepNulls) out[key] = null;
  }
  return out;
}

/**
 * What a posting says about its company (ingest's NormalizedCompany), as a source's values: the posting's name, its
 * tagline and about text (cut to the profile's caps), its website (https), size, industry, headquarters (read as a
 * place), founded year, stage (mapped to COMPANY_STAGES), links (a LinkedIn company page among them) and sponsorship.
 * Funding (free text, no licensed source) is not kept, nor a logo that is not TailorIT's own copy.
 */
export function postingFields(company: NormalizedCompany): ProfileFields {
  const place = company.headquarters ? parseLocations(company.headquarters).find((item) => !item.isRemote && (item.city || item.countryCode)) : undefined;
  const links = company.links ?? [];
  const linkedin = links.map((link) => linkedinCompanyUrl(link.url)).find(Boolean) ?? null;
  return cleanFields({
    displayName: company.name,
    tagline: company.tagline,
    summary: company.about,
    website: company.website,
    sizeBucket: company.sizeBucket,
    industry: company.industry,
    hqCity: place?.city ?? null,
    hqRegion: place?.region ?? null,
    hqCountryCode: place?.countryCode ?? null,
    foundedYear: company.foundedYear,
    foundedKind: company.foundedYear === null ? null : 'founded',
    stage: company.stage,
    linkedinUrl: linkedin,
    otherLinks: links.filter((link) => !linkedinCompanyUrl(link.url)),
    sponsorsH1b: company.sponsorsH1b,
    logoUrl: company.logoPath,
  });
}

/** A stable JSON text (keys sorted), for comparing and hashing values. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function parseObject(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string' || !text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseList(text: unknown): unknown[] {
  if (typeof text !== 'string' || !text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// ── Sources ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SourceKey {
  kind: string;
  ref: string;
  licence: CompanyLicence;
  matchConfidence: number;
  attribution?: string | null;
  purgeGroup?: string | null;
  expiresAt?: string | null;
  status?: CompanySourceStatus;
}

/**
 * How a source's new values meet its stored ones: `replace` (the source's answer as a whole: a board's name and
 * intro, an admin's values, a site's read), `newest` (each value given replaces the stored one; nothing is cleared),
 * `first` (a value is kept once given: a feed of many employers' postings, whose company words vary by posting).
 */
export type SourceMerge = 'replace' | 'newest' | 'first';

/**
 * Writes one source's values for a company (company_sources, unique by company, kind and ref), in the caller's
 * transaction. Answers its id and whether its values changed: an unchanged answer writes nothing (its content_hash),
 * so a posting seen again costs one read.
 */
export async function upsertSource(
  t: DbQueries,
  companyId: number,
  key: SourceKey,
  fields: ProfileFields,
  at: string,
  merge: SourceMerge = 'replace',
): Promise<{ sourceId: number; changed: boolean }> {
  const stored = await t.one<{ id: number; fields: string; content_hash: Buffer | null }>(
    'SELECT id, fields, content_hash FROM company_sources WHERE company_id = ? AND kind = ? AND ref = ?',
    [companyId, key.kind, key.ref],
  );
  const before = stored ? parseObject(stored.fields) : {};
  const merged: Record<string, unknown> =
    merge === 'replace' ? { ...fields } : merge === 'newest' ? { ...before, ...fields } : { ...fields, ...before };
  const json = stableJson(merged);
  const hash = createHash('sha256').update(json).digest();
  if (stored && stored.content_hash && Buffer.compare(stored.content_hash, hash) === 0) return { sourceId: stored.id, changed: false };
  const row = await t.one<{ id: number }>(
    `INSERT INTO company_sources(company_id, kind, ref, licence, attribution, match_confidence, fields, content_hash, status,
       retrieved_at, expires_at, purge_group)
     VALUES (?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, kind, ref) DO UPDATE SET licence = excluded.licence, attribution = excluded.attribution,
       match_confidence = excluded.match_confidence, fields = excluded.fields, content_hash = excluded.content_hash,
       status = excluded.status, retrieved_at = excluded.retrieved_at, expires_at = excluded.expires_at,
       purge_group = excluded.purge_group
     RETURNING id`,
    [
      companyId,
      key.kind,
      key.ref,
      key.licence,
      key.attribution ?? null,
      Math.max(0, Math.min(100, Math.round(key.matchConfidence))),
      json,
      hash,
      key.status ?? 'ok',
      at,
      key.expiresAt ?? null,
      key.purgeGroup ?? null,
    ],
  );
  return { sourceId: row!.id, changed: stableJson(before) !== json || !stored };
}

// ── The profile ────────────────────────────────────────────────────────────────────────────────────────────────────

const PROFILE_SQL = `SELECT p.company_id, p.display_name, p.legal_name, p.tagline, p.summary, p.summary_origin, p.website,
    p.domain, p.linkedin_url, p.other_links, p.logo_path, p.industry, p.industry_detail, p.employees, p.employees_as_of,
    p.size_bucket, p.stage, p.ticker, p.exchange, p.hq_city, p.hq_region, p.hq_country_code, p.founded_year,
    p.founded_kind, p.funding_total_usd, p.funding_as_of, p.sponsors_h1b, p.provenance, p.confidence, p.locked_fields,
    p.conflicts, p.enriched_at, p.next_refresh_at, p.updated_at
  FROM company_profiles p`;

/** A company_profiles row as read (jsonb as text). */
export interface ProfileRow {
  company_id: number;
  display_name: string | null;
  legal_name: string | null;
  tagline: string | null;
  summary: string | null;
  summary_origin: string | null;
  website: string | null;
  domain: string | null;
  linkedin_url: string | null;
  other_links: string | null;
  logo_path: string | null;
  industry: string | null;
  industry_detail: string | null;
  employees: number | null;
  employees_as_of: string | null;
  size_bucket: string | null;
  stage: string | null;
  ticker: string | null;
  exchange: string | null;
  hq_city: string | null;
  hq_region: string | null;
  hq_country_code: string | null;
  founded_year: number | null;
  founded_kind: string | null;
  funding_total_usd: number | null;
  funding_as_of: string | null;
  sponsors_h1b: boolean | null;
  provenance: string | null;
  confidence: string | null;
  locked_fields: string | null;
  conflicts: string | null;
  enriched_at: string | null;
  next_refresh_at: string | null;
  updated_at: string;
}

/** A company's profile row (none for a company made before profiles existed and never resolved since). */
export async function profileRowOf(t: DbQueries, companyId: number, forUpdate = false): Promise<ProfileRow | undefined> {
  return t.one<ProfileRow>(`${PROFILE_SQL} WHERE p.company_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [companyId]);
}

/** The profile's values by field id, as stored (jsonb parsed). */
export function valuesOfRow(row: ProfileRow | undefined): ProfileFields {
  if (!row) return {};
  const values: ProfileFields = {};
  for (const key of ALL_KEYS) {
    const raw = (row as unknown as Record<string, unknown>)[COLUMN[key]];
    const value = key === 'otherLinks' ? parseList(raw) : raw;
    if (value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) values[key] = value;
  }
  return values;
}

/** The DTO of a profile row (every value checked again: a stored value outside its rules reads as null). */
export function profileOfRow(row: ProfileRow | undefined): CompanyProfile {
  const profile = emptyCompanyProfile();
  if (!row) return profile;
  const values = cleanFields(valuesOfRow(row));
  for (const key of COMPANY_PROFILE_FIELDS) {
    if (key === 'otherLinks') profile.otherLinks = (values.otherLinks as CompanyProfile['otherLinks'] | undefined) ?? [];
    else if (values[key] !== undefined) (profile as Record<string, unknown>)[key] = values[key];
  }
  profile.employeesAsOf = (values.employeesAsOf as string | undefined) ?? null;
  profile.fundingAsOf = (values.fundingAsOf as string | undefined) ?? null;
  profile.summaryOrigin = profile.summary ? oneOf(COMPANY_SUMMARY_ORIGINS)(row.summary_origin) : null;
  if (profile.industry && !(INDUSTRY_IDS as readonly string[]).includes(profile.industry)) profile.industry = null;
  return profile;
}

/** Makes the company's profile row when it has none (display name only), in the caller's transaction. */
export async function ensureProfile(t: DbQueries, companyId: number, displayName: string, at: string): Promise<void> {
  await t.run('INSERT INTO company_profiles(company_id, display_name, updated_at) VALUES (?, ?, ?) ON CONFLICT (company_id) DO NOTHING', [
    companyId,
    displayName,
    at,
  ]);
}

/** COMPANY_FIELD_MIN_CONFIDENCE: from the constants service when there is one, else its default. */
export function minConfidenceOf(deps?: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): number {
  return deps ? constantsOf(deps).get('COMPANY_FIELD_MIN_CONFIDENCE') : CONSTANTS.COMPANY_FIELD_MIN_CONFIDENCE.default;
}

interface SourceRow {
  id: number;
  kind: string;
  match_confidence: number;
  fields: string;
}

const rankKind = (kind: string): RankKind | null =>
  kind.startsWith('vendor:') ? 'vendor' : (DEFAULT_ORDER as readonly string[]).includes(kind) ? (kind as RankKind) : null;

export interface Candidate {
  sourceId: number;
  sourceKind: string;
  value: unknown;
  confidence: number;
}

/** Every source's value for a field, best first by 13 §6.1 (the kinds that never give it left out). */
export function candidatesOf(field: CompanyProfileField, sources: readonly SourceRow[]): Candidate[] {
  const order = FIELD_ORDER[field] ?? DEFAULT_ORDER;
  const out: Array<Candidate & { rank: number }> = [];
  for (const source of sources) {
    const kind = rankKind(source.kind);
    const rank = kind ? order.indexOf(kind) : -1;
    if (rank < 0) continue;
    const fields = cleanFields(parseObject(source.fields), kind === 'admin');
    if (!Object.hasOwn(fields, field)) continue;
    if (fields[field] === null && kind !== 'admin') continue;
    out.push({ sourceId: source.id, sourceKind: source.kind, value: fields[field], confidence: source.match_confidence, rank });
  }
  out.sort((a, b) => a.rank - b.rank || b.confidence - a.confidence || a.sourceId - b.sourceId);
  return out.map(({ rank: _rank, ...candidate }) => candidate);
}

/** A company's sources with an answer (status ok). */
export async function sourcesOf(t: DbQueries, companyId: number): Promise<SourceRow[]> {
  return t.all<SourceRow>("SELECT id, kind, match_confidence, fields FROM company_sources WHERE company_id = ? AND status = 'ok' ORDER BY id", [
    companyId,
  ]);
}

export interface RecomputeResult {
  /** Any value of the profile changed. */
  changed: boolean;
  /** A value the search projection copies changed (the name, industry, size, sponsorship): re-project the open jobs. */
  searchChanged: boolean;
  /**
   * v30 FIX-PERF (PGL-19): the company's name (companies.name) changed, which the search rows' words hold: their
   * vectors are written again (projectJobs). Without it only the rows' company columns move (search-refresh.ts).
   */
  nameChanged: boolean;
}

/**
 * Computes the company's profile from its sources and writes it (company_profiles, and companies.name from the
 * display name), in the caller's transaction. The admin row's keys are the locked fields. Answers what changed.
 *
 * v381 GATE (SP v381 PLAN E7): the company row is locked FOR NO KEY UPDATE, never FOR UPDATE. Every caller has just
 * written rows that reference the company (its alias, its source row, a job: their foreign keys take the row's FOR KEY
 * SHARE lock), and two transactions storing postings of one company at once (two links of two platforms read side by
 * side by the link queue, two runs) both hold that lock when they recompute: FOR UPDATE waits for every other KEY SHARE,
 * so each waited for the other and PostgreSQL aborted one (deadlock detected), which the link queue read as "try later".
 * FOR NO KEY UPDATE does not wait for a KEY SHARE: two recomputes of one company still take turns (the second waits for
 * the first's commit, then reads every source), and a merge, an opt-out or a match (FOR UPDATE first) still waits.
 */
export async function recomputeProfile(t: DbQueries, companyId: number, at: string, minConfidence: number): Promise<RecomputeResult> {
  const company = await t.one<{ name: string }>('SELECT name FROM companies WHERE id = ? FOR NO KEY UPDATE', [companyId]); // v381 GATE
  if (!company) return { changed: false, searchChanged: false, nameChanged: false };
  await ensureProfile(t, companyId, company.name, at);
  const row = (await profileRowOf(t, companyId, true))!;
  const sources = await sourcesOf(t, companyId);
  const before = valuesOfRow(row);
  const values: ProfileFields = {};
  const provenance: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  const conflicts: Record<string, Array<{ sourceId: number; value: unknown }>> = {};
  const admin = sources.find((source) => source.kind === 'admin');
  const locked = admin
    ? Object.keys(cleanFields(parseObject(admin.fields), true)).filter((key) => (COMPANY_PROFILE_FIELDS as readonly string[]).includes(key))
    : [];
  let summaryKind: string | null = null;

  const done = new Set<CompanyProfileField>(['displayName']);
  const adminName = admin ? cleanFields(parseObject(admin.fields)).displayName : undefined;
  if (typeof adminName === 'string') {
    values.displayName = adminName;
    provenance.displayName = admin!.id;
    confidence.displayName = 100;
  } else {
    // The board the company was made from names it (13 §6.1: the board's name first), as that board names it now.
    const primary = await t.one<{ id: number; fields: string }>(
      `SELECT s.id, s.fields FROM company_aliases a JOIN company_sources s
         ON s.company_id = a.company_id AND s.ref = a.value AND s.kind IN ('ats_board', 'job_posting') AND s.status = 'ok'
       WHERE a.company_id = ? AND a.kind = 'board' AND a.is_primary ORDER BY s.id LIMIT 1`,
      [companyId],
    );
    const boardName = primary ? cleanFields(parseObject(primary.fields)).displayName : undefined;
    if (typeof boardName === 'string') {
      values.displayName = boardName;
      provenance.displayName = primary!.id;
      confidence.displayName = 100;
    }
  }
  for (const field of COMPANY_PROFILE_FIELDS) {
    if (done.has(field)) continue;
    const group = groupOf(field);
    for (const member of group) done.add(member);
    // The group's source: the best usable source of any member (its lead first).
    let chosen: Candidate | null = null;
    for (const member of group) {
      const usable = candidatesOf(member, sources).filter((candidate) => candidate.sourceKind === 'admin' || candidate.confidence >= minConfidence);
      const best = usable[0];
      if (best && (!chosen || compareRank(member, best, chosen) < 0)) chosen = best;
      if (usable.length > 1 && best && best.sourceKind !== 'admin') {
        const others = usable.slice(1).filter((candidate) => stableJson(candidate.value) !== stableJson(best.value));
        if (others.length > 0) conflicts[member] = others.slice(0, 5).map(({ sourceId, value }) => ({ sourceId, value }));
      }
    }
    if (!chosen) continue;
    const fields = cleanFields(parseObject(sources.find((source) => source.id === chosen.sourceId)!.fields), chosen.sourceKind === 'admin');
    for (const member of group) {
      const value = fields[member];
      if (value === undefined || value === null) continue;
      values[member] = value;
      provenance[member] = chosen.sourceId;
      confidence[member] = chosen.sourceKind === 'admin' ? 100 : chosen.confidence;
      const companion = COMPANIONS[member];
      if (companion && fields[companion] !== undefined) values[companion] = fields[companion];
    }
    if (field === 'summary' && values.summary !== undefined) summaryKind = chosen.sourceKind;
  }
  // Else the company's own name (the first posting's, as v2.0 named it).
  if (values.displayName === undefined) values.displayName = company.name;
  const summaryOrigin = values.summary === undefined ? null : summaryKind === 'ai' ? 'ai' : summaryKind === 'admin' ? 'admin' : 'source_text';

  const changedKeys = ALL_KEYS.filter((key) => stableJson(before[key] ?? null) !== stableJson(values[key] ?? null));
  const metaChanged =
    stableJson(parseObject(row.provenance)) !== stableJson(provenance) ||
    stableJson(parseObject(row.confidence)) !== stableJson(confidence) ||
    stableJson(parseList(row.locked_fields)) !== stableJson(locked) ||
    stableJson(parseObject(row.conflicts)) !== stableJson(conflicts) ||
    (row.summary_origin ?? null) !== summaryOrigin;
  if (changedKeys.length === 0 && !metaChanged) return { changed: false, searchChanged: false, nameChanged: false };

  const set = ALL_KEYS.map((key) => `${COLUMN[key]} = ${key === 'otherLinks' ? 'CAST(? AS jsonb)' : '?'}`).join(', ');
  const params = ALL_KEYS.map((key) => {
    const value = values[key] ?? null;
    if (key === 'otherLinks') return JSON.stringify(value ?? []);
    return value as string | number | boolean | null;
  });
  await t.run(
    `UPDATE company_profiles SET ${set}, summary_origin = ?, provenance = CAST(? AS jsonb), confidence = CAST(? AS jsonb),
       locked_fields = CAST(? AS jsonb), conflicts = CAST(? AS jsonb), updated_at = ? WHERE company_id = ?`,
    [...params, summaryOrigin, JSON.stringify(provenance), JSON.stringify(confidence), JSON.stringify(locked), JSON.stringify(conflicts), at, companyId],
  );
  const name = typeof values.displayName === 'string' ? values.displayName : company.name;
  if (name !== company.name) await t.run('UPDATE companies SET name = ?, updated_at = ? WHERE id = ?', [name, at, companyId]);
  return {
    changed: changedKeys.length > 0,
    searchChanged: changedKeys.some((key) => (SEARCH_FIELDS as readonly string[]).includes(key)),
    nameChanged: name !== company.name,
  };
}

/** Which of two candidates for a group ranks first (the field's order, then confidence, then the older row). */
function compareRank(field: CompanyProfileField, a: Candidate, b: Candidate): number {
  const order = FIELD_ORDER[field] ?? DEFAULT_ORDER;
  const rank = (candidate: Candidate) => order.indexOf(rankKind(candidate.sourceKind) ?? 'legacy');
  return rank(a) - rank(b) || b.confidence - a.confidence || a.sourceId - b.sourceId;
}

/** The open jobs of a company (their search rows copy the company's name, industry, size and sponsorship). */
export async function openJobIdsOf(t: DbQueries, companyId: number): Promise<number[]> {
  return (await t.all<{ id: number }>('SELECT id FROM jobs WHERE company_id = ? AND active /* held_since: projectJob decides */', [companyId])).map(
    (row) => row.id,
  );
}
