import { readFileSync } from 'node:fs';
import { defaultSheetSourceName, type JobRowMapping, type QueuedLinks } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { importFilePath, sheetOfConfig } from '../../ingest/adapters/tabular';
import { rowTableFromJson, rowTableFromText, type RowTable } from '../../ingest/row-table';
import type { RawPosting, SourceRecord } from '../../ingest/types';
import { parseImportRows } from './import-rows';
import { startImport } from './import-store';
import { queueLinks, type LinkQueueOrigin } from './queue';

// v35 IMPORT: an import's rows keep their fields now (company, title, description, rate, location: the shared row
// contract), read when TailorIT cannot read the link (jobs/add/import-pipeline.ts); see queueLinksOfRun.
// v31 LINK (21-jobs-from-links.md §5): an import is a list of links. A run of a CSV or JSON import (a file, or a Google
// Sheet's copy) or of the free_tailor lake reads its rows as before, but stores none of them: each row's link is queued
// for TailorIT's own read (queue.ts), and its title, company, place and text are ignored. The run says so in its log
// (MSG_JOB_ADD_IMPORT_LINKS); its links' progress is the batch `run:<run id>` (GET /api/admin/jobs/add/run:<id>).

/** The source kinds whose rows are links only. */
export const LINK_LIST_KINDS: ReadonlySet<string> = new Set(['csv', 'json', 'ft_lake']);

/** Whether a source's run queues its rows' links instead of storing them. */
export function isLinkListKind(kind: string): boolean {
  return LINK_LIST_KINDS.has(kind);
}

/** v31 LINK2: what an import's answer says of its columns: the link column read, the others ignored. */
export interface ImportLinksNote {
  column: string | null;
  ignoredColumns: string[];
  message: string;
}

/** The import's note (see ImportLinksNote): MSG_JOB_IMPORT_ONLY_LINKS with the link column and the ignored count. */
export function importLinksNote(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  columns: readonly string[],
  linkColumn: string | null | undefined,
): ImportLinksNote {
  const column = linkColumn ?? null;
  const ignoredColumns = columns.filter((name) => name !== column);
  return {
    column,
    ignoredColumns,
    message: constantsOf(deps).message('MSG_JOB_IMPORT_ONLY_LINKS', { column: column ?? '', ignored: ignoredColumns.length }),
  };
}

/** The queue origin of a link-list source: a Google Sheet's copy, a file, or the lake. */
function originOf(source: SourceRecord): LinkQueueOrigin {
  if (source.kind === 'ft_lake') return 'ft_lake';
  return source.config.sheet ? 'sheets' : 'import';
}

/**
 * v35 IMPORT: a v3.4 import's stored file (Admin's v3.0 file and Google Sheet routes: the csv/json source's copy) as a
 * row table, its header row first (v3.0 always read one), numbered as the sheet numbers its rows; null when unreadable.
 */
function storedTable(deps: AppDeps, source: SourceRecord): RowTable | null {
  try {
    const text = readFileSync(importFilePath(deps, source), 'utf8');
    if (source.kind === 'json' || source.config.format === 'json') return rowTableFromJson(text);
    const table = rowTableFromText('csv', text, true);
    const offset = (sheetOfConfig(source.config)?.headerRow ?? 1) - 1;
    return offset > 0 ? { ...table, rows: table.rows.map((row) => ({ ...row, row: row.row + offset })) } : table;
  } catch {
    return null;
  }
}

/** v35 IMPORT: a v3.4 import's column mapping (v3.0's fields) as the row contract's: url, salary as link, rate. */
function rowMappingOf(config: Record<string, unknown>): JobRowMapping {
  const old = (config.mapping ?? {}) as Record<string, unknown>;
  const column = (key: string) => (typeof old[key] === 'string' ? (old[key] as string) : null);
  return {
    link: column('url'),
    company: column('company'),
    title: column('title'),
    description: column('description'),
    rate: column('salary'),
    location: column('location'),
  };
}

/**
 * Queues the links of a link-list run's rows (see the top), and logs what was queued. Answers what was queued (the
 * run stores nothing). v35 IMPORT (SP v35 PLAN.md H1, H6): a file's or a Google Sheet's run (Admin's v3.0 routes) is an
 * import: its stored copy read by the row contract with its columns' fields (H2), each row's result kept, the run's
 * counts written when its rows are read (import-store.ts). The lake's run queues its links as before.
 */
export async function queueLinksOfRun(
  deps: AppDeps,
  source: SourceRecord,
  runId: number,
  postings: readonly RawPosting[],
  log: (line: string) => void,
): Promise<QueuedLinks> {
  if (source.kind !== 'ft_lake') {
    const table = storedTable(deps, source);
    if (table) {
      const rows = parseImportRows(table, rowMappingOf(source.config));
      const sheet = sheetOfConfig(source.config);
      const made = await startImport(deps, {
        kind: 'admin',
        way: sheet ? 'sheet' : 'file',
        name: sheet ? defaultSheetSourceName(sheet.spreadsheetTitle, sheet.tabTitle) : String(source.config.fileName ?? source.name),
        rows,
        actorId: null,
        origin: sheet ? 'sheets' : 'import',
        source,
        runId,
        config: {
          ...(sheet
            ? {
                sheet: {
                  url: sheet.url,
                  spreadsheetId: sheet.spreadsheetId,
                  gid: sheet.gid,
                  headerRow: sheet.headerRow,
                  spreadsheetTitle: sheet.spreadsheetTitle,
                  tabTitle: sheet.tabTitle,
                },
              }
            : {}),
          mapping: rowMappingOf(source.config),
        },
      });
      log(constantsOf(deps).message('MSG_JOB_ADD_IMPORT_LINKS', { queued: made.queued }));
      return {
        batchId: `run:${runId}`,
        queued: made.queued,
        alreadyQueued: 0,
        repeated: rows.filter((row) => row.result === 'repeated').length,
        refused: [],
      };
    }
  }
  const queued = await queueLinks(deps, {
    urls: postings.map((posting) => posting.url),
    origin: originOf(source),
    addedBy: null,
    sourceId: source.id,
    batchId: `run:${runId}`,
  });
  log(constantsOf(deps).message('MSG_JOB_ADD_IMPORT_LINKS', { queued: queued.queued }));
  return queued;
}
