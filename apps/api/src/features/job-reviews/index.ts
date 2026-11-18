import type { AppDeps } from '../../core/context';
import type { Feature } from '../../core/feature';
import { JOB_REVIEWS_DAILY } from './housekeeping';
import { RECHECK_PASS_EVERY_MS, runAutoSweep, runRecheckPass } from './rechecks';
import { createReviewFlagsRouter, createReviewRouter } from './router';
import { runsPaused } from '../ingest/pause-state'; // v31 RUNS

// v30 X1-API: the extension's closed-link reports and new jobs, and Admin › Review (docs/design/part2/14-extension-
// reports.md §3-§7; the build plan's §9). The module map:
// - closed.ts: a closed report (the extension's route, features/autofill/closed-router.ts; the Jobs page's flag,
//   features/jobs/report.ts) into the job's pending closed review, under the daily cap;
// - new-jobs.ts: a held new ATS job and its adders' report rows (features/autofill/jobs.ts), a page job queued for
//   review (features/autofill/from-page.ts), a published page job's sightings;
// - store.ts (the tables), trust.ts (the trust rule), checks.ts (a new job's company, duplicates and board);
// - decide.ts (approve, reject, reopen: closeLink, publishing, offerToDiscovery), auto.ts (the automatic rules, all off
//   by default), rechecks.ts (the re-check queue through recheckPosting, and the automatic rules' sweep);
// - admin.ts, flags.ts, service.ts, router.ts: Admin › Review's API (the Flags lane replaces Admin › Reports');
// - housekeeping.ts: expiry and pruning (Feature.daily); seam.ts: jobReviews (core/seams.ts).

/**
 * The worker hook: a pass of the re-check queue and of the automatic rules' sweep every RECHECK_PASS_EVERY_MS. v31 RUNS:
 * none while an admin paused every run (the re-checks read the reported postings' hosts: the worker's outside work).
 */
function startReviewWorker(deps: AppDeps): () => void {
  let running = false;
  let sweepAfter = 0;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      if (await runsPaused(deps)) return; // v31 RUNS
      const checked = await runRecheckPass(deps);
      const swept = await runAutoSweep(deps, sweepAfter);
      sweepAfter = swept.lastId;
      if (checked > 0 || swept.decided > 0) deps.log.debug(`[job-reviews] ${checked} re-check(s), ${swept.decided} automatic decision(s)`);
    } catch (error) {
      deps.log.warn('[job-reviews] a review pass failed; the next one runs on time', error instanceof Error ? error.name : 'unknown');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pass(), RECHECK_PASS_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const jobReviewsFeature: Feature = {
  name: 'job-reviews',
  routes: [
    // The paths X1-WEB's Admin › Review calls (its review/api.ts REVIEW_ROUTES).
    { path: '/api/admin/reviews', router: createReviewRouter },
    { path: '/api/admin/flags', router: createReviewFlagsRouter },
  ],
  daily: JOB_REVIEWS_DAILY,
  worker: startReviewWorker,
};
