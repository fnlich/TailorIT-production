import type { Feature } from '../core/feature';
import { authFeature } from './auth/index';
import { meFeature } from './me/index';
import { filesFeature } from './files/index';
import { fontsFeature } from './fonts/index';
import { adminUsersFeature } from './admin-users/index';
import { aiTasksFeature } from './ai-tasks/index';
import { adminAiFeature } from './admin-ai/index';
import { resumesFeature } from './resumes/index';
import { resumeTemplatesFeature } from './resume-templates/index';
import { skillsFeature } from './skills/index';
import { coverLettersFeature } from './cover-letters/index';
import { coverLetterTemplatesFeature } from './cover-letter-templates/index';
import { jobAnalysisFeature } from './job-analysis/index';
import { ingestFeature } from './ingest/index';
import { jobsFeature } from './jobs/index';
import { applicationsFeature } from './applications/index';
import { resumeMatchFeature } from './resume-match/index';
import { resumeZipFeature } from './resume-zip/index';
import { autofillFeature } from './autofill/index';
// v1.4 D
import { tailorFeature } from './tailor/index';
// v1.5 P
import { prepareFeature } from './prepare/index';
// v1.5 M
import { mcpFeature } from './mcp/index';
// v2.0 (W0-B): the new features, stubs that their wave-1 packages fill (none of them edits this file).
import { accountFeature } from './account/index';
import { adminConstantsFeature } from './admin-constants/index';
import { announcementsFeature } from './announcements/index';
import { autoApplyFeature } from './auto-apply/index';
import { jobFactsFeature } from './job-facts/index';
import { prepareFiltersFeature } from './prepare-filters/index';
// end v2.0
// v30 ST0: the dev-only seam (empty in the production export).
import { DEV_FEATURES } from '../dev-only/index';
// v30 D5L: the database's upkeep (the start-up partition check, the partitions' daily step, db:partitions).
import { dbMaintenanceFeature } from '../core/db/pg/maintenance/feature';
// v30 SCH: wave 3's new features, stubs their packages fill (E0-API, X1-API); none of them edits this file.
import { companiesFeature } from './companies/index';
import { jobReviewsFeature } from './job-reviews/index';
import { companySummariesFeature } from './companies/summaries/index'; // v30 E3
import { discoveryFeature } from './ingest/discovery/index'; // v30 S2
import { notificationsFeature } from './notifications/index'; // v31 NOTIFY
import { oauthFeature } from './oauth/index'; // v31 OAUTH
import { jobLinksFeature } from './jobs/add/index'; // v31 LINK

/**
 * Every feature of the API, in setup order: services are created in this order (AI before the features that queue
 * AI work), then all routers are mounted, then background work starts. Work packages edit only their own folder.
 */
export const FEATURES: Feature[] = [
  authFeature,
  meFeature,
  filesFeature,
  fontsFeature,
  adminUsersFeature,
  // v2.0 P6b: the account summary and the public constants; Admin › Constants; the announcements.
  accountFeature,
  adminConstantsFeature,
  announcementsFeature,
  aiTasksFeature,
  adminAiFeature,
  resumesFeature,
  resumeTemplatesFeature,
  skillsFeature,
  coverLettersFeature,
  coverLetterTemplatesFeature,
  jobAnalysisFeature,
  // v2.0 P4: each job's facts, read from its analysis (after the job analysis).
  jobFactsFeature,
  ingestFeature,
  jobsFeature,
  jobLinksFeature, // v31 LINK: every job comes from its link (POST /api/jobs/add, the link queue, Retry read)
  // v30 SCH: the companies (E0-API: profiles, resolveCompany, Admin › Companies, /companies/:id) and the extension's
  // reviews (X1-API: closed reports, held new jobs, Admin › Review), after the jobs they describe.
  companiesFeature,
  companySummariesFeature, // v30 E3: company summaries written by AI (after the companies, whose profiles it writes)
  jobReviewsFeature,
  // v30 S2: discovery (12 §4): Admin › Candidates, validation and Common Crawl in the worker, the link signals daily.
  discoveryFeature,
  // Before the tracker: its /api/applications/:id routes must never take /api/applications/resume-zip/...
  resumeZipFeature,
  applicationsFeature,
  resumeMatchFeature,
  autofillFeature,
  // v1.4 D: tailoring (after the AI queue, the resumes, the letters, the tracker and the autofill profile it uses).
  tailorFeature,
  // v2.0 P4: the prepare filters, before Prepare, which runs them; its /api/prepare/filters router is mounted before
  // Prepare's /api/prepare, so no Prepare route takes its paths.
  prepareFiltersFeature,
  // v1.5 P: Prepare, the application drafts (after tailoring, which it runs, and the autofill answers it asks).
  prepareFeature,
  // v2.0 P3: the Auto-Apply page's read models (after the queue and Prepare, which they read).
  autoApplyFeature,
  // v1.5 M: the MCP server for Prepare with the person's own AI (after tailoring, whose code steps it runs).
  mcpFeature,
  oauthFeature, // v31 OAUTH: the OAuth 2.1 server Claude and ChatGPT connect to the MCP server through
  // v30 ST0: features only a development install has (dev-only/index.ts), last.
  notificationsFeature, // v31 NOTIFY: notifications and the header's summary (after every feature that writes them)
  dbMaintenanceFeature, // v30 D5L (before the dev-only seam, which stays last)
  ...DEV_FEATURES,
];
