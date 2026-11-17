import { siteAlias } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { addAlias } from './aliases';
import { companyDomainsOf } from './domain';
import { cleanFields, httpsUrl, linkedinCompanyUrl, minConfidenceOf, recomputeProfile, upsertSource } from './profile';
import { refreshCompanySearchIn } from './search-refresh'; // v30 FIX-PERF (PGL-19)
import { queueEnrichment } from './resolve';

// v30 E0-API: the receiving end of the `hiringOrganization` hand-off (docs/design/part2/11-database.md §5.4, 12 §3.4
// step 5, 13 §3.2). When wave 4's career-page reader (S5) parses a JobPosting, it resolves the company (resolveCompany,
// with the organisation's sameAs/url as domains: strong, 95) and hands the organisation here, in the posting's
// transaction: one company_sources row (kind job_posting, ref 'site:<host>', licence own_site) with its name, website,
// LinkedIn page and other links, skipped when unchanged (content_hash); a changed row recomputes the profile, adds the
// organisation's domain as the company's key (when no other company holds it) and queues the company for enrichment.
// The logo's address is kept in the row (logoSourceUrl) for wave 4's logo pipeline to copy: never hot-linked.

export interface HiringOrganization {
  name?: string | null;
  sameAs?: string | readonly string[] | null;
  url?: string | null;
  logo?: string | null;
}

/** The match confidence of a domain the company states about itself (13 §6.2). */
const STATED_DOMAIN = 95;

export interface HiringOrganizationResult {
  sourceId: number | null;
  /** The source row's values changed (and the profile was recomputed). */
  changed: boolean;
  /** The jobs whose search rows the change moved (re-projected here, in the same transaction). */
  projected: number;
}

/** Keeps a JobPosting's hiringOrganization as the company's source (see the module's note), in the caller's transaction. */
export async function receiveHiringOrganization(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  t: DbQueries,
  input: { companyId: number; host: string; organization: HiringOrganization; at: string },
): Promise<HiringOrganizationResult> {
  const ref = siteAlias(input.host);
  const company = await t.one<{ owner_user_id: string | null; do_not_fetch: boolean }>('SELECT owner_user_id, do_not_fetch FROM companies WHERE id = ?', [
    input.companyId,
  ]);
  // An account's own row is never enriched; an opted-out company is never read about.
  if (!ref || !company || company.owner_user_id !== null || company.do_not_fetch) return { sourceId: null, changed: false, projected: 0 };
  const org = input.organization;
  const links = [org.url ?? null, ...(typeof org.sameAs === 'string' ? [org.sameAs] : (org.sameAs ?? []))].filter(
    (link): link is string => typeof link === 'string' && link.trim() !== '',
  );
  const linkedin = links.map(linkedinCompanyUrl).find(Boolean) ?? null;
  const sites = links.filter((link) => !linkedinCompanyUrl(link));
  const website = sites.map(httpsUrl).find(Boolean) ?? null;
  const domains = companyDomainsOf(sites);
  const fields = {
    ...cleanFields({
      displayName: org.name ?? null,
      website,
      domain: domains[0] ?? null,
      linkedinUrl: linkedin,
      otherLinks: sites.slice(1),
    }),
    ...(httpsUrl(org.logo) ? { logoSourceUrl: httpsUrl(org.logo) } : {}),
  };
  const source = await upsertSource(t, input.companyId, { kind: 'job_posting', ref, licence: 'own_site', matchConfidence: STATED_DOMAIN }, fields, input.at);
  if (!source.changed) return { sourceId: source.sourceId, changed: false, projected: 0 };
  for (const domain of domains) await addAlias(t, input.companyId, 'domain', domain, STATED_DOMAIN, input.at, { sourceId: source.sourceId });
  const result = await recomputeProfile(t, input.companyId, input.at, minConfidenceOf(deps));
  await queueEnrichment(t, input.companyId, input.at, ['company_site', 'logo_dev', 'ai']);
  const projected = await refreshCompanySearchIn(t, input.companyId, result);
  return { sourceId: source.sourceId, changed: true, projected };
}
