import {
  COMPANY_SIZE_IDS,
  JOBS_PAGE_SIZE,
  STATUS,
  annualize,
  constantDefault,
  parseLocations,
  DAY_MS,
  type CompanySizeId,
  type JobsQuery,
} from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { personLocation } from '../prepare-filters/person';
import { decodeCursor, encodeCursor, type OrderMode } from './cursor';
import { buildSearchQuery, rankSql } from './fts';
import { APPLICATION_JOIN, SUMMARY_COLUMNS, postedRuleOf, toListItem, type JobListItem, type PostedRule, type SummaryRow } from './rows'; // v36 IMPORTTIME: postedRuleOf, PostedRule
import { placeKeyOf, remoteKeyOf } from './search-projection/vectors';
import { searchRowVisibleTo } from './visibility';

// GET /api/jobs: the Jobs page's list, on the search projection (`job_search s`, 11-database.md §5.6, §7): one
// statement per page (keyset-paginated, 21 rows) plus one capped COUNT for "Found N jobs". Every value reaches the
// database as a bound parameter; only fixed SQL fragments are concatenated. `countJobs` and `matchingJobIds` read the
// same matches (the same filters and order: the All filters dialog's count, and the search's parity tests).
// v3.0 PG-SEARCH: on PostgreSQL only. A search reads job_search's rows (one per open, verified, unheld job: the
// projection decides "active"), never jobs or the text, until it shows a page:
//   - words: `s.title_tsv @@ query` (the folded tokens of fts.ts); "Most relevant" ranks them with ts_rank inside the
//     newest SEARCH_RELEVANCE_WINDOW matches (§7.3), and pages within that window;
//   - places: the Location filter's places and "Remote in" as keys (`s.place_keys && keys`, one GIN overlap), free
//     text the parser cannot place as `s.locations_text ILIKE` (the trigram index);
//   - facts: in-row columns and small arrays;
//   - "Found N" counts up to JOB_SEARCH_COUNT_CAP matches and answers the cap plus one past it (§7.5).
// v30 WEB-JOBS: "Jobs I can apply to" (`canApply`, owner question 4, off unless asked): the job's candidate eligibility
// (the projected `elig_*` keys) against where the person lives and their time zone (§6 Q4), an unknown part passing;
// the page's cards carry their company's industry and size (the company's profile).

/** "Recently posted": the posting's own date, else when TailorIT first saw it. */
export const POSTED_SQL = 's.posted_sort';
/** "Recently updated" and the "Last updated" filter: the board's update time, else the posting date. */
export const UPDATED_SQL = 's.updated_sort';
/** "Highest salary": yearly USD (the top of the range, else its bottom); no salary sorts last. */
export const SALARY_SQL = 'COALESCE(s.salary_sort, -1)';

/** Named parameters for one statement: `add` returns the placeholder of a new value. */
export class Params {
  readonly values: Record<string, string | number | boolean | null> = {};
  private count = 0;

  constructor(initial: Record<string, string | number | boolean | null> = {}) {
    Object.assign(this.values, initial);
  }

  add(value: string | number | boolean | null): string {
    const name = `p${this.count++}`;
    this.values[name] = value;
    return `@${name}`;
  }

  list(values: readonly (string | number)[]): string {
    return values.map((value) => this.add(value)).join(', ');
  }

  /** A copy that goes on numbering after this one's names (a statement that adds to a shared base). */
  clone(): Params {
    const copy = new Params(this.values);
    copy.count = this.count;
    return copy;
  }

  /** A text[] of `values`, bound as one array literal. */
  array(values: readonly string[]): string {
    return `CAST(${this.add(arrayLiteral(values))} AS text[])`;
  }
}

/** PostgreSQL's literal of a text array: every item double-quoted, its backslashes and quotes escaped. */
export function arrayLiteral(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`).join(',')}}`;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** One place of a filter as what job_search answers: keys of `place_keys`, or a text `locations_text` holds. */
export interface PlaceMatch {
  keys: string[];
  /** A LIKE pattern over the places as written (any case), when the parser could not place the text. */
  written?: string;
}

/** One place of the Location filter ("Fremont, CA, USA", "California", "Canada", "Remote in USA", free text). */
export function placeMatchOf(text: string): PlaceMatch | null {
  const parsed = parseLocations(text)[0];
  if (!parsed) return null;
  if (parsed.isRemote) return { keys: [remoteKeyOf(parsed.countryCode)] };
  const key = placeKeyOf(parsed);
  const written = `%${escapeLike(text.trim())}%`;
  if (!key) return { keys: [], written };
  // A name the parser could not place (no region or country) may be part of a longer place: "Tranquility Base".
  return parsed.region || parsed.countryCode ? { keys: [key] } : { keys: [key], written };
}

/** Places as one condition: any of their keys (one overlap), or any of their written texts. */
export function placesSql(places: readonly PlaceMatch[], params: Params): string | null {
  const keys = [...new Set(places.flatMap((place) => place.keys))];
  const parts: string[] = [];
  if (keys.length > 0) parts.push(`s.place_keys && ${params.array(keys)}`);
  for (const place of places) {
    if (place.written) parts.push(`s.locations_text ILIKE ${params.add(place.written)} ESCAPE '\\'`);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

/** One place's condition (MCP's `location`), or null when the text names no place. */
export function placeSql(text: string, params: Params): string | null {
  const place = placeMatchOf(text);
  return place ? placesSql([place], params) : null;
}

/** The viewer's own job state: every shared job and their own page jobs, never one they hid or of a company they hid. */
export function visibleSql(viewer = '@userId'): string[] {
  return [
    // Every shared job, and the viewer's own jobs made from a page (autofill API version 5): never another account's.
    // v30 SCH: job_search's rule (its rows are unheld; jobVisibleTo's held rule is for jobs rows).
    searchRowVisibleTo('s', viewer),
    `NOT EXISTS (SELECT 1 FROM user_job_state h WHERE h.user_id = ${viewer} AND h.job_id = s.job_id AND h.hidden_at IS NOT NULL)`,
    `NOT EXISTS (SELECT 1 FROM user_hidden_companies hc WHERE hc.user_id = ${viewer} AND hc.company_id = s.company_id)`,
  ];
}

/** The job is applied to or later, now or once (an event at Applied or later): `hideApplied`. Binds @userId. */
export const APPLIED_SQL = `EXISTS (SELECT 1 FROM applications ap WHERE ap.user_id = @userId AND ap.job_id = s.job_id
      AND (ap.current_status >= ${STATUS.applied}
        OR EXISTS (SELECT 1 FROM application_status_events ev WHERE ev.application_id = ap.id AND ev.status >= ${STATUS.applied})))`;

/** The job says it sponsors an H-1B visa, or says nothing and its company does (the Jobs page's H-1B filter). */
export const SPONSORS_SQL = "(s.sponsorship = 'offered' OR (s.sponsorship IS NULL AND s.company_sponsors))";

/**
 * v30 WEB-JOBS: where the person lives and their time zone, as "Jobs I can apply to" compares them (the prepare
 * filters' own reading, prepare-filters/person.ts `personLocation`): null is unknown.
 */
export interface ApplicantPlace {
  /** ISO 3166-1 alpha-2 ("US"). */
  country: string | null;
  /** The subdivision code without its country ("TX"); only with a country. */
  region: string | null;
  /** The time zone's standard UTC offset ("-0500"). */
  timeZoneOffset: string | null;
}

export interface SearchScope {
  userId: string;
  now: Date;
  /** "Found N" counts up to this many matches (JOB_SEARCH_COUNT_CAP; its default when absent). */
  countCap?: number;
  /** "Most relevant" ranks the newest this many matches (SEARCH_RELEVANCE_WINDOW; its default when absent). */
  relevanceWindow?: number;
  /**
   * v30 WEB-JOBS: the person's place for "Jobs I can apply to", read only when a query asks for it (searchScopeOf
   * reads it once per scope). Absent: every part unknown, so every job passes.
   */
  applicant?: () => Promise<ApplicantPlace>;
  /** v36 IMPORTTIME: how a job an admin's import dated reads (rows.ts PostedRule; its default when absent). */
  postedRule?: PostedRule;
}

/** The scope of a search by `userId` now, with the admin's current caps (read at the moment of use). */
export function searchScopeOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, userId: string): SearchScope {
  const constants = constantsOf(deps);
  let applicant: Promise<ApplicantPlace> | undefined;
  return {
    userId,
    now: deps.now(),
    countCap: constants.get('JOB_SEARCH_COUNT_CAP'),
    relevanceWindow: constants.get('SEARCH_RELEVANCE_WINDOW'),
    postedRule: postedRuleOf(constants), // v36 IMPORTTIME
    // v30 WEB-JOBS: once per scope (a scope may count more than once).
    applicant: () => (applicant ??= personLocation(deps, userId)),
  };
}

const countCapOf = (scope: SearchScope) => scope.countCap ?? constantDefault('JOB_SEARCH_COUNT_CAP');
const windowOf = (scope: SearchScope) => scope.relevanceWindow ?? constantDefault('SEARCH_RELEVANCE_WINDOW');

/** v30 WEB-JOBS: the person's place when the query asks for "Jobs I can apply to", else null (no condition). */
async function applicantFor(query: JobsQuery, scope: SearchScope): Promise<ApplicantPlace | null> {
  return query.canApply && scope.applicant ? scope.applicant() : null;
}

/**
 * v30 WEB-JOBS (11-database.md §6 Q4, Part 1's location rule as prepare-filters' `locationMismatch` reads it): the
 * conditions that keep the jobs whose candidate eligibility admits `applicant`. Each part the person has not given is
 * left out (unknown passes), and a job without a rule of a kind holds that kind's '*' key (projected), so:
 *   - a country rule (countries, and the countries of a region rule) names the person's country;
 *   - a region rule within the person's country names their region;
 *   - a time-zone rule names their standard offset.
 * The two overlaps read the GIN index js_elig; the region part is checked on the row.
 */
export function eligibilityConditions(applicant: ApplicantPlace, params: Params): string[] {
  const where: string[] = [];
  const { country, region, timeZoneOffset } = applicant;
  if (country) {
    where.push(`s.elig_keys && ${params.array(['c:*', `c:${country}`])}`);
    if (region) {
      where.push(
        `(NOT (s.elig_region_countries @> ${params.array([country])}) OR s.elig_regions @> ${params.array([`${country}-${region}`])})`,
      );
    }
  }
  if (timeZoneOffset) where.push(`s.elig_keys && ${params.array(['o:*', `o:${timeZoneOffset}`])}`);
  return where;
}

/**
 * The WHERE conditions of a query over job_search `s`. Always: the projection's open jobs the viewer may see, never
 * one they hid or from a company they hid. Lists within one filter are OR, filters are AND; the Location filter's
 * places and its "Remote in" country are one OR group. v30 WEB-JOBS: `applicant` is the person's place when the query
 * asks for "Jobs I can apply to" (applicantFor), else null.
 */
export function filterConditions(query: JobsQuery, scope: SearchScope, params: Params, applicant: ApplicantPlace | null = null): string[] {
  const where = visibleSql();

  const places = query.locations.map(placeMatchOf).filter((place): place is PlaceMatch => place !== null);
  if (query.remote) places.push({ keys: [remoteKeyOf(query.remote)] });
  const placeCondition = placesSql(places, params);
  if (placeCondition) where.push(placeCondition);

  if (query.jobTypes.length > 0) where.push(`s.employment_type IN (${params.list(query.jobTypes)})`);
  if (query.levels.length > 0) where.push(`s.experience_levels && ${params.array(query.levels)}`);
  const categoryParts: string[] = [];
  if (query.categories.length > 0) categoryParts.push(`s.category_id IN (${params.list(query.categories)})`);
  if (query.subcategories.length > 0) categoryParts.push(`s.subcategory_ids && ${params.array(query.subcategories)}`);
  if (categoryParts.length > 0) where.push(`(${categoryParts.join(' OR ')})`);
  if (query.leadership.length > 0) where.push(`s.leadership IN (${params.list(query.leadership)})`);
  if (query.arrangements.length > 0) where.push(`s.work_arrangement IN (${params.list(query.arrangements)})`);

  if (query.minSalary) {
    // The slider's amount is per `payPeriod` (yearly by default) in US dollars; jobs carry yearly USD.
    const yearly = Math.round(annualize(query.minSalary, query.payPeriod ?? 'year'));
    where.push(`s.salary_sort >= ${params.add(yearly)}`);
  }
  if (query.h1b) where.push(SPONSORS_SQL);
  if (query.industries.length > 0) where.push(`COALESCE(s.industry, 'not_specified') IN (${params.list(query.industries)})`);
  if (query.companySizes.length > 0) where.push(`s.company_size IN (${params.list(query.companySizes)})`);
  if (query.companies.length > 0) where.push(`s.company_id IN (${params.list(query.companies.map(Number))})`);
  if (query.clearance === 'required') where.push('s.clearance_required');
  if (query.clearance === 'not_required') where.push('s.clearance_required IS NOT TRUE');
  if (query.hideApplied) where.push(`NOT ${APPLIED_SQL}`);
  if (query.canApply && applicant) where.push(...eligibilityConditions(applicant, params));
  if (query.updatedWithin) {
    const since = new Date(scope.now.getTime() - query.updatedWithin * DAY_MS).toISOString();
    where.push(`${UPDATED_SQL} >= CAST(${params.add(since)} AS timestamptz)`);
  }
  return where;
}

interface Ordering {
  mode: OrderMode;
  /** The sort key's expression (over `s`, or the ranked window's `w.rank`). */
  key: string;
  /** Its type, for the cursor's bound value. */
  cast: 'timestamptz' | 'integer' | 'real';
}

/** How "Most relevant" and the other sorts order rows (every order newest id first on a tie, descending). */
function ordering(query: JobsQuery, hasSearch: boolean): Ordering {
  switch (query.sort) {
    case 'posted':
      return { mode: 'posted', key: POSTED_SQL, cast: 'timestamptz' };
    case 'updated':
      return { mode: 'updated', key: UPDATED_SQL, cast: 'timestamptz' };
    case 'salary':
      return { mode: 'salary', key: SALARY_SQL, cast: 'integer' };
    default:
      // ts_rank is higher for a better match; without a search, the newest postings come first.
      return hasSearch ? { mode: 'rank', key: 'w.rank', cast: 'real' } : { mode: 'posted', key: POSTED_SQL, cast: 'timestamptz' };
  }
}

/**
 * The viewer tracks the job, as the list shows it (rows.ts `toListItem`): saved (an application that is not archived),
 * or applied to and on (Applied or later, archived or not). An application archived while only Saved (un-saved) does
 * not count. Binds @userId; the unique index on applications(user_id, job_id) answers it, as for `hideApplied`.
 */
const TRACKED_SQL = `EXISTS (SELECT 1 FROM applications ap WHERE ap.user_id = @userId AND ap.job_id = s.job_id
      AND (ap.archived_at IS NULL OR ap.current_status >= ${STATUS.applied}))`;

export interface MatchOptions {
  /** Only the matches the viewer does not track (never tracked, or un-saved). */
  untrackedOnly?: boolean;
}

interface Matching {
  /** The words' tsquery text (bound as @words), or null without words. */
  words: string | null;
  params: Params;
  where: string[];
}

/**
 * What every read of the matches shares (the page, its count, the ids in order): WHERE and parameters. v30
 * WEB-JOBS: async, as "Jobs I can apply to" reads the person's place first.
 */
async function matchingSql(query: JobsQuery, scope: SearchScope, options: MatchOptions = {}): Promise<Matching> {
  const words = buildSearchQuery(query.q);
  const params = new Params({ userId: scope.userId, ...(words ? { words } : {}) });
  const where = filterConditions(query, scope, params, await applicantFor(query, scope));
  if (words) where.unshift('s.title_tsv @@ CAST(@words AS tsquery)');
  if (options.untrackedOnly) where.push(`NOT ${TRACKED_SQL}`);
  return { words, params, where };
}

/**
 * The matches' ids with their sort key, in the list's order (`sort_key`, then the newest id first), from `beyond`
 * (a keyset cursor's condition) on, at most `limit`. "Most relevant" ranks the newest SEARCH_RELEVANCE_WINDOW
 * matches (the window), so its rows are that window's.
 */
function orderedIdsSql(match: Matching, order: Ordering, scope: SearchScope, beyond: string | null, limit: string): string {
  if (order.mode === 'rank') {
    const window = match.params.add(windowOf(scope));
    return `SELECT w.job_id AS id, w.rank AS sort_key FROM (
        SELECT ws.job_id, ${rankSql('ws.title_tsv', 'CAST(@words AS tsquery)')} AS rank
        FROM (SELECT s.job_id, s.title_tsv FROM job_search s
              WHERE ${match.where.join('\n                AND ')}
              ORDER BY s.posted_sort DESC, s.job_id DESC
              LIMIT ${window}) ws
      ) w
      ${beyond ? `WHERE ${beyond}` : ''}
      ORDER BY w.rank DESC, w.job_id DESC
      LIMIT ${limit}`;
  }
  const where = beyond ? [...match.where, beyond] : match.where;
  return `SELECT s.job_id AS id, ${order.key} AS sort_key FROM job_search s
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${order.key} DESC, s.job_id DESC
      LIMIT ${limit}`;
}

/** The keyset condition after a cursor: rows after (key, id) in the list's descending order. */
function beyondSql(order: Ordering, key: string | number, id: number, params: Params): string {
  const keyParam = `CAST(${params.add(key)} AS ${order.cast})`;
  const idParam = params.add(id);
  const ownKey = order.mode === 'rank' ? 'w.rank' : order.key;
  const ownId = order.mode === 'rank' ? 'w.job_id' : 's.job_id';
  return `(${ownKey}, ${ownId}) < (${keyParam}, ${idParam})`;
}

/** "Found N": the matches, counted up to the cap and one past it (a count past the cap means "more than the cap"). */
function countSql(match: Matching, scope: SearchScope): string {
  const limit = match.params.add(countCapOf(scope) + 1);
  return `SELECT count(*) AS total FROM (SELECT 1 FROM job_search s WHERE ${match.where.join('\n AND ')} LIMIT ${limit}) x`;
}

export interface JobsPage {
  items: JobListItem[];
  /**
   * "Found N jobs": exact up to JOB_SEARCH_COUNT_CAP; the cap plus one means more than the cap. v30 FIX-PG (PGL-3): on
   * the first page only (no cursor): a next page keeps the first page's count, as the Jobs page does.
   */
  total?: number;
  nextCursor?: string;
}

/** True when PostgreSQL refused the tsquery (it should never happen: the query is built from tokens). */
function isQuerySyntaxError(error: unknown): boolean {
  return error instanceof Error && /tsquery|syntax error in tsquery|word is too long/i.test(error.message);
}

type PageRow = SummaryRow & {
  sort_key: string | number;
  /** v30 WEB-JOBS: the company's profile (company_profiles), for the card's company line. */
  company_industry: string | null;
  company_size_bucket: string | null;
};

const SIZE_IDS: ReadonlySet<string> = new Set(COMPANY_SIZE_IDS);

/**
 * v30 WEB-JOBS: one card, its company with the profile's industry and size when known (13 §2). An unknown value is
 * left out, so a card without them reads as before.
 */
function cardOf(row: PageRow, rule?: PostedRule): JobListItem {
  const item = toListItem(row, rule); // v36 IMPORTTIME: rule
  const industry = row.company_industry?.trim() || null;
  const sizeBucket = row.company_size_bucket && SIZE_IDS.has(row.company_size_bucket) ? (row.company_size_bucket as CompanySizeId) : null;
  return {
    ...item,
    company: { ...item.company, ...(industry ? { industry } : {}), ...(sizeBucket ? { sizeBucket } : {}) },
  };
}

function pageOf(rows: PageRow[], total: number | undefined, order: Ordering, rule?: PostedRule): JobsPage {
  const hasMore = rows.length > JOBS_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, JOBS_PAGE_SIZE) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map((row) => cardOf(row, rule)), // v36 IMPORTTIME: rule
    ...(total !== undefined ? { total } : {}),
    ...(hasMore && last ? { nextCursor: encodeCursor({ mode: order.mode, key: last.sort_key, id: last.id }) } : {}),
  };
}

/**
 * One page of the list for `query` as `scope.userId` sees it. v30 FIX-PG (PG-LOAD PGL-3, measurements.md §3): the capped
 * "Found N jobs" count is run for the first page only. It reads up to JOB_SEARCH_COUNT_CAP + 1 matches (60-700 ms for a
 * common word or a filter at mix B, against a page's 2-30 ms), and the Jobs page shows the first page's count while it
 * loads more; a next page (a cursor) is its page alone.
 */
export async function searchJobs(db: DbQueries, query: JobsQuery, scope: SearchScope): Promise<JobsPage> {
  const match = await matchingSql(query, scope);
  const order = ordering(query, match.words !== null);
  const countStatement = countSql(match, scope);
  const countParams = { ...match.params.values };
  const cursor = decodeCursor(query.cursor, order.mode);
  const beyond = cursor ? beyondSql(order, cursor.key, cursor.id, match.params) : null;
  const ids = orderedIdsSql(match, order, scope, beyond, match.params.add(JOBS_PAGE_SIZE + 1));
  // v30 WEB-JOBS: the company's profile gives the card its industry and size (company_profiles' primary key).
  const pageSql = `
    WITH page AS (${ids})
    SELECT ${SUMMARY_COLUMNS}, page.sort_key AS sort_key,
      cp.industry AS company_industry, cp.size_bucket AS company_size_bucket
    FROM page
    JOIN jobs j ON j.id = page.id
    JOIN companies c ON c.id = j.company_id
    LEFT JOIN company_profiles cp ON cp.company_id = j.company_id
    ${APPLICATION_JOIN}
    ORDER BY page.sort_key DESC, j.id DESC`;
  let rows: PageRow[];
  let total: number | undefined;
  try {
    rows = await db.all<PageRow>(pageSql, match.params.values);
    if (!cursor) total = (await db.one<{ total: number }>(countStatement, countParams))!.total;
  } catch (error) {
    if (match.words && isQuerySyntaxError(error)) return { items: [], total: 0 };
    throw error;
  }
  return pageOf(rows, total, order, scope.postedRule); // v36 IMPORTTIME
}

/**
 * "Found N jobs" alone (the All filters dialog's "Show N jobs" button), capped as the page's. With `untrackedOnly`,
 * only the matches the viewer does not track.
 */
export async function countJobs(db: DbQueries, query: JobsQuery, scope: SearchScope, options: MatchOptions = {}): Promise<number> {
  const match = await matchingSql(query, scope, options);
  try {
    return (await db.one<{ total: number }>(countSql(match, scope), match.params.values))!.total;
  } catch (error) {
    if (match.words && isQuerySyntaxError(error)) return 0;
    throw error;
  }
}

/**
 * The ids of the first `limit` matches, in the order the list shows them (its sort key, then the newest id first,
 * as the pages are cut; "Most relevant" within its window); the cursor is ignored. [] when the search is refused, as
 * the list then shows nothing.
 */
export async function matchingJobIds(
  db: DbQueries,
  query: JobsQuery,
  scope: SearchScope,
  options: MatchOptions & { limit: number },
): Promise<number[]> {
  const match = await matchingSql(query, scope, options);
  const order = ordering(query, match.words !== null);
  const limit = match.params.add(Number.isSafeInteger(options.limit) ? Math.max(0, options.limit) : 0);
  try {
    return (await db.all<{ id: number }>(orderedIdsSql(match, order, scope, null, limit), match.params.values)).map((row) => row.id);
  } catch (error) {
    if (match.words && isQuerySyntaxError(error)) return [];
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------- by words alone

/** One job the words find (the extension's job search lists them). */
export interface WordMatch {
  id: number;
  title: string;
  company: string;
  primary_location: string;
  locations_text: string;
}

/**
 * The extension's job search (autofill/tracker.ts, GET /api/autofill/jobs/search): TailorIT's open jobs whose title,
 * company or places hold every word of `q` (the Jobs page's words), the best match first (ts_rank inside the newest
 * SEARCH_RELEVANCE_WINDOW matches; the older id first on a tie, as before), never one the viewer hid or of a company
 * they hid, at most `limit`. [] when `q` has no searchable word.
 */
export async function searchByWords(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  userId: string,
  q: string,
  limit: number,
): Promise<WordMatch[]> {
  const words = buildSearchQuery(q);
  if (words === null || limit <= 0) return [];
  const scope = searchScopeOf(deps, userId);
  const sql = `SELECT j.id, j.title, c.name AS company, j.primary_location, j.locations_text
    FROM (SELECT w.job_id, w.rank FROM (
            SELECT ws.job_id, ${rankSql('ws.title_tsv', 'CAST(@words AS tsquery)')} AS rank
            FROM (SELECT s.job_id, s.title_tsv FROM job_search s
                  WHERE s.title_tsv @@ CAST(@words AS tsquery) AND ${visibleSql().join(' AND ')}
                  ORDER BY s.posted_sort DESC, s.job_id DESC
                  LIMIT @window) ws
          ) w
          ORDER BY w.rank DESC, w.job_id
          LIMIT @limit) f
    JOIN jobs j ON j.id = f.job_id JOIN companies c ON c.id = j.company_id
    ORDER BY f.rank DESC, j.id`;
  try {
    return await deps.db.all<WordMatch>(sql, { words, userId, window: windowOf(scope), limit });
  } catch (error) {
    if (isQuerySyntaxError(error)) return [];
    throw error;
  }
}
