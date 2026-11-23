import {
  AdminImportStartedSchema,
  JobImportDetailSchema,
  JobImportListSchema,
  JobImportPreviewSchema,
  JobImportSheetAccountSchema,
  JobImportStartedSchema,
  type AdminImportStarted,
  type JobImportDetail,
  type JobImportList,
  type JobImportPreview,
  type JobImportSheetAccount,
  type JobImportStarted,
  type JobImportSummary,
  type JobRowMappingInput,
} from '@tailorit/shared';
import { ApiError, UNREACHABLE_MESSAGE, api } from '@/lib/api';
import { profileHeaders } from '@/lib/profile';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1): the calls the shared import screens make, for an admin (Admin ›
// Import: /api/admin/imports, each import one run on Runs) or a person (Jobs › Add job: /api/jobs/imports, on the tab's
// profile, as Add job is). The routes and answers are IMPORT's (apps/api/src/features/jobs/add/import-router.ts); an
// admin's import is opened by its run, a person's by its own id. An admin's own ways (one link, many links, Recent
// imports) are Admin › Import's (features/settings/admin/import/api.ts).

/** Whose import screens these are. */
export type ImportAudience = 'admin' | 'people';

const BASE: Record<ImportAudience, string> = { admin: '/api/admin/imports', people: '/api/jobs/imports' };

export const IMPORT_ROUTES = {
  base: (audience: ImportAudience) => BASE[audience],
  filePreview: (audience: ImportAudience) => `${BASE[audience]}/file/preview`,
  file: (audience: ImportAudience) => `${BASE[audience]}/file`,
  sheetAccount: (audience: ImportAudience) => `${BASE[audience]}/sheet/account`,
  sheetPreview: (audience: ImportAudience) => `${BASE[audience]}/sheet/preview`,
  sheet: (audience: ImportAudience) => `${BASE[audience]}/sheet`,
  /** An admin's import by its run, a person's by its id. */
  detail: (audience: ImportAudience, id: number) => `${BASE[audience]}/${id}`,
  /** v35 FIX-WEB: a person's imports, newest first (FIX-STORE's route; the fix list's item 9). */
  recent: '/api/jobs/imports/recent',
  /** v35 FIX-WEB (the final review's S4): "Download these rows", a CSV the API makes (FIX-STORE's route). */
  needsDetails: (audience: ImportAudience, id: number) => `${BASE[audience]}/${id}/needs-details.csv`,
} as const;

/** React Query keys. */
export const importKeys = {
  all: ['imports'] as const,
  of: (audience: ImportAudience) => ['imports', audience] as const,
  sheetAccount: (audience: ImportAudience) => ['imports', audience, 'sheet-account'] as const,
  detail: (audience: ImportAudience, id: number, result: string | null) => ['imports', audience, 'detail', id, result ?? 'all'] as const,
  details: (audience: ImportAudience, id: number) => ['imports', audience, 'detail', id] as const,
  /** v35 FIX-WEB: a person's latest import on the profile in use (GET /api/jobs/imports/recent?limit=1). */
  latest: (profile: string | null) => ['imports', 'people', 'latest', profile ?? 'me'] as const,
};

/** What a file import sends beside the file: the mapping (JSON), whether the first row is a header, an .xlsx sheet. */
export interface FileChoices {
  mapping?: JobRowMappingInput | null;
  hasHeader?: boolean;
  sheet?: string | null;
}

/** The multipart body of a file import (IMPORT's `file` + form fields). */
export function fileForm(file: File, choices: FileChoices = {}): FormData {
  const form = new FormData();
  form.append('file', file, file.name);
  if (choices.mapping) form.append('mapping', JSON.stringify(choices.mapping));
  if (choices.hasHeader !== undefined) form.append('hasHeader', choices.hasHeader ? 'true' : 'false');
  if (choices.sheet) form.append('sheet', choices.sheet);
  return form;
}

/** A Google Sheet's tab as a preview and an import send it. */
export interface SheetChoices {
  url: string;
  gid?: number;
  headerRow?: number;
  mapping?: JobRowMappingInput | null;
  hasHeader?: boolean;
  /** Preview only: false reuses the server's last read of the tab (a new mapping or header choice). */
  refresh?: boolean;
}

function sheetBody(choices: SheetChoices, preview: boolean): Record<string, unknown> {
  return {
    url: choices.url,
    ...(choices.gid !== undefined ? { gid: choices.gid } : {}),
    ...(choices.headerRow !== undefined ? { headerRow: choices.headerRow } : {}),
    ...(choices.mapping ? { mapping: choices.mapping } : {}),
    ...(choices.hasHeader !== undefined ? { hasHeader: choices.hasHeader } : {}),
    ...(preview && choices.refresh !== undefined ? { refresh: choices.refresh } : {}),
  };
}

/**
 * An import started, either way: the id its results are read by (an admin's run, a person's import), the import, and a
 * person's rows left today (null for an admin's, or no limit).
 */
export interface StartedImport {
  id: number;
  summary: JobImportSummary;
  rowsLeftToday: number | null;
  retryAt: string | null;
}

/** An import's answer, the same shape for both audiences. */
export function startedOf(audience: ImportAudience, answer: AdminImportStarted | JobImportStarted): StartedImport {
  if (audience === 'admin') {
    const admin = answer as AdminImportStarted;
    return { id: admin.runId, summary: admin.import, rowsLeftToday: null, retryAt: null };
  }
  const person = answer as JobImportStarted;
  return { id: person.import.id, summary: person.import, rowsLeftToday: person.rowsLeftToday, retryAt: person.retryAt };
}

const startedSchema = (audience: ImportAudience) => (audience === 'admin' ? AdminImportStartedSchema : JobImportStartedSchema);

/** POST .../file/preview: the file's guessed (or chosen) mapping and first rows; nothing is saved. */
export function previewFile(audience: ImportAudience, file: File, choices: FileChoices, signal?: AbortSignal): Promise<JobImportPreview> {
  return api.post<JobImportPreview>(IMPORT_ROUTES.filePreview(audience), fileForm(file, choices), { signal, schema: JobImportPreviewSchema });
}

/** POST .../file: imports the file's rows (201). */
export async function importFile(audience: ImportAudience, file: File, choices: FileChoices): Promise<StartedImport> {
  const answer = await api.post<AdminImportStarted | JobImportStarted>(IMPORT_ROUTES.file(audience), fileForm(file, choices), {
    schema: startedSchema(audience),
  });
  return startedOf(audience, answer);
}

/** GET .../sheet/account: whether this server reads Google Sheets, and the address to share a sheet with. */
export function fetchSheetAccount(audience: ImportAudience, signal?: AbortSignal): Promise<JobImportSheetAccount> {
  return api.get<JobImportSheetAccount>(IMPORT_ROUTES.sheetAccount(audience), { signal, schema: JobImportSheetAccountSchema });
}

/** POST .../sheet/preview: the tab's mapping and first rows, and the spreadsheet's tabs. */
export function previewSheet(audience: ImportAudience, choices: SheetChoices, signal?: AbortSignal): Promise<JobImportPreview> {
  return api.post<JobImportPreview>(IMPORT_ROUTES.sheetPreview(audience), sheetBody(choices, true), { signal, schema: JobImportPreviewSchema });
}

/** POST .../sheet: reads the tab again and imports its rows (201). */
export async function importSheet(audience: ImportAudience, choices: SheetChoices): Promise<StartedImport> {
  const answer = await api.post<AdminImportStarted | JobImportStarted>(IMPORT_ROUTES.sheet(audience), sheetBody(choices, false), {
    schema: startedSchema(audience),
  });
  return startedOf(audience, answer);
}

/** GET an import: its counts, a page of rows after `cursor` (of the results `result` names), the rows to fill in. */
export function fetchImportDetail(
  audience: ImportAudience,
  id: number,
  page: { cursor?: string | null; result?: string | null } = {},
  signal?: AbortSignal,
): Promise<JobImportDetail> {
  return api.get<JobImportDetail>(IMPORT_ROUTES.detail(audience, id), {
    signal,
    query: { cursor: page.cursor ?? undefined, result: page.result ?? undefined },
    schema: JobImportDetailSchema,
  });
}

// v35 FIX-WEB (the final review's S4; the fix list's item 9): "Download these rows" from the API's CSV route, and a
// person's latest import from the API (every device), not from this browser.

/** A file the API answered: its name (Content-Disposition's, else the fallback) and its bytes. */
export interface DownloadedFile {
  fileName: string;
  blob: Blob;
}

/** The file name a Content-Disposition header gives (`filename*=UTF-8''…` wins over `filename="…"`), or null. */
export function fileNameOf(header: string | null | undefined): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // the plain parameter below
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  const name = (plain?.[2] ?? plain?.[1] ?? '').trim();
  return name || null;
}

/**
 * GET …/needs-details.csv: the rows that need a title and company, as the CSV the API made (escaped cells). The request
 * names the profile in use, as every API request does (lib/profile.ts). A refusal (413: the file would be too large; 404)
 * throws an ApiError with the server's words.
 */
export async function downloadNeedsDetails(audience: ImportAudience, id: number, fallbackName: string): Promise<DownloadedFile> {
  const path = IMPORT_ROUTES.needsDetails(audience, id);
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'text/csv, application/json', ...profileHeaders(path) } });
  } catch {
    throw new ApiError({ status: 0, code: 'internal', message: UNREACHABLE_MESSAGE, path });
  }
  if (!response.ok) {
    let message = '';
    try {
      const body = (await response.json()) as { error?: { message?: unknown } | string };
      const error = body.error;
      message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
    } catch {
      // not JSON
    }
    throw new ApiError({
      status: response.status,
      code: response.status === 413 ? 'file_too_large' : response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limited' : 'internal',
      message: message || (response.status === 404 ? 'That import was not found.' : 'The rows did not download. Please try again.'),
      path,
    });
  }
  return { fileName: fileNameOf(response.headers.get('Content-Disposition')) ?? fallbackName, blob: await response.blob() };
}

/**
 * GET /api/jobs/imports/recent?limit=1: the profile's latest import (null: none yet). FIX-STORE's route: at /recent, as
 * GET /api/jobs/imports would be the jobs router's GET /api/jobs/:id.
 */
export async function fetchLatestImport(signal?: AbortSignal): Promise<JobImportSummary | null> {
  const list = await api.get<JobImportList>(IMPORT_ROUTES.recent, { signal, query: { limit: 1 }, schema: JobImportListSchema });
  return list.items[0] ?? null;
}
