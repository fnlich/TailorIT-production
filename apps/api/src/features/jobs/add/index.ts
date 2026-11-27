import type { Feature } from '../../../core/feature';
import { canonicalLinksStep } from './canonical-pass';
import { boardLinksStep } from './clean-link-pass'; // v38 ATS-D
import { legacyLinksStep } from './legacy'; // v31 LINK2
import { linkQueuePruneStep, startLinkQueueWorker } from './queue';
import { pageRecheckStep } from './recheck'; // v31 LINK2
import { ADMIN_IMPORTS_ACTING, ADMIN_JOB_LINKS_ACTING, JOB_LINKS_ACTING } from './acting'; // v33 SHARE-6; v35 IMPORT: imports
import { createAdminImportsRouter } from './import-router'; // v35 IMPORT
import { createAdminJobLinksRouter, createJobLinksRouter } from './router';

// v31 LINK: every job comes from its link (docs/design/v3.1/21-jobs-from-links.md; the build plan's D1-D3). The module
// map:
// - pipeline.ts: addJobByLink, the one pipeline every add path runs (the web, a tracker entry's link, the MCP tool, an
//   admin's links and imports through the queue, the extension's routes), readLink (TailorIT's own read of a link) and
//   verifyJob (Retry read);
// - page.ts: an added job's own page read for its schema.org JobPosting (the shared reader, purpose `add_page`, D3) and
//   stored under the host's career-site source;
// - verification.ts: the jobs only their adder sees because TailorIT could not read them (job_verifications), the
//   rejected links, Admin › Review's "Couldn't verify" list;
// - queue.ts: the links an import or an admin's add queued (job_link_queue), read by the worker, a host at a time;
// - limits.ts: JOB_ADDS_PER_HOUR per account; canonical-pass.ts: the stored links made canonical once;
// - v31 LINK2: legacy.ts (the jobs stored before v3.1 from what a row or a browser said: held, read once from their
//   link), recheck.ts (a job read from its page read again every JOB_PAGE_RECHECK_DAYS), pause.ts (RUNS' Pause all);
// - router.ts: POST /api/jobs/add, POST /api/jobs/:id/verify, /api/admin/jobs/....
export { addJobByLink, readLink, verifyJob, type AddJobByLinkInput, type AddJobByLinkOutcome, type LinkRead } from './pipeline';
export { queueLinks } from './queue';

export const jobLinksFeature: Feature = {
  name: 'job-links',
  routes: [
    { path: '/api/jobs', router: createJobLinksRouter, acting: JOB_LINKS_ACTING /* v33 SHARE-6 */ },
    { path: '/api/admin/jobs', router: createAdminJobLinksRouter, acting: ADMIN_JOB_LINKS_ACTING /* v33 SHARE-6 */ },
    // v35 IMPORT (SP v35 PLAN.md H1, H6): Admin › Import's four ways, Recent imports and an import's results.
    { path: '/api/admin/imports', router: createAdminImportsRouter, acting: ADMIN_IMPORTS_ACTING },
  ],
  // v31 LINK2: the legacy jobs held and read once (legacy.ts), the weekly re-read of jobs read from their page (recheck.ts).
  // v38 ATS-D: the stored links of a platform that gained a clean link, re-cleaned once (clean-link-pass.ts).
  daily: [canonicalLinksStep, boardLinksStep, legacyLinksStep, pageRecheckStep, linkQueuePruneStep],
  worker: startLinkQueueWorker,
};
