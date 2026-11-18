import { AddJobResultSchema, type AddJobBody, type AddJobResult } from '@tailorit/shared';
import { api } from '@/lib/api';

// v31 JOBSWEB: the web's two calls of the add-by-link pipeline (docs/design/v3.1/21-jobs-from-links.md §7). The
// server reads the posting from its link; nothing the person types reaches a job anyone else sees.

/**
 * POST /api/jobs/add: the Add job dialog. `details` (title, company, ...) only for a link TailorIT could not read
 * (`needsDetails`): they make the person's own job, seen by them alone. The job is saved to their tracker.
 */
export function addJobByLink(body: AddJobBody): Promise<AddJobResult> {
  return api.post<AddJobResult>('/api/jobs/add', body, { schema: AddJobResultSchema });
}

/** POST /api/jobs/:id/verify: Retry read of a job only its adder sees (the adder or an admin). */
export function retryJobRead(jobId: number): Promise<AddJobResult> {
  return api.post<AddJobResult>(`/api/jobs/${jobId}/verify`, undefined, { schema: AddJobResultSchema });
}
