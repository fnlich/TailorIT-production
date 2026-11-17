import type { JobAnalysisView } from '@tailorit/shared';

// The job analysis service contract (work package J1 implements it; J2's Jobs API and the resume match call it).
// Registered on `deps.services.jobAnalysis` by the job-analysis feature's `services` hook.

export interface EnsuredAnalysis {
  /** The best analysis available now: AI > free_tailor lake > deterministic, with the posting's facets. */
  analysis: JobAnalysisView;
  /** True while an AI analysis for this posting is queued or running (the page shows "Refining…"). */
  refining: boolean;
}

export interface EnsureOptions {
  /** Queue at interactive priority instead of on the background slot (AI_JOB_ANALYSIS=lazy only). */
  interactive?: boolean;
  /**
   * The account whose request this is. A new AI analysis it starts (lazy mode) counts against that account's hourly
   * budget (JOB_ANALYSIS_PER_ACCOUNT_PER_HOUR); past it, the current best analysis is shown and nothing is queued.
   */
  requestedBy?: string;
}

export interface JobAnalysisService {
  /**
   * The analysis to show when a person opens a job. With AI_JOB_ANALYSIS=lazy and no AI analysis yet, queues one
   * (deduplicated by the posting's content hash; background priority unless `interactive`) and answers the current
   * best meanwhile. In every other mode it never queues: the add-time backlog has Claude read each added job.
   * Null when the job does not exist.
   */
  ensure(jobId: number, options?: EnsureOptions): Promise<EnsuredAnalysis | null>;
  /**
   * The current best analysis without queueing anything. It stores what it completes as it reads (a missing
   * deterministic analysis, facets not read yet) and points the job at its best analysis.
   */
  get(jobId: number): Promise<EnsuredAnalysis | null>;
  /**
   * The same answer as `get`, read-only: nothing is stored, nothing queued (for passes that read many jobs, such as the
   * resume chooser). The job-analysis feature always provides it; it is optional at the type level only, so a
   * stand-in of this contract (tests) may leave it out.
   */
  peek?(jobId: number): Promise<EnsuredAnalysis | null>;
  /**
   * v2.0 (05's step b, A7): Prepare forcing a version 2 analysis of its job, charged to the person (`chargeTo`), with
   * `prepare: {id}` in the task's input so its cost is added to that Prepare. Answers the task (one already queued or
   * running for the text is joined: the person pays nothing for it), or null when none is needed or possible (a version
   * 2 analysis exists, too little text, AI_JOB_ANALYSIS=off). Throws the AI gate's AppError. Wait for the task
   * (AiService.waitFor), then read the facts again (PrepareFilterService.evaluate). Background and warm-up readings are
   * charged to no one.
   */
  forceAnalysis?(jobId: number, chargeTo: string, prepare?: { id: string }): Promise<{ taskId: string; deduped: boolean } | null>;
}

declare module '../../core/context' {
  interface AppServices {
    /** Job analysis (work package J1). Optional: J2 falls back to a deterministic analysis when it is missing. */
    jobAnalysis?: JobAnalysisService;
  }
}
