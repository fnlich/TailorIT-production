import { jobAnalysisPrompt } from '../../ai/prompts/job-analysis/job-analysis';
import { defineAiTask } from '../../ai/task';
import type { AppDeps } from '../../core/context';
import type { Feature } from '../../core/feature';
import { startJobAnalysisBacklog } from './backlog';
import { createJobAnalysisService, JobAnalysisTaskInputSchema, type JobAnalysisServiceInternals } from './service';
import { startJobAnalysisWarmup } from './warmup';

// Job analysis (deterministic at ingest; then Claude, as AI_JOB_ANALYSIS says: each added job once through the
// add-time backlog by default). Work package J1 (docs/ARCHITECTURE.md §9). Registers `deps.services.jobAnalysis` (the
// contract in ./types.ts) and the `job_analysis` AI task (v30 ST1: jobAnalysisTask, from `aiTasks`); `start` runs the
// backlog and the optional warm-up.

const internals = new WeakMap<AppDeps, JobAnalysisServiceInternals>();

/** v3.0 D2-F: the async job analysis service these deps made (the backlog, the warm-up, the tests). */
export function jobAnalysisOf(deps: AppDeps): JobAnalysisServiceInternals | undefined {
  return internals.get(deps);
}

/**
 * v30 ST1: the `job_analysis` kind (ai/task.ts defineAiTask). System-owned (userId null: one reading serves everyone
 * who opens the job) and charged as each enqueue says (`chargeTo`, service.ts enqueueAnalysis): no one for the backlog,
 * the warm-up and a lazy view; the person for the reading their Prepare forces. Run by the service these deps made.
 */
export const jobAnalysisTask = defineAiTask({
  kind: 'job_analysis',
  prompts: [jobAnalysisPrompt],
  parse: JobAnalysisTaskInputSchema,
  charge: 'caller',
  defaultModel: 'haiku',
  run: (deps, input, ctx) => {
    const service = internals.get(deps);
    // Registered right after the services hook that makes it (setupServices), so it is always there.
    if (!service) throw new Error('The job analysis service is not set up.');
    return service.analyse(input, ctx);
  },
});

export const jobAnalysisFeature: Feature = {
  name: 'job-analysis',
  aiTasks: [jobAnalysisTask],
  services(deps) {
    const service = createJobAnalysisService(deps);
    internals.set(deps, service);
    deps.services.jobAnalysis = service;
  },
  async start(deps) {
    const service = internals.get(deps);
    if (!service) return;
    const warmup = startJobAnalysisWarmup(deps, service);
    const backlog = await startJobAnalysisBacklog(deps, service);
    return async () => {
      warmup.stop();
      await backlog.stop();
    };
  },
};
