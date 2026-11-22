import { PREPARE_ACTIVE_STATES, type MessageKey } from '@tailorit/shared';
import { typedEmailMatches, type AccountDeletionState } from '@tailorit/shared/account-deletion';
import { normalizeEmail } from '../../core/auth/users';
import { constantsOf } from '../../core/constants/service';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { RUNS_PAUSED_KEY } from '../ingest/pause-state';
import {
  endSharesOfAccount,
  forgetSharesOfAccount,
  sharesEndedByDeletion,
  stopSharedWork,
  tellOtherSides,
} from '../sharing/account-deletion';
import { removeAccountFiles, type FilesRemoved } from './files';

// v34 ACCTDEL (PLAN G10): deleting an account, by its person (POST /api/account/delete, Settings › Account › Delete my
// account) or by an administrator (POST /api/admin/users/:id/delete, Admin › Users). Everything the account holds goes
// at once; what stays is one line in account_deletions (when, and whether it was the person or an administrator: no
// id, no hash of one) and what is someone else's, without the account: the lake jobs it added for everyone, and what
// it did on a profile someone shared with it (that owner's: their entries, queue rows and Prepares, prepared_by and
// started_by NULL).
// In order:
// 0. A check that nothing of another account names one of this account's own companies (that row would refuse the
//    delete); a clear error before anything is turned off.
// 1. Turn off (one transaction): the last administrator who can sign in is refused (another must exist first); the
//    account is disabled, so every session, token and connected app is refused from this moment (as an admin's
//    disable: the session check, the MCP, OAuth and extension token checks read disabled_at); the request is written
//    (account_deletion_requests: when, self or admin), so a deletion that stops part way is finished later; and every
//    open share of it ends, both ways (sharing/account-deletion.ts).
// 2. Stop the work (after that commit): endGrant for each share the deletion ended (as when any share ends); the
//    account's own AI tasks that have not finished are cancelled (their CLI child stopped), and so are the tasks it
//    pays for on someone else's profile; its Prepares that are running are cancelled; its resume ZIP builds stop and
//    their files go.
// 3. Delete (one transaction, tried twice): what names the account on the other side of a share (their notifications,
//    the invites it declined); what an administrator's actions left with its name or id (the runs pause's `by`, the
//    other administrators' "paused/continued runs" notices); the directory reviewer's marker (an app_settings row
//    `directory:reviewer:<id>`, when the account is the one made for the directory's reviewer); the account's rows of
//    the tables with no foreign key to users (UNLINKED_PERSON_COLUMNS); the AI tasks it paid for on someone else's
//    profile (their spend is the account's record; left, the owner would be counted for them); its sent application
//    records, then the copies they sent
//    (application_document_snapshots.file_id is ON DELETE RESTRICT, so the copies go before the files they name); then
//    the account's row: every table that names it by a foreign key follows by its own rule, CASCADE (the row goes:
//    resumes, letters, files' rows, the tracker, the autofill profile, answers and job-site sign-ins, private jobs and
//    companies, sessions, every token and connected app, MCP settings, notifications, the plan's and credit's history,
//    AI tasks and their payloads, shares and their activity, the request of step 1) or SET NULL (a record that is
//    someone else's keeps its row without the account: an administrator's audit of a lake job or a source, the jobs
//    it added by link for everyone, the work it did on a shared profile). apps/api/test/v34-acctdel-schema.test.ts
//    holds every rule to the schema: a new table that names a person without one of these fails it. Then the line
//    kept, and each other side of a share it ended is told, in words that name nobody (and say who deleted it).
// 4. Files: <DATA_DIR>/files/<id> goes (./files.ts; the daily step removes a folder a held file kept).
// A failure in step 3 (both tries) leaves the account off with its request: the route answers `pending` (202), and the
// daily pass (whose first run is at start) finishes it (finishDeletions below). Uploaded resumes are never modified:
// they are deleted, with their rows and files, never rewritten.

type Deps = AppDeps;

/** Who deletes the account. */
export type DeletedVia = 'self' | 'admin';

/** What one deletion did. */
export interface AccountDeleted {
  /** `pending`: the account is off and the rest finishes on its own (the daily pass); `deleted`: it is gone. */
  state: AccountDeletionState;
  /** account_deletions.id, the line kept (null while pending, or when another run finished it first). */
  deletionId: number | null;
  /** Who asked first (the request's): the words the other side reads follow it. */
  via: DeletedVia;
  /** The shares it ended, both ways. */
  sharesEnded: number;
  /** The people told a share ended. */
  othersTold: number;
  /** null while pending. */
  files: FilesRemoved | null;
}

/**
 * A column that names an account without a foreign key to users(id) (the schema test lists every other column that
 * looks like one, with why it names nobody). The deletion deletes each row (`delete`) or clears the column (`clear`),
 * then checks none is left (`writtenAt`: only rows written up to the deletion count; a later one names a new sign-up,
 * not the account). profile_grants.grantee_email (an invite to the address the account declined) is sharing's own
 * (sharing/account-deletion.ts forgetSharesOfAccount).
 */
export interface UnlinkedColumn {
  table: string;
  column: string;
  /** What the column holds of the account: its id, or its address (normalised: lower case). */
  holds: 'id' | 'email';
  then: 'delete' | 'clear';
  writtenAt?: string;
}

export const UNLINKED_PERSON_COLUMNS: readonly UnlinkedColumn[] = [
  // A sign-in code waiting for the address (it is the table's key; used codes go at once, others soon after). A code
  // asked for the address while the deletion runs is a new sign-up's: the check counts the codes written before.
  { table: 'login_codes', column: 'email', holds: 'email', then: 'delete', writtenAt: 'created_at' },
  // The administrator who closed a job report (Admin › Review shows the address beside the report).
  { table: 'job_reports', column: 'resolved_by', holds: 'id', then: 'clear' },
];

/**
 * The tables whose rows of the account are deleted before the account's row, in this order: a row of the first names
 * one of the second without a cascade (application_apply_records.resume_snapshot_id, letter_snapshot_id), and a row
 * of the second names a stored file ON DELETE RESTRICT (application_document_snapshots.file_id). PostgreSQL checks
 * that RESTRICT once the whole cascade from the account's row has run, so the row alone would pass too; deleting the
 * copies first keeps the deletion right whatever order a cascade takes, and says here why a file is never removed
 * before the copy that names it. Each has `user_id`, the account whose record it is.
 */
export const DELETED_FIRST = ['application_apply_records', 'application_document_snapshots'] as const;

/** The notification kinds whose words name an administrator ({admin}: its name, else its address). */
export const ADMIN_NAMING_KINDS = {
  admin_runs_paused: 'MSG_NOTIFY_ADMIN_RUNS_PAUSED_TITLE',
  admin_runs_continued: 'MSG_NOTIFY_ADMIN_RUNS_CONTINUED_TITLE',
} as const satisfies Record<string, MessageKey>;

interface AccountRow {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled_at: string | null;
}

/** A deletion asked and not finished yet (account_deletion_requests). */
export interface DeletionRequest {
  requestedAt: string;
  via: DeletedVia;
}

/** The account's deletion request, or null (none: never asked, or the account is gone). */
export async function deletionRequestOf(db: Pick<DbQueries, 'one'>, userId: string): Promise<DeletionRequest | null> {
  const row = await db.one<{ requested_at: string; via: DeletedVia }>(
    'SELECT requested_at, via FROM account_deletion_requests WHERE user_id = ?',
    [userId],
  );
  return row ? { requestedAt: new Date(row.requested_at).toISOString(), via: row.via } : null;
}

/** The typed address matches the account's (trimmed, without case: @tailorit/shared/account-deletion's rule). */
export function confirmsAccount(account: { email: string }, typed: string): boolean {
  return typedEmailMatches(typed, account.email);
}

/** The enabled administrators' ids, each row locked in one order (two deletions at once cannot each count the other). */
export async function lockEnabledAdmins(t: DbQueries): Promise<string[]> {
  return (await t.all<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY id FOR UPDATE")).map(
    (row) => row.id,
  );
}

/**
 * Refuses the deletion of the last administrator who can sign in: deleting it would leave the server with nobody who
 * can make another. A disabled administrator (one being deleted too) does not count.
 */
async function assertNotLastAdmin(deps: Deps, t: DbQueries, userId: string): Promise<void> {
  const admins = await lockEnabledAdmins(t);
  if (admins.includes(userId) && !admins.some((id) => id !== userId)) {
    throw refuse(deps, 'conflict', 'MSG_ACCOUNT_DELETE_LAST_ADMIN');
  }
}

/**
 * GET /api/account/delete: why the signed-in person cannot delete their account now (the last administrator who can
 * sign in), or null. The deletion checks it again, under its locks.
 */
export async function deletionRefusalOf(deps: Deps, account: { id: string; role: string }): Promise<string | null> {
  if (account.role !== 'admin') return null;
  const others = await deps.db.one<{ n: number }>(
    "SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?",
    [account.id],
  );
  return Number(others?.n ?? 0) > 0 ? null : constantsOf(deps).message('MSG_ACCOUNT_DELETE_LAST_ADMIN');
}

/**
 * Step 0: an account's own company (companies.owner_user_id, a page only it read) is named only by its own rows, so it
 * goes in the same cascade. A row of another account naming one (no path writes one today) would make the delete fail
 * on applications.company_id or jobs.company_id (NO ACTION): refused here, before anything is turned off, with the
 * counts in the log.
 */
async function assertOwnCompaniesUnshared(deps: Deps, userId: string): Promise<void> {
  const row = await deps.db.one<{ entries: number; jobs: number }>(
    `SELECT (SELECT count(*) FROM applications a JOIN companies c ON c.id = a.company_id
              WHERE c.owner_user_id = @user AND a.user_id <> @user) AS entries,
            (SELECT count(*) FROM jobs j JOIN companies c ON c.id = j.company_id
              WHERE c.owner_user_id = @user AND j.owner_user_id IS DISTINCT FROM @user) AS jobs`,
    { user: userId },
  );
  const entries = Number(row?.entries ?? 0);
  const jobs = Number(row?.jobs ?? 0);
  if (entries + jobs > 0) {
    throw refuse(deps, 'internal', 'MSG_ACCOUNT_DELETE_BLOCKED', undefined, {
      cause: new Error(`account delete: ${entries} entries and ${jobs} jobs of other accounts name its own companies`),
    });
  }
}

/** Step 1: the account turned off, the request written and its shares ended, in one transaction. Null: no account. */
async function turnOff(deps: Deps, userId: string, via: DeletedVia): Promise<{ account: AccountRow; request: DeletionRequest } | null> {
  return deps.db.tx(
    async (t) => {
      const seen = await t.one<{ role: string }>('SELECT role FROM users WHERE id = ?', [userId]);
      if (!seen) return null;
      if (seen.role === 'admin') await assertNotLastAdmin(deps, t, userId);
      const account = await t.one<AccountRow>('SELECT id, email, name, role, disabled_at FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (!account) return null;
      // The role may have changed between the two reads: the rule is checked on the row as locked.
      if (account.role === 'admin' && seen.role !== 'admin') await assertNotLastAdmin(deps, t, userId);
      const now = nowIso(deps);
      if (account.disabled_at === null) {
        await t.run('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?', [now, now, userId]);
      }
      // Asked twice (a deletion that stopped part way, asked again): the first request stays, with its time and asker.
      await t.run(
        'INSERT INTO account_deletion_requests(user_id, requested_at, via) VALUES (?, CAST(? AS timestamptz), ?) ON CONFLICT (user_id) DO NOTHING',
        [userId, now, via],
      );
      const request = (await deletionRequestOf(t, userId))!;
      await endSharesOfAccount(deps, t, userId, now);
      return { account, request };
    },
    { label: 'account delete: turn off' },
  );
}

/** Step 2's own part: the account's AI tasks, Prepares and resume ZIP builds that have not finished stop. Never throws. */
async function stopOwnWork(deps: Deps, userId: string): Promise<void> {
  const ai = deps.services.ai;
  if (ai) {
    try {
      // Its own tasks, and the ones it pays for on someone else's profile (endGrant cancelled those of a share).
      const tasks = await deps.db.all<{ id: string }>(
        `SELECT id FROM ai_tasks WHERE (user_id = @user OR charge_user_id = @user) AND status IN ('queued', 'running') ORDER BY id`,
        { user: userId },
      );
      for (const task of tasks) await ai.cancel(task.id, null);
    } catch (error) {
      deps.log.warn("[account] stopping a deleted account's AI tasks failed; their rows go anyway", error);
    }
  }
  const prepare = deps.services.prepare;
  if (prepare) {
    try {
      const running = await deps.db.all<{ id: string }>(
        `SELECT id FROM prepare_jobs WHERE user_id = @user AND state = ANY(CAST(@states AS text[])) ORDER BY id`,
        { user: userId, states: `{${PREPARE_ACTIVE_STATES.join(',')}}` },
      );
      for (const row of running) await prepare.cancel(userId, row.id).catch(() => undefined);
    } catch (error) {
      deps.log.warn("[account] stopping a deleted account's Prepares failed; their rows go anyway", error);
    }
  }
  try {
    await deps.services.resumeZip?.forgetAccount(userId);
  } catch (error) {
    deps.log.warn("[account] stopping a deleted account's resume ZIPs failed; the next start removes their files", error);
  }
}

/** What an unlinked column's value is for this account. */
const valueOf = (column: UnlinkedColumn, account: AccountRow) => (column.holds === 'id' ? account.id : normalizeEmail(account.email));

/**
 * What an administrator's own actions left with its name or id outside a row of its own: the runs pause keeps going,
 * without who paused it (`by` in the setting's JSON; updated_by lets go by its key); the other administrators' notices
 * that it paused or continued runs (their title names it by its name, else its address, as pause.ts wrote it) go.
 */
async function forgetAdminTraces(deps: Deps, t: DbQueries, account: AccountRow): Promise<void> {
  await t.run(
    `UPDATE app_settings SET value = CAST(jsonb_set(CAST(value AS jsonb), '{by}', 'null') AS json)
      WHERE key = @key AND json_typeof(value) = 'object' AND value->>'by' = @id`,
    { key: RUNS_PAUSED_KEY, id: account.id },
  );
  const constants = constantsOf(deps);
  // The title as its message renders it for this administrator, around {what} (every run, or a source's runs).
  const cut = '\u0001';
  const shapes: Array<{ kind: string; prefix: string; suffix: string }> = [];
  for (const [kind, key] of Object.entries(ADMIN_NAMING_KINDS)) {
    for (const who of new Set([account.name.trim(), account.email].filter(Boolean))) {
      const [prefix = '', suffix = ''] = constants.message(key, { admin: who, what: cut }).split(cut);
      shapes.push({ kind, prefix, suffix });
    }
  }
  await t.run(
    `DELETE FROM notifications n
      WHERE n.user_id <> @id
        AND EXISTS (SELECT 1 FROM unnest(CAST(@kinds AS text[]), CAST(@prefixes AS text[]), CAST(@suffixes AS text[])) AS s(kind, prefix, suffix)
                     WHERE n.kind = s.kind AND starts_with(n.title, s.prefix) AND right(n.title, length(s.suffix)) = s.suffix
                       AND length(n.title) >= length(s.prefix) + length(s.suffix))`,
    {
      id: account.id,
      kinds: textArray(shapes.map((shape) => shape.kind)),
      prefixes: textArray(shapes.map((shape) => shape.prefix)),
      suffixes: textArray(shapes.map((shape) => shape.suffix)),
    },
  );
}

/** A PostgreSQL text[] literal of `values` (each quoted). */
function textArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/** Step 3: every row of the account, in one transaction, the line kept and the other sides told. Null: already gone. */
async function deleteRows(
  deps: Deps,
  userId: string,
  via: DeletedVia,
  deletedAt: string,
): Promise<{ deletionId: number; via: DeletedVia; sharesEnded: number; othersTold: number } | null> {
  return deps.db.tx(
    async (t) => {
      const account = await t.one<AccountRow>('SELECT id, email, name, role, disabled_at FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (!account) return null;
      const request = (await deletionRequestOf(t, userId)) ?? { requestedAt: deletedAt, via };
      // Read before the grants go (with the account's row): whom to tell, once it is gone.
      const shares = await sharesEndedByDeletion(t, userId, request.requestedAt);
      await forgetSharesOfAccount(deps, t, userId, normalizeEmail(account.email));
      await forgetAdminTraces(deps, t, account);
      // v34 DIRKIT: the directory reviewer account's marker
      await t.run("DELETE FROM app_settings WHERE key LIKE 'directory:reviewer:%' AND value->>'userId' = ?", [userId]);
      for (const column of UNLINKED_PERSON_COLUMNS) {
        const sql =
          column.then === 'delete'
            ? `DELETE FROM ${column.table} WHERE ${column.column} = ?`
            : `UPDATE ${column.table} SET ${column.column} = NULL WHERE ${column.column} = ?`;
        await t.run(sql, [valueOf(column, account)]);
      }
      // The AI work it paid for on someone else's profile: its spend is the account's record, and left without a payer
      // it would count against that owner (coalesce(charge_user_id, user_id)). What it made stays the owner's.
      await t.run('DELETE FROM ai_tasks WHERE charge_user_id = ? AND user_id <> ?', [userId, userId]);
      for (const table of DELETED_FIRST) await t.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
      await t.run('DELETE FROM users WHERE id = ?', [userId]);
      for (const column of UNLINKED_PERSON_COLUMNS) {
        const written = column.writtenAt ? ` AND ${column.writtenAt} <= CAST(? AS timestamptz)` : '';
        const left = await t.one<{ n: number }>(
          `SELECT count(*) AS n FROM ${column.table} WHERE ${column.column} = ?${written}`,
          column.writtenAt ? [valueOf(column, account), deletedAt] : [valueOf(column, account)],
        );
        if (Number(left?.n ?? 0) > 0) throw new Error(`account delete: ${column.table}.${column.column} still names the account`);
      }
      const line = await t.one<{ id: number }>(
        'INSERT INTO account_deletions(deleted_at, via) VALUES (CAST(? AS timestamptz), ?) RETURNING id',
        [deletedAt, request.via],
      );
      // In this transaction, after the notices that named it went: the other sides learn it with the deletion.
      const othersTold = await tellOtherSides(deps, shares, request.via);
      return { deletionId: Number(line!.id), via: request.via, sharesEnded: shares.length, othersTold };
    },
    { label: 'account delete' },
  );
}

/** Step 3, tried twice (a deadlock with a write on the account's rows passes the second time). Null: it stays pending. */
async function deleteRowsOrWait(deps: Deps, userId: string, via: DeletedVia): Promise<Awaited<ReturnType<typeof deleteRows>> | 'gone' | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return (await deleteRows(deps, userId, via, nowIso(deps))) ?? 'gone';
    } catch (error) {
      if (attempt === 2) {
        deps.log.error('[account] deleting an account failed; it stays off, and the daily pass finishes the deletion', error);
        return null;
      }
      deps.log.warn('[account] deleting an account failed; trying once more', error);
    }
  }
  return null;
}

/**
 * Deletes account `userId` and everything it holds (the order at the top). Refuses the last administrator who can sign
 * in (conflict). 404 for an account that does not exist. Answers `pending` when step 3 failed: the account is off and
 * the daily pass finishes it; asked again, it finishes it now.
 */
export async function deleteAccount(deps: Deps, userId: string, via: DeletedVia): Promise<AccountDeleted> {
  deps.db.assertNoTx('deleteAccount (endGrant and the files run between its transactions)');
  await assertOwnCompaniesUnshared(deps, userId);
  const off = await turnOff(deps, userId, via);
  if (!off) throw notFound('That account');
  const shares = await sharesEndedByDeletion(deps.db, userId, off.request.requestedAt);
  await stopSharedWork(deps, shares);
  await stopOwnWork(deps, userId);
  const done = await deleteRowsOrWait(deps, userId, off.request.via);
  if (done === null) {
    return { state: 'pending', deletionId: null, via: off.request.via, sharesEnded: shares.length, othersTold: 0, files: null };
  }
  let files: FilesRemoved = 'left';
  try {
    files = removeAccountFiles(deps, userId);
  } catch (error) {
    deps.log.warn("[account] a deleted account's files could not be removed yet; the daily pass removes them", error);
  }
  if (done === 'gone') {
    // Another run (the daily pass, a second request) finished it meanwhile.
    return { state: 'deleted', deletionId: null, via: off.request.via, sharesEnded: shares.length, othersTold: 0, files };
  }
  deps.log.info(`[account] deleted an account (#${done.deletionId}, ${done.via}): ${done.sharesEnded} shares ended, files ${files}`);
  return { state: 'deleted', deletionId: done.deletionId, via: done.via, sharesEnded: done.sharesEnded, othersTold: done.othersTold, files };
}

/**
 * The daily step (its first run is at start): every deletion that stopped part way (a request left) is run again, the
 * oldest first, each on its own (one that fails again is logged and tried at the next pass). Answers how many it
 * finished.
 */
export async function finishDeletions(deps: Deps): Promise<number> {
  const pending = await deps.db.all<{ user_id: string; via: DeletedVia }>(
    'SELECT user_id, via FROM account_deletion_requests ORDER BY requested_at, user_id',
  );
  let finished = 0;
  for (const row of pending) {
    try {
      const done = await deleteAccount(deps, row.user_id, row.via);
      if (done.state === 'deleted') finished += 1;
    } catch (error) {
      deps.log.error('[account] finishing a deletion failed; the next pass tries again', error);
    }
  }
  return finished;
}
