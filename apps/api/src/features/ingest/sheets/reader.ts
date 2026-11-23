import type { Response } from 'express';
import { parseSpreadsheetRef, spreadsheetUrl, type SheetAccount } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../../core/context';
import { AppError, conflict, validationFailed } from '../../../core/http/errors';
import { rowTableOf, type RowTable } from '../row-table';
import { requireSheets, type SheetsClient } from './client';
import { SHEETS_MESSAGES, sheetsUnavailable } from './errors';
import { SHEET_IMPORT_TIMING, createSheetReadCache, readSheetTab, type CachedSheetRead, type SheetRead, type TabRequest } from './read';
import { SHEET_ERROR_VALUES } from './table';

// The reading of one Google Sheet tab for an import, shared by Admin › Import's Google Sheet (v3.0's routes,
// sheets/router.ts; v3.5's, jobs/add/import-router.ts) and, v35 IMPORT (SP v35 PLAN.md H1), a person's Jobs › Add job
// › Google Sheet: the link parsed, the server's reader account checked, the tab read within the time budget (one read in
// flight per reader key: a newer one replaces it; the browser going away stops it), and the last read kept a while per
// key (a new mapping or header row reads nothing again). Only Google's own API is ever called (client.ts), with the
// service account's read-only scope.

/** A tab's read target: the client and the tab asked for. */
export interface SheetTarget {
  client: SheetsClient;
  request: TabRequest;
}

export interface SheetTabReader {
  /** Whether the server has a reader account, and the address to share a sheet with. */
  account(): SheetAccount;
  /**
   * The link's tab (or `gid`); 400 for a link that is no sheet's, 503 while the server has no reader account. v35
   * FIX-STORE (S3): `person` reads no hidden tab (read.ts TabRequest.visibleOnly; their words for a tab not found).
   */
  targetOf(url: string, gid: number | undefined, person?: { tabNotFound: string }): SheetTarget;
  /** A read of the tab: the cached one when `reuse` and one is kept for this key, else a fresh one (then kept). */
  read(key: string, res: Response, target: SheetTarget, reuse: boolean): Promise<CachedSheetRead>;
  /** A fresh read that is not kept (an import reads the tab again, never a preview's copy). */
  freshRead(key: string, res: Response, target: SheetTarget): Promise<SheetRead>;
  /** Forgets the key's kept reads. */
  clear(key: string): void;
}

export function createSheetTabReader(deps: AppDeps): SheetTabReader {
  const timing = () => ({ ...SHEET_IMPORT_TIMING, ...deps.services.sheetsTiming });
  const cache = createSheetReadCache(
    () => deps.now().getTime(),
    () => timing().cacheTtlMs,
  );
  /** One read of Google in flight per key: a new one replaces (aborts) the last. */
  const reads = new Map<string, AbortController>();

  function targetOf(url: string, gid: number | undefined, person?: { tabNotFound: string }): SheetTarget {
    const ref = parseSpreadsheetRef(url);
    if (!ref.ok) throw validationFailed(ref.message, { url: ref.message });
    const client = requireSheets(deps);
    const account = client.account();
    if (!account.configured) throw sheetsUnavailable(account.problem ?? 'Google Sheet import is not set up on this server.');
    const request = { spreadsheetId: ref.spreadsheetId, gid: gid ?? ref.gid, strictGid: gid !== undefined };
    return { client, request: person ? { ...request, visibleOnly: true, tabNotFound: person.tabNotFound } : request };
  }

  async function freshRead(key: string, res: Response, { client, request }: SheetTarget): Promise<SheetRead> {
    const { readBudgetMs } = timing();
    reads.get(key)?.abort(conflict('A newer read of a Google Sheet replaced this one.'));
    const controller = new AbortController();
    reads.set(key, controller);
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new AppError('validation_failed', 'The read of the sheet was cancelled.'));
    };
    res.on('close', onClose);
    const timer = setTimeout(() => controller.abort(sheetsUnavailable(SHEETS_MESSAGES.timeout(readBudgetMs))), readBudgetMs);
    try {
      return await readSheetTab(client, request, { signal: controller.signal, deadline: Date.now() + readBudgetMs }, () => nowIso(deps));
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      if (reads.get(key) === controller) reads.delete(key);
    }
  }

  return {
    account: () => requireSheets(deps).account(),
    targetOf,
    async read(key, res, target, reuse) {
      const { spreadsheetId, gid } = target.request;
      const kept = reuse ? cache.get(key, spreadsheetId, gid) : null;
      return kept ?? cache.set(key, await freshRead(key, res, target));
    },
    freshRead,
    clear: (key) => cache.clear(key),
  };
}

/**
 * v35 IMPORT: a tab's rows from `headerRow` on as a row table (H1's rule decides whether that row is a header, unless
 * `hasHeader` says), formula errors (#REF!, #N/A...) blank. 400 for an empty tab.
 */
export function sheetRowTable(read: SheetRead, headerRow: number, hasHeader?: boolean): RowTable {
  const firstRow = Math.max(1, read.values.firstRow);
  const records = read.values.rows
    .map((cells, index) => ({ row: firstRow + index, cells: cells.map((cell) => (SHEET_ERROR_VALUES.has(cell.trim()) ? '' : cell)) }))
    .filter((record) => record.row >= headerRow);
  let table: RowTable;
  try {
    table = rowTableOf('sheet', records, hasHeader);
  } catch {
    const message = `The tab "${read.tab.title}" has no rows from row ${headerRow} on.`;
    throw validationFailed(message, { gid: message });
  }
  // Its rows are at most the read's (SHEET_READ_ROWS); an import checks its own limit (SHEET_MAX_ROWS, JOB_IMPORT_ROWS_MAX).
  return table;
}

/** The tab's address (.../edit#gid=N). */
export function tabUrlOf(read: SheetRead): string {
  return spreadsheetUrl(read.spreadsheet.spreadsheetId, read.tab.gid);
}
