import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbClient, DbQueries } from '../../core/db/types';
import { searchRowOwnedBy, searchRowShared } from './visibility';

// v30 FIX-PG (PG-LOAD PGL-5, docs/design/part2/measurements.md §6): the counts behind the Jobs page's filter lists (the
// facets summary: which filters the data can answer, the categories and the "Remote in" countries), counted once for
// everyone instead of three scans of job_search a request (1.7-3.2 s at mix B's base size).
//
// They split along the visibility rule (searchRowVisibleTo = shared rows OR the viewer's own): the shared rows' counts
// are the same for every account and are kept in job_facet_counts (migration 0037); the viewer's own page jobs are
// counted at each request on js_owner (a handful of rows) and added on top, so a person's own jobs show at once.
//
// The freshness rule (constants JOB_FACETS_REFRESH_MINUTES, JOB_FACETS_CACHE_MIN_JOBS):
//   - under JOB_FACETS_CACHE_MIN_JOBS open shared jobs the shared counts are made at every request: exact, and cheap at
//     that size (the row is not written);
//   - from it on a request answers with the kept counts; once they are older than JOB_FACETS_REFRESH_MINUTES the
//     request also counts them again after answering (in the background), one process at a time: the process that
//     claims the row (`refreshing_until`, a claim that runs out by itself) counts, the others keep answering;
//   - JOB_FACETS_REFRESH_MINUTES 0 counts them at every request, whatever the size.
// So past the minimum the lists are at most one refresh period (plus the time to the next request) behind ingest.

/** A value and how many jobs carry it. */
export type CountPair = [value: string, count: number];

/** The flags of the summary's `available`: whether any job carries a value for each filter. */
export const AVAILABLE_KEYS = ['salary', 'h1b', 'clearance', 'leadership', 'industries', 'companySizes', 'arrangements', 'levels'] as const;
export type AvailableKey = (typeof AVAILABLE_KEYS)[number];

/** The summary's counts over a set of job_search rows (the shared ones, or one viewer's own). */
export interface SummaryCounts {
  total: number;
  available: Record<AvailableKey, boolean>;
  /** Every category with its jobs (not cut: a viewer's own jobs are added before the list is cut). */
  categories: CountPair[];
  /** Every remote country ('rm:<country>' keys) with its jobs. */
  remoteCountries: CountPair[];
}

type FacetCountDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The rows a count reads: the shared rows, or one viewer's own (binds @viewer). */
type RowSet = { kind: 'shared' } | { kind: 'own'; viewer: string };

function rowsSql(rows: RowSet): string {
  return rows.kind === 'shared' ? searchRowShared('s') : searchRowOwnedBy('s', '@viewer');
}

const paramsOf = (rows: RowSet) => (rows.kind === 'own' ? { viewer: rows.viewer } : {});

/** The summary's counts over `rows` (three statements, as the summary always read them). */
export async function countSummary(db: DbQueries, rows: RowSet): Promise<SummaryCounts> {
  const where = rowsSql(rows);
  const params = paramsOf(rows);
  const flags = (await db.one<Record<string, number | boolean | null>>(
    `SELECT count(*) AS total,
       bool_or(s.salary_sort IS NOT NULL) AS salary,
       bool_or(s.sponsorship = 'offered' OR s.company_sponsors) AS h1b,
       bool_or(s.clearance_required IS NOT NULL) AS clearance,
       bool_or(s.leadership IS NOT NULL) AS leadership,
       bool_or(s.industry IS NOT NULL) AS industries,
       bool_or(s.company_size IS NOT NULL) AS company_sizes,
       bool_or(s.work_arrangement IS NOT NULL) AS arrangements,
       bool_or(cardinality(s.experience_levels) > 0) AS levels
     FROM job_search s WHERE ${where}`,
    params,
  ))!;
  const categories = await db.all<{ value: string; count: number }>(
    `SELECT s.category_id AS value, count(*) AS count FROM job_search s
     WHERE ${where} AND s.category_id IS NOT NULL AND s.category_id <> '' GROUP BY s.category_id`,
    params,
  );
  const remote = await db.all<{ value: string; count: number }>(
    `SELECT substr(k.key, 4) AS value, count(DISTINCT s.job_id) AS count
     FROM job_search s CROSS JOIN LATERAL unnest(s.place_keys) AS k(key)
     WHERE ${where} AND k.key LIKE 'rm:%'
     GROUP BY k.key`,
    params,
  );
  const yes = (key: string) => flags[key] === true;
  return {
    total: Number(flags.total ?? 0),
    available: {
      salary: yes('salary'),
      h1b: yes('h1b'),
      clearance: yes('clearance'),
      leadership: yes('leadership'),
      industries: yes('industries'),
      companySizes: yes('company_sizes'),
      arrangements: yes('arrangements'),
      levels: yes('levels'),
    },
    categories: categories.map((row) => [row.value, Number(row.count)]),
    remoteCountries: remote.map((row) => [row.value, Number(row.count)]),
  };
}

/** Adds two sets of counts over disjoint rows (the shared ones and a viewer's own). */
export function addCounts(a: SummaryCounts, b: SummaryCounts): SummaryCounts {
  const sum = (x: CountPair[], y: CountPair[]): CountPair[] => {
    const out = new Map<string, number>(x);
    for (const [value, count] of y) out.set(value, (out.get(value) ?? 0) + count);
    return [...out.entries()];
  };
  const available = { ...a.available };
  for (const key of AVAILABLE_KEYS) available[key] = a.available[key] || b.available[key];
  return {
    total: a.total + b.total,
    available,
    categories: sum(a.categories, b.categories),
    remoteCountries: sum(a.remoteCountries, b.remoteCountries),
  };
}

// ── The kept shared counts ──────────────────────────────────────────────────────────────────────────────────────

interface KeptRow {
  counts: SummaryCounts | string;
  counted_at: string;
}

/** The kept row's counts (the driver hands jsonb over parsed; a text copy is parsed here). */
function countsOf(row: KeptRow): SummaryCounts {
  return typeof row.counts === 'string' ? (JSON.parse(row.counts) as SummaryCounts) : row.counts;
}

const STORE_SQL = `INSERT INTO job_facet_counts(id, counts, counted_at, refreshing_until)
  VALUES (1, CAST(@counts AS jsonb), CAST(@at AS timestamptz), NULL)
  ON CONFLICT (id) DO UPDATE SET counts = excluded.counts, counted_at = excluded.counted_at, refreshing_until = NULL`;

const store = (db: DbQueries, counts: SummaryCounts, at: string) => db.run(STORE_SQL, { counts: JSON.stringify(counts), at });

/** The background recounts this process has started, by database client (one at a time each). */
const refreshes = new WeakMap<DbClient, Promise<void>>();

/**
 * Counts the shared rows again and keeps them, when this process claims the row (no other process is counting and
 * the kept counts are still older than the refresh period). Never throws: a failure is logged and the claim given back.
 */
async function refreshShared(deps: FacetCountDeps, minutes: number): Promise<void> {
  const now = deps.now();
  const claimed = await deps.db.one<{ id: number }>(
    `UPDATE job_facet_counts SET refreshing_until = CAST(@until AS timestamptz)
     WHERE id = 1 AND counted_at <= CAST(@staleAt AS timestamptz)
       AND (refreshing_until IS NULL OR refreshing_until < CAST(@now AS timestamptz))
     RETURNING id`,
    {
      until: new Date(now.getTime() + minutes * 60_000).toISOString(),
      staleAt: new Date(now.getTime() - minutes * 60_000).toISOString(),
      now: now.toISOString(),
    },
  );
  if (!claimed) return;
  try {
    const counts = await countSummary(deps.db, { kind: 'shared' });
    await store(deps.db, counts, deps.now().toISOString());
  } catch (error) {
    deps.log.warn('[jobs] could not count the filter lists again; the kept counts stay until the next try', error);
    await deps.db.run('UPDATE job_facet_counts SET refreshing_until = NULL WHERE id = 1').catch(() => undefined);
  }
}

/** Starts a background recount unless this process has one going. */
function startRefresh(deps: FacetCountDeps, minutes: number): void {
  if (refreshes.has(deps.db)) return;
  const running = refreshShared(deps, minutes)
    .catch((error: unknown) => deps.log.warn('[jobs] could not count the filter lists again', error))
    .finally(() => refreshes.delete(deps.db));
  refreshes.set(deps.db, running);
}

/** The background recount this process has going on `db`, if any (tests wait for it). */
export function facetCountsRefreshing(db: DbClient): Promise<void> | null {
  return refreshes.get(db) ?? null;
}

/** The shared rows' counts under the freshness rule (see the top). */
export async function sharedCounts(deps: FacetCountDeps): Promise<SummaryCounts> {
  const constants = constantsOf(deps);
  const minutes = constants.get('JOB_FACETS_REFRESH_MINUTES');
  const minJobs = constants.get('JOB_FACETS_CACHE_MIN_JOBS');
  if (minutes > 0) {
    const row = await deps.db.one<KeptRow>('SELECT counts, counted_at FROM job_facet_counts WHERE id = 1');
    if (row) {
      const kept = countsOf(row);
      if (kept.total >= minJobs) {
        if (deps.now().getTime() - Date.parse(row.counted_at) >= minutes * 60_000) startRefresh(deps, minutes);
        return kept;
      }
    }
  }
  const counts = await countSummary(deps.db, { kind: 'shared' });
  if (minutes > 0 && counts.total >= minJobs) await store(deps.db, counts, deps.now().toISOString());
  return counts;
}

/** The counts a viewer's filter lists show: the shared rows' (kept) plus the viewer's own page jobs (at once). */
export async function viewerCounts(deps: FacetCountDeps, viewer: string): Promise<SummaryCounts> {
  const shared = await sharedCounts(deps);
  return addCounts(shared, await countSummary(deps.db, { kind: 'own', viewer }));
}
