import type { JobReportBody } from '@tailorit/shared';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

// v30 ST5: the flag button's request and its mutation, moved unchanged from jobs/api.ts and jobs/hooks.ts with the flag
// dialog (report/ReportDialog.tsx), so the job reports' web side is one folder (X1-WEB, wave 2).

/** POST /api/jobs/:id/report: why a posting is wrong, for the admin console. */
export const reportJob = (id: number, body: JobReportBody) => api.post(`/api/jobs/${id}/report`, body);

export function useReportJob() {
  return useMutation({
    mutationFn: ({ jobId, body }: { jobId: number; body: JobReportBody }) => reportJob(jobId, body),
  });
}
