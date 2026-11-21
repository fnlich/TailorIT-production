import type { MessageKey } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { refuse } from '../../core/http/refuse';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §9 "Editors"): on a shared profile two people may have one letter (or
// letter template) open at once, A and B, or the same person in two tabs. A save names the version it changes (the
// editor's `baseUpdatedAt`: the detail's `updatedAt` it loaded or last saved); when the row was saved since, nothing is
// saved and the answer is 409 `revision_conflict` (the editor then loads the latest version: "Someone else changed this
// letter." on a shared profile). The row is locked while it is compared and saved, so two saves from one version never
// both land. A save without `baseUpdatedAt` (the extension, an older page) is saved as before.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The tables whose rows an editor saves with this precondition. */
type EditedTable = 'cover_letters' | 'cover_letter_templates';

/** Whether two ISO times name the same instant (the stored one is read back as ISO text; the editor sends it back). */
const sameInstant = (a: string, b: string) => {
  const at = Date.parse(a);
  return Number.isFinite(at) && at === Date.parse(b);
};

/**
 * Runs `save` when the row `id` of `userId` is still at `base` (or `base` is absent); else 409 `revision_conflict` with
 * `message`. A row that is gone is left to `save`, which answers its own 404.
 */
export async function saveFromVersion<T>(
  deps: Deps,
  table: EditedTable,
  ref: { id: string; userId: string; base: string | undefined },
  message: MessageKey,
  save: () => Promise<T>,
): Promise<T> {
  if (ref.base === undefined) return save();
  const base = ref.base;
  return deps.db.tx(
    async (t) => {
      const row = await t.one<{ updated_at: string }>(`SELECT updated_at FROM ${table} WHERE id = ? AND user_id = ? FOR UPDATE`, [
        ref.id,
        ref.userId,
      ]);
      if (row && !sameInstant(row.updated_at, base)) throw refuse(deps, 'revision_conflict', message);
      return save();
    },
    { label: `${table} save` },
  );
}
