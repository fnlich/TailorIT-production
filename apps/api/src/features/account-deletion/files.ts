import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';

// v34 ACCTDEL (PLAN G10): an account's files on disk. The file store keeps each upload at <DATA_DIR>/files/<userId>/
// <fileId> (its thumbnail beside it), so an account's files are one folder, removed whole once the account's rows are
// gone (the rows first: a file is never removed while a row could still name it). A removal that fails (Windows can
// hold a file a moment) is left to the daily step below, which removes every folder whose account no longer exists.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log'>;

/** An account id as the file store names its folder (core/files/store.ts assertPlainId: anything else is never a path). */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** An account id as accounts are made (core/auth/users.ts: a random UUID): the only folders the daily step may remove. */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** <DATA_DIR>/files */
export const filesRootOf = (deps: Pick<AppDeps, 'config'>) => join(deps.config.dataDir, 'files');

/** <DATA_DIR>/files/<userId>, or null for an id that is no plain id. */
export function accountFilesDir(deps: Pick<AppDeps, 'config'>, userId: string): string | null {
  return PLAIN_ID.test(userId) ? join(filesRootOf(deps), userId) : null;
}

/** What removing an account's folder did. */
export type FilesRemoved = 'removed' | 'none' | 'left';

/** Removes the account's folder of files (after its rows are gone). Never throws: `left` is for the daily step. */
export function removeAccountFiles(deps: Deps, userId: string): FilesRemoved {
  const dir = accountFilesDir(deps, userId);
  if (dir === null) return 'none';
  let had: boolean;
  try {
    readdirSync(dir);
    had = true;
  } catch {
    had = false;
  }
  if (!had) return 'none';
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return 'removed';
  } catch (error) {
    deps.log.warn("[account] a deleted account's files could not all be removed yet; the daily pass removes them", error);
    return 'left';
  }
}

/**
 * The daily step: every folder under <DATA_DIR>/files named after an account that no longer exists is removed (an
 * account deleted while one of its files was held open). A folder whose account exists is never touched, and nothing
 * but a folder named as an account id is. Answers how many folders went.
 */
export const removeOrphanFiles: DailyStep = {
  name: 'orphanFiles',
  run: async (deps) => {
    let names: string[];
    try {
      names = readdirSync(filesRootOf(deps), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ACCOUNT_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return 0;
    }
    if (names.length === 0) return 0;
    const known = new Set(
      (
        await deps.db.all<{ id: string }>('SELECT id FROM users WHERE id = ANY(CAST(@ids AS text[]))', {
          ids: `{${names.join(',')}}`,
        })
      ).map((row) => row.id),
    );
    let removed = 0;
    for (const name of names) {
      if (known.has(name)) continue;
      if (removeAccountFiles(deps, name) === 'removed') removed += 1;
    }
    return removed;
  },
};
