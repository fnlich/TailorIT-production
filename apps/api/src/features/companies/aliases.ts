import { JOB_SOURCE_KIND_PLATFORM, boardAlias, parseBoardAlias, siteAlias, type JobSourceKind } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';

// v30 E0-API: the keys that find a company (company_aliases; docs/design/part2/13-company-enrichment.md §5.1,
// 11-database.md §5.4). A strong kind (board, domain, wikidata, cik, lei, uk_company) points at one company only: the
// unique index idx_company_alias_strong, which also makes two writers of one key at once agree (ON CONFLICT).

/** Where each board kind keeps its board in job_sources.config (the adapters' normalised names). */
const BOARD_CONFIG_KEYS: readonly string[] = ['token', 'site', 'board', 'account', 'tenant', 'company'];

/**
 * A job source's board alias ('<platform>:<board>', 'site:<host>'; @tailorit/shared boardAlias): its kind's platform
 * and the board its config names. Null for kinds of many employers (feeds, imports, the lake, pages).
 */
export function boardAliasOfSource(source: { kind: string; config: Record<string, unknown> | null | undefined }): string | null {
  const platform = JOB_SOURCE_KIND_PLATFORM[source.kind as JobSourceKind];
  if (!platform) return null;
  const config = source.config ?? {};
  if (platform === 'site') return typeof config.host === 'string' ? siteAlias(config.host) : null;
  for (const key of BOARD_CONFIG_KEYS) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return boardAlias(platform, value.trim().toLowerCase());
  }
  return null;
}

/** Every config key that may name a source's board (ingest's discovery reads the same keys, in its own order). */
const ANY_BOARD_KEYS: readonly string[] = ['token', 'site', 'board', 'account', 'careerSite', 'company', 'tenant', 'host'];

/**
 * v30 FIX-C SEC-2: the job sources of a company's boards (its `board` aliases), whatever their company_id says: a
 * source of the board's platform whose name or any board key of its config names the board (an opt-out errs on the
 * side of more: discovery validates a board, and its source keeps company_id NULL until a posting of it resolves). An
 * admin's rare action reads it (opt-out, merge): it may scan the kinds' sources.
 */
export async function boardSourceIdsOf(t: DbQueries, companyId: number): Promise<number[]> {
  const aliases = await t.all<{ value: string }>("SELECT value FROM company_aliases WHERE company_id = ? AND kind = 'board'", [companyId]);
  const ids = new Set<number>();
  for (const alias of aliases) {
    const parsed = parseBoardAlias(alias.value);
    if (!parsed) continue;
    const kinds = Object.entries(JOB_SOURCE_KIND_PLATFORM)
      .filter(([, platform]) => platform === parsed.platform)
      .map(([kind]) => kind);
    if (kinds.length === 0) continue;
    const board = parsed.board.toLowerCase();
    const rows = await t.all<{ id: number }>(
      `SELECT id FROM job_sources WHERE kind IN (${t.dialect.list(kinds.length)})
         AND (lower(name) = ? OR ${ANY_BOARD_KEYS.map((key) => `lower(config->>'${key}') = ?`).join(' OR ')})`,
      [...kinds, board, ...ANY_BOARD_KEYS.map(() => board)],
    );
    for (const row of rows) ids.add(Number(row.id));
  }
  return [...ids].sort((a, b) => a - b);
}

/** The company a strong key points at (followed through merges), with its opt-out; undefined when none does. */
export async function companyOfAlias(
  t: DbQueries,
  kind: string,
  value: string,
): Promise<{ id: number; doNotFetch: boolean } | undefined> {
  const row = await t.one<{ company_id: number }>('SELECT company_id FROM company_aliases WHERE kind = ? AND value = ? ORDER BY company_id LIMIT 1', [
    kind,
    value,
  ]);
  return row ? survivorOf(t, row.company_id) : undefined;
}

/** The row a company was merged into, at the end of the chain (itself when not merged). */
export async function survivorOf(t: DbQueries, companyId: number): Promise<{ id: number; doNotFetch: boolean } | undefined> {
  let id = companyId;
  for (let hops = 0; hops < 10; hops += 1) {
    const row = await t.one<{ merged_into_id: number | null; do_not_fetch: boolean }>(
      'SELECT merged_into_id, do_not_fetch FROM companies WHERE id = ?',
      [id],
    );
    if (!row) return undefined;
    if (row.merged_into_id === null) return { id, doNotFetch: row.do_not_fetch };
    id = row.merged_into_id;
  }
  return undefined;
}

/**
 * Adds a key to a company; answers false when a strong key is already another company's (or the key is already
 * there). Two writers of one strong key at once: the second waits for the first and then answers false.
 */
export async function addAlias(
  t: DbQueries,
  companyId: number,
  kind: string,
  value: string,
  confidence: number,
  at: string,
  options: { sourceId?: number | null; primary?: boolean } = {},
): Promise<boolean> {
  const row = await t.one<{ company_id: number }>(
    `INSERT INTO company_aliases(kind, value, company_id, source_id, confidence, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING company_id`,
    [kind, value, companyId, options.sourceId ?? null, Math.max(0, Math.min(100, Math.round(confidence))), options.primary ?? false, at],
  );
  return row !== undefined;
}
