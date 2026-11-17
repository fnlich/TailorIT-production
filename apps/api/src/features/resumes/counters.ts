import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import type { DailyStep } from '../../core/feature';

// v30 DB-JOBS (D1d; docs/design/part2/11-database.md §5.7, §6 Q10): the stored resume count. `user_counters` holds one
// row per account that ever had a resume: a count per made_by (upload, editor, copy, tailor) and their total. The
// baseline's triggers on `resumes` keep it in the writer's own transaction (count_resumes: an insert adds one, a delete
// takes one, a change of made_by moves one), so the limit check is one primary-key read instead of count(*) over the
// account's resumes (up to 5,040 for the heaviest account, 11 §4.3). The same row is the person's lock
// (DbClient.lockPerson takes it FOR UPDATE): a limit check behind it sees every committed resume.
//
// The nightly recount (`recountResumes`, a Feature.daily step) compares each account's row with count(*) and repairs a
// row that drifted (a write that bypassed the triggers, say), each repair behind the person's lock, so a resume made
// meanwhile is neither lost nor counted twice.

/** The stored count of the account's resumes, of every kind (0 when it never had one: no row yet). */
export async function resumeCount(db: DbQueries, userId: string): Promise<number> {
  return (await db.one<{ n: number }>('SELECT resumes_total AS n FROM user_counters WHERE user_id = ?', [userId]))?.n ?? 0;
}

/** An account's counts by made_by, as stored or as counted. */
export interface ResumeCounts {
  upload: number;
  editor: number;
  copy: number;
  tailor: number;
}

const COUNTED_COLUMNS = `count(*) FILTER (WHERE r.made_by = 'upload') AS upload,
         count(*) FILTER (WHERE r.made_by = 'editor') AS editor,
         count(*) FILTER (WHERE r.made_by = 'copy') AS copy,
         count(*) FILTER (WHERE r.made_by = 'tailor') AS tailor`;

/** What count(*) says of one account's resumes now. */
export async function countedResumes(db: DbQueries, userId: string): Promise<ResumeCounts> {
  const row = await db.one<ResumeCounts>(`SELECT ${COUNTED_COLUMNS} FROM resumes r WHERE r.user_id = ?`, [userId]);
  return row ?? { upload: 0, editor: 0, copy: 0, tailor: 0 };
}

/** The accounts the recount reads at once (a keyset page of users). */
export const RECOUNT_BATCH = 1000;

interface RecountRow extends ResumeCounts {
  id: string;
  /** Null: the account has no user_counters row. */
  s_upload: number | null;
  s_editor: number | null;
  s_copy: number | null;
  s_tailor: number | null;
}

/** One page of accounts with their stored and counted numbers (users by id; the counts through idx_resumes_made_by). */
const RECOUNT_PAGE = `SELECT u.id, c.resumes_upload AS s_upload, c.resumes_editor AS s_editor, c.resumes_copy AS s_copy,
         c.resumes_tailor AS s_tailor, n.upload, n.editor, n.copy, n.tailor
       FROM users u
       LEFT JOIN user_counters c ON c.user_id = u.id
       CROSS JOIN LATERAL (SELECT ${COUNTED_COLUMNS} FROM resumes r WHERE r.user_id = u.id) n
       WHERE u.id > ? ORDER BY u.id LIMIT ?`;

const KINDS = ['upload', 'editor', 'copy', 'tailor'] as const;

/** Whether the stored row disagrees with the count (no row agrees with no resumes). */
function drifted(row: RecountRow): boolean {
  if (row.s_upload === null) return KINDS.some((kind) => row[kind] > 0);
  return KINDS.some((kind) => row[`s_${kind}`] !== row[kind]);
}

/**
 * Repairs one account's row behind its lock: counted again inside the transaction (a resume committed since the page
 * was read is in it, and one being written waits for the lock), written only when it still differs. Answers whether
 * it wrote.
 */
export async function repairResumeCounts(deps: Pick<AppDeps, 'db'>, userId: string): Promise<boolean> {
  return deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const counted = await countedResumes(t, userId);
      const result = await t.run(
        `UPDATE user_counters SET resumes_upload = ?, resumes_editor = ?, resumes_copy = ?, resumes_tailor = ?, updated_at = now()
          WHERE user_id = ? AND (resumes_upload, resumes_editor, resumes_copy, resumes_tailor)
            IS DISTINCT FROM (CAST(? AS integer), CAST(? AS integer), CAST(? AS integer), CAST(? AS integer))`,
        [counted.upload, counted.editor, counted.copy, counted.tailor, userId, counted.upload, counted.editor, counted.copy, counted.tailor],
      );
      return result.changes > 0;
    },
    { label: 'repairResumeCounts' },
  );
}

/** Every account's stored counts against count(*), a page at a time; answers how many rows it repaired. */
export async function recountAllResumes(deps: Pick<AppDeps, 'db' | 'log'>, batch = RECOUNT_BATCH): Promise<number> {
  let after = '';
  let repaired = 0;
  for (;;) {
    const page = await deps.db.all<RecountRow>(RECOUNT_PAGE, [after, batch]);
    for (const row of page) {
      if (!drifted(row)) continue;
      if (await repairResumeCounts(deps, row.id)) {
        repaired += 1;
        deps.log.warn(`[resumes] the stored resume count of account ${row.id} had drifted; recounted`);
      }
    }
    if (page.length < batch) return repaired;
    after = page[page.length - 1]!.id;
  }
}

/** resumesFeature.daily: the nightly recount (11 §5.7). */
export const recountResumes: DailyStep = {
  name: 'resumeCounts',
  run: (deps) => recountAllResumes(deps),
};
