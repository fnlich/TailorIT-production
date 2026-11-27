import {
  AdminJobEditorSchema,
  AdminJobEditSavedSchema,
  AdminJobReadSchema,
  type AdminJobEditBody,
  type AdminJobEditor,
  type AdminJobEditSaved,
  type AdminJobRead,
  type JobEditField,
} from '@tailorit/shared/reviews';
import { api } from '@/lib/api';
import { reviewKeys } from '../api';

// v38 REVEDIT (SP v38 PLAN.md E1-E6): Edit job's requests (the API's job-reviews/edit/routes.ts), in one place.

export const JOB_EDIT_ROUTES = {
  editor: (jobId: number) => `/api/admin/reviews/jobs/${jobId}`,
  read: (jobId: number) => `/api/admin/reviews/jobs/${jobId}/read`,
  restore: (jobId: number) => `/api/admin/reviews/jobs/${jobId}/restore`,
} as const;

/** The editor's React Query key (under Review's, so a lane's refresh reads it again too). */
export const jobEditKey = (jobId: number) => [...reviewKeys.all, 'edit', jobId] as const;

/** GET: the job's values, its version, the fields an admin edited. */
export function fetchJobEditor(jobId: number, signal?: AbortSignal): Promise<AdminJobEditor> {
  return api.get<AdminJobEditor>(JOB_EDIT_ROUTES.editor(jobId), { signal, schema: AdminJobEditorSchema });
}

/** PATCH: the changed values (saved), or the job TailorIT already has of a new link (nothing saved). */
export function saveJobEdit(jobId: number, body: AdminJobEditBody): Promise<AdminJobEditSaved> {
  return api.patch<AdminJobEditSaved>(JOB_EDIT_ROUTES.editor(jobId), body, { schema: AdminJobEditSavedSchema });
}

/** POST …/read: "Read this link" now, through the one link verdict. */
export function readJobLink(jobId: number): Promise<AdminJobRead> {
  return api.post<AdminJobRead>(JOB_EDIT_ROUTES.read(jobId), {}, { schema: AdminJobReadSchema });
}

/** POST …/restore: "Use the posting's text again" for one field. */
export function restoreJobField(jobId: number, field: JobEditField): Promise<AdminJobEditor> {
  return api.post<AdminJobEditor>(JOB_EDIT_ROUTES.restore(jobId), { field }, { schema: AdminJobEditorSchema });
}
