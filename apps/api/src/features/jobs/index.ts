import type { Feature } from '../../core/feature';
import { AI_SEARCH_ACTING, JOBS_ACTING, SAVED_SEARCHES_ACTING } from './acting'; // v33 SHARE-3, SHARE-6; v36 JOBS: Save all is gone
import { createAiSearchRouter, createAiSearchService, jobSearchTask } from './ai-search';
import { createJobsRouter } from './jobs-router';
import { createSavedSearchesRouter } from './saved-searches-router';
import { searchRepairCommand, searchRepairStep } from './search-projection/repair'; // v30 PG-SEARCH

// Job browse/search, detail, analysis and match, hide/report, saved searches. Owned by work package J2; v2.0's AI job
// search by P6a. v36 JOBS (PLAN J1): Save all (WP7, /api/jobs/save-all) is gone: the list's Select saves the jobs chosen.
//   /api/jobs/ai-search   v2.0 AI job search (Paid): a sentence in, 202 {taskId}; the `job_search` task's answer is the
//                         classic search's query (ai-search.ts)
//   /api/jobs             list (FTS5 + filters + keyset pages), count, facets, detail, analysis, match, hide, report
//   (/api/companies, hide / unhide a company's jobs: v30 E0-API moved it to the companies feature)
//   /api/saved-searches   the toolbar bookmark's saved searches
// AI search is mounted first: Express tries routers in this order, so the jobs router's /:id routes never see its path.
export const jobsFeature: Feature = {
  name: 'jobs',
  services: (deps) => {
    // v2.0 P6a: the service MCP uses too.
    deps.services.aiSearch = createAiSearchService(deps);
  },
  // v30 ST3: the `job_search` task (defineAiTask), registered whenever the server has an AI queue.
  aiTasks: [jobSearchTask],
  routes: [
    { path: '/api/jobs/ai-search', router: createAiSearchRouter, acting: AI_SEARCH_ACTING /* v33 SHARE-3 */ },
    { path: '/api/jobs', router: createJobsRouter, acting: JOBS_ACTING /* v33 SHARE-6 */ },
    { path: '/api/saved-searches', router: createSavedSearchesRouter, acting: SAVED_SEARCHES_ACTING /* v33 SHARE-6 */ },
  ],
  // v30 PG-SEARCH: the search projection's nightly repair (job_search, both ways), and the same pass on demand.
  daily: [searchRepairStep],
  commands: { 'search:repair': searchRepairCommand },
  // end v30 PG-SEARCH
};
