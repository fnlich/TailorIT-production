import type { Feature } from '../../core/feature';
import { aboutSectionsStep } from './about';
import { createAdminCompaniesRouter, createAdminCompanyReviewsRouter, createAdminOptOutsRouter } from './admin';
import { jobCountsStep } from './counts';
import { enrichmentWorker } from './enrich/worker'; // v30 E1
import { createLogosRouter, LOGO_ROUTE } from './logos';
import { refdataCommands } from './refdata/index'; // v30 E1
import { createCompaniesRouter } from './router';
import { companySitesDailyStep } from './site/index'; // v30 E2

// v30 E0-API: the companies (docs/design/part2/13-company-enrichment.md §11 phase 0; 11-database.md §5.4). A company
// row keeps its identity; what it shows is its profile (company_profiles), computed from its sources (company_sources:
// provenance, licence, confidence), and every key that finds it is an alias (company_aliases: board, domain, ...).
//   resolve.ts     resolveCompany (core/seams.ts): which company a posting belongs to (board, domain, name)
//   profile.ts     sources -> profile (13 §6.1's priority, admin locks, COMPANY_FIELD_MIN_CONFIDENCE)
//   detail.ts      CompanyDetail for the job detail (and the logo/industry reads of other features)
//   router.ts      /api/companies: the company page (/companies/:id), its jobs, hide / unhide
//   admin.ts       /api/admin/companies (the editor), /api/admin/company-reviews, /api/admin/company-opt-outs
//   opt-out.ts     companies.do_not_fetch (crawl_opt_outs, sources disabled, purgeSource) and the opt-out list
//   logos.ts       the logo store, served at /api/company-logos/<sha256>.<ext>
//   merge.ts       merges, own rows giving way to shared ones, splits
//   about.ts       a board's intro and the postings' "About" sections as source text (a daily step)
//   hiring-org.ts  the receiving end of a JobPosting's hiringOrganization (wave 4's career pages call it)
//   counts.ts      company_job_counts (a daily step, and after merges, splits and opt-outs)
// Wave 4 adds refdata/ (E1), site/ and logos/ (E2) and summaries/ (E3); every new outside read goes through the
// identity guard (core/http/identity.ts).
export const companiesFeature: Feature = {
  name: 'companies',
  routes: [
    // Moved from the jobs feature (features/jobs/companies-router.ts): the company page and hide / unhide.
    { path: '/api/companies', router: createCompaniesRouter },
    { path: LOGO_ROUTE, router: createLogosRouter },
    { path: '/api/admin/companies', router: createAdminCompaniesRouter },
    { path: '/api/admin/company-reviews', router: createAdminCompanyReviewsRouter },
    { path: '/api/admin/company-opt-outs', router: createAdminOptOutsRouter },
  ],
  daily: [jobCountsStep, aboutSectionsStep, companySitesDailyStep /* v30 E2 */],
  // v30 E1: the enrichment queue's worker (enrich/), in the ingest:worker process; the refdata build and its report
  // as commands of their own (refdata/: npm run refdata:build, refdata:match, refdata:coverage), never the API.
  worker: enrichmentWorker,
  commands: { ...refdataCommands },
  // end v30 E1
};
