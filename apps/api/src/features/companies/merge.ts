import type { DbQueries } from '../../core/db/types';
import { stableJson } from './profile';

// v30 E0-API: moving what points at one company row to another (docs/design/part2/13-company-enrichment.md §5.5,
// 11-database.md §5.4 "Merges"), in the caller's transaction:
// - mergeOwnRows: an account's own rows of a name (made for its page jobs while the lake had no company of that name)
//   give way to the shared row, as v2.0's ingest store did (mergeOwnCompanies);
// - mergeCompanies: an admin's merge (or an accepted match review): the other row keeps merged_into_id, so old links
//   and MCP answers still find the survivor;
// - moveSourcesToNew (split): chosen boards and their jobs to a new company.
// Each answers the jobs it moved: their search rows name the company, so the caller re-projects them in the same
// transaction (projectJobs).

/** The jobs, tracker entries, sources and hidden marks of one company row moved to another; answers the jobs moved. */
async function moveReferences(t: DbQueries, fromId: number, toId: number): Promise<number[]> {
  const moved = await t.all<{ id: number }>('UPDATE jobs SET company_id = ? WHERE company_id = ? RETURNING id', [toId, fromId]);
  await t.run('UPDATE applications SET company_id = ? WHERE company_id = ?', [toId, fromId]);
  await t.run('UPDATE job_sources SET company_id = ? WHERE company_id = ?', [toId, fromId]);
  // A person who hid either hides the survivor: one mark each.
  await t.run(
    'DELETE FROM user_hidden_companies WHERE company_id = ? AND user_id IN (SELECT user_id FROM user_hidden_companies WHERE company_id = ?)',
    [fromId, toId],
  );
  await t.run('UPDATE user_hidden_companies SET company_id = ? WHERE company_id = ?', [toId, fromId]);
  return moved.map((row) => row.id);
}

/**
 * Every account's own row of a name ("page:<owner>:<key>") gives way to the shared row `sharedId`: its jobs, tracker
 * entries, sources and hidden marks move, and the own row goes. Answers the jobs moved.
 */
export async function mergeOwnRows(t: DbQueries, sharedId: number, nameKey: string): Promise<number[]> {
  if (!nameKey) return [];
  const own = await t.all<{ id: number }>(
    "SELECT id FROM companies WHERE owner_user_id IS NOT NULL AND name_key = 'page:' || owner_user_id || ':' || ?",
    [nameKey],
  );
  const moved: number[] = [];
  for (const { id } of own) {
    moved.push(...(await moveReferences(t, id, sharedId)));
    await t.run('DELETE FROM companies WHERE id = ?', [id]);
  }
  return moved;
}

/**
 * Merges company `otherId` into `survivorId`: jobs, tracker entries, job sources, hidden marks, sources (an admin's
 * values joined, the survivor's winning), aliases, relations, match reviews and opt-out rows move; the other row keeps
 * merged_into_id (and so does every row merged into it before); an opted-out company keeps its opt-out on the
 * survivor. Answers the jobs moved. The caller recomputes the survivor's profile and recounts both rows.
 */
export async function mergeCompanies(t: DbQueries, survivorId: number, otherId: number, at: string): Promise<number[]> {
  const moved = await moveReferences(t, otherId, survivorId);

  // The admin rows: one per company, the survivor's values winning.
  const admins = await t.all<{ company_id: number; fields: string }>(
    "SELECT company_id, fields FROM company_sources WHERE kind = 'admin' AND ref = '' AND company_id IN (?, ?)",
    [survivorId, otherId],
  );
  const survivorAdmin = admins.find((row) => row.company_id === survivorId);
  const otherAdmin = admins.find((row) => row.company_id === otherId);
  if (otherAdmin && survivorAdmin) {
    const joined = { ...(JSON.parse(otherAdmin.fields) as object), ...(JSON.parse(survivorAdmin.fields) as object) };
    await t.run(
      "UPDATE company_sources SET fields = CAST(? AS jsonb), content_hash = NULL, retrieved_at = ? WHERE company_id = ? AND kind = 'admin' AND ref = ''",
      [stableJson(joined), at, survivorId],
    );
  }
  // Sources: a kind and ref the survivor has stays the survivor's.
  await t.run(
    `UPDATE company_sources s SET company_id = ? WHERE s.company_id = ?
       AND NOT EXISTS (SELECT 1 FROM company_sources o WHERE o.company_id = ? AND o.kind = s.kind AND o.ref = s.ref)`,
    [survivorId, otherId, survivorId],
  );
  await t.run('DELETE FROM company_sources WHERE company_id = ?', [otherId]);
  // The other's keys move as secondary ones: the survivor's primary board keeps naming it.
  await t.run(
    `UPDATE company_aliases a SET company_id = ?, is_primary = false WHERE a.company_id = ?
       AND NOT EXISTS (SELECT 1 FROM company_aliases o WHERE o.company_id = ? AND o.kind = a.kind AND o.value = a.value)`,
    [survivorId, otherId, survivorId],
  );
  await t.run('DELETE FROM company_aliases WHERE company_id = ?', [otherId]);
  // Relations: kept apart, never merged (13 §5.4); one that would point at itself or repeat another goes.
  for (const [mine, theirs] of [
    ['parent_id', 'child_id'],
    ['child_id', 'parent_id'],
  ] as const) {
    await t.run(
      `DELETE FROM company_relations r WHERE r.${mine} = ? AND (r.${theirs} = ?
         OR EXISTS (SELECT 1 FROM company_relations o WHERE o.${mine} = ? AND o.${theirs} = r.${theirs}))`,
      [otherId, survivorId, survivorId],
    );
    await t.run(`UPDATE company_relations SET ${mine} = ? WHERE ${mine} = ?`, [survivorId, otherId]);
  }
  // Reviews about the pair are settled by the merge; the others follow the survivor.
  await t.run(
    `UPDATE company_match_reviews SET status = 'accepted', decided_at = ? WHERE status = 'open'
       AND ((company_id = ? AND other_company_id = ?) OR (company_id = ? AND other_company_id = ?))`,
    [at, survivorId, otherId, otherId, survivorId],
  );
  await t.run('UPDATE company_match_reviews SET company_id = ? WHERE company_id = ? AND other_company_id IS DISTINCT FROM ?', [
    survivorId,
    otherId,
    survivorId,
  ]);
  await t.run('UPDATE company_match_reviews SET other_company_id = ? WHERE other_company_id = ? AND company_id <> ?', [survivorId, otherId, survivorId]);
  await t.run('UPDATE crawl_opt_outs SET company_id = ? WHERE company_id = ?', [survivorId, otherId]);
  await t.run('DELETE FROM company_enrichment_queue WHERE company_id = ?', [otherId]);
  const other = await t.one<{ do_not_fetch: boolean }>('SELECT do_not_fetch FROM companies WHERE id = ?', [otherId]);
  if (other?.do_not_fetch) await t.run('UPDATE companies SET do_not_fetch = true, updated_at = ? WHERE id = ?', [at, survivorId]);
  await t.run('UPDATE companies SET merged_into_id = ?, updated_at = ? WHERE id = ? OR merged_into_id = ?', [survivorId, at, otherId, otherId]);
  return moved;
}

/**
 * Split: the chosen job sources of company `fromId`, with their jobs (those every live link of which is one of them)
 * and those jobs' tracker entries, move to company `toId` (the caller moves the board aliases). Answers the jobs moved.
 */
export async function moveSources(t: DbQueries, fromId: number, toId: number, sourceIds: readonly number[]): Promise<number[]> {
  if (sourceIds.length === 0) return [];
  const list = t.dialect.list(sourceIds.length);
  const sources = await t.all<{ id: number; kind: string; name: string }>(
    `UPDATE job_sources SET company_id = ? WHERE company_id = ? AND id IN (${list}) RETURNING id, kind, name`,
    [toId, fromId, ...sourceIds],
  );
  if (sources.length === 0) return [];
  const ids = sources.map((source) => source.id);
  const idList = t.dialect.list(ids.length);
  // A job moves when every link it has is one of the moved sources' (a job other boards list stays).
  const moved = await t.all<{ id: number }>(
    `UPDATE jobs j SET company_id = ? WHERE j.company_id = ?
       AND EXISTS (SELECT 1 FROM job_source_links l WHERE l.job_id = j.id AND l.source_id IN (${idList}))
       AND NOT EXISTS (SELECT 1 FROM job_source_links l WHERE l.job_id = j.id AND l.source_id NOT IN (${idList}))
     RETURNING j.id`,
    [toId, fromId, ...ids, ...ids],
  );
  // v30 FIX-C BEH-11: the tracker entries of the moved jobs follow them (Saved, Tracker, Queue and Prepare read the
  // company through applications.company_id), as a merge's moveReferences moves them.
  const jobIds = moved.map((row) => row.id);
  if (jobIds.length > 0) {
    await t.run(`UPDATE applications SET company_id = ? WHERE company_id = ? AND job_id IN (${t.dialect.list(jobIds.length)})`, [toId, fromId, ...jobIds]);
  }
  return jobIds;
}
