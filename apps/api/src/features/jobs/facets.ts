import {
  CA_PROVINCES,
  COMPANY_SIZES,
  US_STATES,
  countryDisplayName,
  formatLocation,
  industryLabel,
  jobCategoryLabel,
  jobSubcategoryLabel,
  subcategoryParent,
  type JobFacet,
  type JobFacetItem,
  type JobFacetsSummary,
} from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { viewerCounts, type CountPair } from './facet-counts';
import { searchRowVisibleTo } from './visibility';

// The value lists the filters offer, with how many open jobs carry each value ("Category [2]" menu counts, the
// Location suggestions, "Remote in USA"). Counts are over every job the viewer's list can hold (the shared ones and
// the viewer's own page jobs, never another account's), not the current search.
// v3.0 PG-SEARCH: counted on the search projection (`job_search s`, 11-database.md §7.5): its rows are the open,
// verified, unheld jobs, with the job's facts, its industry (else its company's) and its company's size in the row.
// Only the places read job_locations (the city as the posting wrote it, for its label).
// v30 FIX-PG (PG-LOAD PGL-5): the summary and the two lists it holds (categories, "Remote in" countries) come from
// facet-counts.ts: the shared jobs' counts kept once for everyone, the viewer's own page jobs added at each request.

interface Counted {
  value: string;
  count: number;
}

/** The jobs this viewer's list can hold (`s`: job_search). Binds @viewer. */
const VISIBLE = searchRowVisibleTo('s', '@viewer'); // v30 SCH: job_search's rule

function matches(label: string, q: string | undefined): boolean {
  if (!q) return true;
  return label.toLocaleLowerCase('en-US').includes(q.toLocaleLowerCase('en-US'));
}

function top(items: JobFacetItem[], q: string | undefined, limit: number): JobFacetItem[] {
  return items
    .filter((item) => matches(item.label, q))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** The category list from its counts (a category with no label is left out). */
function categories(counts: readonly CountPair[]): JobFacetItem[] {
  return counts
    .map(([value, count]) => ({ value, label: jobCategoryLabel(value), count }))
    .filter((item) => item.label);
}

async function subcategories(db: DbQueries, viewer: string): Promise<JobFacetItem[]> {
  const rows = await db.all<Counted>(
    `SELECT sc.value AS value, count(DISTINCT s.job_id) AS count
     FROM job_search s CROSS JOIN LATERAL unnest(s.subcategory_ids) AS sc(value)
     WHERE ${VISIBLE} GROUP BY sc.value`,
    { viewer },
  );
  const out: JobFacetItem[] = [];
  for (const row of rows) {
    const label = jobSubcategoryLabel(row.value);
    const parent = subcategoryParent(row.value);
    if (label && parent) out.push({ value: row.value, label, count: row.count, parent });
  }
  return out;
}

async function industries(db: DbQueries, viewer: string): Promise<JobFacetItem[]> {
  const rows = await db.all<Counted>(
    `SELECT COALESCE(s.industry, 'not_specified') AS value, count(*) AS count FROM job_search s WHERE ${VISIBLE} GROUP BY 1`,
    { viewer },
  );
  return rows
    .map((row) => ({ value: row.value, label: industryLabel(row.value), count: row.count }))
    .filter((item) => item.label);
}

async function companySizes(db: DbQueries, viewer: string): Promise<JobFacetItem[]> {
  const rows = await db.all<Counted>(
    `SELECT s.company_size AS value, count(*) AS count FROM job_search s
     WHERE ${VISIBLE} AND s.company_size IS NOT NULL GROUP BY s.company_size`,
    { viewer },
  );
  const counts = new Map(rows.map((row) => [row.value, row.count]));
  // Size order, not count order.
  return COMPANY_SIZES.filter((size) => counts.has(size.id)).map((size) => ({
    value: size.id,
    label: size.label,
    count: counts.get(size.id) ?? 0,
  }));
}

async function companies(db: DbQueries, viewer: string, q: string | undefined, limit: number): Promise<JobFacetItem[]> {
  const like = q ? `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  const rows = await db.all<Counted & { label: string }>(
    `SELECT CAST(c.id AS text) AS value, c.name AS label, n.count
     FROM (SELECT s.company_id, count(*) AS count FROM job_search s WHERE ${VISIBLE} GROUP BY s.company_id) n
     JOIN companies c ON c.id = n.company_id
     ${like ? `WHERE ${db.dialect.like('c.name', '@like')}` : ''}
     ORDER BY n.count DESC, lower(c.name), c.id LIMIT @limit`,
    { viewer, limit, ...(like ? { like } : {}) },
  );
  return rows.map((row) => ({ value: row.value, label: row.label, count: row.count }));
}

interface PlaceRow {
  city: string | null;
  region: string | null;
  country_code: string | null;
  count: number;
}

const REGION_NAMES: Record<string, Readonly<Record<string, string>>> = { US: US_STATES, CA: CA_PROVINCES };

/** The places of the jobs this viewer's list can hold (job_locations `jl` of job_search `s`). */
const PLACES_FROM = `job_locations jl JOIN job_search s ON s.job_id = jl.job_id`;

/** Places to suggest in the Location filter: cities, then states/provinces and countries, each with its job count. */
async function locations(db: DbQueries, viewer: string): Promise<JobFacetItem[]> {
  const out = new Map<string, JobFacetItem>();
  const add = (label: string, count: number) => {
    if (!label) return;
    const existing = out.get(label.toLowerCase());
    if (existing) existing.count = Math.max(existing.count, count);
    else out.set(label.toLowerCase(), { value: label, label, count });
  };
  const cities = await db.all<PlaceRow>(
    `SELECT min(jl.city) AS city, jl.region, jl.country_code, count(DISTINCT jl.job_id) AS count
     FROM ${PLACES_FROM}
     WHERE ${VISIBLE} AND NOT jl.is_remote AND jl.city IS NOT NULL AND jl.city <> ''
     GROUP BY lower(jl.city), jl.region, jl.country_code`,
    { viewer },
  );
  for (const row of cities) {
    add(formatLocation({ raw: row.city ?? '', city: row.city, region: row.region, countryCode: row.country_code, isRemote: false }), row.count);
  }
  const regions = await db.all<PlaceRow>(
    `SELECT NULL AS city, jl.region, jl.country_code, count(DISTINCT jl.job_id) AS count
     FROM ${PLACES_FROM}
     WHERE ${VISIBLE} AND jl.region IS NOT NULL AND jl.country_code IN ('US', 'CA')
     GROUP BY jl.region, jl.country_code`,
    { viewer },
  );
  for (const row of regions) {
    const name = row.country_code && row.region ? REGION_NAMES[row.country_code]?.[row.region.toUpperCase()] : undefined;
    if (name) add(name, row.count);
  }
  const countries = await db.all<PlaceRow>(
    `SELECT NULL AS city, NULL AS region, jl.country_code, count(DISTINCT jl.job_id) AS count
     FROM ${PLACES_FROM}
     WHERE ${VISIBLE} AND jl.country_code IS NOT NULL GROUP BY jl.country_code`,
    { viewer },
  );
  for (const row of countries) add(countryDisplayName(row.country_code), row.count);
  return [...out.values()];
}

/** "Remote in USA", "Remote in Canada", ...: countries with remote postings (the projection's 'rm:<country>' keys). */
function remoteCountries(counts: readonly CountPair[]): JobFacetItem[] {
  return counts.map(([value, count]) => ({ value, label: `Remote in ${countryDisplayName(value)}`, count }));
}

type FacetDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** One facet list, filtered by `q` (case-insensitive, on the label) and cut to `limit`, most jobs first. */
export async function facetItems(
  deps: FacetDeps,
  viewer: string,
  facet: JobFacet,
  q: string | undefined,
  limit: number,
): Promise<JobFacetItem[]> {
  const db = deps.db;
  switch (facet) {
    case 'categories':
      return top(categories((await viewerCounts(deps, viewer)).categories), q, limit);
    case 'subcategories':
      return top(await subcategories(db, viewer), q, limit);
    case 'industries':
      return top(await industries(db, viewer), q, limit);
    case 'companySizes':
      return (await companySizes(db, viewer)).filter((item) => matches(item.label, q)).slice(0, limit);
    case 'companies':
      return companies(db, viewer, q, limit);
    case 'locations':
      return top(await locations(db, viewer), q, limit);
    case 'remoteCountries':
      return top(remoteCountries((await viewerCounts(deps, viewer)).remoteCountries), q, limit);
  }
}

/**
 * Which filters the data can answer, with the small lists inline (GET /api/jobs/facets/summary). v30 FIX-PG: the shared
 * jobs' counts kept (facet-counts.ts), the viewer's own page jobs added.
 */
export async function facetsSummary(deps: FacetDeps, viewer: string): Promise<JobFacetsSummary> {
  const counts = await viewerCounts(deps, viewer);
  return {
    total: counts.total,
    available: counts.available,
    categories: top(categories(counts.categories), undefined, 50),
    remoteCountries: top(remoteCountries(counts.remoteCountries), undefined, 50),
  };
}
