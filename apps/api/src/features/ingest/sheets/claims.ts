import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { refuse } from '../../../core/http/refuse';

// v35 FIX-STORE (the final review's S3; SP v35 FINAL-FIXES.md, the coordinator's decision 1): a Google Sheet belongs to
// the first account that reads it through TailorIT's reader account (migration 0059's sheet_claims). TailorIT reads
// every sheet shared with that one address, so the address alone says nothing of whose a sheet is:
//   - a person (Jobs › Add job › Google Sheet) reads a spreadsheet only while no account claims it, or while the account
//     whose profile the import lands on claims it (userOf: B acting on A's profile reads A's sheet); the first such read
//     claims it for that account. Anyone else is refused, the same words whoever claimed it (MSG_JOB_IMPORT_SHEET_CLAIMED:
//     make a copy, share the copy, import the copy);
//   - an administrator (Admin › Import, v3.0's Admin › Import jobs › Google Sheet) reads any sheet, as before v3.5; their
//     read claims an unclaimed sheet for the administrators (user_id NULL), so people are refused it.
// The check comes before the read of Google; the claim after a read that worked (a sheet not shared with the reader is
// claimed by no one). Two people reading one new sheet at once: the first claim wins, the other is refused.

/** Who reads a sheet: the administrators, or the person whose profile the import lands on. */
export type SheetReader = { kind: 'admin' } | { kind: 'person'; userId: string };

/** An administrator's read (Admin › Import). */
export const ADMIN_SHEET_READER: SheetReader = { kind: 'admin' };

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The account a spreadsheet is claimed for: a person's id, null for the administrators, undefined when unclaimed. */
async function claimantOf(db: DbQueries, spreadsheetId: string): Promise<string | null | undefined> {
  const row = await db.one<{ user_id: string | null }>('SELECT user_id FROM sheet_claims WHERE spreadsheet_id = ?', [spreadsheetId]);
  return row ? row.user_id : undefined;
}

/** Whether `reader` may read a spreadsheet claimed for `claimant` (undefined: unclaimed). */
function mayRead(reader: SheetReader, claimant: string | null | undefined): boolean {
  if (reader.kind === 'admin' || claimant === undefined) return true;
  return claimant === reader.userId;
}

/** The refusal of a sheet another account claims (403, an alert's words). */
function claimedElsewhere(deps: Deps) {
  return refuse(deps, 'forbidden', 'MSG_JOB_IMPORT_SHEET_CLAIMED');
}

/** Before a read of Google: refuses a person a spreadsheet another account claims. */
export async function assertSheetReadable(deps: Deps, spreadsheetId: string, reader: SheetReader): Promise<void> {
  if (reader.kind === 'admin') return;
  if (!mayRead(reader, await claimantOf(deps.db, spreadsheetId))) throw claimedElsewhere(deps);
}

/**
 * After a read of Google that worked: claims the spreadsheet for the reader when no account has (a person: their
 * account; an administrator: the administrators). A person whose claim lost to another account's meanwhile is refused.
 */
export async function claimSheet(deps: Deps, spreadsheetId: string, reader: SheetReader): Promise<void> {
  const userId = reader.kind === 'admin' ? null : reader.userId;
  await deps.db.run('INSERT INTO sheet_claims(spreadsheet_id, user_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT (spreadsheet_id) DO NOTHING', [
    spreadsheetId,
    userId,
    nowIso(deps),
  ]);
  if (reader.kind === 'admin') return;
  if (!mayRead(reader, await claimantOf(deps.db, spreadsheetId))) throw claimedElsewhere(deps);
}
