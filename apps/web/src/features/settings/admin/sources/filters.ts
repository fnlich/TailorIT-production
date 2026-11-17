import { ADMIN_PAGE_DEFAULT } from '@tailorit/shared/reviews';
import {
  ADMIN_SOURCE_SORTS,
  JOB_SOURCE_KINDS,
  JOB_SOURCE_KINDS_NOT_BUILT,
  type AdminSourceSort,
  type JobSourceDiscoveredVia,
  type JobSourceKind,
  type JobSourceRobotsStatus,
  type JobSourceTermsStatus,
  type JobSourceTier,
} from '@tailorit/shared/sourcing';

// v30 S1-WEB: Admin › Sources' filters (12 §9.8: kind, tier, status, terms, robots, failing), its search and order, as
// the query string CT's AdminSourcesQuerySchema reads. Pure, so the web tests check the query against the schema.

export type SourceEnabledFilter = 'all' | 'enabled' | 'disabled';

export interface SourceFilters {
  /** Name or host. */
  q: string;
  kinds: readonly JobSourceKind[];
  tiers: readonly JobSourceTier[];
  terms: readonly JobSourceTermsStatus[];
  robots: readonly JobSourceRobotsStatus[];
  via: readonly JobSourceDiscoveredVia[];
  enabled: SourceEnabledFilter;
  /** Only sources failing now. */
  failing: boolean;
  /** One host's sources (from Admin › Hosts). */
  host: string | null;
  /** One company's sources. */
  companyId: number | null;
  sort: AdminSourceSort;
}

export const EMPTY_SOURCE_FILTERS: SourceFilters = {
  q: '',
  kinds: [],
  tiers: [],
  terms: [],
  robots: [],
  via: [],
  enabled: 'all',
  failing: false,
  host: null,
  companyId: null,
  sort: 'next_run',
};

/** The kinds the Kind filter offers: every kind v3.0 builds (the Nordic feeds and a licensed feed are not). */
export const FILTER_KINDS: readonly JobSourceKind[] = JOB_SOURCE_KINDS.filter(
  (kind) => !(JOB_SOURCE_KINDS_NOT_BUILT as readonly JobSourceKind[]).includes(kind),
);

export const SOURCE_SORT_LABEL: Record<AdminSourceSort, string> = {
  next_run: 'Next run',
  last_run: 'Last run',
  name: 'Name',
  open_jobs: 'Open jobs',
  failures: 'Failures',
};

export const SOURCE_SORT_OPTIONS = ADMIN_SOURCE_SORTS.map((value) => ({ value, label: `Sort: ${SOURCE_SORT_LABEL[value]}` }));

export const SOURCE_ENABLED_LABEL: Record<SourceEnabledFilter, string> = {
  all: 'Enabled and paused',
  enabled: 'Enabled',
  disabled: 'Paused',
};

/** The query string of a page: the filters CT reads, the lists as repeated keys, empty ones left out. */
export function sourcesQuery(filters: SourceFilters, cursor?: string, limit: number = ADMIN_PAGE_DEFAULT) {
  return {
    q: filters.q.trim() || undefined,
    kind: filters.kinds.length ? [...filters.kinds] : undefined,
    tier: filters.tiers.length ? [...filters.tiers] : undefined,
    terms: filters.terms.length ? [...filters.terms] : undefined,
    robots: filters.robots.length ? [...filters.robots] : undefined,
    discoveredVia: filters.via.length ? [...filters.via] : undefined,
    enabled: filters.enabled === 'all' ? undefined : filters.enabled,
    failing: filters.failing ? 1 : undefined,
    host: filters.host ?? undefined,
    companyId: filters.companyId ?? undefined,
    sort: filters.sort,
    cursor,
    limit,
  };
}

/** How many filters narrow the list (the search and the order aside). */
export function activeFilterCount(filters: SourceFilters): number {
  return (
    filters.kinds.length +
    filters.tiers.length +
    filters.terms.length +
    filters.robots.length +
    filters.via.length +
    (filters.enabled === 'all' ? 0 : 1) +
    (filters.failing ? 1 : 0) +
    (filters.host ? 1 : 0) +
    (filters.companyId ? 1 : 0)
  );
}

/** Whether the list is narrowed at all (a search or a filter): its empty state says "no match", not "no sources". */
export function isFiltered(filters: SourceFilters): boolean {
  return filters.q.trim() !== '' || activeFilterCount(filters) > 0;
}

/** The filters with every narrowing cleared (the order kept). */
export function clearedFilters(filters: SourceFilters): SourceFilters {
  return { ...EMPTY_SOURCE_FILTERS, sort: filters.sort };
}

/** The filters an address opens with: `host=` (Admin › Hosts' "See its sources") and `company=`. */
export function filtersFromAddress(params: { get(name: string): string | null }): SourceFilters {
  const host = params.get('host')?.trim().toLowerCase() || null;
  const company = Number(params.get('company'));
  return { ...EMPTY_SOURCE_FILTERS, host, companyId: Number.isInteger(company) && company > 0 ? company : null };
}

/** `values` with `value` added (on) or removed (off), in `order`'s order. */
export function toggledIn<V extends string>(values: readonly V[], value: V, on: boolean, order: readonly V[]): V[] {
  const next = new Set(values);
  if (on) next.add(value);
  else next.delete(value);
  return order.filter((item) => next.has(item));
}

