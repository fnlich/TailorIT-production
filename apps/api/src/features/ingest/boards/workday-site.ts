import { WORKDAY_SITE_BOARD } from '@tailorit/shared/sourcing';
import { workdaySiteAdapter, workdaySiteOf } from '../adapters/workdaySite';
import type { ApiBoardDescriptor } from './types';
import { workdayRefOfLink } from './workday';

// v38 FRAME: a Workday career site's API part (its shared part: @tailorit/shared/sourcing WORKDAY_SITE_BOARD): its own
// sitemap, each posting read on its own (adapters/workdaySite.ts), on the Workday lane.

export const WORKDAY_SITE: ApiBoardDescriptor<'workday_site'> = {
  board: WORKDAY_SITE_BOARD,
  adapter: workdaySiteAdapter,
  // v30 S3: a new kind of read (BOT_USER_AGENT); its own sitemap (the owner's answer to question 11: sitemaps only).
  readKind: 'feed_read',
  terms: { status: 'allowed', url: null },
  transferKeys: ['host', 'tenant', 'careerSite'],
  importable: true,
  // Its host, tenant and site, checked as a source's config is (workdaySiteOf throws IngestError for one it does not read).
  importConfig: (given) => {
    const site = workdaySiteOf(given);
    return { host: site.host, tenant: site.tenant, careerSite: site.careerSite };
  },
  // v30 FIX-A (INT-4 open item S3 C): its postings are read as Add job's Workday postings are (the job's own page link).
  posting: { refOf: workdayRefOfLink },
};
