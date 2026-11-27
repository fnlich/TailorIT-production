import {
  AdminEmbeddedSiteForgetResultSchema,
  AdminEmbeddedSiteRememberResultSchema,
  AdminEmbeddedSitesSchema,
  type AdminEmbeddedSite,
  type AdminEmbeddedSiteForgetResult,
  type AdminEmbeddedSiteRememberResult,
  type AdminEmbeddedSites,
} from '@tailorit/shared/sourcing';
import { api } from '@/lib/api';

// v381 EMBED (SP v381 PLAN E2, E5): the company sites whose job pages show a Greenhouse or Ashby source's board. TailorIT
// learns them when a job link on the company's own site (?gh_jid=, ?ashby_jid=) is read from the board, or from the
// board's own job links; a later link of the site is then read from the board at once. Admin › Sources' sheet lists them
// (EmbeddedSites.tsx); Runs' Sources found says "Found via <site>" for a board an import found through that site.
// v381 FIX (SP v381 FIXES-381 G6): Forget keeps a mark: the site's job links are read from their own pages, and neither
// a link nor the board's runs remember it again until an admin's Remember again.

/** The source kinds whose boards a company's site embeds (embedded_boards.kind). */
export const EMBEDDED_SOURCE_KINDS: readonly string[] = ['greenhouse', 'ashby'];

/** Whether a source's sheet lists the company sites that show its board. */
export const showsEmbeddedSites = (kind: string): boolean => EMBEDDED_SOURCE_KINDS.includes(kind);

/** React Query key of a source's company sites (under Sources' keys, so a change there reads them again). */
export const embeddedSitesKey = (id: number) => ['admin', 'sources', 'embedded-sites', id] as const;

/** GET /api/admin/sources/:id/embedded-sites. */
export function fetchEmbeddedSites(id: number, signal?: AbortSignal): Promise<AdminEmbeddedSites> {
  return api.get<AdminEmbeddedSites>(`/api/admin/sources/${id}/embedded-sites`, { signal, schema: AdminEmbeddedSitesSchema });
}

/** POST /api/admin/sources/:id/embedded-sites/forget {site}. */
export function forgetEmbeddedSite(id: number, site: string): Promise<AdminEmbeddedSiteForgetResult> {
  return api.post<AdminEmbeddedSiteForgetResult>(`/api/admin/sources/${id}/embedded-sites/forget`, { site }, { schema: AdminEmbeddedSiteForgetResultSchema });
}

/** v381 FIX (G6): POST /api/admin/sources/:id/embedded-sites/remember {site}: Remember again. */
export function rememberEmbeddedSite(id: number, site: string): Promise<AdminEmbeddedSiteRememberResult> {
  return api.post<AdminEmbeddedSiteRememberResult>(`/api/admin/sources/${id}/embedded-sites/remember`, { site }, {
    schema: AdminEmbeddedSiteRememberResultSchema,
  });
}

/** Whether an admin forgot the site (v381 FIX G6). */
export const isForgotten = (site: AdminEmbeddedSite): boolean => Boolean(site.forgottenAt);

/** One site's line: "Job pages on acme.com use this board.", or (forgotten) what TailorIT does instead. */
export const embeddedSiteLine = (site: AdminEmbeddedSite): string =>
  isForgotten(site) ? `Forgotten: job links on ${site.site} are read from their own pages.` : `Job pages on ${site.site} use this board.`;

/** How TailorIT learned a site, in a few words. */
export function embeddedSiteHow(site: AdminEmbeddedSite): string {
  if (site.confirmedVia === 'posting_url') return "Found from the board's own job links";
  if (site.confirmedVia === 'admin') return 'Added by an admin';
  return 'Found by a job link on the site';
}

/** What a Forget or a Remember again did, as its toast says it (v381 FIX: REVIEW381-ux L6, the server's own answer). */
export function siteChangeToast(
  action: 'forget' | 'remember',
  site: string,
  changed: boolean,
): { tone: 'success' | 'info'; title: string; description: string } {
  if (action === 'forget') {
    return changed
      ? { tone: 'success', title: `TailorIT forgot ${site}`, description: 'Its job links are read from their own pages until an admin remembers it again.' }
      : { tone: 'info', title: `${site} was already forgotten`, description: 'The list shows it as it is now.' };
  }
  return changed
    ? { tone: 'success', title: `TailorIT remembers ${site} again`, description: 'Its job links are read from this board at once.' }
    : { tone: 'info', title: `${site} was already remembered`, description: 'The list shows it as it is now.' };
}

/** Runs' Sources found: "Found via acme.com" (and how many more), or null for none. */
export function foundViaText(sites: readonly string[] | undefined): string | null {
  if (!sites || sites.length === 0) return null;
  const [first, ...rest] = sites;
  return rest.length === 0 ? `Found via ${first}` : `Found via ${first} and ${rest.length} more`;
}
