import {
  JOB_SOURCE_CANDIDATE_STATUSES,
  JOB_SOURCE_DISCOVERED_VIA,
  type AdminCandidateAddOutcome,
  type AdminCandidatesAddBody,
  type AdminCandidatesAddResult,
  type AdminCandidatesBulkBody,
  type AdminCandidatesBulkResult,
  type AdminCandidatesQuery,
  type CandidateFunnel,
  type JobSourceCandidate,
  type JobSourceCandidateStatus,
  type JobSourceDiscoveredVia,
  type JobSourceKind,
} from '@tailorit/shared';
import { decodeCursor, encodeCursor, likeText, Where } from '../../../core/admin/index';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import type { SqlParams } from '../../../core/db/types';
import { validationFailed } from '../../../core/http/errors';
import { candidateName } from './boards';
import { COMMON_CRAWL_QUERIES, COMMON_CRAWL_STATE, NO_CRAWL, type CrawlState } from './common-crawl';
import { boardToOffer } from './links';
import { CANDIDATE_KINDS, offerToDiscovery } from './offer';
import { SOURCE_KIND_LABEL } from '../types'; // v30 FIX-A (UX-17)
import { counterOf, discoveryDayOf, readState, VALIDATIONS_COUNTER } from './state';
import { validatableKinds, validationAllowed } from './validate';

// v30 S2: Admin › Candidates' API (docs/design/part2/12-job-sourcing.md §4, §9.8 "the candidate funnel"; CT's
// AdminCandidates* schemas): the candidates, newest seen first, searched and filtered, with the funnel (by state, by
// signal, today's validations and the cap, why validation is off, Common Crawl's progress, the companies with no
// board); an admin's retry or drop of up to ADMIN_BULK_MAX; an admin's own boards (signal 7); the measures by kind.
// A candidate never names a person, so nothing here does either.

const STALE_CURSOR = 'This list changed since it was loaded. Load it again.';

interface CandidateRow {
  id: number;
  kind: JobSourceKind;
  name: string;
  discovered_via: JobSourceDiscoveredVia;
  seen_count: number;
  first_seen_at: string;
  last_seen_at: string;
  status: JobSourceCandidateStatus;
  attempts: number;
  next_check_at: string | null;
  source_id: number | null;
  checked_at: string | null;
  open_jobs: number | null;
  last_error: string | null;
  source_name: string | null;
  source_enabled: boolean | null;
  source_open_jobs: number | null;
  open_life_days: number | null;
  /** v36 SOURCES: its source is off and no admin ever turned it on. */
  source_waiting: boolean | null;
}

const CANDIDATE_COLUMNS = `c.id, c.kind, c.name, c.discovered_via, c.seen_count, c.first_seen_at, c.last_seen_at, c.status, c.attempts,
  c.next_check_at, c.source_id, c.checked_at, c.open_jobs, c.last_error, s.name AS source_name, s.enabled AS source_enabled,
  COALESCE(m.open_jobs, s.open_jobs) AS source_open_jobs, m.open_life_days_median AS open_life_days,
  (NOT s.enabled AND s.enabled_at IS NULL) AS source_waiting`; // v36 SOURCES
const CANDIDATE_FROM = `job_source_candidates c LEFT JOIN job_sources s ON s.id = c.source_id
  LEFT JOIN job_source_measures m ON m.source_id = c.source_id`;

function toCandidate(row: CandidateRow): JobSourceCandidate {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    discoveredVia: row.discovered_via,
    seenCount: row.seen_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    status: row.status,
    attempts: row.attempts,
    nextCheckAt: row.next_check_at,
    sourceId: row.source_id,
    checkedAt: row.checked_at,
    openJobs: row.open_jobs,
    lastError: row.last_error,
    sourceName: row.source_name,
    sourceEnabled: row.source_id === null ? null : row.source_enabled === true,
    sourceOpenJobs: row.source_id === null ? null : row.source_open_jobs,
    openLifeDays: row.open_life_days === null ? null : Math.round(Number(row.open_life_days) * 10) / 10,
    sourceWaiting: row.source_id === null ? null : row.source_waiting === true, // v36 SOURCES (PLAN S8)
  };
}

/** The funnel (see the top). */
export async function candidateFunnel(deps: AppDeps): Promise<CandidateFunnel> {
  const db = deps.db;
  // v36 FIX-SRC (the final ux review's L7): with each status, how many of its candidates' sources wait for an admin (off,
  // never turned on: the candidate rows' source_waiting) and how many are on, so the funnel says "waiting for you" only
  // of those still waiting.
  const byStatus = await db.all<{ status: JobSourceCandidateStatus; count: number; sources_waiting: number; sources_on: number }>(
    `SELECT c.status, count(*) AS count,
       count(*) FILTER (WHERE NOT s.enabled AND s.enabled_at IS NULL) AS sources_waiting, count(*) FILTER (WHERE s.enabled) AS sources_on
     FROM job_source_candidates c LEFT JOIN job_sources s ON s.id = c.source_id GROUP BY c.status`,
  );
  const byVia = await db.all<{ discovered_via: JobSourceDiscoveredVia; count: number }>(
    'SELECT discovered_via, count(*) AS count FROM job_source_candidates GROUP BY discovered_via',
  );
  const statusCounts = new Map(byStatus.map((row) => [row.status, row]));
  const viaCounts = new Map(byVia.map((row) => [row.discovered_via, row.count]));
  const usedToday = await counterOf(db, discoveryDayOf(deps), VALIDATIONS_COUNTER);
  const reading = new Set(validatableKinds(deps));
  const waitingKinds = (
    await db.all<{ kind: JobSourceKind }>("SELECT DISTINCT kind FROM job_source_candidates WHERE status IN ('new', 'error', 'not_found') ORDER BY kind")
  )
    .map((row) => row.kind)
    .filter((kind) => !reading.has(kind));
  // v30 FIX-A (P6.1): validation is on while the v2.0 kinds read today, the other kinds waiting for the identity.
  const reason = !validationAllowed(deps) ? 'identity' : !deps.config.ingest.enabled ? 'ingest_off' : null;
  const companies = await db.one<{ n: number }>(
    `SELECT count(*) AS n FROM companies c JOIN company_job_counts n ON n.company_id = c.id
     WHERE c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND n.open_jobs > 0
       AND NOT EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.kind = 'board')
       AND NOT EXISTS (SELECT 1 FROM job_sources s WHERE s.company_id = c.id)`,
  );
  const crawl: CrawlState = { ...NO_CRAWL, ...((await readState<Partial<CrawlState>>(db, COMMON_CRAWL_STATE)) ?? {}) };
  const c = constantsOf(deps);
  return {
    byStatus: JOB_SOURCE_CANDIDATE_STATUSES.map((status) => {
      const row = statusCounts.get(status);
      return { status, count: Number(row?.count ?? 0), sourcesWaiting: Number(row?.sources_waiting ?? 0), sourcesOn: Number(row?.sources_on ?? 0) };
    }),
    byVia: JOB_SOURCE_DISCOVERED_VIA.map((discoveredVia) => ({ discoveredVia, count: viaCounts.get(discoveredVia) ?? 0 })),
    validatedToday: usedToday,
    validation: { on: reason === null, reason, cap: c.get('DISCOVERY_VALIDATIONS_PER_DAY'), usedToday, waitingKinds },
    companiesWithoutBoard: companies?.n ?? 0,
    probesPerHost: c.get('DISCOVERY_PROBES_PER_HOST_PER_DAY'),
    commonCrawl: {
      crawl: crawl.crawl,
      done: crawl.done,
      query: Math.min(crawl.query, COMMON_CRAWL_QUERIES.length),
      queries: COMMON_CRAWL_QUERIES.length,
      finishedAt: crawl.finishedAt,
    },
  };
}

/** Admin › Candidates' page: newest seen first (keyset on last_seen_at, id), every match counted, and the funnel. */
export async function listCandidates(deps: AppDeps, query: AdminCandidatesQuery) {
  const where = new Where();
  if (query.q) where.add("c.name ILIKE @q ESCAPE '\\'", { q: likeText(query.q) });
  if (query.kind.length) where.add("c.kind = ANY(string_to_array(@kinds, ','))", { kinds: query.kind.join(',') });
  if (query.status.length) where.add("c.status = ANY(string_to_array(@statuses, ','))", { statuses: query.status.join(',') });
  if (query.discoveredVia.length) where.add("c.discovered_via = ANY(string_to_array(@vias, ','))", { vias: query.discoveredVia.join(',') });
  const total = (await deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM job_source_candidates c ${where.sql()}`, where.params as SqlParams))?.n ?? 0;
  const page = new Where();
  const params: Record<string, unknown> = { ...where.params, limit: query.limit + 1 };
  if (query.cursor) {
    const { c, id } = decodeCursor(query.cursor, STALE_CURSOR);
    if (typeof c !== 'string' || typeof id !== 'number') throw validationFailed(STALE_CURSOR);
    page.add('(c.last_seen_at < CAST(@cursorAt AS timestamptz) OR (c.last_seen_at = CAST(@cursorAt AS timestamptz) AND c.id < @cursorId))', {
      cursorAt: c,
      cursorId: id,
    });
  }
  const conditions = [where.sql().replace(/^WHERE /, ''), page.sql().replace(/^WHERE /, '')].filter(Boolean).join(' AND ');
  const rows = await deps.db.all<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM ${CANDIDATE_FROM} ${conditions ? `WHERE ${conditions}` : ''}
     ORDER BY c.last_seen_at DESC, c.id DESC LIMIT @limit`,
    { ...params, ...page.params } as SqlParams,
  );
  const items = rows.slice(0, query.limit).map(toCandidate);
  const last = items[items.length - 1];
  return {
    items,
    total,
    funnel: await candidateFunnel(deps),
    ...(rows.length > query.limit && last ? { nextCursor: encodeCursor({ c: last.lastSeenAt, id: last.id }) } : {}),
  };
}

/** One candidate as Admin › Candidates shows it, or null. */
export async function adminCandidate(deps: Pick<AppDeps, 'db'>, id: number): Promise<JobSourceCandidate | null> {
  const row = await deps.db.one<CandidateRow>(`SELECT ${CANDIDATE_COLUMNS} FROM ${CANDIDATE_FROM} WHERE c.id = ?`, [id]);
  return row ? toCandidate(row) : null;
}

/** Why a candidate is skipped by a bulk action. */
const SKIP_WORDS = {
  gone: 'That candidate was not found.',
  source: 'This board is a source already: change it in Sources.',
  dropped: 'This candidate was dropped already.',
  due: 'This candidate is waiting for its validation already.',
} as const;

/**
 * Retry (validate at the next chance: status `new`, its tries forgotten, due now) or drop (never validated again) up to
 * ADMIN_BULK_MAX candidates. A board that became a source is left to Sources; a forbidden one may be retried (robots.txt
 * may allow it now), and an opted-out company's board is refused again by validation, unread.
 */
export async function bulkCandidates(deps: AppDeps, body: AdminCandidatesBulkBody): Promise<{ ids: number[]; body: AdminCandidatesBulkResult }> {
  const at = nowIso(deps);
  const rows = new Map(
    (
      await deps.db.all<{ id: number; status: JobSourceCandidateStatus; next_check_at: string | null }>(
        "SELECT id, status, next_check_at FROM job_source_candidates WHERE id = ANY(CAST(string_to_array(?, ',') AS bigint[]))",
        [body.ids.join(',')],
      )
    ).map((row) => [row.id, row]),
  );
  const results: AdminCandidatesBulkResult['results'] = [];
  const chosen: number[] = [];
  for (const id of body.ids) {
    const row = rows.get(id);
    const skip = (why: keyof typeof SKIP_WORDS) => results.push({ id, outcome: 'skipped', message: SKIP_WORDS[why] });
    if (!row) skip('gone');
    else if (row.status === 'valid' || row.status === 'empty') skip('source');
    else if (body.action === 'drop' && row.status === 'dropped') skip('dropped');
    else if (body.action === 'retry' && row.status === 'new' && row.next_check_at !== null && row.next_check_at <= at) skip('due');
    else chosen.push(id);
  }
  if (chosen.length > 0) {
    await deps.db.run(
      body.action === 'drop'
        ? `UPDATE job_source_candidates SET status = 'dropped', next_check_at = NULL WHERE id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))`
        : `UPDATE job_source_candidates SET status = 'new', attempts = 0, next_check_at = CAST(@at AS timestamptz), last_error = NULL
           WHERE id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))`,
      { ids: chosen.join(','), at },
    );
    for (const id of chosen) results.push({ id, outcome: 'done' });
  }
  const order = new Map(body.ids.map((id, index) => [id, index]));
  results.sort((a, b) => order.get(a.id as number)! - order.get(b.id as number)!);
  const counts: AdminCandidatesBulkResult['counts'] = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return { ids: chosen, body: { results, counts } };
}

/** v30 FIX-A (REV-UX UX-17): why an admin's entry names no board TailorIT reads (each refused line says so). */
const REFUSE_WORDS = {
  spaces: "A board's name has no spaces. Give the board's address, or <kind>:<board> (greenhouse:acme).",
  unknown: "This names no board TailorIT reads. Give a board's or a posting's address, or <kind>:<board> (greenhouse:acme).",
  name: "That is not a board name {kind} uses. Give the board's address instead.",
  kind: 'TailorIT reads no boards of the kind "{kind}".',
} as const;

/** The board an admin's entry names, or why it names none (see addCandidates). */
function entryBoard(entry: string, kind: JobSourceKind | undefined, careerSites: boolean): { kind: JobSourceKind; name: string } | { reason: string } {
  const text = entry.trim();
  // A board's or a posting's address names its board and kind.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || (!/\s/.test(text) && text.includes('/'))) {
    return boardToOffer(text, careerSites) ?? { reason: REFUSE_WORDS.unknown };
  }
  // <kind>:<board>, the board as that kind's normaliser keeps it (in any case).
  const keyed = /^([a-z_]+):(\S+)$/.exec(text);
  if (keyed) {
    const named = keyed[1] as JobSourceKind;
    if (!CANDIDATE_KINDS.includes(named)) return { reason: REFUSE_WORDS.kind.replace('{kind}', keyed[1]!) };
    return namedBoard(named, keyed[2]!);
  }
  if (/\s/.test(text)) return { reason: REFUSE_WORDS.spaces };
  // A host (careers.acme.com, acme.workable.com) is an address without its scheme.
  const found = text.includes('.') ? boardToOffer(text, careerSites) : null;
  if (found) return found;
  return kind ? namedBoard(kind, text) : { reason: REFUSE_WORDS.unknown };
}

/** A bare board name of `kind`: only one its normaliser keeps as it is (never "not a board" squashed to "notaboard"). */
function namedBoard(kind: JobSourceKind, name: string): { kind: JobSourceKind; name: string } | { reason: string } {
  const normal = candidateName(kind, name);
  const label = SOURCE_KIND_LABEL[kind as keyof typeof SOURCE_KIND_LABEL] ?? kind;
  if (!normal || normal.toLowerCase() !== name.trim().toLowerCase()) return { reason: REFUSE_WORDS.name.replace('{kind}', label) };
  return { kind, name: normal };
}

/**
 * An admin's boards (12 §4.1 signal 7): each entry a board's or posting's address (its kind read from it), a
 * `<kind>:<board>` key, or a bare name (of `kind`), offered as an `admin` candidate in one transaction. Answers each
 * entry's outcome. v30 FIX-A (REV-UX UX-17): a name is taken only as its kind's normaliser keeps it; free text ("not a
 * board at all") is refused with a reason, never squashed into a board name.
 */
export async function addCandidates(deps: AppDeps, body: AdminCandidatesAddBody): Promise<{ ids: number[]; body: AdminCandidatesAddResult }> {
  const at = nowIso(deps);
  const careerSites = constantsOf(deps).get('SITE_READER_CAREER_PAGES');
  const results = await deps.db.tx(async (t) => {
    const done: AdminCandidatesAddResult['results'] = [];
    for (const entry of body.entries) {
      // An address names its board (and kind); <kind>:<board> or a bare name of `kind` only as its kind keeps it.
      const board = entryBoard(entry, body.kind, careerSites);
      if ('reason' in board) {
        done.push({ entry, outcome: 'refused', kind: null, name: null, candidateId: null, sourceId: null, reason: board.reason });
        continue;
      }
      const offered = await offerToDiscovery(deps, t, { kind: board.kind, name: board.name, via: 'admin', at });
      done.push({
        entry,
        outcome: offered.outcome,
        kind: board.kind,
        name: offered.outcome === 'refused' ? null : candidateName(board.kind, board.name),
        candidateId: offered.candidateId,
        sourceId: offered.sourceId,
      });
    }
    return done;
  });
  const counts: AdminCandidatesAddResult['counts'] = {};
  for (const result of results) counts[result.outcome as AdminCandidateAddOutcome] = (counts[result.outcome as AdminCandidateAddOutcome] ?? 0) + 1;
  return { ids: results.map((result) => result.candidateId).filter((id): id is number => id !== null), body: { results, counts } };
}
