import { NEW_CATEGORY_IDS_V33, OTHER_CATEGORY_ID, TITLE_RULES_VERSION, categorizeTitle } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';
import { projectJobs } from '../jobs/search-projection/project';

// v33 ROLES (F3): the one-time, rule-based re-categorization of the jobs stored before v3.3's categories. Each job's
// title is read again by `categorizeTitle`, and its category is rewritten when
//   - it had none, or `other`, and the title now names one; or
//   - the title now names one of v3.3's new parents (NEW_CATEGORY_IDS_V33): v3.2 filed a security guard under Security,
//     a data entry clerk under Data & Analytics and a retail sales associate under Sales, having nowhere else.
// Every other job keeps its category (a source's own field, or Claude's). The job's search row is rewritten in the same
// transaction (projectJobs). No AI.
//
// It runs in batches of PASS_BATCH jobs by id, a transaction each; it is idempotent, so a pass cut short runs again
// whole at the next daily pass. Done, it writes app_settings `v33:role-categories:<TITLE_RULES_VERSION>` and never
// runs again for those rules.
// v33 FIX-2 (final review, security 3): a database with no job (a new install, v3.3's fresh start) has nothing stored
// before these rules, so it writes the mark at once ({moved: 0}): otherwise the first pass after the sources come back
// would rewrite the categories v3.3's own ingest kept from a source, and only for the jobs that came before it (the same
// posting in two categories by when it arrived).

export const RECATEGORIZE_MARK = `v33:role-categories:${TITLE_RULES_VERSION}`;
const PASS_BATCH = 1000;
const NEW_PARENTS = new Set<string>(NEW_CATEGORY_IDS_V33);

interface JobCategoryRow {
  id: number;
  title: string;
  category_id: string | null;
}

/** The job's new category and subcategories, or null when it keeps its own. */
export function recategorized(row: Pick<JobCategoryRow, 'title' | 'category_id'>): { categoryId: string; subcategoryIds: string[] } | null {
  const read = categorizeTitle(row.title);
  if (read.categoryId === OTHER_CATEGORY_ID || read.categoryId === row.category_id) return null;
  const unfiled = row.category_id === null || row.category_id === '' || row.category_id === OTHER_CATEGORY_ID;
  return unfiled || NEW_PARENTS.has(read.categoryId) ? read : null;
}

/** One pass over every job; answers how many it moved. */
export async function recategorizeJobs(deps: AppDeps): Promise<number> {
  let moved = 0;
  for (let after = 0; ; ) {
    const rows = await deps.db.all<JobCategoryRow>('SELECT id, title, category_id FROM jobs WHERE id > ? ORDER BY id LIMIT ?', [
      after,
      PASS_BATCH,
    ]);
    if (rows.length === 0) return moved;
    after = Number(rows[rows.length - 1]!.id);
    const changes = rows
      .map((row) => ({ id: Number(row.id), next: recategorized(row) }))
      .filter((row): row is { id: number; next: { categoryId: string; subcategoryIds: string[] } } => row.next !== null);
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) {
          await t.run('UPDATE jobs SET category_id = ?, subcategory_ids = CAST(? AS jsonb) WHERE id = ?', [
            change.next.categoryId,
            JSON.stringify(change.next.subcategoryIds),
            change.id,
          ]);
        }
        await projectJobs(t, changes.map((change) => change.id));
      },
      { label: 'role categories: jobs' },
    );
    moved += changes.length;
  }
}

/** The daily step (see the top): jobs moved; nothing once done; on an empty database nothing, and done (v33 FIX-2). */
export const recategorizeJobsStep: DailyStep = {
  name: 'role-categories',
  async run(deps) {
    if (await deps.db.one('SELECT 1 FROM app_settings WHERE key = ?', [RECATEGORIZE_MARK])) return 0;
    const moved = (await deps.db.one('SELECT 1 FROM jobs LIMIT 1')) ? await recategorizeJobs(deps) : 0;
    const at = deps.now().toISOString();
    await deps.db.run(
      'INSERT INTO app_settings(key, value, updated_at) VALUES (?, CAST(? AS json), ?) ON CONFLICT (key) DO NOTHING',
      [RECATEGORIZE_MARK, JSON.stringify({ done: at, moved }), at],
    );
    return moved;
  },
};
