import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppDeps } from '../../../core/context';
import { constantsOf } from '../../../core/constants/index';
import { splitStatements } from '../../../core/db/pg/migrate';
import { coverageMarkdown, coverageReport, type CoverageReport } from './coverage';
import { readRefdataFiles, refdataFingerprint, refdataState, REFDATA_NEXT, REFDATA_OLD, REFDATA_SCHEMA, type RefdataFile } from './format';
import { dumpFilesOf, inputsOf, loadGleif, loadSec, loadWikidata, type LoadCounts } from './load';
import { matchCompany, RefdataReader, type MatchResult } from './match';

// v30 E1: the monthly `refdata` build (docs/design/part2/13-company-enrichment.md §3.2, §7, §11 phase 1; 11-database.md
// §5.4). A command of its own, `npm run refdata:build -- --from <folder>` (features/companies/index.ts' commands), never
// the API process: the dumps are large (Wikidata's is 130 GiB and more) and the work takes hours.
//
//   1. take the build's turn (refdata_builds: one `running` row; a row whose heartbeat is older than STALE_MS is a
//      build that died, and is closed as failed);
//   2. a fresh `refdata_next` schema, the schema files run into it (migrations-pg/refdata: the tables);
//   3. the dumps loaded (load.ts), the heartbeat moved after each batch;
//   4. the index files, ANALYZE, the build's facts in `meta` (its id, time, the files' fingerprint, the dumps it read);
//   5. the swap: in one transaction `refdata` becomes `refdata_old` and `refdata_next` becomes `refdata`, so a reader
//      sees the whole old build or the whole new one; `refdata_old` is dropped after;
//   6. every company that may be enriched is matched again (match.ts; unchanged answers write nothing); the companies
//      with the most open jobs that have no strong key get a review for the one item of their name
//      (REFDATA_NAME_REVIEWS_PER_BUILD);
//   7. the coverage report, kept in the build's row and printed.
// A build that fails before the swap leaves `refdata` as it was (its `refdata_next` dropped) and its row `failed`.

/** A running build whose heartbeat is older than this died without a word: the next build takes over. */
export const STALE_MS = 30 * 60_000;
/** Companies read per page of the matching pass. */
const MATCH_PAGE = 500;
/** The least time between two heartbeats (each batch would move it otherwise). */
const HEARTBEAT_MS = 15_000;

type BuildDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Another build is running (its id); nothing was done. */
export class RefdataBuildBusyError extends Error {
  readonly buildId: number;
  constructor(buildId: number) {
    super(`Refdata build ${buildId} is running; one build runs at a time. Wait for it, or for its heartbeat to stop for 30 minutes.`);
    this.name = 'RefdataBuildBusyError';
    this.buildId = buildId;
  }
}

export interface BuildOptions {
  /** The dumps' folder (wikidata/, sec/, gleif/). */
  from: string;
  /** Skip the matching pass (step 6) and the report (`refdata:match` does them later). */
  match?: boolean;
  signal?: AbortSignal;
}

export interface BuildResult {
  buildId: number;
  counts: LoadCounts & Partial<MatchCounts>;
  coverage: CoverageReport | null;
}

export interface MatchCounts {
  companies: number;
  wikidata: number;
  sec: number;
  gleif: number;
  changed: number;
  projected: number;
  reviews: number;
  merges: number;
  failed: number;
}

const iso = (deps: BuildDeps) => deps.now().toISOString();

/** Takes the build's turn: a new `running` row (see step 1). */
export async function startBuild(deps: BuildDeps, format: string): Promise<number> {
  const at = iso(deps);
  try {
    return await deps.db.tx(
      async (t) => {
        const running = await t.one<{ id: number; heartbeat_at: string }>(
          "SELECT id, heartbeat_at FROM refdata_builds WHERE status = 'running' FOR UPDATE",
        );
        if (running) {
          if (deps.now().getTime() - new Date(running.heartbeat_at).getTime() < STALE_MS) throw new RefdataBuildBusyError(running.id);
          await t.run(
            "UPDATE refdata_builds SET status = 'failed', finished_at = ?, error = 'It stopped without finishing (no heartbeat).' WHERE id = ?",
            [at, running.id],
          );
          deps.log.warn(`[refdata] build ${running.id} stopped without finishing; a new build takes over`);
        }
        const row = await t.one<{ id: number }>(
          "INSERT INTO refdata_builds(status, phase, started_at, heartbeat_at, format) VALUES ('running', 'load', ?, ?, ?) RETURNING id",
          [at, at, format],
        );
        return row!.id;
      },
      { label: 'refdata build start' },
    );
  } catch (error) {
    // Two builds starting at once: the unique index lets one row in.
    if ((error as { code?: string }).code === '23505') {
      const running = await deps.db.one<{ id: number }>("SELECT id FROM refdata_builds WHERE status = 'running'");
      throw new RefdataBuildBusyError(running?.id ?? 0);
    }
    throw error;
  }
}

function heartbeat(deps: BuildDeps, buildId: number) {
  let last = 0;
  return async (phase?: string, force = false) => {
    const now = Date.now();
    if (!force && !phase && now - last < HEARTBEAT_MS) return;
    last = now;
    const done = await deps.db.run(
      `UPDATE refdata_builds SET heartbeat_at = ?, phase = COALESCE(?, phase) WHERE id = ? AND status = 'running'`,
      [iso(deps), phase ?? null, buildId],
    );
    if (done.changes === 0) throw new Error(`Refdata build ${buildId} is no longer the running build (another build took over).`);
  };
}

/** Runs a schema file's statements into `refdata_next` (its search_path), in one transaction. */
async function runFile(deps: BuildDeps, file: RefdataFile): Promise<void> {
  await deps.db.tx(
    async (t) => {
      await t.run(`SET LOCAL search_path TO ${REFDATA_NEXT}`);
      for (const statement of splitStatements(file.sql)) await t.run(statement);
    },
    { label: `refdata ${file.name}` },
  );
}

/** Step 5: `refdata_next` in, the old build out, in one transaction. */
export async function swapRefdata(deps: BuildDeps): Promise<void> {
  await deps.db.tx(
    async (t) => {
      await t.run(`DROP SCHEMA IF EXISTS ${REFDATA_OLD} CASCADE`);
      const live = await t.one<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${REFDATA_SCHEMA}') AS found`);
      if (live?.found) await t.run(`ALTER SCHEMA ${REFDATA_SCHEMA} RENAME TO ${REFDATA_OLD}`);
      await t.run(`ALTER SCHEMA ${REFDATA_NEXT} RENAME TO ${REFDATA_SCHEMA}`);
    },
    { label: 'refdata swap' },
  );
  await deps.db.run(`DROP SCHEMA IF EXISTS ${REFDATA_OLD} CASCADE`);
}

/** The companies with the most open jobs and no strong key: the one item of their name becomes a review (step 6). */
async function nameReviewCompanies(deps: BuildDeps): Promise<Set<number>> {
  const limit = constantsOf(deps).get('REFDATA_NAME_REVIEWS_PER_BUILD');
  if (limit <= 0) return new Set();
  const rows = await deps.db.all<{ id: number }>(
    `SELECT c.id FROM companies c
     JOIN LATERAL (SELECT count(*) AS n FROM jobs j WHERE j.company_id = c.id AND j.active /* held_since: counts, an admin's review only */) o ON o.n > 0
     WHERE c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND NOT c.do_not_fetch
       AND NOT EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.kind IN ('wikidata', 'cik', 'lei', 'domain'))
       AND NOT EXISTS (SELECT 1 FROM company_match_reviews r WHERE r.company_id = c.id AND r.kind = 'wikidata' AND r.status = 'rejected')
     ORDER BY o.n DESC, c.id LIMIT ?`,
    [limit],
  );
  return new Set(rows.map((row) => row.id));
}

/** Step 6: matches every company that may be enriched against the refdata in place. */
export async function matchAll(deps: BuildDeps, options: { signal?: AbortSignal; progress?: () => Promise<void> } = {}): Promise<MatchCounts> {
  const counts: MatchCounts = { companies: 0, wikidata: 0, sec: 0, gleif: 0, changed: 0, projected: 0, reviews: 0, merges: 0, failed: 0 };
  const state = await refdataState(deps.db);
  if (!state.ready) return counts;
  const reader = new RefdataReader(deps.db, true);
  const byName = await nameReviewCompanies(deps);
  let after = 0;
  for (;;) {
    const page = await deps.db.all<{ id: number }>(
      `SELECT id FROM companies WHERE id > ? AND owner_user_id IS NULL AND merged_into_id IS NULL AND NOT do_not_fetch ORDER BY id LIMIT ${MATCH_PAGE}`,
      [after],
    );
    if (page.length === 0) break;
    for (const { id } of page) {
      if (options.signal?.aborted) throw new Error('The refdata matching was stopped.');
      after = id;
      let result: MatchResult | null = null;
      try {
        result = await matchCompany(deps, id, { at: iso(deps), reader, byName: byName.has(id) });
      } catch (error) {
        counts.failed += 1;
        deps.log.error(`[refdata] company ${id} was not matched; the next build tries again`, error);
      }
      if (!result) continue;
      counts.companies += 1;
      if (result.wikidata) counts.wikidata += 1;
      if (result.sec) counts.sec += 1;
      if (result.gleif) counts.gleif += 1;
      if (result.changed) counts.changed += 1;
      counts.projected += result.projected;
      counts.reviews += result.reviews.wikidata ?? 0;
      counts.merges += result.reviews.merge ?? 0;
    }
    await options.progress?.();
  }
  return counts;
}

/** The whole build (see the module's note). Throws RefdataBuildBusyError while another build runs. */
export async function buildRefdata(deps: BuildDeps, options: BuildOptions): Promise<BuildResult> {
  const from = resolve(options.from);
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`The refdata folder ${from} does not exist.`);
  const files = dumpFilesOf(from);
  for (const [source, list] of Object.entries(files)) {
    if (list.length === 0) throw new Error(`The refdata folder has no ${source} dump (${resolve(from, source)}).`);
  }
  const schemaFiles = readRefdataFiles();
  const format = refdataFingerprint(schemaFiles);
  const buildId = await startBuild(deps, format);
  const beat = heartbeat(deps, buildId);
  const hooks = { progress: () => beat(), signal: options.signal };
  let swapped = false;
  try {
    await deps.db.run(
      'UPDATE refdata_builds SET inputs = CAST(? AS jsonb) WHERE id = ?',
      [JSON.stringify(inputsOf(files)), buildId],
    );
    deps.log.info(`[refdata] build ${buildId}: loading ${from}`);
    await deps.db.run(`DROP SCHEMA IF EXISTS ${REFDATA_NEXT} CASCADE`);
    await deps.db.run(`CREATE SCHEMA ${REFDATA_NEXT}`);
    for (const file of schemaFiles.filter((item) => !item.afterLoad)) await runFile(deps, file);

    const wikidata = await loadWikidata(deps.db, files.wikidata, hooks);
    const sec = await loadSec(deps.db, files.sec, hooks);
    const gleif = await loadGleif(deps.db, files.gleif, hooks);
    const counts: BuildResult['counts'] = {
      wd_orgs: wikidata.orgs,
      wd_items: wikidata.items,
      wikidata_passes: wikidata.passes,
      sec_filers: sec,
      gleif_entities: gleif.entities,
      gleif_relations: gleif.relations,
    };
    for (const [table, rows] of Object.entries({ wd_orgs: counts.wd_orgs, sec_filers: counts.sec_filers, gleif_entities: counts.gleif_entities })) {
      if (rows === 0) throw new Error(`The dumps gave no ${table} row: the build stops before the swap, and the refdata in place stays.`);
    }

    await beat('index', true);
    for (const file of schemaFiles.filter((item) => item.afterLoad)) await runFile(deps, file);
    for (const table of ['wd_orgs', 'wd_items', 'sec_filers', 'gleif_entities', 'gleif_relations']) await deps.db.run(`ANALYZE ${REFDATA_NEXT}.${table}`);
    const at = iso(deps);
    await deps.db.run(
      `INSERT INTO ${REFDATA_NEXT}.meta(key, value)
       SELECT r.key, r.value FROM jsonb_each(CAST(? AS jsonb)) AS r(key, value)`,
      [JSON.stringify({ build_id: buildId, built_at: at, format, inputs: inputsOf(files), counts })],
    );
    await deps.db.run('UPDATE refdata_builds SET counts = CAST(? AS jsonb) WHERE id = ?', [JSON.stringify(counts), buildId]);

    await beat('swap', true);
    await swapRefdata(deps);
    swapped = true;
    deps.log.info(`[refdata] build ${buildId} is in place: ${counts.wd_orgs} Wikidata organisations, ${counts.sec_filers} SEC filers, ${counts.gleif_entities} GLEIF entities`);

    let coverage: CoverageReport | null = null;
    if (options.match !== false) {
      await beat('match', true);
      const matched = await matchAll(deps, { signal: options.signal, progress: () => beat() });
      Object.assign(counts, matched);
      await beat('report', true);
      coverage = await coverageReport(deps.db, iso(deps));
    }
    await deps.db.run(
      `UPDATE refdata_builds SET status = 'done', finished_at = ?, heartbeat_at = ?, counts = CAST(? AS jsonb), coverage = CAST(? AS jsonb) WHERE id = ?`,
      [iso(deps), iso(deps), JSON.stringify(counts), coverage ? JSON.stringify(coverage) : null, buildId],
    );
    return { buildId, counts, coverage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.db
      .run("UPDATE refdata_builds SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'", [iso(deps), message.slice(0, 2000), buildId])
      .catch(() => undefined);
    if (!swapped) await deps.db.run(`DROP SCHEMA IF EXISTS ${REFDATA_NEXT} CASCADE`).catch(() => undefined);
    throw error;
  }
}

/** The report of the matching alone (after admins' keys or reviews; `refdata:match`). */
export async function rematch(deps: BuildDeps): Promise<{ counts: MatchCounts; coverage: CoverageReport }> {
  const counts = await matchAll(deps);
  return { counts, coverage: await coverageReport(deps.db, iso(deps)) };
}

export { coverageMarkdown };
