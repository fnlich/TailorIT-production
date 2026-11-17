import type { AppDeps } from '../../../core/context';
import type { DbTx } from '../../../core/db/types';
import { receiveHiringOrganization, type HiringOrganizationResult } from '../../companies/hiring-org';
import type { RawPosting, SourceRecord } from '../types';
import { careerHostOfConfig } from './config';

// v30 S5: the `hiringOrganization` hand-off (docs/design/part2/12-job-sourcing.md §3.4 step 5; 11-database.md §5.4;
// 13-company-enrichment.md §3.2). A career page's JobPosting names its employer (name, sameAs, url, logo): the strongest
// website signal there is. The store resolves the posting's company first (resolveCompany: the site's `site:<host>` board
// alias, the organisation's domain as a strong hint), then calls this in the posting's transaction, and E0-API's
// receiving end (companies/hiring-org.ts) keeps it: one company_sources row (kind job_posting, ref 'site:<host>',
// licence own_site), skipped when unchanged; a changed row adds the domain alias, recomputes the profile and queues the
// company for enrichment. The logo's address is kept for the logo pipeline (never hot-linked).

/** Hands a career-page posting's hiringOrganization to its company's sources, in the posting's transaction. */
export async function handOffHiringOrganization(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  t: DbTx,
  input: { source: SourceRecord; companyId: number; raw: RawPosting; at: string },
): Promise<HiringOrganizationResult | null> {
  const organization = input.raw.hiringOrganization;
  if (!organization) return null;
  // The career site's host (the source's); a posting from elsewhere names its own page's host.
  let host = careerHostOfConfig(input.source.config);
  if (!host) {
    try {
      host = new URL(input.raw.url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  return receiveHiringOrganization(deps, t, {
    companyId: input.companyId,
    host,
    organization: {
      name: organization.name ?? null,
      sameAs: organization.sameAs ?? [],
      url: organization.url ?? null,
      logo: organization.logo ?? null,
    },
    at: input.at,
  });
}
