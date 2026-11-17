import type { Feature } from '../../core/feature';
import { createAiSearchRouter, createAiSearchService, jobSearchTask } from './ai-search';
import { createJobsRouter } from './jobs-router';
import { createSaveAllRouter } from './save-all-router';
import { createSavedSearchesRouter } from './saved-searches-router';
import { searchRepairCommand, searchRepairStep } from './search-projection/repair'; // v30 PG-SEARCH

// Job browse/search, detail, analysis and match, hide/report, saved searches. Owned by work package J2; Save all by
// WP7; v2.0's AI job search by P6a.
//   /api/jobs/save-all    Save all: the confirm's numbers (/preview) and the save itself (POST), over the list's filters
//   /api/jobs/ai-search   v2.0 AI job search (Paid): a sentence in, 202 {taskId}; the `job_search` task's answer is the
//                         classic search's query (ai-search.ts)
//   /api/jobs             list (FTS5 + filters + keyset pages), count, facets, detail, analysis, match, hide, report
//   (/api/companies, hide / unhide a company's jobs: v30 E0-API moved it to the companies feature)
//   /api/saved-searches   the toolbar bookmark's saved searches
// Save all and AI search are mounted first: Express tries routers in this order, so the jobs router's /:id routes never
// see their paths.
export const jobsFeature: Feature = {
  name: 'jobs',
  services: (deps) => {
    // v2.0 P6a: the service MCP uses too.
    deps.services.aiSearch = createAiSearchService(deps);
  },
  // v30 ST3: the `job_search` task (defineAiTask), registered whenever the server has an AI queue.
  aiTasks: [jobSearchTask],
  routes: [
    { path: '/api/jobs/save-all', router: createSaveAllRouter },
    { path: '/api/jobs/ai-search', router: createAiSearchRouter },
    { path: '/api/jobs', router: createJobsRouter },
    { path: '/api/saved-searches', router: createSavedSearchesRouter },
  ],
  // v30 PG-SEARCH: the search projection's nightly repair (job_search, both ways), and the same pass on demand.
  daily: [searchRepairStep],
  commands: { 'search:repair': searchRepairCommand },
  // end v30 PG-SEARCH
};
