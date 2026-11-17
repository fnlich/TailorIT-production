'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';

// v30 S1-WEB: the addresses between Sources, Hosts and Runs past the registry's `go(tab, source)`: a host's sources
// (`?tab=sources&host=`), a source's host (`?tab=hosts&host=`), the daily report (`?tab=runs&view=report`). The Admin
// page reads `tab` and `source`; each tab reads its own extra key when it opens (the page draws one tab at a time).

export interface AdminAddress {
  tab: 'sources' | 'hosts' | 'runs';
  source?: number | null;
  host?: string | null;
  company?: number | null;
  view?: 'report' | null;
}

/** `?tab=…&source=…&host=…&company=…&view=…`, the empty keys left out. */
export function adminSearch(address: AdminAddress): string {
  const params = new URLSearchParams();
  params.set('tab', address.tab);
  if (address.source) params.set('source', String(address.source));
  if (address.host) params.set('host', address.host);
  if (address.company) params.set('company', String(address.company));
  if (address.view) params.set('view', address.view);
  return `?${params.toString()}`;
}

/** Goes to another place of the Admin page (replacing the address, as the tabs do). */
export function useAdminLink(): (address: AdminAddress) => void {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback((address: AdminAddress) => router.replace(`${pathname}${adminSearch(address)}`, { scroll: false }), [router, pathname]);
}
