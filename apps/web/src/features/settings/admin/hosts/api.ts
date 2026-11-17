import { z } from 'zod';
import { AdminHostSchema, AdminHostsListSchema, type AdminHost, type AdminHostHoldBody } from '@tailorit/shared/sourcing';
import { api } from '@/lib/api';

// v30 S1-WEB: Admin › Hosts' calls (12 §9.4, §9.8: each host's pace, holds, breaker, robots.txt and content signals).
// Answers are CT's (@tailorit/shared/sourcing); S1-API names the routes. A host is named in the path, encoded.

export type HostShow = 'all' | 'held' | 'failing';

export interface HostFilters {
  q: string;
  show: HostShow;
}

export type AdminHostsPage = z.infer<typeof AdminHostsListSchema>;

/** React Query keys of Hosts (under ['admin', 'hosts']). */
export const hostKeys = {
  all: ['admin', 'hosts'] as const,
  page: (filters: HostFilters) => ['admin', 'hosts', 'page', filters] as const,
  detail: (host: string) => ['admin', 'hosts', 'detail', host] as const,
};

/** The list's query string. */
export function hostsQuery(filters: HostFilters, cursor?: string) {
  return {
    q: filters.q.trim() || undefined,
    held: filters.show === 'held' ? 1 : undefined,
    failing: filters.show === 'failing' ? 1 : undefined,
    cursor,
  };
}

/** GET /api/admin/hosts?q&held&failing&cursor&limit. */
export function fetchHostsPage(filters: HostFilters, cursor?: string, signal?: AbortSignal): Promise<AdminHostsPage> {
  return api.get<AdminHostsPage>('/api/admin/hosts', { signal, query: hostsQuery(filters, cursor), schema: AdminHostsListSchema });
}

/** GET /api/admin/hosts/:host: the row and its robots.txt. */
export function fetchHost(host: string, signal?: AbortSignal): Promise<AdminHost> {
  return api.get<AdminHost>(`/api/admin/hosts/${encodeURIComponent(host)}`, { signal, schema: AdminHostSchema });
}

/** POST /api/admin/hosts/:host/hold: hold it for some hours (an admin's hold), or release its hold. */
export function holdHost(host: string, body: AdminHostHoldBody): Promise<AdminHost> {
  return api.post<AdminHost>(`/api/admin/hosts/${encodeURIComponent(host)}/hold`, body, { schema: AdminHostSchema });
}
