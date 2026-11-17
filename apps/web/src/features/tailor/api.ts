import {
  TailorAcceptedSchema,
  TailorTaskViewSchema,
  type TailorAccepted,
  type TailorRequest,
  type TailorTaskView,
} from '@tailorit/shared';
import { api } from '@/lib/api';

// v1.4 E (decision 16): the web pages' tailoring calls (builder D's routes): start a tailoring for a job or a tracker
// entry, then follow its task until it has made the resume and its letter.

export const tailorKeys = {
  task: (taskId: string) => ['tailor', 'task', taskId] as const,
};

/** POST /api/tailor: 202 {taskId, deduped} (the same tailoring within a day answers the earlier task). */
export function startTailor(body: TailorRequest): Promise<TailorAccepted> {
  return api.post<TailorAccepted>('/api/tailor', body, { schema: TailorAcceptedSchema });
}

/** GET /api/tailor/:taskId: where the tailoring stands, and once it succeeded what it made. */
export function fetchTailorTask(taskId: string, signal?: AbortSignal): Promise<TailorTaskView> {
  return api.get<TailorTaskView>(`/api/tailor/${encodeURIComponent(taskId)}`, { signal, schema: TailorTaskViewSchema });
}
