import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import {
  AdminImportLinkBodySchema,
  AdminImportPasteBodySchema,
  defaultSheetSourceName,
  importRowResultsOf,
  JOB_ROW_FIELDS,
  JobImportFileJsonBodySchema,
  JobImportSheetBodySchema,
  JobRowMappingInputSchema,
  MINUTE_MS,
  SHEET_MAX_ROWS,
  type AdminImportStarted,
  type JobImportPreview,
  type JobImportSheetAccount,
  type JobImportSheetRef,
  type JobImportStarted,
  type JobRowMappingInput,
} from '@tailorit/shared';
import { adminRouter, PositiveId } from '../../../core/admin/index';
import { ACCOUNT_ROW_SQL, effectiveType, type AccountRow } from '../../../core/accounts/entitlements';
import { actorOf, rateKeyOf, userOf } from '../../../core/auth/guards';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import { getFileStore } from '../../../core/files/index';
import { notFound, validationFailed } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { parseInput } from '../../../core/http/validate';
import { keyedRateLimit } from '../../../core/rate-limit';
import { rowTableFromFile, rowTableFromPaste, rowTableOf, type RowTable } from '../../ingest/row-table';
import { createSheetTabReader, sheetRowTable, tabUrlOf, type SheetTabReader } from '../../ingest/sheets/reader';
import { ADMIN_SHEET_READER, assertSheetReadable, claimSheet, type SheetReader } from '../../ingest/sheets/claims'; // v35 FIX-STORE
import { IngestError } from '../../ingest/types';
import { XlsxError } from '../../ingest/xlsx';
import { importPreview, mappingOf, parseImportRows, type ParsedImportRow } from './import-rows';
import {
  adminImportSummary,
  fileImportSource,
  importDetail,
  listAdminImports,
  listUserImports,
  needsDetailsCsv,
  pastedLinksSource,
  rowsLeftToday,
  sheetImportSource,
  startImport,
  userImportSummary,
  type StartImportInput,
} from './import-store';

// v35 IMPORT (SP v35 PLAN.md H1, H2, H6): the import routes. Every way is read into rows by the shared row contract
// (import-rows.ts), previewed (the guessed or chosen mapping and the first rows; nothing saved), then imported: its rows
// queued for TailorIT's read in the link queue's worker (import-pipeline.ts), never inside the request.
//
// Admins (/api/admin/imports; Admin's, `never` on a shared profile): each import is one run on Runs (H6).
//   POST /link                     one link and its optional fields                      → 201 AdminImportStarted
//   POST /paste/preview, /paste    links one a line, or rows copied from a spreadsheet    → JobImportPreview / 201
//                                  (tab-separated, header optional; ADMIN_ADD_LINKS_MAX rows)
//   POST /file/preview, /file      .csv .tsv .txt .json .xlsx (multipart `file` + form `mapping` (JSON), `hasHeader`,
//                                  `sheet`; or JSON {fileName, content | contentBase64, ...}; SHEET_MAX_ROWS rows)
//   POST /sheet/preview, /sheet    a Google Sheet's tab (its link; gid, headerRow, mapping; SHEET_MAX_ROWS rows)
//   GET  /sheet/account            whether the server reads Google Sheets, and the address to share one with
//   GET  /                         Recent imports (each with its counts; a sheet's tab and mapping for Import again)
//   GET  /:runId?cursor=           the import of a run: counts, a page of rows, "Download these rows"
// People (/api/jobs/imports, beside Add job; on a shared profile as Add job is: the jobs are saved to that profile's
// Job Tracker; the rows count toward the person acting): the file and sheet ways, JOB_IMPORT_ROWS_MAX rows each,
// FREE_/PAID_JOB_IMPORT_ROWS_PER_DAY in any 24 hours (the person's plan), JOB_IMPORTS_PER_MINUTE requests a minute.
//   POST /imports/file/preview, /imports/file, /imports/sheet/preview, /imports/sheet → JobImportPreview / 201 JobImportStarted
//   GET  /imports/sheet/account, GET /imports/:id (progress and results)
// v35 FIX-STORE (the final review's S3, S4, S7; the fix list's item 9):
//   - a Google Sheet belongs to the first account that reads it (ingest/sheets/claims.ts): a person reads one no other
//     account claims (403 MSG_JOB_IMPORT_SHEET_CLAIMED), never its hidden tabs; an admin reads any and claims it;
//   - results carry counts, not the rows that need a title and company: those are a CSV, GET /:runId/needs-details.csv
//     (admins) and GET /imports/:id/needs-details.csv (people), at most JOB_IMPORT_DOWNLOAD_MAX_MB (413 past it);
//   - GET /imports/recent?limit=1..20&cursor= the profile's imports, newest first (JobImportList);
//   - a person's reads (the list, the results, the download) JOB_IMPORT_READS_PER_MINUTE a minute.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** An uploaded import file, with the form's choices. */
interface UploadedImport {
  fileName: string;
  bytes: Uint8Array;
  mapping?: JobRowMappingInput;
  hasHeader?: boolean;
  sheet?: string;
}

/** The form's mapping (JSON text in multipart; an object in JSON). */
function mappingInput(value: unknown): JobRowMappingInput | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw validationFailed('The column mapping is not valid JSON.');
    }
  }
  return parseInput(JobRowMappingInputSchema, parsed, 'column mapping');
}

const flagOf = (value: unknown): boolean | undefined => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined);

/** The upload of a file import: multipart `file` (the web), or JSON {fileName, content | contentBase64} (scripts, tests). */
function uploadOf(req: Request): UploadedImport {
  const file = req.file;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (file) {
    return {
      fileName: (file.originalname || 'import.csv').slice(0, 200),
      bytes: new Uint8Array(file.buffer.buffer, file.buffer.byteOffset, file.buffer.byteLength),
      mapping: mappingInput(body.mapping),
      hasHeader: flagOf(body.hasHeader),
      ...(typeof body.sheet === 'string' && body.sheet ? { sheet: body.sheet.slice(0, 200) } : {}),
    };
  }
  const json = parseInput(JobImportFileJsonBodySchema, body, 'import');
  const bytes = json.contentBase64 !== undefined ? Buffer.from(json.contentBase64, 'base64') : Buffer.from(json.content ?? '', 'utf8');
  if (bytes.length === 0) throw validationFailed('The file is empty.');
  return {
    fileName: json.fileName,
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ...(json.mapping ? { mapping: json.mapping } : {}),
    ...(json.hasHeader !== undefined ? { hasHeader: json.hasHeader } : {}),
    ...(json.sheet ? { sheet: json.sheet } : {}),
  };
}

/**
 * A file as a table; a file TailorIT cannot read answers 400 (413 for a spreadsheet too large once opened). v35 INT-2
 * (FIX-PARSE's exact edit 1): the route's row limit goes to the parser, which keeps `maxRows + 1` rows and counts the
 * rest (`totalRows`).
 */
async function tableOfUpload(deps: Deps, upload: UploadedImport, maxRows: number): Promise<RowTable> {
  try {
    return await rowTableFromFile(upload.fileName, upload.bytes, { hasHeader: upload.hasHeader, sheet: upload.sheet, maxRows });
  } catch (error) {
    if (error instanceof XlsxError) {
      if (error.tooBig) throw refuse(deps, 'file_too_large', 'MSG_JOB_IMPORT_FILE_TOO_BIG');
      if (error.noSheet) throw validationFailed(error.message);
      throw refuse(deps, 'validation_failed', 'MSG_JOB_IMPORT_FILE_UNREADABLE');
    }
    if (error instanceof IngestError) throw validationFailed(error.message);
    throw error;
  }
}

/** A pasted list as a table (400 when it holds no row). */
function tableOfPaste(text: string, hasHeader: boolean | undefined): RowTable {
  try {
    return rowTableFromPaste(text, hasHeader);
  } catch (error) {
    if (error instanceof IngestError) throw validationFailed(error.message);
    throw error;
  }
}

/** The rows of a table by its mapping, checked: a link column, at least one row, at most `max` rows. */
function rowsToImport(deps: Deps, table: RowTable, mapping: JobRowMappingInput | undefined, max: number, tooMany: 'rows' | 'links'): ParsedImportRow[] {
  const chosen = mappingOf(table, mapping);
  if (chosen.link === null) throw refuse(deps, 'validation_failed', 'MSG_JOB_IMPORT_NO_LINK_COLUMN');
  if (table.rows.length === 0) throw refuse(deps, 'validation_failed', 'MSG_JOB_IMPORT_EMPTY');
  // v35 INT-2 (FIX-PARSE's exact edit 1): every row of the file counts, not only the ones the parser kept.
  const rowCount = table.totalRows ?? table.rows.length;
  if (rowCount > max) {
    if (tooMany === 'links') throw refuse(deps, 'validation_failed', 'MSG_JOB_ADD_TOO_MANY_LINKS', { max });
    throw refuse(deps, 'validation_failed', 'MSG_JOB_IMPORT_TOO_MANY_ROWS', { max, rows: rowCount });
  }
  return parseImportRows(table, chosen);
}

/** The name of a pasted import ("24 pasted links"). */
function pastedName(rows: number): string {
  return rows === 1 ? '1 pasted link' : `${rows.toLocaleString('en-US')} pasted links`;
}

/** The Google Sheet reader's account as a person or an admin sees it (no key file path, no project). */
function sheetAccountOf(reader: SheetTabReader): JobImportSheetAccount {
  try {
    const account = reader.account();
    return { configured: account.configured, clientEmail: account.configured ? account.clientEmail : null };
  } catch {
    return { configured: false, clientEmail: null };
  }
}

/** A tab's import reference (Import again reads it again). */
function sheetRefOf(read: Awaited<ReturnType<SheetTabReader['freshRead']>>, headerRow: number): JobImportSheetRef {
  return {
    url: tabUrlOf(read),
    spreadsheetId: read.spreadsheet.spreadsheetId,
    gid: read.tab.gid,
    headerRow,
    spreadsheetTitle: read.spreadsheet.title,
    tabTitle: read.tab.title,
  };
}

/** A sheet preview: the tab's rows from its header row, with the sheet's own name. */
function sheetPreview(deps: Deps, read: Awaited<ReturnType<SheetTabReader['freshRead']>>, body: { headerRow?: number; hasHeader?: boolean; mapping?: JobRowMappingInput }, maxRows: number): JobImportPreview {
  const table = sheetRowTable(read, body.headerRow ?? 1, body.hasHeader);
  return {
    ...importPreview(deps, table, { name: defaultSheetSourceName(read.spreadsheet.title, read.tab.title), mapping: body.mapping, maxRows }),
    // v35 IMPORTWEB: the spreadsheet's tabs, for the tab choice (a tab's gid is sent back).
    spreadsheet: {
      title: read.spreadsheet.title,
      url: tabUrlOf(read),
      gid: read.tab.gid,
      tabs: read.spreadsheet.tabs.map((tab) => ({ gid: tab.gid, title: tab.title, hidden: tab.hidden })),
    },
  };
}

// ------------------------------------------------------------------------------------------------- admins

/** Mounted at /api/admin/imports (administrators only). */
export function createAdminImportsRouter(deps: AppDeps): Router {
  const upload: RequestHandler = (req, res, next) => getFileStore(deps).uploadSingle('file', { required: false })(req, res, next);
  const reader = createSheetTabReader(deps);
  const max = () => ({ paste: constantsOf(deps).get('ADMIN_ADD_LINKS_MAX'), file: SHEET_MAX_ROWS });

  const started = async (runId: number | null, importId: number): Promise<AdminImportStarted> => {
    const summary = await adminImportSummary(deps, importId);
    if (!summary || runId === null) throw new Error('import: the started import is gone');
    return { runId, import: summary };
  };

  return adminRouter(deps, {
    resource: 'import',
    routes(router, { handle, audit }) {
      router.post(
        '/link',
        handle(async (req, admin) => {
          const body = parseInput(AdminImportLinkBodySchema, req.body ?? {}, 'job');
          const cells = JOB_ROW_FIELDS.map((field) => body[field] ?? '');
          const table = rowTableOf('paste', [{ row: 1, cells }], false);
          const rows = parseImportRows(table, mappingOf(table));
          const source = await deps.db.tx((t) => pastedLinksSource(t, nowIso(deps)), { label: 'import source' });
          const made = await startImport(deps, { kind: 'admin', way: 'link', name: '1 link', rows, actorId: admin.id, origin: 'admin', source });
          await audit({ action: 'import', ids: [made.importId], actor: admin, change: { way: 'link', rows: 1 } });
          req.res!.status(201);
          return started(made.runId, made.importId);
        }),
      );
      router.post(
        '/paste/preview',
        handle((req) => {
          const body = parseInput(AdminImportPasteBodySchema, req.body ?? {}, 'links');
          const table = tableOfPaste(body.text, body.hasHeader);
          return importPreview(deps, table, { name: pastedName(table.rows.length), mapping: body.mapping, maxRows: max().paste });
        }),
      );
      router.post(
        '/paste',
        handle(async (req, admin) => {
          const body = parseInput(AdminImportPasteBodySchema, req.body ?? {}, 'links');
          const table = tableOfPaste(body.text, body.hasHeader);
          const rows = rowsToImport(deps, table, body.mapping, max().paste, 'links');
          const source = await deps.db.tx((t) => pastedLinksSource(t, nowIso(deps)), { label: 'import source' });
          const made = await startImport(deps, {
            kind: 'admin',
            way: 'paste',
            name: pastedName(rows.length),
            rows,
            actorId: admin.id,
            origin: 'admin',
            source,
            config: { mapping: mappingOf(table, body.mapping) },
          });
          await audit({ action: 'import', ids: [made.importId], actor: admin, change: { way: 'paste', rows: rows.length } });
          req.res!.status(201);
          return started(made.runId, made.importId);
        }),
      );
      router.post(
        '/file/preview',
        upload,
        handle(async (req) => {
          const file = uploadOf(req);
          const table = await tableOfUpload(deps, file, max().file);
          return importPreview(deps, table, { name: file.fileName, mapping: file.mapping, maxRows: max().file });
        }),
      );
      router.post(
        '/file',
        upload,
        handle(async (req, admin) => {
          const file = uploadOf(req);
          const table = await tableOfUpload(deps, file, max().file);
          const rows = rowsToImport(deps, table, file.mapping, max().file, 'rows');
          const source = await deps.db.tx((t) => fileImportSource(t, file.fileName, nowIso(deps)), { label: 'import source' });
          const made = await startImport(deps, {
            kind: 'admin',
            way: 'file',
            name: table.sheet !== undefined ? `${file.fileName} (${table.sheet})` : file.fileName,
            rows,
            actorId: admin.id,
            origin: 'import',
            source,
            config: { mapping: mappingOf(table, file.mapping) },
          });
          await audit({ action: 'import', ids: [made.importId], actor: admin, change: { way: 'file', fileName: file.fileName, rows: rows.length } });
          req.res!.status(201);
          return started(made.runId, made.importId);
        }),
      );
      router.get('/sheet/account', handle(() => sheetAccountOf(reader)));
      router.post(
        '/sheet/preview',
        handle(async (req, admin) => {
          const body = parseInput(JobImportSheetBodySchema, req.body ?? {}, 'sheet');
          const target = reader.targetOf(body.url, body.gid);
          const { read } = await reader.read(`admin:${admin.id}`, req.res!, target, body.refresh === false);
          await claimSheet(deps, target.request.spreadsheetId, ADMIN_SHEET_READER); // v35 FIX-STORE (S3)
          return sheetPreview(deps, read, body, max().file);
        }),
      );
      router.post(
        '/sheet',
        handle(async (req, admin) => {
          const body = parseInput(JobImportSheetBodySchema, req.body ?? {}, 'sheet');
          const target = reader.targetOf(body.url, body.gid);
          const read = await reader.freshRead(`admin:${admin.id}`, req.res!, target);
          await claimSheet(deps, target.request.spreadsheetId, ADMIN_SHEET_READER); // v35 FIX-STORE (S3)
          reader.clear(`admin:${admin.id}`);
          const headerRow = body.headerRow ?? 1;
          const table = sheetRowTable(read, headerRow, body.hasHeader);
          const rows = rowsToImport(deps, table, body.mapping, max().file, 'rows');
          const ref = sheetRefOf(read, headerRow);
          const name = defaultSheetSourceName(read.spreadsheet.title, read.tab.title);
          const source = await deps.db.tx((t) => sheetImportSource(t, ref, name, nowIso(deps)), { label: 'import source' });
          const made = await startImport(deps, {
            kind: 'admin',
            way: 'sheet',
            name,
            rows,
            actorId: admin.id,
            origin: 'sheets',
            source,
            config: { sheet: ref, mapping: mappingOf(table, body.mapping) },
          });
          await audit({ action: 'import', ids: [made.importId], actor: admin, change: { way: 'sheet', spreadsheetId: ref.spreadsheetId, gid: ref.gid } });
          req.res!.status(201);
          return started(made.runId, made.importId);
        }),
      );
      router.get(
        '/',
        handle((req) => {
          const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 40) : undefined;
          return listAdminImports(deps, cursor);
        }),
      );
      router.get(
        '/:runId',
        handle(async (req) => {
          const id = PositiveId.safeParse(req.params.runId);
          const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 20) : undefined;
          // v35 IMPORTWEB: ?result=a,b (the results' chips).
          const detail = id.success ? await importDetail(deps, { runId: id.data }, cursor, importRowResultsOf(req.query.result)) : null;
          if (!detail) throw notFound('That import');
          return detail;
        }),
      );
      // v35 FIX-STORE (the final review's S4): "Download these rows", a CSV of its own.
      router.get(
        '/:runId/needs-details.csv',
        handle(async (req) => {
          const id = PositiveId.safeParse(req.params.runId);
          const file = id.success ? await needsDetailsCsv(deps, { runId: id.data }) : null;
          if (!file) throw notFound('That import');
          sendCsv(req.res!, file);
          return undefined;
        }),
      );
    },
  });
}

/** v35 FIX-STORE (S4): a CSV file to save (text/csv in UTF-8, its file name, never cached). */
function sendCsv(res: Response, file: { fileName: string; text: string }): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(file.text);
}

// ------------------------------------------------------------------------------------------------- people

/** The person's rows a day (their plan's): FREE_/PAID_JOB_IMPORT_ROWS_PER_DAY. */
async function dayLimitOf(deps: Deps, actorId: string): Promise<number | null> {
  const row = (await deps.db.one<AccountRow>(ACCOUNT_ROW_SQL, [actorId])) ?? { account_type: 'free' as const, paid_until: null };
  const paid = effectiveType(row, deps.now()) === 'paid';
  return constantsOf(deps).get(paid ? 'PAID_JOB_IMPORT_ROWS_PER_DAY' : 'FREE_JOB_IMPORT_ROWS_PER_DAY');
}

/** The routes of a person's imports, added to the /api/jobs links router (createJobLinksRouter). */
export function addJobImportRoutes(deps: AppDeps, router: Router): void {
  const upload: RequestHandler = (req, res, next) => getFileStore(deps).uploadSingle('file', { required: false })(req, res, next);
  const reader = createSheetTabReader(deps);
  const limit = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: () => constantsOf(deps).get('JOB_IMPORTS_PER_MINUTE'),
    key: (req) => `job-imports:${rateKeyOf(req, MINUTE_MS)}`,
    message: () => constantsOf(deps).message('MSG_JOB_IMPORT_BUSY'),
  });
  // v35 FIX-STORE (the final review's S7): the reads of a person's imports (the list, the results and their polls, the
  // download), JOB_IMPORT_READS_PER_MINUTE a minute.
  const reads = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: () => constantsOf(deps).get('JOB_IMPORT_READS_PER_MINUTE'),
    key: (req) => `job-import-reads:${rateKeyOf(req, MINUTE_MS)}`,
    message: () => constantsOf(deps).message('MSG_JOB_IMPORT_READS_BUSY'),
  });
  const maxRows = () => constantsOf(deps).get('JOB_IMPORT_ROWS_MAX');

  /** Starts a person's import on the profile in use (the owner's tracker), counted toward the person acting. */
  const start = async (req: Request, res: Response, input: Pick<StartImportInput, 'way' | 'name' | 'rows' | 'origin' | 'config'>) => {
    const owner = userOf(req);
    const actor = actorOf(req);
    const dayLimit = await dayLimitOf(deps, actor.id);
    const made = await startImport(deps, {
      kind: 'user',
      ...input,
      actorId: actor.id,
      userId: owner.id,
      grantId: req.acting?.grantId ?? null,
      dayLimit,
    });
    const summary = await userImportSummary(deps, made.importId, owner.id);
    if (!summary) throw new Error('import: the started import is gone');
    const body: JobImportStarted = { import: summary, rowsLeftToday: made.rowsLeftToday, retryAt: made.retryAt };
    res.status(201).json(body);
  };

  /** A person's preview: the import's, with the rows they may still import today. */
  const withRoom = async (req: Request, preview: JobImportPreview): Promise<JobImportPreview> => ({
    ...preview,
    rowsLeftToday: await rowsLeftFor(deps, actorOf(req).id),
  });

  router.post('/imports/file/preview', limit, upload, async (req, res) => {
    const file = uploadOf(req);
    const table = await tableOfUpload(deps, file, maxRows());
    res.json(await withRoom(req, importPreview(deps, table, { name: file.fileName, mapping: file.mapping, maxRows: maxRows() })));
  });

  router.post('/imports/file', limit, upload, async (req, res) => {
    const file = uploadOf(req);
    const table = await tableOfUpload(deps, file, maxRows());
    const rows = rowsToImport(deps, table, file.mapping, maxRows(), 'rows');
    await start(req, res, {
      way: 'file',
      name: table.sheet !== undefined ? `${file.fileName} (${table.sheet})` : file.fileName,
      rows,
      origin: 'import',
      config: { mapping: mappingOf(table, file.mapping) },
    });
  });

  router.get('/imports/sheet/account', limit, (_req, res) => {
    res.json(sheetAccountOf(reader));
  });

  /**
   * v35 FIX-STORE (the final review's S3): who reads a sheet here: the person whose profile the import lands on (userOf),
   * or, on their own profile, an administrator (who reads any sheet). The read's key keeps an administrator's reads
   * (every tab) apart from their reads as a person (no hidden tab).
   */
  const sheetReaderOf = (req: Request): { who: SheetReader; key: string; person?: { tabNotFound: string } } => {
    const owner = userOf(req);
    const actor = actorOf(req).id;
    if (!req.acting && owner.role === 'admin') return { who: ADMIN_SHEET_READER, key: `user:${actor}:admin` };
    return {
      who: { kind: 'person', userId: owner.id },
      key: `user:${actor}`,
      person: { tabNotFound: constantsOf(deps).message('MSG_JOB_IMPORT_SHEET_TAB_NOT_FOUND') },
    };
  };

  router.post('/imports/sheet/preview', limit, async (req, res) => {
    const body = parseInput(JobImportSheetBodySchema, req.body ?? {}, 'sheet');
    const { who, key, person } = sheetReaderOf(req);
    const target = reader.targetOf(body.url, body.gid, person);
    await assertSheetReadable(deps, target.request.spreadsheetId, who); // v35 FIX-STORE (S3)
    const { read } = await reader.read(key, res, target, body.refresh === false);
    await claimSheet(deps, target.request.spreadsheetId, who);
    res.json(await withRoom(req, sheetPreview(deps, read, body, maxRows())));
  });

  router.post('/imports/sheet', limit, async (req, res) => {
    const body = parseInput(JobImportSheetBodySchema, req.body ?? {}, 'sheet');
    const { who, key, person } = sheetReaderOf(req);
    const target = reader.targetOf(body.url, body.gid, person);
    await assertSheetReadable(deps, target.request.spreadsheetId, who); // v35 FIX-STORE (S3)
    const read = await reader.freshRead(key, res, target);
    await claimSheet(deps, target.request.spreadsheetId, who);
    reader.clear(key);
    const headerRow = body.headerRow ?? 1;
    const table = sheetRowTable(read, headerRow, body.hasHeader);
    const rows = rowsToImport(deps, table, body.mapping, maxRows(), 'rows');
    await start(req, res, {
      way: 'sheet',
      name: defaultSheetSourceName(read.spreadsheet.title, read.tab.title),
      rows,
      origin: 'sheets',
      config: { sheet: sheetRefOf(read, headerRow), mapping: mappingOf(table, body.mapping) },
    });
  });

  // v35 FIX-STORE (the fix list's item 9): the profile's imports, newest first (Add job's latest import on every device).
  // At /imports/recent: GET /api/jobs/imports is the jobs router's GET /api/jobs/:id (mounted first: "That job was not
  // found"). Before /imports/:id, whose id it is not.
  router.get('/imports/recent', reads, async (req, res) => {
    const query = parseInput(UserImportsQuerySchema, req.query, 'query');
    res.json(await listUserImports(deps, userOf(req).id, query.limit, query.cursor));
  });

  // v35 FIX-STORE (S7): read JOB_IMPORT_READS_PER_MINUTE times a minute at most (the web polls it while rows are read).
  router.get('/imports/:id', reads, async (req, res) => {
    const id = PositiveId.safeParse(req.params.id);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 20) : undefined;
    // v35 IMPORTWEB: ?result=a,b (the results' chips).
    const detail = id.success ? await importDetail(deps, { importId: id.data, userId: userOf(req).id }, cursor, importRowResultsOf(req.query.result)) : null;
    if (!detail) throw notFound('That import');
    res.json(detail);
  });

  // v35 FIX-STORE (the final review's S4): "Download these rows", a CSV of its own.
  router.get('/imports/:id/needs-details.csv', reads, async (req, res) => {
    const id = PositiveId.safeParse(req.params.id);
    const file = id.success ? await needsDetailsCsv(deps, { importId: id.data, userId: userOf(req).id }) : null;
    if (!file) throw notFound('That import');
    sendCsv(res, file);
  });
}

/** v35 FIX-STORE: GET /api/jobs/imports's query: at most 20 imports a page (20 when not said), after import `cursor`. */
const UserImportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(20),
  cursor: z.string().regex(/^\d{1,18}$/).optional(),
});

/** v35 IMPORT: a person's rows left today (the Add job dialog's line), counted toward the person acting. */
export async function rowsLeftFor(deps: AppDeps, actorId: string): Promise<number | null> {
  return rowsLeftToday(deps, actorId, await dayLimitOf(deps, actorId));
}
