import { ADMIN_PAGE_DEFAULT } from '@tailorit/shared/reviews';
import {
  ADMIN_SOURCE_LIST_KINDS,
  ADMIN_SOURCE_SORTS,
  JOB_SOURCE_KINDS_NOT_BUILT,
  type AdminSourceEnabledFilter,
  type AdminSourceListKind,
  type AdminSourceTurnedOffPart,
  type AdminSourcesFilter,
  type AdminSourceSort,
  type JobSourceFoundVia,
  type JobSourceKind,
  type JobSourceRobotsStatus,
  type JobSourceTermsStatus,
  type JobSourceTier,
} from '@tailorit/shared/sourcing';

// v30 S1-WEB: Admin › Sources' filters (12 §9.8: kind, tier, status, terms, robots, failing), its search and order, as
// the query string CT's AdminSourcesQuerySchema reads. Pure, so the web tests check the query against the schema.

/** v36 SOURCES (PLAN S8): `waiting`, found and never turned on by an admin. */
export type SourceEnabledFilter = AdminSourceEnabledFilter;

export interface SourceFilters {
  /** Name or host. */
  q: string;
  kinds: readonly AdminSourceListKind[];
  tiers: readonly JobSourceTier[];
  terms: readonly JobSourceTermsStatus[];
  robots: readonly JobSourceRobotsStatus[];
  /** v35 OPSWEB: how it was found, "Found by import" (`import`) among them. */
  via: readonly JobSourceFoundVia[];
  enabled: SourceEnabledFilter;
  /** Only sources failing now. */
  failing: boolean;
  /** One host's sources (from Admin › Hosts). */
  host: string | null;
  /** One company's sources. */
  companyId: number | null;
  /** v36 SOURCES (PLAN S7): only the sources v3.6 turned off (the notice's), all or one part; null: any. */
  turnedOff: AdminSourceTurnedOffPart | null;
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
  turnedOff: null, // v36 SOURCES
  sort: 'next_run',
};

/**
 * The kinds the Kind filter offers: every kind v3.0 builds (the Nordic feeds and a licensed feed are not). v35 OPSWEB
 * (PLAN H6): an import is not a source, so its records' kinds (csv, json) are not offered (ADMIN_SOURCE_LIST_KINDS).
 */
export const FILTER_KINDS: readonly AdminSourceListKind[] = ADMIN_SOURCE_LIST_KINDS.filter(
  (kind) => !(JOB_SOURCE_KINDS_NOT_BUILT as readonly JobSourceKind[]).includes(kind),
  // v37 FIX-37B (the ux review's L6): iCIMS among the boards, after BambooHR (the table's kinds list it last).
).flatMap((kind): AdminSourceListKind[] => (kind === 'icims' ? [] : kind === 'bamboohr' ? ['bamboohr', 'icims'] : [kind]));

export const SOURCE_SORT_LABEL: Record<AdminSourceSort, string> = {
  next_run: 'Next run',
  last_run: 'Last run',
  name: 'Name',
  open_jobs: 'Open jobs',
  failures: 'Failures',
};

export const SOURCE_SORT_OPTIONS = ADMIN_SOURCE_SORTS.map((value) => ({ value, label: `Sort: ${SOURCE_SORT_LABEL[value]}` }));

/**
 * v31 RUNS: an off source is "Disabled" (Paused is an admin's pause of its runs). v36 SOURCES (PLAN S8): "Waiting for an
 * admin", an off source discovery or an import found that no admin turned on yet.
 */
export const SOURCE_ENABLED_LABEL: Record<SourceEnabledFilter, string> = {
  all: 'Enabled and disabled',
  enabled: 'Enabled',
  disabled: 'Disabled',
  waiting: 'Waiting for an admin',
};

/** v36 SOURCES (PLAN S7): the chip of the notice's filter, by part. */
export const TURNED_OFF_LABEL: Record<AdminSourceTurnedOffPart, string> = {
  all: 'Turned off by v3.6',
  untouched: 'Turned off by v3.6: untouched since found',
  changed: 'Turned off by v3.6: changed since found',
  candidates: 'Turned off by v3.6: added from Candidates', // v36 FIX-SRC (D6)
};

/** v35 OPSWEB: the filters' query string alone (no order or page): GET /api/admin/sources/all/count's. */
export function sourcesFilterQuery(filters: SourceFilters) {
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
    turnedOff: filters.turnedOff ?? undefined, // v36 SOURCES
  };
}

/** The query string of a page: the filters CT reads, the lists as repeated keys, empty ones left out. */
export function sourcesQuery(filters: SourceFilters, cursor?: string, limit: number = ADMIN_PAGE_DEFAULT) {
  return { ...sourcesFilterQuery(filters), sort: filters.sort, cursor, limit };
}

// v35 OPSWEB (PLAN H6): the "Found by import" chip, and Enable all / Disable all for everything the filter shows.

/** Whether the list shows only the sources an admin's import found (the "Found by import" chip is on). */
export function foundByImportOnly(filters: Pick<SourceFilters, 'via'>): boolean {
  return filters.via.length === 1 && filters.via[0] === 'import';
}

/** The filters with "Found by import" turned on (the only way found) or off (any way). */
export function withFoundByImport(filters: SourceFilters, on: boolean): SourceFilters {
  return { ...filters, via: on ? ['import'] : filters.via.filter((via) => via !== 'import') };
}

/**
 * The filter Enable all and Disable all act on (and count): the list's own filters, the order and page left out, as
 * AdminSourcesFilterSchema reads them (lists [] when empty; `enabled` always named).
 */
export function sourcesAllFilter(filters: SourceFilters): AdminSourcesFilter {
  const q = filters.q.trim();
  return {
    ...(q ? { q } : {}),
    kind: [...filters.kinds],
    tier: [...filters.tiers],
    terms: [...filters.terms],
    robots: [...filters.robots],
    discoveredVia: [...filters.via],
    enabled: filters.enabled,
    ...(filters.failing ? { failing: true as const } : {}),
    ...(filters.host ? { host: filters.host } : {}),
    ...(filters.companyId ? { companyId: filters.companyId } : {}),
    ...(filters.turnedOff ? { turnedOff: filters.turnedOff } : {}), // v36 SOURCES
  };
}
// end v35 OPSWEB

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
    (filters.companyId ? 1 : 0) +
    (filters.turnedOff ? 1 : 0) // v36 SOURCES
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

/**
 * The filters an address opens with: `host=` (Admin › Hosts' "See its sources"), `company=`, and v35 OPSWEB `found=import`
 * (the "Found by import" chip on). v36 SOURCES: `state=waiting` (the "Waiting for an admin" chip on, as Admin ›
 * Candidates links a waiting source).
 */
export function filtersFromAddress(params: { get(name: string): string | null }): SourceFilters {
  const host = params.get('host')?.trim().toLowerCase() || null;
  const company = Number(params.get('company'));
  const via: JobSourceFoundVia[] = params.get('found') === 'import' ? ['import'] : []; // v35 OPSWEB
  const enabled: SourceEnabledFilter = params.get('state') === 'waiting' ? 'waiting' : 'all'; // v36 SOURCES
  return { ...EMPTY_SOURCE_FILTERS, host, via, enabled, companyId: Number.isInteger(company) && company > 0 ? company : null };
}

// v36 SOURCES (PLAN S8): the "Waiting for an admin" chip: the sources discovery or an import found that wait, off.

/** Whether the list shows only the sources waiting for an admin (the chip is on). */
export function waitingOnly(filters: Pick<SourceFilters, 'enabled'>): boolean {
  return filters.enabled === 'waiting';
}
// end v36 SOURCES

/** `values` with `value` added (on) or removed (off), in `order`'s order. */
export function toggledIn<V extends string>(values: readonly V[], value: V, on: boolean, order: readonly V[]): V[] {
  const next = new Set(values);
  if (on) next.add(value);
  else next.delete(value);
  return order.filter((item) => next.has(item));
}

