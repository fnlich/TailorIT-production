import { autoApplySupportOf } from '@tailorit/shared';
import type { DbQueries } from '../../../core/db/types';
import { plainTextOf } from '../text';
import { eligibilityOf, placeKeysOf, tsvectorOf, type PlaceRow } from './vectors';

// v3.0 PG-SEARCH (11-database.md §5.6, §7.7): `projectJob` writes a job's one row of `job_search`, the table every
// search reads (the Jobs page, Save all, MCP search_jobs and ai_search_jobs, the extension's job search), or deletes
// it when the job is not searchable: closed, unverified for JOB_UNVERIFIED_HIDE_DAYS (`unverified_since`), or held
// for review (`held_since`, 14 §9). Call it in the same transaction as every change that affects the row:
//   - a job inserted, updated, closed, reopened, held, approved, verified again (ingest's store, the one close
//     function, the reviews);
//   - its company's name, industry, size or sponsorship (re-project the company's open jobs, in batches);
//   - its places (job_locations), its text (job_texts), its facts (job_facts and their eligibility and
//     certifications), the analysis it points at (jobs.analysis_id: the years MCP reads);
//   - its owner (a page job taken into the lake).
// A trigger of migration 0004 also deletes the row the moment a job closes, goes unverified or is held, and keeps the
// row's owner, company and years with the job's, whoever writes them; the nightly repair (repair.ts) catches anything
// else, both ways.
//
//   await projectJob(t, jobId);                 // true: the job has a search row now
//   await projectJobs(t, jobIds);               // several (a company's jobs, the repair's batches)

/**
 * The projection's version, stored in `job_search.facts_version`. Raise it with any change to what a row holds: the
 * nightly repair re-projects every row of an older version.
 */
export const SEARCH_PROJECTION_VERSION = 1;

/** "Searchable": open, verified within JOB_UNVERIFIED_HIDE_DAYS, not held (jobs `alias`). */
export function searchableSql(alias = 'j'): string {
  return `(${alias}.active AND ${alias}.unverified_since IS NULL AND ${alias}.held_since IS NULL)`;
}

interface SourceRow {
  id: number;
  searchable: boolean;
  owner_user_id: string | null;
  company_id: number;
  title: string;
  posted_sort: string;
  updated_sort: string;
  employment_type: string | null;
  work_arrangement: string | null;
  experience_levels: string | null;
  leadership: string | null;
  category_id: string | null;
  subcategory_ids: string | null;
  industry: string | null;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  sponsors_h1b: boolean | null;
  requires_clearance: boolean | null;
  apply_url: string;
  apply_platform: string;
  locations_text: string;
  company_name: string;
  company_size: string | null;
  company_sponsors: boolean | null;
  f_levels: string | null;
  f_sponsorship: string | null;
  f_clearance: boolean | null;
  f_degree: string | null;
  f_min_years: number | null;
  f_authorization: string | null;
  f_auto_apply: string | null;
  analysis_years: number | null;
  description_html: string | null;
  places: string | null;
  eligibility: string | null;
  certs: string | null;
}

// v35 IMPORT (SP v35 PLAN.md H5): a job an admin's import reposted (jobs.reposted_at) sorts and filters from its repost:
// posted_sort and updated_sort are the later of the job's own date and reposted_at (GREATEST skips a NULL), so "Recently
// posted", "Most relevant" without words, the "Last updated" filter and MCP's postedSince all count it as new; the
// job's own posted date (jobs.posted_at, jobs.posted_sort) is kept. A repost re-projects the job (jobs/add/import-jobs.ts).
// One read of everything a row holds. The job's own columns win; job_facts fill what the job leaves empty (Part 1's
// buildJobFacts merges them so); the company gives its industry when the job has none, its size, its sponsorship
// (v30 E0-API: from its profile, company_profiles: the values in use, 13 §6).
const SOURCE_SQL = `SELECT j.id, ${searchableSql('j')} AS searchable, j.owner_user_id, j.company_id, j.title,
    GREATEST(j.posted_sort, j.reposted_at) AS posted_sort,
    GREATEST(COALESCE(j.source_updated_at, j.posted_at, j.first_seen_at), j.reposted_at) AS updated_sort,
    COALESCE(j.employment_type, f.employment_type) AS employment_type,
    COALESCE(j.work_arrangement, f.work_arrangement) AS work_arrangement,
    j.experience_levels::text AS experience_levels, j.leadership, j.category_id, j.subcategory_ids::text AS subcategory_ids,
    COALESCE(NULLIF(j.industry, ''), f.industry, NULLIF(cp.industry, '')) AS industry,
    floor(COALESCE(j.salary_annual_usd_min, f.salary_min_usd)) AS salary_min_usd,
    floor(COALESCE(j.salary_annual_usd_max, f.salary_max_usd)) AS salary_max_usd,
    j.sponsors_h1b, j.requires_clearance, j.apply_url, j.apply_platform, j.locations_text,
    c.name AS company_name, cp.size_bucket AS company_size, cp.sponsors_h1b AS company_sponsors,
    f.experience_levels::text AS f_levels, f.sponsorship AS f_sponsorship, f.clearance_required AS f_clearance,
    f.degree_level AS f_degree, f.min_years AS f_min_years, f."authorization" AS f_authorization,
    f.auto_apply AS f_auto_apply, ja.required_years AS analysis_years,
    jt.description_html,
    (SELECT json_agg(json_build_array(l.city, l.region, l.country_code, l.is_remote) ORDER BY l.position)
       FROM job_locations l WHERE l.job_id = j.id)::text AS places,
    (SELECT json_agg(json_build_array(e.kind, e.value)) FROM job_facts_eligibility e WHERE e.job_id = j.id)::text AS eligibility,
    (SELECT json_agg(fc.cert_key ORDER BY fc.cert_key) FROM job_facts_certifications fc
       WHERE fc.job_id = j.id AND fc.required)::text AS certs
  FROM jobs j
  JOIN companies c ON c.id = j.company_id
  LEFT JOIN company_profiles cp ON cp.company_id = j.company_id
  LEFT JOIN job_facts f ON f.job_id = j.id
  LEFT JOIN job_analyses ja ON ja.id = j.analysis_id
  LEFT JOIN job_texts jt ON jt.job_id = j.id
  WHERE j.id IN `;

const COLUMNS = [
  'job_id', 'owner_user_id', 'company_id', 'posted_sort', 'updated_sort', 'title_tsv', 'body_tsv',
  'employment_type', 'work_arrangement', 'experience_levels', 'leadership', 'category_id', 'subcategory_ids',
  'industry', 'company_size', 'company_sponsors', 'salary_min_usd', 'salary_max_usd', 'sponsorship',
  'clearance_required', 'degree_level', 'min_years', '"authorization"', 'apply_platform', 'auto_apply', 'place_keys',
  'locations_text', 'elig_keys', 'elig_region_countries', 'elig_regions', 'cert_required', 'facts_version',
  'refreshed_at',
] as const;

/** A JSON list as text[] (bound as JSON text: no array literal to escape). */
const textArray = (param: string) => `ARRAY(SELECT jsonb_array_elements_text(CAST(${param} AS jsonb)))`;

const VALUES = [
  '@job_id', '@owner_user_id', '@company_id', '@posted_sort', '@updated_sort', 'CAST(@title_tsv AS tsvector)',
  'CAST(@body_tsv AS tsvector)', '@employment_type', '@work_arrangement', textArray('@experience_levels'), '@leadership',
  '@category_id', textArray('@subcategory_ids'), '@industry', '@company_size', '@company_sponsors', '@salary_min_usd',
  '@salary_max_usd', '@sponsorship', '@clearance_required', '@degree_level', '@min_years', '@authorization',
  '@apply_platform', '@auto_apply', textArray('@place_keys'), '@locations_text', textArray('@elig_keys'),
  textArray('@elig_region_countries'), textArray('@elig_regions'), textArray('@cert_required'), '@facts_version', 'now()',
];

const UPSERT_SQL = `INSERT INTO job_search(${COLUMNS.join(', ')}) VALUES (${VALUES.join(', ')})
  ON CONFLICT (job_id) DO UPDATE SET ${COLUMNS.filter((column) => column !== 'job_id')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')}`;

function jsonList(text: string | null | undefined): unknown[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const strings = (text: string | null | undefined) => jsonList(text).filter((item): item is string => typeof item === 'string');
const unique = (values: readonly string[]) => [...new Set(values)];

/** The sponsorship a job states (job_facts' words), else null: the job's own column, else its facts. */
function sponsorshipOf(row: SourceRow): string | null {
  if (row.sponsors_h1b === true) return 'offered';
  if (row.sponsors_h1b === false) return 'not_offered';
  return row.f_sponsorship === 'offered' || row.f_sponsorship === 'not_offered' ? row.f_sponsorship : null;
}

function smallint(value: number | null): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 32_767 ? value : null;
}

/** The job_search row of one searchable job, as named parameters of UPSERT_SQL. */
function rowOf(row: SourceRow): Record<string, string | number | boolean | null> {
  const text = row.description_html ? plainTextOf(row.description_html) : '';
  const places: PlaceRow[] = jsonList(row.places).map((item) => {
    const [city, region, countryCode, isRemote] = Array.isArray(item) ? item : [];
    return {
      city: typeof city === 'string' ? city : null,
      region: typeof region === 'string' ? region : null,
      countryCode: typeof countryCode === 'string' ? countryCode : null,
      isRemote: isRemote === true,
    };
  });
  const eligibility = eligibilityOf(
    jsonList(row.eligibility).map((item) => {
      const [kind, value] = Array.isArray(item) ? item : [];
      return { kind: String(kind ?? ''), value: String(value ?? '') };
    }),
  );
  const levels = strings(row.experience_levels);
  return {
    job_id: row.id,
    owner_user_id: row.owner_user_id,
    company_id: row.company_id,
    posted_sort: row.posted_sort,
    updated_sort: row.updated_sort,
    title_tsv: tsvectorOf([
      { text: row.title, weight: 'A' },
      { text: row.company_name, weight: 'B' },
      { text: row.locations_text, weight: 'C' },
    ]),
    body_tsv: tsvectorOf([
      { text: row.title, weight: 'A' },
      { text: row.company_name, weight: 'B' },
      { text: row.locations_text, weight: 'C' },
      { text, weight: 'D' },
    ]),
    employment_type: row.employment_type,
    work_arrangement: row.work_arrangement,
    experience_levels: JSON.stringify(unique(levels.length > 0 ? levels : strings(row.f_levels))),
    leadership: row.leadership,
    category_id: row.category_id,
    subcategory_ids: JSON.stringify(unique(strings(row.subcategory_ids))),
    industry: row.industry,
    company_size: row.company_size,
    company_sponsors: row.company_sponsors,
    salary_min_usd: row.salary_min_usd,
    salary_max_usd: row.salary_max_usd,
    sponsorship: sponsorshipOf(row),
    clearance_required: row.requires_clearance ?? row.f_clearance,
    degree_level: row.f_degree,
    min_years: smallint(row.analysis_years ?? row.f_min_years),
    authorization: row.f_authorization,
    apply_platform: row.apply_platform,
    auto_apply: row.f_auto_apply ?? autoApplySupportOf(row.apply_url ?? ''),
    place_keys: JSON.stringify(placeKeysOf(places, row.work_arrangement === 'remote')),
    locations_text: row.locations_text ?? '',
    elig_keys: JSON.stringify(eligibility.keys),
    elig_region_countries: JSON.stringify(eligibility.regionCountries),
    elig_regions: JSON.stringify(eligibility.regions),
    cert_required: JSON.stringify(unique(strings(row.certs))),
    facts_version: SEARCH_PROJECTION_VERSION,
  };
}

/** The most jobs one read of projectJobs takes. */
const READ_BATCH = 500;

/**
 * Writes the search rows of `jobIds` (the searchable ones) and deletes the others' (closed, unverified, held, or
 * gone). Answers how many of them have a search row now. Statements run on `t`: the caller's transaction.
 */
export async function projectJobs(t: DbQueries, jobIds: readonly number[]): Promise<number> {
  const ids = [...new Set(jobIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  let written = 0;
  for (let start = 0; start < ids.length; start += READ_BATCH) {
    const batch = ids.slice(start, start + READ_BATCH);
    const rows = await t.all<SourceRow>(`${SOURCE_SQL}(${t.dialect.list(batch.length)})`, batch);
    const searchable = new Set<number>();
    for (const row of rows) {
      if (!row.searchable) continue;
      await t.run(UPSERT_SQL, rowOf(row));
      searchable.add(row.id);
    }
    const gone = batch.filter((id) => !searchable.has(id));
    if (gone.length > 0) await t.run(`DELETE FROM job_search WHERE job_id IN (${t.dialect.list(gone.length)})`, gone);
    written += searchable.size;
  }
  return written;
}

/**
 * Writes the job's search row, or deletes it when the job is not searchable (closed, unverified, held) or does not
 * exist. Call it on the transaction of the change (`t`); true when the job has a search row now.
 */
export async function projectJob(t: DbQueries, jobId: number): Promise<boolean> {
  return (await projectJobs(t, [jobId])) === 1;
}
