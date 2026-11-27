import { AddJobResultSchema, type AddJobBody, type AddJobResult } from '@tailorit/shared';
import type { FanoutAddJobResult, FanoutRefused, ProfileChoice } from '@tailorit/shared/sharing';
import { api } from '@/lib/api';
import { addJobTo } from '../../sharing/fanout/api'; // v34 FANWEB

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

/** v34 FANWEB: an add on the tab's profile and, with "Also save to", on other profiles: the tab's answer and the others'. */
export interface AddOnProfiles {
  /** The tab's own profile's result (null: refused there, `refused`). */
  result: AddJobResult | null;
  /** v34 FANWEB fix (sharing L7): the tab's own profile's refusal (the others' adds are kept and said). */
  refused: FanoutRefused | null;
  /** The other profiles' results (empty without "Also save to"). */
  others: FanoutAddJobResult[];
}

/**
 * v34 FANWEB (PLAN G4: "Add job gets Also save to…"): the add on the tab's own profile alone (POST /api/jobs/add, as
 * before), or with other profiles in one request (POST /api/profiles/jobs/add: the add runs on each; a link TailorIT
 * cannot read is read once; one of the person's adds an hour). The tab's own result is the dialog's. v34 FANWEB fix
 * (sharing L7): a refusal of the tab's own profile comes back beside the others' results (never thrown: the job may be
 * added on the other profiles already, and a retry would spend another add).
 */
export async function addJobOnProfiles(body: AddJobBody, tab: ProfileChoice, also: readonly ProfileChoice[]): Promise<AddOnProfiles> {
  if (also.length === 0) return { result: await addJobByLink(body), refused: null, others: [] };
  const answer = await addJobTo([tab, ...also.filter((choice) => choice !== tab)], body.url, body.details, body.company); // v38 FIX-APP: company
  const others = answer.results.filter((entry) => entry.profile !== tab);
  const own = answer.results.find((entry) => entry.profile === tab);
  if (!own || !own.ok) {
    const refused: FanoutRefused = own && !own.ok ? own : { profile: tab, name: '', ok: false, refused: 'internal', message: '' };
    return { result: null, refused, others };
  }
  const result: AddJobResult = {
    state: own.state,
    jobId: own.jobId,
    url: own.url,
    reason: own.reason,
    created: own.created,
    needsDetails: own.needsDetails,
    message: own.message,
    ...(own.needsCompany ? { needsCompany: true } : {}), // v38 FIX-APP (D1)
  };
  return { result, refused: null, others };
}
