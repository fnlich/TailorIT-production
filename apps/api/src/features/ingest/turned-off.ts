import type { AdminSourcesTurnedOff, AdminSourceTurnedOffPart } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';

// v36 SOURCES (SP v36 PLAN S7): v3.6's one-time notice. Migration 0060 turned off every source that v3.5's discovery had
// switched on without an admin, and wrote their ids into app_settings' TURNED_OFF_KEY ({"at", "untouched": [ids],
// "changed": [ids]}: untouched since found, or changed since, maybe by an admin). Admin › Sources shows it, with a filter
// for them (AdminSourcesFilter `turnedOff`: sources.ts sourcesWhere) and Enable all, until an admin dismisses it
// ({"dismissedAt"} added; who dismissed it is app_settings.updated_by, which a deleted account sets null). No notice
// exists on a server 0060 turned nothing off.
// v36 FIX-SRC (coordinator decision D6, the final data review's owner item 2): a board an admin added from Admin ›
// Candidates › Add boards (its source's discovered_via `admin`) is told apart, whichever list 0060 put it in: the part
// `candidates` ("Added from Candidates"), left out of `untouched` and `changed`.

/** app_settings' key of the notice (migration 0060 writes it). */
export const TURNED_OFF_KEY = 'ingest:v36-turned-off';

/** The notice's two lists of source ids. */
const LISTS = ['untouched', 'changed'] as const;

/** v36 FIX-SRC (D6): the way a board an admin added from Admin › Candidates was found (its source's discovered_via). */
const FROM_CANDIDATES_SQL = "s.discovered_via = 'admin'";

/**
 * SQL: the job_sources row `s` is one of the notice's (both lists for `all`), dismissed or not: `untouched` and `changed`
 * that list's sources but those an admin added from Candidates, `candidates` those (from either list). The parts are a
 * closed list, written into the text; a missing notice or list matches nothing.
 */
export function turnedOffSql(part: AdminSourceTurnedOffPart): string {
  const lists = (part === 'all' || part === 'candidates' ? LISTS : [part])
    .map((list) => `SELECT json_array_elements_text(a.value -> '${list}') AS id FROM app_settings a WHERE a.key = '${TURNED_OFF_KEY}'`)
    .join(' UNION ALL ');
  const listed = `s.id IN (SELECT CAST(t.id AS bigint) FROM (${lists}) t)`;
  if (part === 'all') return listed;
  return part === 'candidates' ? `(${listed} AND ${FROM_CANDIDATES_SQL})` : `(${listed} AND s.discovered_via IS DISTINCT FROM 'admin')`;
}

/** GET /api/admin/sources/turned-off: the notice's counts, or null once dismissed (or when there is none). */
export async function turnedOffNotice(db: DbQueries): Promise<AdminSourcesTurnedOff> {
  const row = await db.one<{ at: string | null; dismissed: boolean }>(
    "SELECT value ->> 'at' AS at, (value ->> 'dismissedAt') IS NOT NULL AS dismissed FROM app_settings WHERE key = ?",
    [TURNED_OFF_KEY],
  );
  if (!row || row.dismissed || !row.at) return { notice: null };
  const count = async (part: Exclude<AdminSourceTurnedOffPart, 'all'>) =>
    (await db.one<{ total: number; off: number }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE NOT s.enabled) AS off FROM job_sources s WHERE ${turnedOffSql(part)}`,
    )) ?? { total: 0, off: 0 };
  const untouched = await count('untouched');
  const changed = await count('changed');
  const candidates = await count('candidates');
  return {
    notice: {
      at: new Date(row.at).toISOString(),
      untouched: Number(untouched.total),
      changed: Number(changed.total),
      untouchedOff: Number(untouched.off),
      changedOff: Number(changed.off),
      candidates: Number(candidates.total),
      candidatesOff: Number(candidates.off),
    },
  };
}

/** POST /api/admin/sources/turned-off/dismiss: the notice goes for every admin (its lists stay, for the filter). */
export async function dismissTurnedOff(db: DbQueries, adminId: string, now: string): Promise<AdminSourcesTurnedOff> {
  await db.run(
    `UPDATE app_settings SET value = CAST(jsonb_set(CAST(value AS jsonb), '{dismissedAt}', to_jsonb(CAST(? AS text))) AS json),
       updated_at = CAST(? AS timestamptz), updated_by = ?
     WHERE key = ? AND (value ->> 'dismissedAt') IS NULL`,
    [now, now, adminId, TURNED_OFF_KEY],
  );
  return { notice: null };
}
