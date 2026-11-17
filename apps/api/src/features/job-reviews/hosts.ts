import { isLinkedInHost } from '@tailorit/shared/autofill';
import { assertRedirectAllowed, refusedServiceOf } from '../../core/http/outbound';

// v30 X1-API: the hosts whose pages never feed the shared job lake (docs/design/part2/14-extension-reports.md §4.2,
// §8; 12-job-sourcing.md §3.10): LinkedIn, and the job boards and job-search sites TailorIT refuses (they copy the
// employers' postings, or their terms forbid copying). A page job made from one of them stays its account's own: it is
// never queued for review, never published, and its host never becomes a career-site candidate.
// v30 INT-3 (coordinator decision 4, X1-API edit C): one list: S1-API's refused services (core/http/outbound.ts
// REFUSED_SERVICES), the same hosts its client never reads.

/** A host as compared: lower case, no trailing dots. */
export function normalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** Whether a page on `host` may never feed the job lake (LinkedIn, or a refused job board or service). */
export function isRefusedPageHost(host: string): boolean {
  const name = normalHost(host);
  return !name || isLinkedInHost(name) || refusedServiceOf(name) !== null;
}

/**
 * A host name TailorIT may keep as a career site's (`site:<host>`): dotted, letters, digits and hyphens only, and not
 * a local name. v30 FIX-B (SEC-7): the names outbound.ts never follows a redirect to (localhost, `.local`, `.internal`,
 * `.corp`, `.lan`, `home.arpa`, nip.io and its kind) are no career site either: the same rule, read from one place.
 */
export function isSiteHost(host: string): boolean {
  const name = normalHost(host);
  if (name.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) return false;
  try {
    assertRedirectAllowed(`https://${name}/`);
    return true;
  } catch {
    return false;
  }
}
