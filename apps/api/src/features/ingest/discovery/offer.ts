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
//   only to keep its postings' links (config addedBy 'autofill', 14 §4.1) reads nothing: it is no known source;
// - `forbidden`: the board's company is opted out (companies.do_not_fetch, through its board or domain alias) or the
//   site's domain is on crawl_opt_outs: the candidate is kept `forbidden`, never validated;
// - `added` / `bumped`: the candidate row made now, or seen again.
//
// v30 S2: the board kinds and names moved to boards.ts (re-exported here: job-reviews reads them from this file); the
// known-source lookup is two index lookups (migration 0020: the name in any case, the board its config names) instead
// of a scan of every source of the kind, as every signal now offers boards by the thousand.

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
 * 0028 with S3's keys: a Workday career site's `careerSite` before its `tenant`, a feed's `company`).
 */
export const SOURCE_BOARD_SQL =
  "lower(COALESCE(config->>'token', config->>'site', config->>'board', config->>'account', config->>'careerSite', config->>'company', config->>'tenant', config->>'host'))";

/** A job_sources row as the board lookups read it. */
export interface BoardSourceRow {
  id: number;
  enabled: boolean;
  name: string;
  config: Record<string, unknown>;
}

/** Every source of the kind whose name or config names the board, oldest first (Add job's link keepers included). */
export async function sourcesOfBoard(t: DbQueries, kind: JobSourceKind, name: string): Promise<BoardSourceRow[]> {
  const rows = await t.all<{ id: number; enabled: boolean; name: string; config: string }>(
    `SELECT id, enabled, name, config::text AS config FROM job_sources
     WHERE kind = @kind AND (lower(name) = lower(@name) OR ${SOURCE_BOARD_SQL} = lower(@board)) ORDER BY id`,
    // A Workday career site's config names its site first: its name, or its site's, finds it. A Personio board on the
    // .com host names its tenant in `company` (v30 FIX-A).
    {
      kind,
      name,
      board: kind === 'workday_site' ? name.slice(name.lastIndexOf('/') + 1) : kind === 'personio' ? name.replace(/\.jobs\.personio\.com$/i, '') : name,
    },
  );
  const found: BoardSourceRow[] = [];
  for (const row of rows) {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      config = {};
    }
    // The board its config names decides; a source whose config names none (an older row) is matched by its name.
    const named = boardNameOf(kind, config);
    if ((named ?? row.name).toLowerCase() === name.toLowerCase()) {
      found.push({ id: row.id, enabled: row.enabled === true, name: row.name, config });
    }
  }
  return found;
}

/** Whether a source is only Add job's keeper of a board's links (disabled, marked addedBy 'autofill'): it reads nothing. */
export const isLinkKeeper = (source: BoardSourceRow) => !source.enabled && source.config.addedBy === ADDED_BY_ADD_JOB;

/** The source that already reads the board (any but Add job's link keepers), or undefined. */
export async function knownSource(t: DbQueries, kind: JobSourceKind, name: string): Promise<number | undefined> {
  return (await sourcesOfBoard(t, kind, name)).find((source) => !isLinkKeeper(source))?.id;
}

/** Whether the board's company opted out, or a career site's domain is on crawl_opt_outs. */
export async function optedOut(t: DbQueries, kind: JobSourceKind, name: string): Promise<boolean> {
  const alias = aliasOf(kind, name);
  const aliases = alias ? [alias] : [];
  const domains: string[] = [];
  if (kind === 'career_site') {
    // The host and each parent domain with at least two labels (careers.acme.com: careers.acme.com, acme.com).
    const labels = name.split('.');
    for (let at = 0; at <= labels.length - 2; at += 1) domains.push(labels.slice(at).join('.'));
  }
  const row = await t.one<{ opted: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM company_aliases a JOIN companies c ON c.id = a.company_id
               WHERE c.do_not_fetch AND ((a.kind = 'board' AND a.value IN (SELECT value FROM ${t.dialect.jsonEach('?')}))
                 OR (a.kind IN ('domain', 'domain_shared') AND a.value IN (SELECT value FROM ${t.dialect.jsonEach('?')}))))
             OR EXISTS (SELECT 1 FROM crawl_opt_outs o WHERE o.domain IN (SELECT value FROM ${t.dialect.jsonEach('?')}))) AS opted`,
    [JSON.stringify(aliases), JSON.stringify(domains), JSON.stringify(domains)],
  );
  return row?.opted === true;
}

/** Adds or bumps the candidate (kept `forbidden` when asked); its id and whether it was made now. */
async function upsertCandidate(
  t: DbTx,
  input: DiscoveryOfferInput,
  name: string,
  forbidden: boolean,
): Promise<{ id: number; added: boolean }> {
  const row = await t.one<{ id: number; added: boolean }>(
    `INSERT INTO job_source_candidates(kind, name, discovered_via, seen_count, first_seen_at, last_seen_at, status, next_check_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (kind, name) DO UPDATE SET
       seen_count = job_source_candidates.seen_count + 1,
       last_seen_at = GREATEST(job_source_candidates.last_seen_at, excluded.last_seen_at),
       status = CASE WHEN excluded.status = 'forbidden' THEN 'forbidden' ELSE job_source_candidates.status END,
       next_check_at = CASE WHEN excluded.status = 'forbidden' THEN NULL ELSE job_source_candidates.next_check_at END
     RETURNING id, (xmax = 0) AS added`,
    [input.kind, name, input.via, input.at, input.at, forbidden ? 'forbidden' : 'new', forbidden ? null : input.at],
  );
  return { id: row!.id, added: row!.added === true };
}

/** Adds a board to job_source_candidates, or bumps it (core/seams.ts OfferToDiscovery; see above). */
export const offerToDiscovery: OfferToDiscovery = async (_deps: AppDeps, t: DbTx, input: DiscoveryOfferInput): Promise<DiscoveryOfferResult> => {
  const name = candidateName(input.kind, input.name);
  if (name === null) return { outcome: 'refused', candidateId: null, sourceId: null };
  const sourceId = await knownSource(t, input.kind, name);
  if (sourceId !== undefined) return { outcome: 'known_source', candidateId: null, sourceId };
  if (await optedOut(t, input.kind, name)) {
    const { id } = await upsertCandidate(t, input, name, true);
    return { outcome: 'forbidden', candidateId: id, sourceId: null };
  }
  const { id, added } = await upsertCandidate(t, input, name, false);
  return { outcome: added ? 'added' : 'bumped', candidateId: id, sourceId: null };
};

/** The kinds a candidate may have: the board kinds and career sites. */
export const CANDIDATE_KINDS: readonly JobSourceKind[] = [...(Object.keys(BOARD_KINDS) as JobSourceKind[]), 'career_site'];
