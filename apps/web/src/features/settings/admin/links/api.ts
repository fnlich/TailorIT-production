import {
  LinkBatchProgressSchema,
  QueuedLinksSchema,
  type LinkBatchProgress,
  type QueuedLinks,
} from '@tailorit/shared/jobs';
import { api } from '@/lib/api';

// v31 ADMINWEB: an admin's links (LINK's routes, apps/api/src/features/jobs/add/router.ts), in one place.

export const LINK_ROUTES = {
  add: '/api/admin/jobs/add',
  batch: (batchId: string) => `/api/admin/jobs/add/${encodeURIComponent(batchId)}`,
} as const;

/** React Query keys (under the admin console's own `['admin', …]`). */
export const linkKeys = {
  all: ['admin', 'links'] as const,
  batch: (batchId: string) => ['admin', 'links', 'batch', batchId] as const,
};

/** POST /api/admin/jobs/add: queues the links for TailorIT's own read (202), at most ADMIN_ADD_LINKS_MAX. */
export function addLinks(urls: readonly string[]): Promise<QueuedLinks> {
  return api.post<QueuedLinks>(LINK_ROUTES.add, { urls }, { schema: QueuedLinksSchema });
}

/** GET /api/admin/jobs/add/:batchId: a batch's progress (an import run's links: `run:<runId>`). */
export function fetchLinkBatch(batchId: string, signal?: AbortSignal): Promise<LinkBatchProgress> {
  return api.get<LinkBatchProgress>(LINK_ROUTES.batch(batchId), { signal, schema: LinkBatchProgressSchema });
}
