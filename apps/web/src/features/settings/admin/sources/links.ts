'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';

// v30 S1-WEB: the addresses between Sources, Hosts and Runs past the registry's `go(tab, source)`: a host's sources
// (`?tab=sources&host=`), a source's host (`?tab=hosts&host=`), the daily report (`?tab=runs&view=report`). The Admin
// page reads `tab` and `source`; each tab reads its own extra key when it opens (the page draws one tab at a time).
// v35 OPSWEB (SP v35 build/WAVE2-LINKS.md): an import's results on Admin › Import (`?tab=import&run=<runId>`, Runs' "Open
// results"), Review's lanes filtered to one import (`?tab=review&lane=unverified&run=<runId>`), and Sources' "Found by
// import" (`?tab=sources&found=import`). INT-B changes a key here, in one place, if IMPORTWEB reads another.
// v35 INT-B: Runs on one import's run (`?tab=runs&run=<runId>`, Import results' "See it on Runs"); Admin › Import's
// addresses (import/address.ts) are built here too, so both packages write and read the same keys.

export interface AdminAddress {
  tab: 'sources' | 'hosts' | 'runs' | 'import' | 'review'; // v35 OPSWEB: import, review
  source?: number | null;
  host?: string | null;
  company?: number | null;
  view?: 'report' | null;
  /** v35 OPSWEB: Review's lane (`unverified`, `new_job`). */
  lane?: string | null;
  /** v35 OPSWEB: one import, by its run (Import's results; Review's From filter; v35 INT-B: Runs, that run opened). */
  run?: number | null;
  /** v35 OPSWEB: Sources' "Found by import" filter. */
  found?: 'import' | null;
  /** v35 FIX-WEB (decision 7): Admin › Import's way in ("many": Many links, the Admin header's Add links). */
  mode?: 'link' | 'many' | 'file' | 'sheet' | null;
}

/** `?tab=…&source=…&host=…&company=…&view=…`, the empty keys left out. */
export function adminSearch(address: AdminAddress): string {
  const params = new URLSearchParams();
  params.set('tab', address.tab);
  if (address.source) params.set('source', String(address.source));
  if (address.host) params.set('host', address.host);
  if (address.company) params.set('company', String(address.company));
  if (address.view) params.set('view', address.view);
  if (address.lane) params.set('lane', address.lane); // v35 OPSWEB
  if (address.run) params.set('run', String(address.run)); // v35 OPSWEB
  if (address.found) params.set('found', address.found); // v35 OPSWEB
  if (address.mode) params.set('mode', address.mode); // v35 FIX-WEB
  return `?${params.toString()}`;
}

/** v35 OPSWEB: the address of one import's results on Admin › Import (Runs' "Open results"). */
export function importResultsHref(runId: number): string {
  return `/settings/admin${adminSearch({ tab: 'import', run: runId })}`;
}

/** v35 OPSWEB: the address of a Review lane filtered to one import. */
export function reviewOfImportHref(lane: 'unverified' | 'new_job', runId: number): string {
  return `/settings/admin${adminSearch({ tab: 'review', lane, run: runId })}`;
}

/** v35 FIX-WEB (decision 7): Admin › Import on Many links (the Admin header's Add links). */
export const ADD_LINKS_HREF = `/settings/admin${adminSearch({ tab: 'import', mode: 'many' })}`;

/** v35 INT-B: the address of Runs on one import's run (the runs of its record, that run opened). */
export function runsOfImportHref(runId: number): string {
  return `/settings/admin${adminSearch({ tab: 'runs', run: runId })}`;
}

/** Goes to another place of the Admin page (replacing the address, as the tabs do). */
export function useAdminLink(): (address: AdminAddress) => void {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback((address: AdminAddress) => router.replace(`${pathname}${adminSearch(address)}`, { scroll: false }), [router, pathname]);
}
