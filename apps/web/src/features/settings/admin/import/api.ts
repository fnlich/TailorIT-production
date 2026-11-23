import {
  AdminImportStartedSchema,
  JobImportListSchema,
  JobImportPreviewSchema,
  type AdminImportLinkBody,
  type AdminImportPasteBody,
  type AdminImportStarted,
  type JobImportList,
  type JobImportPreview,
} from '@tailorit/shared';
import { api } from '@/lib/api';
import { IMPORT_ROUTES, startedOf, type StartedImport } from '../../../imports/api';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §2): Admin › Import's own calls beside the shared file and sheet ones
// (features/imports/api.ts): one link with its details, many links pasted (rows copied from a spreadsheet previewed),
// and Recent imports. IMPORT's routes (apps/api/src/features/jobs/add/import-router.ts); each import is one run on Runs.

export const ADMIN_IMPORT_ROUTES = {
  link: `${IMPORT_ROUTES.base('admin')}/link`,
  pastePreview: `${IMPORT_ROUTES.base('admin')}/paste/preview`,
  paste: `${IMPORT_ROUTES.base('admin')}/paste`,
  recent: IMPORT_ROUTES.base('admin'),
} as const;

/** React Query keys (under the shared imports' keys, so a new import refreshes them). */
export const adminImportKeys = {
  recent: ['imports', 'admin', 'recent'] as const,
};

/** POST /api/admin/imports/link: one link and the details given (201). */
export async function importOneLink(body: AdminImportLinkBody): Promise<StartedImport> {
  return startedOf('admin', await api.post<AdminImportStarted>(ADMIN_IMPORT_ROUTES.link, body, { schema: AdminImportStartedSchema }));
}

/** POST /api/admin/imports/paste/preview: rows copied from a spreadsheet, their mapping and first rows. */
export function previewPaste(body: AdminImportPasteBody, signal?: AbortSignal): Promise<JobImportPreview> {
  return api.post<JobImportPreview>(ADMIN_IMPORT_ROUTES.pastePreview, body, { signal, schema: JobImportPreviewSchema });
}

/** POST /api/admin/imports/paste: links one a line, or rows copied from a spreadsheet (201). */
export async function importPaste(body: AdminImportPasteBody): Promise<StartedImport> {
  return startedOf('admin', await api.post<AdminImportStarted>(ADMIN_IMPORT_ROUTES.paste, body, { schema: AdminImportStartedSchema }));
}

/** GET /api/admin/imports: Recent imports, newest first (a page after `cursor`). */
export function fetchRecentImports(cursor: string | null, signal?: AbortSignal): Promise<JobImportList> {
  return api.get<JobImportList>(ADMIN_IMPORT_ROUTES.recent, { signal, query: { cursor: cursor ?? undefined }, schema: JobImportListSchema });
}
