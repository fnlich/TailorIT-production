import { JOB_SOURCE_KIND_PLATFORM } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';

// v30 FIX-A (REV-SEC SEC-2, REV-BEH BEH-3; 11-database.md §5.4 "The opt-out", 12 §8.5, 13 §4 rule 6): a company's
// opt-out (companies.do_not_fetch) is a gate on its sources, not only the one-time disable setOptOut makes. A source is
// opted out when:
//   - its company (or the company that one was merged into) opts out, or
//   - its board's alias ('<platform>:<board>', 'site:<host>') names a company that opts out: a source whose company_id
//     is still empty (a validated board not run yet, an empty board) is caught by its board, or
//   - (a career site) its host, or a domain above it, is on crawl_opt_outs.
// The due queue never takes such a source (scheduler.ts dueSources), a run refuses it (service.ts run: Run now, the
// worker, an import), turning it on refuses (PATCH enabled: 409) and the bulk actions skip it (enable, run now).
//
// The board alias in SQL is boardAliasOfSource's (features/companies/aliases.ts): the first config key of
// SOURCE_BOARD_KEYS that holds a value, trimmed and in lower case; a career site's host. ingest-fixa-gate.test.ts holds
// the two to the same answer for every board kind.

/** The config keys a board kind keeps its board under, in boardAliasOfSource's order. */
export const SOURCE_BOARD_KEYS: readonly string[] = ['token', 'site', 'board', 'account', 'tenant', 'company'];

/** SQL: the board alias of the job_sources row `s` (NULL for a kind of many employers). */
export function sourceBoardAliasSql(s = 's'): string {
  const platforms = Object.entries(JOB_SOURCE_KIND_PLATFORM)
    .filter(([kind]) => kind !== 'career_site')
    .map(([kind, platform]) => `WHEN '${kind}' THEN '${platform}'`)
    .join(' ');
  const board = `COALESCE(${SOURCE_BOARD_KEYS.map((key) => `NULLIF(btrim(${s}.config->>'${key}'), '')`).join(', ')})`;
  return `(CASE WHEN ${s}.kind = 'career_site' THEN 'site:' || NULLIF(rtrim(lower(btrim(${s}.config->>'host')), '.'), '')
    ELSE (CASE ${s}.kind ${platforms} END) || ':' || lower(${board}) END)`;
}

/** SQL: whether the job_sources row `s` belongs to a company that opted out (see the top). */
export function optedOutSourceSql(s = 's'): string {
  return `(EXISTS (SELECT 1 FROM companies oc WHERE oc.id = ${s}.company_id
            AND (oc.do_not_fetch OR EXISTS (SELECT 1 FROM companies om WHERE om.id = oc.merged_into_id AND om.do_not_fetch)))
       OR EXISTS (SELECT 1 FROM company_aliases oa JOIN companies oc ON oc.id = oa.company_id
            WHERE oa.kind = 'board' AND oa.value = ${sourceBoardAliasSql(s)} AND oc.do_not_fetch)
       OR (${s}.kind = 'career_site' AND EXISTS (SELECT 1 FROM crawl_opt_outs oo
            WHERE lower(rtrim(btrim(${s}.config->>'host'), '.')) = oo.domain
               OR lower(rtrim(btrim(${s}.config->>'host'), '.')) LIKE '%.' || oo.domain)))`;
}

/** The ids among `ids` whose sources are opted out. */
export async function optedOutSources(db: DbQueries, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db.all<{ id: number }>(
    `SELECT s.id FROM job_sources s WHERE s.id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND ${optedOutSourceSql('s')}`,
    [ids.join(',')],
  );
  return new Set(rows.map((row) => row.id));
}

/** Whether one source is opted out. */
export async function sourceOptedOut(db: DbQueries, id: number): Promise<boolean> {
  return (await optedOutSources(db, [id])).has(id);
}
