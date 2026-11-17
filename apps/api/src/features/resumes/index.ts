import type { Feature } from '../../core/feature';
import { createResumeAnalysisBackfill } from './analysis/backfill';
import { createResumeAnalysisBacklog } from './analysis/backlog';
import { flushAllResumeAnalyses } from './analysis/deferred';
import { createResumeCopyBacklog } from './copies/backlog';
import { createResumeCopiesRouter } from './copies/router';
import { recountResumes } from './counters';
import { getResumeEngine } from './engine';
import { createResumePhotosRouter } from './photos';
import { createResumeBulletsRouter, createResumesRouter } from './router';
import { RESUMES_AI_TASKS } from './tasks';
import { runResumesUpgrade } from './upgrade';

// Resumes: CRUD, upload/import, preview, thumbnails, export, what TailorIT reads from each resume, and the AI tasks
// `resume_import` (an editable copy of an upload), `entry_bullets` (Write with AI) and `resume_analysis` (Claude's
// reading of an upload). The editable copies of several uploads at once wait in the copy line (copies/), which starts
// their `resume_import` tasks one at a time per account. Owned by work package R1 (resume analysis: WP3). v30 ST1: the
// three kinds are defined in ./tasks.ts (defineAiTask) and registered from `aiTasks`.
export const resumesFeature: Feature = {
  name: 'resumes',
  // Always registered: AI_RESUME_ANALYSIS=off (or AI off, or no background slot) only keeps the backlog idle.
  aiTasks: RESUMES_AI_TASKS,
  services: (deps) => {
    getResumeEngine(deps);
    deps.services.resumeAnalysis = {
      backlog: createResumeAnalysisBacklog(deps),
      backfill: createResumeAnalysisBackfill(deps),
    };
    deps.services.resumeCopies = createResumeCopyBacklog(deps);
  },
  routes: [
    // Before /api/resumes, whose GET /:id would take 'copies' or 'photos' for a resume id.
    { path: '/api/resumes/copies', router: createResumeCopiesRouter },
    { path: '/api/resumes/photos', router: createResumePhotosRouter },
    { path: '/api/resumes', router: createResumesRouter },
    { path: '/api/ai/resume-bullets', router: createResumeBulletsRouter },
  ],
  // v30 DB-JOBS (D1d): the stored resume counts against count(*), every night.
  daily: [recountResumes],
  commands: {
    // Moves every older resume into the on-page editor (--dry-run: compares their printed words instead).
    'resumes:upgrade': runResumesUpgrade,
  },
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
