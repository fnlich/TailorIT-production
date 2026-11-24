import { boardAlias, JOB_SOURCE_KIND_PLATFORM, siteAlias, type JobSourceKind } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import type { DbQueries, DbTx } from '../../../core/db/types';
import type { DiscoveryOfferInput, DiscoveryOfferResult, OfferToDiscovery } from '../../../core/seams';
import { BOARD_KINDS, boardNameOf, candidateName } from './boards';

// v30 X1-API (wave 3), then S2's (wave 4): offerToDiscovery, the seam that makes a board a discovery candidate
// (docs/design/part2/12-job-sourcing.md §4.1, 14-extension-reports.md §5.2 step 3, §5.3 step 2, core/seams.ts
// OfferToDiscovery). In the caller's transaction it adds the board to job_source_candidates, or bumps the one there
// (seen_count, last_seen_at; UNIQUE (kind, name)), due for validation at once (next_check_at): never a user id, never
// the job, never the page. Validation (validate.ts) reads it later, behind the identity guard. Outcomes:
// - `refused`: the kind is no board (JOB_SOURCE_KIND_PLATFORM names none: pages, imports, feeds of many employers), its
//   normaliser rejects the name (boards.ts candidateName), or a career site's host is no site host or a refused job
//   board's (LinkedIn's above all);
// - `known_source`: a source already reads the board (enabled, or disabled by an admin). A disabled source Add job made
//   only to keep its postings' links (config addedBy 'autofill', 14 §4.1) reads nothing: it is no known source, unless
//   an admin ever turned it on (v36 SOURCES: isLinkKeeper);
// - `forbidden`: the board's company is opted out (companies.do_not_fetch, through its board or domain alias) or the
//   site's domain is on crawl_opt_outs: the candidate is kept `forbidden`, never validated;
// - `added` / `bumped`: the candidate row made now, or seen again.
//
// v30 S2: the board kinds and names moved to boards.ts (re-exported here: job-reviews reads them from this file); the
// known-source lookup is two index lookups (migration 0020: the name in any case, the board its config names) instead
// of a scan of every source of the kind, as every signal now offers boards by the thousand.
//
// v3.0.1 FIX-PERF2 (PG-LOAD PGL-25, docs/design/part2/measurements.md §10.3): a Workday career site's config names its
// site by `careerSite` alone ("External", as many tenants name theirs), so the board lookup by SOURCE_BOARD_SQL found
// every Workday site source for each Workday link (18,067 rows with their config at mix B's size, parsed in JS to keep
// the one whose name matched); the link sweep spent 612 of its 1,093 s on them and fell behind (PGL-18). A Workday site
// is now looked up by its tenant and site (WORKDAY_SITE_KEY_SQL, migration 0038's idx_job_sources_workday_site), and
// offerBoards looks up a whole batch's boards in one statement (sourcesOfBoards), checks the unknown ones' opt-outs in
// one, and adds or bumps their candidates in one: the link sweep's batch of 1,000 rows made up to three round trips a
// board. offerToDiscovery is offerBoards of one board.

export { boardNameOf, candidateName } from './boards';

/** The marker Add job leaves on the disabled source it keeps a board's links under (ingest/liveness.ts ADDED_BY_AUTOFILL). */
const ADDED_BY_ADD_JOB = 'autofill';

/** A board's company alias ('<platform>:<board>'; 'site:<host>' for a career site), or null. */
export function aliasOf(kind: JobSourceKind, name: string): string | null {
  const platform = JOB_SOURCE_KIND_PLATFORM[kind];
  if (!platform) return null;
  return kind === 'career_site' ? siteAlias(name) : boardAlias(platform, name);
}

/**
 * The board a source's config names, in SQL (idx_job_sources_board reads the same expression: 0020, and v30 INT-4's
 * 0028 with S3's keys: a Workday career site's `careerSite` before its `tenant`, a feed's `company`). Not for a Workday
 * career site: its `careerSite` names no board alone (WORKDAY_SITE_KEY_SQL).
 */
export const SOURCE_BOARD_SQL =
  "lower(COALESCE(config->>'token', config->>'site', config->>'board', config->>'account', config->>'careerSite', config->>'company', config->>'tenant', config->>'host'))";

/**
 * v3.0.1 FIX-PERF2 (PGL-25): a Workday career site source's tenant and site, in SQL, as migration 0038's partial index
 * idx_job_sources_workday_site holds them (`WHERE kind = 'workday_site'`; the expressions must stay the same text). The
 * tenant is the config's, else its host's first label (a tenant's own host names it there: adapters/workdaySite.ts
 * refuses a config whose tenant is not that label).
 */
export const WORKDAY_SITE_KEY_SQL = {
  tenant: "lower(COALESCE(config->>'tenant', split_part(config->>'host', '.', 1)))",
  site: "lower(config->>'careerSite')",
} as const;

/** A job_sources row as the board lookups read it. */
export interface BoardSourceRow {
  id: number;
  enabled: boolean;
  name: string;
  config: Record<string, unknown>;
  /** v35 ADMIN: how it was found (`import`: Found by import, switched on only by an admin). */
  discoveredVia?: string | null;
  /** v36 SOURCES: when an admin last turned it on (null: never). */
  enabledAt?: string | null;
}

/** A board to look up: its kind and its name as candidateName keeps it. */
export interface BoardRef {
  kind: JobSourceKind;
  name: string;
}

/** What a board's lookup compares: the board its config names, or a Workday career site's tenant and site. */
function lookupKeyOf(kind: JobSourceKind, name: string): { board: string | null; tenant: string | null; site: string | null } {
  if (kind === 'workday_site') {
    // <host>/<site> (the tenant is the host's first label) or <host>/recruiting/<tenant>/<site> (boards.ts).
    const [host, ...path] = name.split('/');
    const site = path[path.length - 1] ?? '';
    const tenant = path[0] === 'recruiting' && path.length >= 3 ? path[1]! : (host ?? '').split('.')[0]!;
    return { board: null, tenant: tenant.toLowerCase(), site: site.toLowerCase() };
  }
  // A Personio board on the .com host names its tenant in `company` (v30 FIX-A).
  return { board: kind === 'personio' ? name.replace(/\.jobs\.personio\.com$/i, '') : name, tenant: null, site: null };
}

/** A board's key in the maps below (kind and name as kept). */
const refKey = (kind: JobSourceKind, name: string) => `${kind}\n${name}`;

/**
 * Every source of each board, the sources whose name or config names it (Add job's link keepers included), oldest
 * first: one statement for the whole list. Each board finds its sources by three index lookups, at most: its name in
 * any case (idx_job_sources_name_ci), the board its config names (idx_job_sources_board), and for a Workday career site
 * its tenant and site (idx_job_sources_workday_site). The board its config names then decides (boardNameOf), as before.
 */
export async function sourcesOfBoards(t: DbQueries, boards: readonly BoardRef[]): Promise<Map<string, BoardSourceRow[]>> {
  const found = new Map<string, BoardSourceRow[]>();
  if (boards.length === 0) return found;
  const keyed = boards.map((board, i) => ({ i, kind: board.kind, name: board.name, ...lookupKeyOf(board.kind, board.name) }));
  const rows = await t.all<{ i: number; id: number; enabled: boolean; name: string; config: string; discovered_via: string | null; enabled_at: string | null }>(
    `SELECT b.i, s.id, s.enabled, s.name, s.config::text AS config, s.discovered_via, s.enabled_at
     FROM json_to_recordset(CAST(? AS json)) AS b(i integer, kind text, name text, board text, tenant text, site text)
     CROSS JOIN LATERAL (
       SELECT n.id FROM job_sources n WHERE n.kind = b.kind AND lower(n.name) = lower(b.name)
       UNION
       SELECT c.id FROM job_sources c
         WHERE b.board IS NOT NULL AND c.kind = b.kind AND ${SOURCE_BOARD_SQL.replace(/config->>/g, 'c.config->>')} = lower(b.board)
       UNION
       SELECT w.id FROM job_sources w
         WHERE b.site IS NOT NULL AND w.kind = 'workday_site'
           AND ${WORKDAY_SITE_KEY_SQL.tenant.replace(/config->>/g, 'w.config->>')} = b.tenant
           AND ${WORKDAY_SITE_KEY_SQL.site.replace(/config->>/g, 'w.config->>')} = b.site
     ) f
     JOIN job_sources s ON s.id = f.id
     ORDER BY b.i, s.id`,
    [JSON.stringify(keyed)],
  );
  for (const row of rows) {
    const board = boards[row.i]!;
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      config = {};
    }
    // The board its config names decides; a source whose config names none (an older row) is matched by its name.
    const named = boardNameOf(board.kind, config);
    if ((named ?? row.name).toLowerCase() !== board.name.toLowerCase()) continue;
    const key = refKey(board.kind, board.name);
    const list = found.get(key) ?? [];
    list.push({
      id: row.id,
      enabled: row.enabled === true,
      name: row.name,
      config,
      discoveredVia: row.discovered_via ?? null,
      enabledAt: row.enabled_at ?? null, // v36 SOURCES
    });
    found.set(key, list);
  }
  return found;
}

/** Every source of the kind whose name or config names the board, oldest first (Add job's link keepers included). */
export async function sourcesOfBoard(t: DbQueries, kind: JobSourceKind, name: string): Promise<BoardSourceRow[]> {
  return (await sourcesOfBoards(t, [{ kind, name }])).get(refKey(kind, name)) ?? [];
}

/**
 * Whether a source is only Add job's keeper of a board's links (disabled, marked addedBy 'autofill'): it reads nothing.
 * v35 ADMIN (PLAN H6): a source Found by import never is one, whatever its config says: it is the admin's to switch on,
 * so discovery neither offers its board again nor adopts the source (validate.ts sourceForCandidate). v36 SOURCES (SP
 * v36 PLAN S2): nor is a source an admin ever turned on (enabled_at), whatever its config says: an admin's off stays
 * off (discovery adopts only a keeper, and an adopted keeper stays off too: nothing but an admin turns a source on).
 * v36 FIX-SRC (the final data review's D2): nor is a keeper discovery adopted (discovered_via set, any value): a career
 * site's keeps Add job's mark until an admin turns it on (validate.ts), and is the board's source all the same, so its
 * board is a known source, never adopted or offered again.
 */
export const isLinkKeeper = (source: BoardSourceRow) =>
  !source.enabled && source.config.addedBy === ADDED_BY_ADD_JOB && !source.discoveredVia && !source.enabledAt;

/** The source that already reads the board (any but Add job's link keepers), or undefined. */
export async function knownSource(t: DbQueries, kind: JobSourceKind, name: string): Promise<number | undefined> {
  return (await sourcesOfBoard(t, kind, name)).find((source) => !isLinkKeeper(source))?.id;
}

/** The aliases and domains a board's opt-out is looked for under. */
function optOutKeysOf(kind: JobSourceKind, name: string): { aliases: string[]; domains: string[] } {
  const alias = aliasOf(kind, name);
  const domains: string[] = [];
  if (kind === 'career_site') {
    // The host and each parent domain with at least two labels (careers.acme.com: careers.acme.com, acme.com).
    const labels = name.split('.');
    for (let at = 0; at <= labels.length - 2; at += 1) domains.push(labels.slice(at).join('.'));
  }
  return { aliases: alias ? [alias] : [], domains };
}

/** Of `boards`, the indexes of those whose company opted out, or whose career site's domain is on crawl_opt_outs. */
async function optedOutOf(t: DbQueries, boards: readonly BoardRef[]): Promise<Set<number>> {
  if (boards.length === 0) return new Set();
  const keyed = boards.map((board, i) => ({ i, ...optOutKeysOf(board.kind, board.name) }));
  const rows = await t.all<{ i: number }>(
    `SELECT x.i FROM json_to_recordset(CAST(? AS json)) AS x(i integer, aliases json, domains json)
     WHERE EXISTS (SELECT 1 FROM company_aliases a JOIN companies c ON c.id = a.company_id
             WHERE c.do_not_fetch AND ((a.kind = 'board' AND a.value IN (SELECT value FROM json_array_elements_text(x.aliases)))
               OR (a.kind IN ('domain', 'domain_shared') AND a.value IN (SELECT value FROM json_array_elements_text(x.domains)))))
        OR EXISTS (SELECT 1 FROM crawl_opt_outs o WHERE o.domain IN (SELECT value FROM json_array_elements_text(x.domains)))`,
    [JSON.stringify(keyed)],
  );
  return new Set(rows.map((row) => Number(row.i)));
}

/** Whether the board's company opted out, or a career site's domain is on crawl_opt_outs. */
export async function optedOut(t: DbQueries, kind: JobSourceKind, name: string): Promise<boolean> {
  return (await optedOutOf(t, [{ kind, name }])).has(0);
}

/**
 * Adds or bumps each board's candidate (kept `forbidden` when asked) in one statement, in (kind, name) order (the
 * order two batches lock rows in); each one's id and whether it was made now, by its key.
 */
async function upsertCandidates(
  t: DbTx,
  boards: ReadonlyArray<BoardRef & { forbidden: boolean }>,
  via: DiscoveryOfferInput['via'],
  at: string,
): Promise<Map<string, { id: number; added: boolean }>> {
  const out = new Map<string, { id: number; added: boolean }>();
  if (boards.length === 0) return out;
  const rows = await t.all<{ kind: JobSourceKind; name: string; id: number; added: boolean }>(
    `INSERT INTO job_source_candidates(kind, name, discovered_via, seen_count, first_seen_at, last_seen_at, status, next_check_at)
     SELECT x.kind, x.name, CAST(@via AS text), 1, CAST(@at AS timestamptz), CAST(@at AS timestamptz),
       CASE WHEN x.forbidden THEN 'forbidden' ELSE 'new' END, CASE WHEN x.forbidden THEN NULL ELSE CAST(@at AS timestamptz) END
     FROM json_to_recordset(CAST(@boards AS json)) AS x(kind text, name text, forbidden boolean)
     ORDER BY x.kind, x.name
     ON CONFLICT (kind, name) DO UPDATE SET
       seen_count = job_source_candidates.seen_count + 1,
       last_seen_at = GREATEST(job_source_candidates.last_seen_at, excluded.last_seen_at),
       status = CASE WHEN excluded.status = 'forbidden' THEN 'forbidden' ELSE job_source_candidates.status END,
       next_check_at = CASE WHEN excluded.status = 'forbidden' THEN NULL ELSE job_source_candidates.next_check_at END
     RETURNING kind, name, id, (xmax = 0) AS added`,
    { via, at, boards: JSON.stringify(boards.map(({ kind, name, forbidden }) => ({ kind, name, forbidden }))) },
  );
  for (const row of rows) out.set(refKey(row.kind, row.name), { id: Number(row.id), added: row.added === true });
  return out;
}

/**
 * Offers each board to discovery (see the top), in the caller's transaction: one answer per board, in their order. The
 * whole list's known sources are one statement, the unknown boards' opt-outs one, their candidates one: a board named
 * twice is looked up and bumped once (both get its answer).
 */
export async function offerBoards(
  _deps: AppDeps,
  t: DbTx,
  boards: readonly BoardRef[],
  via: DiscoveryOfferInput['via'],
  at: string,
): Promise<DiscoveryOfferResult[]> {
  const names = boards.map((board) => candidateName(board.kind, board.name));
  const distinct = new Map<string, BoardRef>();
  boards.forEach((board, i) => {
    const name = names[i];
    if (name !== null && name !== undefined) distinct.set(refKey(board.kind, name), { kind: board.kind, name });
  });
  const refs = [...distinct.values()];
  const sources = await sourcesOfBoards(t, refs);
  const known = new Map<string, number>();
  for (const ref of refs) {
    const reading = (sources.get(refKey(ref.kind, ref.name)) ?? []).find((source) => !isLinkKeeper(source));
    if (reading) known.set(refKey(ref.kind, ref.name), reading.id);
  }
  const unknown = refs.filter((ref) => !known.has(refKey(ref.kind, ref.name)));
  const opted = await optedOutOf(t, unknown);
  const candidates = await upsertCandidates(
    t,
    unknown.map((ref, i) => ({ ...ref, forbidden: opted.has(i) })),
    via,
    at,
  );
  const forbidden = new Set(unknown.filter((_, i) => opted.has(i)).map((ref) => refKey(ref.kind, ref.name)));
  // A board named twice in one call is one candidate: its first mention says `added`, a later one `bumped`.
  const answered = new Set<string>();
  return boards.map((board, i): DiscoveryOfferResult => {
    const name = names[i];
    if (name === null || name === undefined) return { outcome: 'refused', candidateId: null, sourceId: null };
    const key = refKey(board.kind, name);
    const sourceId = known.get(key);
    if (sourceId !== undefined) return { outcome: 'known_source', candidateId: null, sourceId };
    const candidate = candidates.get(key)!;
    if (forbidden.has(key)) return { outcome: 'forbidden', candidateId: candidate.id, sourceId: null };
    const first = !answered.has(key);
    answered.add(key);
    return { outcome: candidate.added && first ? 'added' : 'bumped', candidateId: candidate.id, sourceId: null };
  });
}

/** Adds a board to job_source_candidates, or bumps it (core/seams.ts OfferToDiscovery; see above). */
export const offerToDiscovery: OfferToDiscovery = async (deps: AppDeps, t: DbTx, input: DiscoveryOfferInput): Promise<DiscoveryOfferResult> =>
  (await offerBoards(deps, t, [{ kind: input.kind, name: input.name }], input.via, input.at))[0]!;

/** The kinds a candidate may have: the board kinds and career sites. */
export const CANDIDATE_KINDS: readonly JobSourceKind[] = [...(Object.keys(BOARD_KINDS) as JobSourceKind[]), 'career_site'];
