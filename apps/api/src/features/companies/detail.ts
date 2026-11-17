import {
  COMPANY_SOURCE_LABEL,
  formatLocation,
  type CompanyDetail,
  type CompanyParentRef,
  type CompanyProfile,
  type CompanySourceKind,
  type CompanySourceLine,
} from '@tailorit/shared';
import { profileOfRow, type ProfileRow } from './profile';

// v30 E0-API: the company as the jobs' readers show it (the job detail's Company section, CompanyDetail), from its
// profile (docs/design/part2/13-company-enrichment.md §10 "API and UI shapes"). A reader of `companies c` selects
// COMPANY_DETAIL_SQL('c') (the profile, its parent and the sources its shown values came from, as one JSON text) and
// maps it with companyDetailOf; the logo alone is COMPANY_LOGO_SQL('c').

/** The company's stored logo path (a same-origin path), for a reader of `companies` aliased `alias`. */
export const COMPANY_LOGO_SQL = (alias = 'c') => `(SELECT cp.logo_path FROM company_profiles cp WHERE cp.company_id = ${alias}.id)`;

/** The company's industry (its profile's), for a reader of `companies` aliased `alias`. */
export const COMPANY_INDUSTRY_SQL = (alias = 'c') => `(SELECT NULLIF(cp.industry, '') FROM company_profiles cp WHERE cp.company_id = ${alias}.id)`;

/** The company's H-1B word (its profile's), for a reader of `companies` aliased `alias`. */
export const COMPANY_SPONSORS_SQL = (alias = 'c') => `(SELECT cp.sponsors_h1b FROM company_profiles cp WHERE cp.company_id = ${alias}.id)`;

/**
 * One JSON text with the company's profile row, its parent ({id, name}: "Part of {parent}") and the sources its shown
 * values came from (kind, licence, attribution), for a reader of `companies` aliased `alias`; null without a profile.
 */
export const COMPANY_DETAIL_SQL = (alias = 'c') => `(SELECT json_build_object(
    'profile', row_to_json(cp),
    'parent', (SELECT json_build_object('id', pc.id, 'name', pc.name) FROM company_relations r JOIN companies pc ON pc.id = r.parent_id
               WHERE r.child_id = cp.company_id AND pc.merged_into_id IS NULL ORDER BY r.confidence DESC, pc.id LIMIT 1),
    'sources', (SELECT json_agg(json_build_object('kind', s.kind, 'licence', s.licence, 'attribution', s.attribution,
                                                  'inputs', CASE WHEN s.kind = 'ai' THEN s.fields->'inputKinds' END) ORDER BY s.id)
                FROM company_sources s WHERE s.company_id = cp.company_id
                  AND s.id IN (SELECT (e.value)::bigint FROM jsonb_each_text(cp.provenance) e)))::text
  FROM company_profiles cp WHERE cp.company_id = ${alias}.id)`;

interface DetailJson {
  profile: Record<string, unknown> | null;
  parent: { id: number; name: string } | null;
  sources: Array<{ kind: string; licence: string; attribution: string | null; inputs?: unknown }> | null;
}

/** A row_to_json(company_profiles) object as the row the profile module reads (jsonb columns as text). */
function profileRowOfJson(json: Record<string, unknown> | null): ProfileRow | undefined {
  if (!json) return undefined;
  const row: Record<string, unknown> = { ...json };
  for (const key of ['other_links', 'provenance', 'confidence', 'locked_fields', 'conflicts']) {
    if (row[key] !== null && row[key] !== undefined && typeof row[key] !== 'string') row[key] = JSON.stringify(row[key]);
  }
  return row as unknown as ProfileRow;
}

function parseDetail(text: string | null | undefined): DetailJson {
  if (!text) return { profile: null, parent: null, sources: null };
  try {
    return JSON.parse(text) as DetailJson;
  } catch {
    return { profile: null, parent: null, sources: null };
  }
}

/**
 * The sources line (13 §6.3): each kind's words once, in the order the sources came; the old columns' name nothing. v30
 * E3: an AI row names the sources it was written from (its fields' `inputKinds`), so "Summary written by AI from …"
 * (the web reads the line) names the summary's own inputs even when no other shown value comes from them.
 */
export function sourcesLineOf(
  sources: ReadonlyArray<{ kind: string; licence: string; attribution: string | null; inputs?: unknown }> | null | undefined,
): CompanySourceLine[] {
  const out: CompanySourceLine[] = [];
  const add = (label: string) => {
    if (label && !out.some((line) => line.label === label)) out.push({ label: label.slice(0, 120) });
  };
  for (const source of sources ?? []) {
    if (source.licence === 'legacy') continue;
    if (source.kind === 'ai') {
      for (const input of Array.isArray(source.inputs) ? source.inputs : []) add(COMPANY_SOURCE_LABEL[input as CompanySourceKind] ?? '');
      continue;
    }
    add(source.kind.startsWith('vendor:') ? (source.attribution ?? '') : (COMPANY_SOURCE_LABEL[source.kind as CompanySourceKind] ?? ''));
  }
  return out;
}

/** "Austin, TX, USA" from the profile's headquarters fields; null when it has none. */
export function headquartersOf(profile: Pick<CompanyProfile, 'hqCity' | 'hqRegion' | 'hqCountryCode'>): string | null {
  if (!profile.hqCity && !profile.hqRegion && !profile.hqCountryCode) return null;
  const text = formatLocation({ raw: '', city: profile.hqCity, region: profile.hqRegion, countryCode: profile.hqCountryCode, isRemote: false });
  return text || null;
}

/** A funding total in short words ("$85M"); null without one (only a licensed source gives it). */
export function fundingText(usd: number | null): string | null {
  if (usd === null || usd <= 0) return null;
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (usd >= size) return `$${Number((usd / size).toFixed(usd / size >= 10 ? 0 : 1))}${unit}`;
  }
  return `$${usd}`;
}

/** The profile's links row: its other links, and its LinkedIn page when an allowed source named one. */
export function linksOf(profile: Pick<CompanyProfile, 'otherLinks' | 'linkedinUrl'>): Array<{ label: string; url: string }> {
  const links = [...profile.otherLinks];
  if (profile.linkedinUrl && !links.some((link) => link.url === profile.linkedinUrl)) links.push({ label: 'LinkedIn', url: profile.linkedinUrl });
  return links;
}

/** The parent of a detail JSON, checked. */
function parentOf(parent: DetailJson['parent']): CompanyParentRef | null {
  return parent && typeof parent.id === 'number' && typeof parent.name === 'string' ? { id: parent.id, name: parent.name } : null;
}

/** The profile of COMPANY_DETAIL_SQL's text. */
export function profileOfDetail(text: string | null | undefined): { profile: CompanyProfile; row: ProfileRow | undefined; json: DetailJson } {
  const json = parseDetail(text);
  const row = profileRowOfJson(json.profile);
  return { profile: profileOfRow(row), row, json };
}

/**
 * CompanyDetail from COMPANY_DETAIL_SQL's text: the job detail's Company section. `logoUrl` is the reader's own
 * (logoUrlOf of the same profile's path), so the cards and the section agree.
 */
export function companyDetailOf(
  base: { id: number; name: string; logoUrl: string | null; jobCount?: number },
  text: string | null | undefined,
): CompanyDetail {
  const { profile, row, json } = profileOfDetail(text);
  return {
    id: base.id,
    name: base.name,
    logoUrl: base.logoUrl,
    tagline: profile.tagline,
    website: profile.website,
    ...(base.jobCount === undefined ? {} : { jobCount: base.jobCount }),
    about: profile.summary,
    sizeBucket: profile.sizeBucket,
    stage: profile.stage,
    funding: fundingText(profile.fundingTotalUsd),
    headquarters: headquartersOf(profile),
    foundedYear: profile.foundedYear,
    industry: profile.industry,
    links: linksOf(profile),
    sponsorsH1b: profile.sponsorsH1b,
    linkedinUrl: profile.linkedinUrl,
    foundedKind: profile.foundedYear === null ? null : profile.foundedKind,
    parent: parentOf(json.parent),
    summaryOrigin: profile.summaryOrigin,
    sources: sourcesLineOf(json.sources),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}
