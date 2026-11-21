import { type EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, STATUS, formatLocation, type ExperienceLevel } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { POSTING_TEXT_RULE } from '../../ai/prompts/tailor/posting-text-rule';
import type { DbQueries } from '../../core/db/index';
import { notFound, validationFailed } from '../../core/http/errors';
import { untrustedLines, untrustedText } from '../autofill/ai/untrusted';
import { jobVisible } from '../autofill/lookup';
import type { SOURCE_KINDS } from '../ingest/types';
import { fallbackAnalysis } from '../jobs/analysis';
import { jobCreditOf, jobCreditSql } from '../jobs/credit'; // v30 FIX-B
import { readJobText } from '../jobs/text';
import { rankSql } from '../jobs/fts';
import { APPLIED_SQL, Params, placeSql, SPONSORS_SQL, visibleSql } from '../jobs/search';
import { jobVisibleTo } from '../jobs/visibility';
import { dayIn, instantOf, offsetMinutes, zoneOf, type Zone } from './dates';
import { PLATFORMS } from './platform';
import { loadResultSet, readSetCursor, saveResultSet, SET_MAX_IDS, setCursor, type ResultSet, type SetOwner } from './result-sets';
import { matchExpression, type MatchExpression } from './terms';

// v1.5 Q2: search_jobs and job_details, in SQL only, at the scale of a million jobs. The matches' ids (the first
// SET_MAX_IDS in the answer's order) are kept as a result set (result-sets.ts), and a page is read from it by cursor,
// so paging never searches again. Every answer is compact: {total, cols, rows, next, setId}, a row an array in
// `cols`' order.
//
// What each filter reads (and what it cannot know) is in SEARCH_DESCRIPTION, which the tool's description carries.
// A filter on a judgement TailorIT may not have (clearance, sponsorship, years, salary) reports `unknown`: how many of
// the jobs that match every other filter do not say.
// v3.0 PG-SEARCH: the search reads the search projection (`job_search s`, 11-database.md §5.6, §7), never jobs or the
// text: the words as a tsquery over body_tsv (terms.ts), relevance as ts_rank inside the newest
// SEARCH_RELEVANCE_WINDOW matches, places as keys, the facts in the row. The counts and facets are SQL `GROUP BY`s
// (coordinator decision N) under SEARCH_STATEMENT_TIMEOUT_MS; past it the answer is the capped count
// (JOB_SEARCH_COUNT_CAP) and `facetsNotComputed`. The shown rows (jobRows) still read jobs.

export const JOB_FIELDS = [
  'id',
  'title',
  'company',
  'location',
  'posted',
  'platform',
  'flags',
  'salary',
  'seniority',
  'years',
  'type',
  'url',
  'status',
  // v30 FIX-B (REV-REQ REQ-1, 12 §3.6-3.7): the credit line a job's source asks for wherever the job is shown.
  'credit',
] as const;
export type JobField = (typeof JOB_FIELDS)[number];
export const DEFAULT_JOB_FIELDS: readonly JobField[] = ['id', 'title', 'company', 'location', 'posted', 'platform', 'flags'];

export const JOB_FACETS = ['company', 'platform', 'location', 'remote', 'posted', 'seniority'] as const;
export type JobFacet = (typeof JOB_FACETS)[number];

export const CLEARANCE_FILTERS = ['none', 'required', 'statedNone'] as const;
export const SPONSORSHIP_FILTERS = ['yes', 'notDenied', 'no'] as const;

export const PAGE_DEFAULT = 25;
export const PAGE_MAX = 100;
/** The most values one facet answers. */
export const FACET_TOP = 10;

export interface SearchArgs {
  query?: string;
  anyOf?: string[];
  allOf?: string[];
  notAny?: string[];
  expand?: boolean;
  title?: string;
  company?: string;
  location?: string;
  remote?: boolean;
  postedSince?: string;
  postedBetween?: [string, string];
  tz?: string;
  seniority?: ExperienceLevel[];
  minYears?: number;
  maxYears?: number;
  clearance?: (typeof CLEARANCE_FILTERS)[number];
  sponsorship?: (typeof SPONSORSHIP_FILTERS)[number];
  platform?: string[];
  salaryMin?: number;
  source?: (typeof SOURCE_KINDS)[number][];
  type?: (typeof EMPLOYMENT_TYPES)[number][];
  excludeApplied?: boolean;
  excludeSaved?: boolean;
  excludeQueued?: boolean;
  sort?: 'relevance' | 'newest';
  countOnly?: boolean;
  facets?: JobFacet[];
  fields?: JobField[];
  limit?: number;
  cursor?: string;
}

type Deps = Pick<AppDeps, 'db' | 'now'>;

/** The posting's time: its own date, else when TailorIT first saw it (the Jobs page's "posted"). */
const POSTED = 'COALESCE(j.posted_at, j.first_seen_at)';
const YEARS = '(SELECT ja.required_years FROM job_analyses ja WHERE ja.id = j.analysis_id)';

/** A filter whose unknowns the answer counts: its condition, and the condition of "does not say". */
interface Judged {
  name: 'clearance' | 'sponsorship' | 'years' | 'salary';
  sql: string;
  unknown: string;
}

interface Built {
  params: Params;
  fts: MatchExpression;
  /** Conditions every match meets (base and filters), apart from the judged ones. */
  where: string[];
  judged: Judged[];
  zone: Zone;
  now: Date;
}

/** v3.0 PG-SEARCH: what a search reads besides the database: the admin's caps and the facets' time. */
type SearchDeps = Pick<AppDeps, 'db' | 'now' | 'config' | 'log' | 'services'>;

/** Remote work: a remote place, or a remote posting (the projection's 'rm' key). */
const REMOTE = "s.place_keys @> CAST('{rm}' AS text[])";

/** The arguments as SQL over job_search `s` (every value a bound parameter; only fixed fragments are concatenated). */
function build(args: SearchArgs, userId: string, now: Date): Built {
  const zone = zoneOf(args.tz);
  const fts = matchExpression(args);
  const params = new Params({ userId });
  const where = visibleSql();
  if (fts.exclude && !fts.match) where.push(`NOT (s.body_tsv @@ CAST(${params.add(fts.exclude)} AS tsquery))`);
  if (args.location) {
    const place = placeSql(args.location, params);
    if (place) where.push(place);
  }
  if (args.remote === true) where.push(REMOTE);
  // Not remote: the job says where it is worked (onsite, hybrid) and no place of it is remote; a job that does not
  // say is left out (v2.0's NOT over an unknown arrangement left it out).
  if (args.remote === false) where.push(`(s.work_arrangement IS NOT NULL AND NOT ${REMOTE})`);
  const instant = (value: Date) => `CAST(${params.add(value.toISOString())} AS timestamptz)`;
  if (args.postedSince) where.push(`s.posted_sort >= ${instant(instantOf(args.postedSince, now, zone, 'postedSince'))}`);
  if (args.postedBetween) {
    const [from, to] = args.postedBetween;
    where.push(`s.posted_sort >= ${instant(instantOf(from, now, zone, 'postedBetween'))}`);
    // A day as the end means the whole of that day.
    const end = /^\d{4}-\d{2}-\d{2}$/.test(to.trim())
      ? new Date(instantOf(to, now, zone, 'postedBetween').getTime() + 86_400_000)
      : instantOf(to, now, zone, 'postedBetween');
    where.push(`s.posted_sort < ${instant(end)}`);
  }
  if (args.seniority && args.seniority.length > 0) where.push(`s.experience_levels && ${params.array(args.seniority)}`);
  if (args.platform && args.platform.length > 0) where.push(`s.apply_platform IN (${params.list(args.platform)})`);
  if (args.type && args.type.length > 0) where.push(`s.employment_type IN (${params.list(args.type)})`);
  if (args.source && args.source.length > 0) {
    where.push(`EXISTS (SELECT 1 FROM job_source_links sl JOIN job_sources so ON so.id = sl.source_id
      WHERE sl.job_id = s.job_id AND so.kind IN (${params.list(args.source)}))`);
  }
  if (args.excludeApplied) where.push(`NOT ${APPLIED_SQL}`);
  if (args.excludeSaved) {
    where.push(`NOT EXISTS (SELECT 1 FROM applications ap WHERE ap.user_id = @userId AND ap.job_id = s.job_id
      AND ap.current_status = ${STATUS.saved} AND ap.archived_at IS NULL)`);
  }
  if (args.excludeQueued) {
    where.push(`NOT EXISTS (SELECT 1 FROM autofill_agent_queue aq WHERE aq.user_id = @userId AND aq.job_id = s.job_id
      AND aq.state IN ('queued', 'running'))`);
  }

  // Each judged condition is true or false, never unknown (a job "passes" a filter only when it is true).
  const judged: Judged[] = [];
  if (args.clearance) {
    const sql = { none: 's.clearance_required IS NOT TRUE', required: 's.clearance_required IS TRUE', statedNone: 's.clearance_required IS FALSE' }[
      args.clearance
    ];
    judged.push({ name: 'clearance', sql, unknown: 's.clearance_required IS NULL' });
  }
  if (args.sponsorship) {
    const sql = {
      yes: `${SPONSORS_SQL} IS TRUE`,
      notDenied: "s.sponsorship IS DISTINCT FROM 'not_offered'",
      no: "s.sponsorship IS NOT DISTINCT FROM 'not_offered'",
    }[args.sponsorship];
    judged.push({ name: 'sponsorship', sql, unknown: 's.sponsorship IS NULL' });
  }
  if (args.minYears !== undefined || args.maxYears !== undefined) {
    const parts: string[] = [];
    if (args.minYears !== undefined) parts.push(`s.min_years >= ${params.add(args.minYears)}`);
    if (args.maxYears !== undefined) parts.push(`s.min_years <= ${params.add(args.maxYears)}`);
    judged.push({ name: 'years', sql: `COALESCE(${parts.join(' AND ')}, false)`, unknown: 's.min_years IS NULL' });
  }
  if (args.salaryMin !== undefined) {
    judged.push({ name: 'salary', sql: `COALESCE(s.salary_sort >= ${params.add(args.salaryMin)}, false)`, unknown: 's.salary_sort IS NULL' });
  }
  if (fts.match) {
    const expression = fts.exclude ? `(${fts.match}) & !${fts.exclude}` : fts.match;
    params.values.words = expression;
    where.unshift('s.body_tsv @@ CAST(@words AS tsquery)');
  }
  return { params, fts, where, judged, zone, now };
}

/** True when PostgreSQL refused the tsquery (it should not: every term is a phrase of tokens). */
function isQueryError(error: unknown): boolean {
  return error instanceof Error && /tsquery|word is too long/i.test(error.message);
}

/** Runs a read; a query PostgreSQL refuses reads as no match. */
async function read<T>(empty: T, get: () => Promise<T>): Promise<T> {
  try {
    return await get();
  } catch (error) {
    if (isQueryError(error)) return empty;
    throw error;
  }
}

/** The matches' ids, newest first (the newest id first on a tie), from `offset`, at most `limit`. */
function newestSql(built: Built, where: readonly string[], offset: string | null, limit: string): string {
  return `SELECT s.job_id AS id FROM job_search s WHERE ${where.join(' AND ')}
    ORDER BY s.posted_sort DESC, s.job_id DESC${offset ? ` OFFSET ${offset}` : ''} LIMIT ${limit}`;
}

/**
 * v30 FIX-PERF (PG-LOAD PGL-7): the matches' ids when the search has words and a judged filter (clearance,
 * sponsorship, years, salary): the words' GIN matches are read first (`m`, a materialized CTE through js_body), then
 * ordered and cut. Without it the planner walked js_posted newest first and tested every posting it met (its body_tsv
 * read out of line, about 6 KB), misjudging how few pass the judged filter: "nurse" with sponsorship stopped after
 * 5-6 minutes at mix B's size (942 ms this way). Relevance ranks the first `window` of the newest SET_MAX_IDS + 1 (the
 * newest id first on a tie) and the rest follow newest first, as matchIds' two statements order them, in one.
 */
function judgedWordsSql(where: readonly string[], sort: 'relevance' | 'newest', window: string | null, max: string): string {
  const matches = `WITH m AS MATERIALIZED (SELECT s.job_id, s.posted_sort FROM job_search s WHERE ${where.join(' AND ')})`;
  if (sort !== 'relevance' || window === null) return `${matches} SELECT m.job_id AS id FROM m ORDER BY m.posted_sort DESC, m.job_id DESC LIMIT ${max}`;
  return `${matches},
    t AS (SELECT m.job_id, row_number() OVER (ORDER BY m.posted_sort DESC, m.job_id DESC) AS place
          FROM m ORDER BY m.posted_sort DESC, m.job_id DESC LIMIT ${max})
    SELECT w.job_id AS id FROM (
      SELECT t.job_id, t.place, CASE WHEN t.place <= ${window} THEN
          (SELECT ${rankSql('r.body_tsv', 'CAST(@words AS tsquery)')} FROM job_search r WHERE r.job_id = t.job_id) END AS rank
      FROM t) w
    ORDER BY w.place > ${window}, w.rank DESC, CASE WHEN w.place <= ${window} THEN w.job_id END DESC, w.place`;
}

/**
 * The ids of the first SET_MAX_IDS + 1 matches in the answer's order (one more tells that there are more). Relevance
 * ranks the newest SEARCH_RELEVANCE_WINDOW matches by ts_rank over the posting (bm25's weights: the title most), the
 * newest id first on a tie; the matches past the window follow, newest first (11-database.md §7.3).
 */
async function matchIds(deps: SearchDeps, built: Built, sort: 'relevance' | 'newest'): Promise<number[]> {
  const where = [...built.where, ...built.judged.map((filter) => filter.sql)];
  const params = built.params.clone();
  const ids = (sql: string) => read([] as number[], async () => (await deps.db.all<{ id: number }>(sql, params.values)).map((row) => row.id));
  if (built.fts.match !== null && built.judged.length > 0) {
    const window = sort === 'relevance' ? params.add(Math.min(constantsOf(deps).get('SEARCH_RELEVANCE_WINDOW'), SET_MAX_IDS + 1)) : null;
    return ids(judgedWordsSql(where, sort, window, params.add(SET_MAX_IDS + 1)));
  }
  if (sort !== 'relevance' || built.fts.match === null) return ids(newestSql(built, where, null, params.add(SET_MAX_IDS + 1)));
  const window = Math.min(constantsOf(deps).get('SEARCH_RELEVANCE_WINDOW'), SET_MAX_IDS + 1);
  const windowParam = params.add(window);
  const ranked = await ids(`SELECT w.job_id AS id FROM (
      SELECT ws.job_id, ${rankSql('ws.body_tsv', 'CAST(@words AS tsquery)')} AS rank
      FROM (SELECT s.job_id, s.body_tsv FROM job_search s WHERE ${where.join(' AND ')}
            ORDER BY s.posted_sort DESC, s.job_id DESC LIMIT ${windowParam}) ws
    ) w ORDER BY w.rank DESC, w.job_id DESC`);
  if (ranked.length < window) return ranked;
  return [...ranked, ...(await ids(newestSql(built, where, windowParam, params.add(SET_MAX_IDS + 1 - window))))];
}

type FacetRows = Array<[string, number]>;

/** v3.0.1 FIX-PERF2 (PGL-21): the facets were counted on a sample of the matches and scaled: each count is about. */
export interface FacetsAbout {
  /** The matches the facets counted. */
  counted: number;
  /** Of every match (the exact total). */
  of: number;
}

interface Aggregate {
  total: number;
  unknown?: Record<string, number>;
  facets?: Record<string, FacetRows>;
  /** The facets were not computed in SEARCH_STATEMENT_TIMEOUT_MS: `total` is the capped count. */
  facetsNotComputed?: true;
  /** v3.0.1 FIX-PERF2 (PGL-21): the facets are a sample's, scaled. */
  facetsAbout?: FacetsAbout;
}

/**
 * v3.0.1 FIX-PERF2 (PG-LOAD PGL-21, PGL-6): past this many matches the facets count a sample of about this many of them
 * (every match whose id's hash falls in one bucket of total / FACET_SAMPLE_ROWS) and scale their counts to the total;
 * the answer says so (`facetsAbout`). The total and the unknowns stay exact.
 */
export const FACET_SAMPLE_ROWS = 20_000;

/** A sampled count scaled to every match, to two significant digits (it is about; under 100 as it is). */
function scaled(n: number, scale: number): number {
  const value = Math.round(n * scale);
  if (value < 100) return value;
  const unit = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.round(value / unit) * unit;
}

/** PostgreSQL's code for a statement its statement_timeout cancelled. */
const QUERY_CANCELED = '57014';

function timedOut(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === QUERY_CANCELED || (error instanceof Error && /statement timeout/i.test(error.message));
}

/** The facet's rows, most jobs first (the value as text on a tie), or by value, newest first (`byKey`). */
function topRows(counts: ReadonlyArray<[string, number]>, limit: number, byKey = false): FacetRows {
  return [...counts]
    .sort((a, b) => (byKey ? b[0].localeCompare(a[0]) : b[1] - a[1] || a[0].localeCompare(b[0])))
    .slice(0, limit);
}

/** One row of the aggregate's statement: a total (`total`, `u<k>`), a facet's group, or a place's group. */
interface AggregateRow {
  facet: string;
  key: string | null;
  n: number;
  city: string | null;
  region: string | null;
  country_code: string | null;
  is_remote: boolean | null;
  raw: string | null;
}

/** The place columns of a branch of the aggregate's UNION ALL that has none. */
const NO_PLACE = 'CAST(NULL AS text), CAST(NULL AS text), CAST(NULL AS text), CAST(NULL AS boolean), CAST(NULL AS text)';

/**
 * What the jobs that meet every filter but the judged ones count (11-database.md §7.5, coordinator decision N: SQL
 * `GROUP BY`, no row read into the app): the matches (`total`), for each judged filter the jobs that meet every other
 * filter and do not say (`unknown`), and each requested facet over the matches, under SEARCH_STATEMENT_TIMEOUT_MS. Past
 * that time the answer is the capped count without facets. null when nothing needs it (the ids told the total).
 *
 * v30 FIX-PERF (PG-LOAD PGL-6): one statement. The matches are read once (`m`, a materialized CTE of their job_search
 * columns and, per judged filter, whether a job passes it and whether it does not say), and the totals and every facet
 * are GROUP BYs over `m`, joined by UNION ALL: each facet was its own statement that read every match again (640,000
 * rows and 100,000 pages each for a common word at mix B's size, 4-9 s a call), and the statement timeout bounded each
 * statement, not the call. Now SEARCH_STATEMENT_TIMEOUT_MS bounds the whole aggregate.
 *
 * v3.0.1 FIX-PERF2 (PG-LOAD PGL-21): the one read was still every facet over every match: 3.4 s for "engineer"
 * (640,630 matches at mix B's size; the levels unnested and the places joined for each one: 1.4 s and 1.6 s), 2.4-2.7 s
 * with no words and remote, against 1.5 s. `m` now keeps each match's id and judged flags only (it fits in work_mem),
 * the totals and unknowns count it exactly (`c`), and the facets count `x`: every match while they are at most
 * FACET_SAMPLE_ROWS, else the matches whose id's hash falls in one of total / FACET_SAMPLE_ROWS buckets (a sample of
 * about that many, spread over every company, platform and day as the matches are), each read by its key; the answer
 * scales the sample's counts to the total and says they are about (`facetsAbout`).
 */
async function aggregate(deps: SearchDeps, built: Built, facets: readonly JobFacet[], idsTold: number | null): Promise<Aggregate | null> {
  const wanted = [...new Set(facets)];
  if (wanted.length === 0 && built.judged.length === 0 && idsTold !== null) return null;
  const constants = constantsOf(deps);
  const params = built.params.clone();
  const base = built.where.join(' AND ');
  // Each judged filter k: p<k>, the job passes it; q<k>, the job does not say (each condition is true or false).
  const flags = built.judged.flatMap((filter, k) => [`(${filter.sql}) AS p${k}`, `(${filter.unknown}) AS q${k}`]);
  const pass = (except?: number) => built.judged.map((_, k) => k).filter((k) => k !== except).map((k) => `m.p${k}`);
  const all = pass();
  const matched = all.length > 0 ? all.join(' AND ') : 'true';
  const totals = [`count(*) FILTER (WHERE ${matched}) AS total`];
  built.judged.forEach((_, k) => {
    // A job that meets every other judged filter and does not say what k reads is one of k's unknowns.
    totals.push(`count(*) FILTER (WHERE ${[`m.q${k}`, ...pass(k)].join(' AND ')}) AS u${k}`);
  });
  const totalNames = ['total', ...built.judged.map((_, k) => `u${k}`)];
  const shift = offsetMinutes(built.now, built.zone.tz);
  const known = params.array([...EXPERIENCE_LEVELS]);
  // Each facet counts `x`: the matches (or their sample) with the columns the facets read.
  const branches: Record<JobFacet, () => string> = {
    company: () => `(SELECT 'company', CAST(x.company_id AS text), count(*), ${NO_PLACE} FROM x
      GROUP BY x.company_id ORDER BY count(*) DESC, CAST(x.company_id AS text) COLLATE "C" LIMIT ${FACET_TOP})`,
    platform: () => `SELECT 'platform', x.apply_platform, count(*), ${NO_PLACE} FROM x GROUP BY x.apply_platform`,
    remote: () => `SELECT 'remote', COALESCE(x.work_arrangement, 'unknown'), count(*), ${NO_PLACE} FROM x GROUP BY 2`,
    posted: () => `SELECT 'posted',
      to_char((x.posted_sort AT TIME ZONE 'UTC') + make_interval(mins => CAST(${params.add(shift)} AS integer)), 'YYYY-MM-DD'),
      count(*), ${NO_PLACE} FROM x GROUP BY 2`,
    seniority: () => `SELECT 'seniority', lv.key, count(*), ${NO_PLACE} FROM x
      CROSS JOIN LATERAL (SELECT y FROM unnest(x.experience_levels) y WHERE y = ANY(${known})
                          UNION ALL SELECT 'unknown' WHERE NOT (x.experience_levels && ${known})) AS lv(key)
      GROUP BY lv.key`,
    // Each one's first place by its key (LIMIT 1: a probe a row, never a join over every place).
    location: () => `SELECT 'location', CAST(NULL AS text), count(*), jl.city, jl.region, jl.country_code, jl.is_remote, max(jl.raw)
      FROM x LEFT JOIN LATERAL (SELECT l.city, l.region, l.country_code, l.is_remote, l.raw FROM job_locations l
                                WHERE l.job_id = x.job_id AND l.position = 0 LIMIT 1) jl ON true
      GROUP BY jl.city, jl.region, jl.country_code, jl.is_remote`,
  };
  const sample = params.add(FACET_SAMPLE_ROWS);
  // The sample: every match while they are at most FACET_SAMPLE_ROWS, else those whose id's hash falls in bucket 0 of
  // ceil(total / FACET_SAMPLE_ROWS). Each one's facet columns by its key (LIMIT 1: a probe a row, never a read of the
  // table: the planner cannot know how few rows the sample keeps).
  const sampleSql = `x AS MATERIALIZED (
      SELECT r.* FROM c, m
      CROSS JOIN LATERAL (SELECT s.job_id, s.company_id, s.apply_platform, s.work_arrangement, s.posted_sort, s.experience_levels
                          FROM job_search s WHERE s.job_id = m.job_id LIMIT 1) r
      WHERE ${matched} AND (c.total <= ${sample}
        OR hashint8(m.job_id) % CAST(ceil(c.total / CAST(${sample} AS numeric)) AS integer) = 0)
    ),`;
  const counts = [...totalNames.map((name) => `('${name}', c.${name})`), ...(wanted.length > 0 ? ["('counted', (SELECT count(*) FROM x))"] : [])];
  const sql = `WITH m AS MATERIALIZED (
      SELECT s.job_id${flags.map((flag) => `, ${flag}`).join('')} FROM job_search s WHERE ${base}
    ),
    c AS MATERIALIZED (SELECT ${totals.join(', ')} FROM m),
    ${wanted.length > 0 ? sampleSql : ''}
    v AS (SELECT v.facet, v.n FROM c CROSS JOIN LATERAL (VALUES ${counts.join(', ')}) AS v(facet, n))
    SELECT v.facet, CAST(NULL AS text) AS key, v.n, CAST(NULL AS text) AS city, CAST(NULL AS text) AS region,
      CAST(NULL AS text) AS country_code, CAST(NULL AS boolean) AS is_remote, CAST(NULL AS text) AS raw
    FROM v
    ${wanted.map((facet) => `UNION ALL ${branches[facet]()}`).join('\n    ')}`;
  const timeout = constants.get('SEARCH_STATEMENT_TIMEOUT_MS');
  try {
    return await deps.db.tx(
      async (t) => {
        await t.one("SELECT set_config('statement_timeout', ?, true)", [String(timeout)]);
        const rows = await t.all<AggregateRow>(sql, params.values);
        const counted = new Map(
          rows.filter((row) => totalNames.includes(row.facet) || row.facet === 'counted').map((row) => [row.facet, Number(row.n)]),
        );
        const total = counted.get('total') ?? 0;
        // A sample's counts, scaled to every match (FACET_SAMPLE_ROWS).
        const sampled = counted.get('counted') ?? total;
        const about = wanted.length > 0 && sampled > 0 && sampled < total;
        const scale = about ? total / sampled : 1;
        const groups = (facet: JobFacet) =>
          rows.filter((row) => row.facet === facet).map((row) => ({ ...row, n: about ? scaled(Number(row.n), scale) : Number(row.n) }));
        const out: Record<string, FacetRows> = {};
        for (const facet of wanted) {
          if (facet === 'location') {
            const labels = new Map<string, string>();
            const counts = groups('location').map((row): [string, number] => {
              if (row.raw === null) return ['', Number(row.n)];
              const key = `${row.city ?? ''}|${row.region ?? ''}|${row.country_code ?? ''}|${row.is_remote ? 1 : 0}`;
              labels.set(key, formatLocation({ raw: row.raw, city: row.city, region: row.region, countryCode: row.country_code, isRemote: row.is_remote === true }));
              return [key, Number(row.n)];
            });
            out.location = topRows(counts, FACET_TOP).map(([key, n]) => [labels.get(key) ?? 'unknown', n]);
            continue;
          }
          const facetRows = groups(facet).map((row): [string, number] => [row.key ?? '', Number(row.n)]);
          if (facet === 'company') {
            const names = new Map(
              facetRows.length === 0
                ? []
                : (
                    await t.all<{ id: number; name: string }>(
                      `SELECT id, name FROM companies WHERE id IN (${t.dialect.list(facetRows.length)})`,
                      facetRows.map(([id]) => Number(id)),
                    )
                  ).map((row) => [String(row.id), row.name]),
            );
            out.company = topRows(facetRows, FACET_TOP).map(([id, n]) => [untrustedText(names.get(id) ?? '', 80), n]);
          } else if (facet === 'posted') out.posted = topRows(facetRows, 14, true);
          else out[facet] = topRows(facetRows, facet === 'platform' ? PLATFORMS.length : FACET_TOP);
        }
        return {
          total,
          ...(built.judged.length > 0 ? { unknown: Object.fromEntries(built.judged.map((filter, k) => [filter.name, counted.get(`u${k}`) ?? 0])) } : {}),
          ...(wanted.length > 0 ? { facets: out } : {}),
          ...(about ? { facetsAbout: { counted: sampled, of: total } } : {}),
        };
      },
      { label: 'search_jobs facets' },
    );
  } catch (error) {
    if (isQueryError(error)) return { total: 0 };
    if (!timedOut(error)) throw error;
    // Past the time, without facets: the total the ids told, else the matches counted up to JOB_SEARCH_COUNT_CAP (and
    // one past it).
    if (idsTold !== null) return { total: idsTold, facetsNotComputed: true };
    const matches = [base, ...built.judged.map((filter) => `(${filter.sql})`)].join(' AND ');
    const cap = params.add(constants.get('JOB_SEARCH_COUNT_CAP') + 1);
    const capped = await deps.db.one<{ total: number }>(`SELECT count(*) AS total FROM (SELECT 1 FROM job_search s WHERE ${matches} LIMIT ${cap}) x`, params.values);
    return { total: capped?.total ?? 0, facetsNotComputed: true };
  }
}

interface JobRow {
  id: number;
  title: string;
  company: string;
  primary_location: string;
  location_count: number;
  posted: string;
  apply_platform: string;
  work_arrangement: string | null;
  /** Flags: booleans on PostgreSQL (1 is read as true too). */
  requires_clearance: boolean | number | null;
  sponsors_h1b: boolean | number | null;
  salary_annual_usd_min: number | null;
  salary_annual_usd_max: number | null;
  experience_levels: string;
  employment_type: string | null;
  apply_url: string;
  years: number | null;
  app_status: number | null;
  app_archived: string | null;
  queue_state: string | null;
  /** v30 FIX-B (REQ-1): the job's source's credit line as JSON text (jobs/credit.ts), or null. */
  credit_json: string | null;
}

/** The shown jobs' rows, in the order of `ids`, for the account. */
export async function jobRows(db: DbQueries, userId: string, ids: readonly number[]): Promise<JobRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<JobRow>(
    `SELECT j.id, j.title, c.name AS company, j.primary_location, j.location_count, ${POSTED} AS posted, j.apply_platform,
       j.work_arrangement, j.requires_clearance, j.sponsors_h1b, j.salary_annual_usd_min, j.salary_annual_usd_max,
       j.experience_levels, j.employment_type, j.apply_url, ${YEARS} AS years,
       a.current_status AS app_status, a.archived_at AS app_archived, q.state AS queue_state, ${jobCreditSql('j')} AS credit_json
     FROM jobs j JOIN companies c ON c.id = j.company_id
     LEFT JOIN applications a ON a.user_id = @userId AND a.job_id = j.id
     LEFT JOIN autofill_agent_queue q ON q.user_id = @userId AND q.job_id = j.id
     WHERE j.id IN (SELECT CAST(value AS INTEGER) FROM ${db.dialect.jsonEach('@ids')}) AND ${jobVisibleTo('j', '@userId')}`,
    { userId, ids: JSON.stringify(ids) },
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is JobRow => row !== undefined);
}

function levelsOf(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((level): level is string => typeof level === 'string') : [];
  } catch {
    return [];
  }
}

/** "$120k-150k" (yearly US dollars), or "". */
function salaryOf(row: Pick<JobRow, 'salary_annual_usd_min' | 'salary_annual_usd_max'>): string {
  const k = (value: number) => `${Math.round(value / 1000)}k`;
  const { salary_annual_usd_min: min, salary_annual_usd_max: max } = row;
  if (min !== null && max !== null && max !== min) return `$${k(min)}-${k(max)}`;
  const one = max ?? min;
  return one === null ? '' : `$${k(one)}`;
}

/** The person's own state of a job: saved, applied (or later), queued. */
function statusOf(row: Pick<JobRow, 'app_status' | 'app_archived' | 'queue_state'>): string {
  const parts: string[] = [];
  if (row.app_status !== null && (row.app_archived === null || row.app_status >= STATUS.applied)) {
    parts.push(row.app_status === STATUS.saved ? 'saved' : 'applied');
  }
  if (row.queue_state === 'queued' || row.queue_state === 'running') parts.push('queued');
  return parts.join(',');
}

/** A yes/no fact as read (a boolean on PostgreSQL, 0/1 on SQLite); null when the posting does not say. */
function factOf(value: boolean | number | null): boolean | null {
  return value === null ? null : value === true || value === 1;
}

/** The flags (the tool's description lists them). */
export function flagsOf(row: JobRow): string {
  let flags = '';
  if (row.work_arrangement === 'remote' || row.primary_location.startsWith('Remote')) flags += 'R';
  else if (row.work_arrangement === 'hybrid') flags += 'H';
  const clearance = factOf(row.requires_clearance);
  if (clearance === true) flags += 'C';
  else if (clearance === false) flags += 'N';
  const sponsors = factOf(row.sponsors_h1b);
  if (sponsors === true) flags += 'V';
  else if (sponsors === false) flags += 'X';
  if (row.salary_annual_usd_max !== null || row.salary_annual_usd_min !== null) flags += '$';
  const status = statusOf(row);
  if (status.includes('saved')) flags += 'S';
  if (status.includes('applied')) flags += 'A';
  if (status.includes('queued')) flags += 'Q';
  return flags;
}

/** v30 FIX-B (REQ-1): the credit its source asks for, "Himalayas (https://himalayas.app/)", or null. */
function creditTextOf(row: Pick<JobRow, 'credit_json'>): string | null {
  const credit = jobCreditOf(row.credit_json);
  if (!credit) return null;
  return credit.url ? `${credit.text} (${credit.url})` : credit.text;
}

function cell(row: JobRow, field: JobField, zone: Zone): string | number | null {
  switch (field) {
    case 'id':
      return row.id;
    case 'title':
      return untrustedText(row.title, 120);
    case 'company':
      return untrustedText(row.company, 80);
    case 'location': {
      const place = untrustedText(row.primary_location, 60);
      return row.location_count > 1 ? `${place} +${row.location_count - 1}` : place;
    }
    case 'posted':
      return dayIn(new Date(row.posted), zone.tz);
    case 'platform':
      return row.apply_platform;
    case 'flags':
      return flagsOf(row);
    case 'salary':
      return salaryOf(row);
    case 'seniority':
      return levelsOf(row.experience_levels).join(',');
    case 'years':
      return row.years;
    case 'type':
      return row.employment_type;
    case 'url':
      return row.apply_url;
    case 'status':
      return statusOf(row);
    case 'credit':
      return creditTextOf(row);
  }
}

export interface Table {
  cols: readonly string[];
  rows: Array<Array<string | number | null>>;
}

function tableOf(rows: readonly JobRow[], fields: readonly JobField[], zone: Zone): Table {
  // v30 FIX-B (REQ-1): the credit column comes with a shown job whose source asks for it, asked for or not.
  const shown: readonly JobField[] =
    fields.includes('credit') || !rows.some((row) => creditTextOf(row) !== null) ? fields : [...fields, 'credit'];
  return { cols: shown, rows: rows.map((row) => shown.map((field) => cell(row, field, zone))) };
}

export interface SearchAnswer {
  total: number;
  setId: string;
  cols?: readonly string[];
  rows?: Table['rows'];
  next?: string;
  facets?: Record<string, FacetRows>;
  unknown?: Record<string, number>;
  /** Set when total > the ids the set keeps: only the first SET_MAX_IDS can be paged or acted on. */
  capped?: number;
  /** The zone dates were read in, when the arguments held a date or the rows show one. */
  tz?: string;
  expanded?: Record<string, string[]>;
  /** v3.0 PG-SEARCH: the facets took longer than SEARCH_STATEMENT_TIMEOUT_MS: `total` is the capped count, no facets. */
  facetsNotComputed?: true;
  /** v3.0.1 FIX-PERF2 (PGL-21): the facets counted a sample of the matches, scaled to all of them: each count is about. */
  facetsAbout?: FacetsAbout;
}

/** One page of a set's jobs. */
async function pageOf(deps: Deps, userId: string, set: ResultSet, offset: number, args: SearchArgs, zone: Zone): Promise<SearchAnswer> {
  const limit = Math.min(args.limit ?? PAGE_DEFAULT, PAGE_MAX);
  const fields = args.fields && args.fields.length > 0 ? args.fields : DEFAULT_JOB_FIELDS;
  const ids = set.ids.slice(offset, offset + limit);
  const table = tableOf(await jobRows(deps.db, userId, ids), fields, zone);
  const end = offset + ids.length;
  return {
    total: set.total,
    cols: table.cols,
    rows: table.rows,
    ...(end < set.ids.length ? { next: setCursor(set.id, end) } : {}),
    setId: set.id,
    ...(set.total > set.ids.length ? { capped: set.ids.length } : {}),
    ...(fields.includes('posted') ? { tz: zone.tz } : {}),
  };
}

/** search_jobs. */
export async function searchJobs(
  deps: SearchDeps,
  userId: string,
  args: SearchArgs,
  sets: SetOwner = userId, // v33 SHARE-8: the caller on this profile (result-sets.ts)
): Promise<SearchAnswer> {
  if (args.cursor) {
    const { setId, offset } = readSetCursor(args.cursor);
    const set = await loadResultSet(deps, sets, setId);
    if (set.source !== 'search') throw validationFailed('cursor: that cursor is not a search\'s; use list_applications or queue_list with it.');
    const stored = set.query as SearchArgs;
    const paging = { ...args, fields: args.fields ?? stored.fields, limit: args.limit ?? stored.limit };
    return pageOf(deps, userId, set, offset, paging, zoneOf(args.tz ?? stored.tz));
  }
  if (args.minYears !== undefined && args.maxYears !== undefined && args.minYears > args.maxYears) {
    throw validationFailed('minYears is more than maxYears.');
  }
  const built = build(args, userId, deps.now());
  const ids = await matchIds(deps, built, args.sort ?? 'relevance');
  const counted = await aggregate(deps, built, args.facets ?? [], ids.length > SET_MAX_IDS ? null : ids.length);
  const total = counted?.total ?? ids.length;
  const query = { ...args, countOnly: undefined, facets: undefined, cursor: undefined };
  const set = await saveResultSet(deps, sets, 'search', query, ids, total);
  const extra: Partial<SearchAnswer> = {
    ...(set.total > set.ids.length ? { capped: set.ids.length } : {}),
    ...(counted?.facetsNotComputed ? { facetsNotComputed: true as const } : {}),
    ...(counted?.facetsAbout ? { facetsAbout: counted.facetsAbout } : {}),
    ...(Object.keys(built.fts.expanded).length > 0 ? { expanded: built.fts.expanded } : {}),
  };
  const unknown = counted?.unknown;
  const facets = counted?.facets;
  const dated = args.postedSince !== undefined || args.postedBetween !== undefined || args.facets?.includes('posted');
  if (args.countOnly) {
    return {
      total: set.total,
      setId: set.id,
      ...(facets ? { facets } : {}),
      ...(unknown ? { unknown } : {}),
      ...extra,
      ...(dated ? { tz: built.zone.tz } : {}),
    };
  }
  const page = await pageOf(deps, userId, set, 0, args, built.zone);
  return { ...page, ...(facets ? { facets } : {}), ...(unknown ? { unknown } : {}), ...extra, ...(dated ? { tz: built.zone.tz } : {}) };
}

// ------------------------------------------------------------------------------------------------- job_details

export const DETAIL_SECTIONS = ['requirements', 'responsibilities', 'desired'] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];
/** The most posting text one job_details answer holds, over all its jobs. */
export const DETAIL_TEXT_MAX = 20_000;
const KEYWORDS_SHOWN = 8;

export interface DetailArgs {
  jobId?: number;
  jobIds?: number[];
  maxChars?: number;
  sections?: DetailSection[];
  tz?: string;
}

/** job_details: a one-line summary per job, and the posting's text or sections only when asked. */
export async function jobDetails(deps: Deps, userId: string, args: DetailArgs) {
  const ids = [...new Set([...(args.jobId !== undefined ? [args.jobId] : []), ...(args.jobIds ?? [])])];
  if (ids.length === 0) throw validationFailed('Send jobId, or jobIds (at most 10).');
  if (ids.length > 10) throw validationFailed('jobIds: at most 10 jobs at once.');
  const zone = zoneOf(args.tz);
  const visible: number[] = [];
  for (const id of ids) if (await jobVisible(deps, userId, id)) visible.push(id);
  if (visible.length === 0) throw notFound('That job');
  const rows = await jobRows(deps.db, userId, visible);
  // v30 FIX-B (REQ-1): the credit column when a shown job's source asks for one.
  const credited = rows.some((row) => creditTextOf(row) !== null);
  const cols = ['id', 'title', 'company', 'location', 'posted', 'platform', 'seniority', 'years', 'keywords', 'salary', 'flags', ...(credited ? ['credit'] : [])];
  const texts: Array<Record<string, unknown>> = [];
  const budget = Math.min(args.maxChars ?? 0, DETAIL_TEXT_MAX);
  let left = budget;
  const perJob = rows.length > 0 ? Math.max(200, Math.floor(budget / rows.length)) : 0;
  const table: unknown[][] = [];
  for (const row of rows) {
    const analysis = await fallbackAnalysis(deps, row.id);
    const keywords = (analysis?.keywords.high ?? []).concat(analysis?.keywords.low ?? []).slice(0, KEYWORDS_SHOWN).map((group) => untrustedText(group.term, 40));
    const levels = analysis && analysis.experienceLevels.length > 0 ? analysis.experienceLevels : levelsOf(row.experience_levels);
    const years = analysis?.requiredYears ?? row.years;
    if (args.sections?.length || args.maxChars) {
      const text: Record<string, unknown> = { id: row.id };
      for (const section of new Set(args.sections ?? [])) {
        text[section] = (analysis?.[section] ?? []).slice(0, 12).map((line) => untrustedText(line, 300));
      }
      if (args.maxChars && left > 0) {
        // The posting's plain text, read through the text accessor (v3.0: job_texts holds it).
        const posting = (await readJobText(deps.db, row.id))?.text ?? '';
        const take = Math.min(perJob, left);
        const body = untrustedLines(posting, take);
        left -= [...body].length;
        text.posting = `<untrusted>\n${body}\n</untrusted>`;
        text.cut = [...posting].length > take;
      }
      texts.push(text);
    }
    table.push([
      row.id,
      untrustedText(row.title, 120),
      untrustedText(row.company, 80),
      cell(row, 'location', zone),
      cell(row, 'posted', zone),
      row.apply_platform,
      levels.join(','),
      years ?? null,
      keywords.join(','),
      salaryOf(row),
      flagsOf(row),
      ...(credited ? [creditTextOf(row)] : []),
    ]);
  }
  const missing = ids.filter((id) => !visible.includes(id));
  return {
    cols,
    rows: table,
    ...(texts.length > 0 ? { texts } : {}),
    ...(texts.some((text) => text.posting) ? { rule: POSTING_TEXT_RULE } : {}),
    ...(missing.length > 0 ? { notFound: missing } : {}),
    tz: zone.tz,
  };
}


/**
 * The query plan of a search's matches (PostgreSQL's EXPLAIN, one line a row), for the scale test and the tests that
 * check a search reads job_search's indexes, never the postings' rows.
 */
export async function searchPlan(deps: SearchDeps, userId: string, args: SearchArgs): Promise<string[]> {
  const built = build(args, userId, deps.now());
  const where = [...built.where, ...built.judged.map((filter) => filter.sql)];
  const params = built.params.clone();
  const relevance = (args.sort ?? 'relevance') === 'relevance' && built.fts.match !== null;
  if (built.fts.match !== null && built.judged.length > 0) {
    // v30 FIX-PERF (PGL-7): the GIN matches first, as matchIds reads them.
    const window = relevance ? params.add(Math.min(constantsOf(deps).get('SEARCH_RELEVANCE_WINDOW'), SET_MAX_IDS + 1)) : null;
    const sql = judgedWordsSql(where, relevance ? 'relevance' : 'newest', window, params.add(SET_MAX_IDS + 1));
    return (await deps.db.all<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params.values)).map((row) => row['QUERY PLAN']);
  }
  const sql = relevance
    ? `SELECT w.job_id AS id FROM (
         SELECT ws.job_id, ${rankSql('ws.body_tsv', 'CAST(@words AS tsquery)')} AS rank
         FROM (SELECT s.job_id, s.body_tsv FROM job_search s WHERE ${where.join(' AND ')}
               ORDER BY s.posted_sort DESC, s.job_id DESC LIMIT ${params.add(constantsOf(deps).get('SEARCH_RELEVANCE_WINDOW'))}) ws
       ) w ORDER BY w.rank DESC, w.job_id DESC`
    : newestSql(built, where, null, params.add(SET_MAX_IDS + 1));
  return (await deps.db.all<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params.values)).map((row) => row['QUERY PLAN']);
}
