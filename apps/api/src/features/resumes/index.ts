import type { Feature } from '../../core/feature';
import { RESUME_BULLETS_ACTING, RESUME_COPIES_ACTING, RESUME_PHOTOS_ACTING, RESUME_ROLE_FAMILY_ACTING, RESUMES_ACTING } from './acting'; // v33 SHARE-3
import { createResumeAnalysisBackfill } from './analysis/backfill';
import { createResumeAnalysisBacklog } from './analysis/backlog';
import { flushAllResumeAnalyses } from './analysis/deferred';
import { createResumeCopyBacklog } from './copies/backlog';
import { createResumeCopiesRouter } from './copies/router';
import { recountResumes } from './counters';
import { registerBacklogsEndGrantStep } from './end-grant'; // v33 SHARE-3
import { createResumePhotosRouter } from './photos';
import { createResumeRoleFamilyRouter } from './role-family'; // v33 ROLES
import { createResumeBulletsRouter, createResumesRouter } from './router';
import { RESUMES_AI_TASKS } from './tasks';

// Resumes: CRUD, upload/import, thumbnails, export, what TailorIT reads from each resume, and the AI tasks
// `resume_import` (an editable copy of an upload), `entry_bullets` (Write with AI) and `resume_analysis` (Claude's
// reading of an upload). The editable copies of several uploads at once wait in the copy line (copies/), which starts
// their `resume_import` tasks one at a time per account. Owned by work package R1 (resume analysis: WP3). v30 ST1: the
// three kinds are defined in ./tasks.ts (defineAiTask) and registered from `aiTasks`.
export const resumesFeature: Feature = {
  name: 'resumes',
  // Always registered: AI_RESUME_ANALYSIS=off (or AI off, or no background slot) only keeps the backlog idle.
  aiTasks: RESUMES_AI_TASKS,
  services: (deps) => {
    deps.services.resumeAnalysis = {
      backlog: createResumeAnalysisBacklog(deps),
      backfill: createResumeAnalysisBackfill(deps),
    };
    deps.services.resumeCopies = createResumeCopyBacklog(deps);
    registerBacklogsEndGrantStep(); // v33 SHARE-3: ending a grant stops the readings and copies paid under it
  },
  routes: [
    // Before /api/resumes, whose GET /:id would take 'copies' or 'photos' for a resume id.
    { path: '/api/resumes/copies', router: createResumeCopiesRouter, acting: RESUME_COPIES_ACTING /* v33 SHARE-3 */ },
    { path: '/api/resumes/photos', router: createResumePhotosRouter, acting: RESUME_PHOTOS_ACTING /* v33 SHARE-3 */ },
    { path: '/api/resumes', router: createResumeRoleFamilyRouter, acting: RESUME_ROLE_FAMILY_ACTING /* v33 SHARE-3 */ }, // v33 ROLES: GET/PUT /:id/role-family (the Field)
    { path: '/api/resumes', router: createResumesRouter, acting: RESUMES_ACTING /* v33 SHARE-3 */ },
    { path: '/api/ai/resume-bullets', router: createResumeBulletsRouter, acting: RESUME_BULLETS_ACTING /* v33 SHARE-3 */ },
  ],
  // v30 DB-JOBS (D1d): the stored resume counts against count(*), every night.
  daily: [recountResumes],
  // The workers start only here (never before the server listens; tests and CLI commands do not start them).
  start: (deps) => {
    const stops: Array<() => Promise<void>> = [];
    const workers = deps.services.resumeAnalysis;
    if (workers) stops.push(workers.backfill.start(), workers.backlog.start());
    if (deps.services.resumeCopies) stops.push(deps.services.resumeCopies.start());
    return async () => {
      // Readings still waiting on the editor's saves run before the server goes.
      await flushAllResumeAnalyses(deps);
      for (const stop of stops) await stop();
    };
  },
};
