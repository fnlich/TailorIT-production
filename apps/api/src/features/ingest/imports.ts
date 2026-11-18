import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportMapping, SheetSourceConfig } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import { AppError, conflict } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { importsRoot, sheetOfConfig } from './adapters/tabular';
import { requireIngest, type StartedRun } from './service';
import { adminSource, findSheetSource, findSourceRecord, insertSource, type AdminRunDetail, type AdminSource } from './sources';
import type { SourceRecord } from './types';
import type { ImportLinksNote } from '../jobs/add/imports'; // v31 LINK2

// Storing an import (a CSV/JSON file, or the CSV copy of a Google Sheet tab) as a csv/json source and running it. One
// stored file per source: importing again under the same name (or the same sheet tab) replaces the copy; unchanged
// rows stay unchanged and rows that are gone stay open (csv/json sources never close missing postings). v3.0 D2-C:
// the source is found or made in one transaction, and its file and config are written once the run holds the source's
// lease (RunOptions.prepare), so a second import of it at once is refused before it touches the first one's file.

/** Imports with more rows than this run in the background instead of holding the request (Next's proxy waits 120 s). */
export const BACKGROUND_IMPORT_ROWS = 2000;

export function safeFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'import';
}

export interface ImportRequest {
  kind: 'csv' | 'json';
  sourceName: string;
  /** The name shown for the stored file. */
  fileName: string;
  text: string;
  mapping: ImportMapping;
  /** Rows below the header: more than BACKGROUND_IMPORT_ROWS import in the background. */
  rowCount: number;
  /** Where a Google Sheet copy came from (config.sheet). */
  sheet?: SheetSourceConfig;
  /** How long the caller may still wait for the run, in ms: a run that takes longer answers 202. Default: no limit. */
  waitMs?: number;
}

export interface ImportResult {
  source: AdminSource;
  /** Null while the import runs in the background (follow `runId` under Runs). */
  run: AdminRunDetail | null;
  runId: number;
  /** v31 LINK2: the link column read and the columns ignored (the route adds it: an import is a list of links). */
  links?: ImportLinksNote;
}

/** The run, or null when it is still going after `ms`. */
async function finishedWithin(done: Promise<AdminRunDetail>, ms: number): Promise<AdminRunDetail | null> {
  if (ms <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([done, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds or creates the source, stores the text as its one file, sets its config and starts its run. 201 with the run
 * once it finished; 202 (run null) for a large import, or when the run outlasts `waitMs`. 409 when the source is
 * running or the name belongs to another import (a file import and a sheet import never share a source).
 */
export async function storeAndRunImport(deps: AppDeps, request: ImportRequest): Promise<{ status: 201 | 202; body: ImportResult }> {
  const db = deps.db;
  const { kind, sourceName, sheet } = request;
  const now = nowIso(deps);
  const service = requireIngest(deps);
  const source = await db.tx(
    async (t): Promise<SourceRecord> => {
      const named = await findSourceRecord(t, kind, sourceName);
      const sameTab = sheet ? await findSheetSource(t, sheet.spreadsheetId, sheet.gid) : null;
      if (sheet) {
        if (named && named.id !== sameTab?.id) {
          const other = sheetOfConfig(named.config);
          throw conflict(
            other
              ? `"${sourceName}" imports another tab ("${other.tabTitle}" of "${other.spreadsheetTitle}"). Choose another source name.`
              : `A file import is already named "${sourceName}". Choose another source name.`,
          );
        }
      } else if (named && sheetOfConfig(named.config)) {
        throw conflict(`A Google Sheet import is already named "${sourceName}". Choose another source name.`);
      }
      const found = sameTab ?? named;
      if (found && service.isRunning(found.id)) throw refuse(deps, 'conflict', 'MSG_INGEST_IMPORT_RUNNING');
      if (found) {
        // The same tab imported again under a new name: one source per tab, renamed.
        if (found.name !== sourceName) await t.run('UPDATE job_sources SET name = ?, updated_at = ? WHERE id = ?', [sourceName, now, found.id]);
        return found;
      }
      // Null: another import of this name made its source after the look (it runs it).
      const created = await insertSource(t, { kind, name: sourceName, config: {} }, now);
      if (!created) throw refuse(deps, 'conflict', 'MSG_INGEST_IMPORT_RUNNING');
      return created;
    },
    { label: 'import source' },
  );
  // v3.0 PG-C: the 202 answer reads the source once `prepare` stored its config (a sheet import's kind label comes from
  // it). On SQLite the answer's read queued behind prepare's write; on PostgreSQL they run on two connections at once.
  let markPrepared = () => {};
  const prepared = new Promise<void>((resolve) => (markPrepared = resolve));
  /** The file and the config, written once the run holds the source (outside any transaction: a file). */
  const prepare = async () => {
    try {
      const folder = join(importsRoot(deps), String(source.id));
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      const relative = `${source.id}/${now.replace(/[:.]/g, '-')}-${safeFileName(request.fileName)}`;
      writeFileSync(join(importsRoot(deps), relative), request.text, 'utf8');
      const config = { file: relative, fileName: request.fileName, format: kind, mapping: request.mapping, ...(sheet ? { sheet } : {}) };
      await db.run('UPDATE job_sources SET config = ?, updated_at = ? WHERE id = ?', [JSON.stringify(config), now, source.id]);
    } finally {
      markPrepared();
    }
  };
  let started: StartedRun;
  try {
    started = await service.run(source.id, 'upload', { bypassSlots: true, prepare });
  } catch (error) {
    // Leased meanwhile by another import (or a run) of the source.
    if (error instanceof AppError && error.code === 'conflict') throw refuse(deps, 'conflict', 'MSG_INGEST_IMPORT_RUNNING');
    throw error;
  }
  const id = source.id;
  const background = async () => {
    // A run that fails before it prepares ends instead: its end stands for prepare's then.
    await Promise.race([prepared, started.done]);
    return { status: 202 as const, body: { source: (await adminSource(db, id, true))!, run: null, runId: started.runId } };
  };
  if (request.rowCount > BACKGROUND_IMPORT_ROWS) return background();
  const run = request.waitMs === undefined ? await started.done : await finishedWithin(started.done, request.waitMs);
  if (!run) return background();
  return { status: 201, body: { source: (await adminSource(db, id, false))!, run, runId: started.runId } };
}
