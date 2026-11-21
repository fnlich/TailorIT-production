import {
  CONSTANTS,
  STATUS,
  type ResumeDocument,
} from '@tailorit/shared';
import type { AutofillKnownQuestion, AutofillSubmittedAnswerValue } from '@tailorit/shared/autofill';
import {
  PREPARE_ACTIVE_STATES,
  PREPARE_RESUME_MODES,
  type CoverLetterMode,
  type LetterReason,
  type PrepareJobState,
  type PreparePartStatus,
  type PrepareResumeMode,
  type PrepareStartRequest,
  type PrepareStartResponse,
} from '@tailorit/shared/prepare';
import type { PersonPayer } from '../../core/accounts/payer'; // v33 SHARE-8
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import type { PrepareService } from '../../core/seams'; // v33 INT-D (SHARE-8's seam edit)
import { readAutofillProfile } from '../autofill/profile/repository';
import { decideLetter } from '../prepare/kit';
import {
  draftQuestions,
  draftView,
  markDraft,
  saveDraftAnswers,
  saveDraftLetter,
  saveDraftResume,
} from '../prepare/service';

// v1.5 M, reworked for v2.0 P5 (docs/design/v2.0/05-prepare-flow.md, 07-mcp.md): the one place the MCP tools touch
// Prepare & Queue (features/prepare, P2). It reads the person's `mcp` Prepares (prepare_jobs, read-only SQL on the
// table 0822 and 0827 made) and calls P2's service for everything that changes one: starting (startPrepare, mode
// `mcp`), cancelling, finishing (finishIfComplete, which queues the job), and the kit's parts (the draft functions).
// The MCP tools never write P2's tables themselves. `by` is always 'mcp': the kit's answers get the provenance `mcp`.
// INT: the draft functions are v1.5's names in features/prepare/service.ts; if P2 renames them, this file alone changes.
// v3.0 D2: every method answers a promise (its reads go through the async client). The prepare service's functions are
// awaited whether they are async yet or not (features/prepare converts them: D2-F), so this file needs no change then.
// v33 SHARE-8 (PLAN-sharing.md §7 "Handles"; SHARE-5's edit 7): the caller's own AI works only on the MCP Prepares the
// caller started (prepare_jobs.started_by, `startedBy` below), on whichever profile: the list, the saves, the finish and
// a cancel name them. A start on another person's profile is the caller's, paid under the grant
// (payerOfGrant(grant, 'mcp')), its reasons masked without `sensitive:view` (the viewer); the service checks the grant
// is live, the owner's and the caller's, with `prepare:run` and `mcp`.

/** A kit's parts as the MCP tools read them (P2's draft view). */
export interface DraftParts {
  resumeStatus: PreparePartStatus;
  resumeId: string | null;
  letterStatus: PreparePartStatus;
  coverLetterId: string | null;
  answersStatus: PreparePartStatus;
}

/** One Prepare of the person (prepare_jobs), as the MCP tools read it. */
export interface McpPrepare {
  id: string;
  applicationId: string;
  jobId: number | null;
  mode: 'server' | 'mcp';
  state: PrepareJobState;
  letterMode: CoverLetterMode;
  letterWanted: boolean | null;
  /** DECISIONS A29: fixed when it started. */
  resumeMode: PrepareResumeMode;
  /** The resume it chose (the default, the most similar, or the tailored one once made); null until chosen. */
  resumeId: string | null;
  createdAt: string;
  /** v33 SHARE-8: who started it (prepare_jobs.started_by: the owner's own, or someone the profile is shared with). */
  startedBy: string;
}

/** A job waiting for the person's own AI (prepare_queue's row). */
export interface WaitingJob {
  prepare: McpPrepare;
  jobId: number;
  company: string;
  title: string;
  parts: DraftParts | null;
}

/** A known question as the kit sees it (P2's draftQuestions): 'draft' is the only state the AI may answer. */
export interface DraftQuestion {
  question: AutofillKnownQuestion;
  state: 'draft' | 'not_ready' | 'profile';
}

export type DraftAnswerRefusal = 'not_this_job' | 'never_drafted' | 'does_not_fit' | 'sensitive';

/** What a finishing save reports: the job queued, or kept prepared because the queue is full. */
export interface Finished {
  queued: boolean;
  queueFull: boolean;
}

/** v33 SHARE-8: who starts an MCP Prepare and pays (the caller), and what its answer may show. */
export interface McpStartOptions {
  payer: PersonPayer;
  viewer: { sensitive: boolean };
}

export interface PrepareAdapter {
  /**
   * The person's `mcp` Prepares waiting for their AI, oldest first, whose entries are still at Saved. v33 SHARE-8: those
   * `startedBy` started (the caller's own AI's).
   */
  waiting(deps: AppDeps, userId: string, startedBy: string): Promise<WaitingJob[]>;
  /** The application's active Prepare (either mode, anyone's: McpPrepare.startedBy says whose), or null. */
  active(deps: AppDeps, userId: string, applicationId: string): Promise<McpPrepare | null>;
  /** prepare_start: P2's startPrepare in mode `mcp` (its checks; no AI check, since no server AI runs). */
  start(deps: AppDeps, userId: string, request: PrepareStartRequest, options: McpStartOptions): Promise<PrepareStartResponse>;
  /** Queues the application's `mcp` Prepare `startedBy` started when its required parts are ready (finishIfComplete). */
  finish(deps: AppDeps, userId: string, applicationId: string, startedBy: string): Promise<Finished>;
  /** v33 SHARE-8: `actorId` (the caller) cancels only a Prepare they started on someone else's profile. */
  cancel(deps: AppDeps, userId: string, prepareId: string, actorId: string): Promise<void>;
  /** The person's resume mode (user_settings.prepare_resume_mode; the constant's default without a row). */
  resumeMode(deps: AppDeps, userId: string): Promise<PrepareResumeMode>;
  /** Whether a letter is made for the job, and why (the Prepare's letter mode, else the profile's). */
  letter(
    deps: AppDeps,
    userId: string,
    job: { applicationId: string; jobId: number },
    prepare: McpPrepare | null,
  ): Promise<{ wanted: boolean; reason: LetterReason }>;
  draft(deps: AppDeps, userId: string, applicationId: string): Promise<DraftParts | null>;
  questions(deps: AppDeps, userId: string, applicationId: string): Promise<DraftQuestion[]>;
  // v33 SHARE-8: each save names `startedBy` (the caller): only a Prepare they started takes it (SHARE-5's McpSaveOptions).
  saveResume(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    input: { document: ResumeDocument; sourceResumeId: string; title?: string },
    startedBy: string,
  ): Promise<{ resumeId: string }>;
  saveLetter(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    input: { paragraphs: string[] },
    startedBy: string,
  ): Promise<{ coverLetterId: string }>;
  saveAnswers(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    answers: ReadonlyArray<{ questionId: number; answer: AutofillSubmittedAnswerValue | null }>,
    startedBy: string,
  ): Promise<{ kept: number; ready: number; refused: Array<{ questionId: number; reason: DraftAnswerRefusal }> }>;
  mark(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    status: 'failed' | 'skipped',
    reason: string,
    part: 'resume' | 'letter' | 'answers' | 'all' | undefined,
    startedBy: string,
  ): Promise<void>;
}

interface PrepareRow {
  id: string;
  application_id: string;
  job_id: number | null;
  mode: 'server' | 'mcp';
  state: PrepareJobState;
  letter_mode: CoverLetterMode;
  letter_wanted: number | null;
  resume_mode: PrepareResumeMode;
  resume_id: string | null;
  created_at: string;
  started_by: string;
}

const PREPARE_COLUMNS = `p.id, p.application_id, p.job_id, p.mode, p.state, p.letter_mode, p.letter_wanted, p.resume_mode,
  p.resume_id, p.created_at, p.started_by`;
const ACTIVE = `(${PREPARE_ACTIVE_STATES.map((state) => `'${state}'`).join(', ')})`;

const prepareOf = (row: PrepareRow): McpPrepare => ({
  id: row.id,
  applicationId: row.application_id,
  jobId: row.job_id,
  mode: row.mode,
  state: row.state,
  letterMode: row.letter_mode,
  // A flag as either engine reads it (0/1 or false/true).
  letterWanted: row.letter_wanted === null ? null : Boolean(row.letter_wanted),
  resumeMode: row.resume_mode,
  resumeId: row.resume_id,
  createdAt: row.created_at,
  startedBy: row.started_by, // v33 SHARE-8 (NOT NULL since 0049)
});

/**
 * P2's service; refused plainly while a server has none (a build before INT wires it). v33 INT-D: core/seams.ts'
 * PrepareService takes the v3.3 options of cancel and finishIfComplete (SHARE-8's seam edit): no cast.
 */
function service(deps: AppDeps): PrepareService {
  const prepare = deps.services.prepare;
  if (!prepare) throw new AppError('internal', 'Prepare & Queue is not available on this TailorIT server.');
  return prepare;
}

const isResumeMode = (value: unknown): value is PrepareResumeMode =>
  (PREPARE_RESUME_MODES as readonly unknown[]).includes(value);

export const prepareService: PrepareAdapter = {
  async waiting(deps, userId, startedBy) {
    const rows = await deps.db.all<PrepareRow & { title: string; company_name: string }>(
      `SELECT ${PREPARE_COLUMNS}, a.title, a.company_name FROM prepare_jobs p
         JOIN applications a ON a.id = p.application_id AND a.user_id = p.user_id
        WHERE p.user_id = ? AND p.mode = 'mcp' AND p.state IN ${ACTIVE} AND p.job_id IS NOT NULL
          AND p.started_by = ? AND a.current_status = ? AND a.archived_at IS NULL
        ORDER BY p.created_at, p.id`,
      [userId, startedBy, STATUS.saved],
    );
    const jobs: WaitingJob[] = [];
    for (const row of rows) {
      jobs.push({
        prepare: prepareOf(row),
        jobId: row.job_id!,
        company: row.company_name,
        title: row.title,
        parts: await prepareService.draft(deps, userId, row.application_id),
      });
    }
    return jobs;
  },

  async active(deps, userId, applicationId) {
    const row = await deps.db.one<PrepareRow>(
      `SELECT ${PREPARE_COLUMNS} FROM prepare_jobs p WHERE p.user_id = ? AND p.application_id = ? AND p.state IN ${ACTIVE}
        ORDER BY p.created_at DESC LIMIT 1`,
      [userId, applicationId],
    );
    return row ? prepareOf(row) : null;
  },

  async start(deps, userId, request, options) {
    // v33 SHARE-5 (the review's decision 4: the seam takes the payer) and SHARE-8: the caller pays (their own on their
    // profile; payerOfGrant(grant, 'mcp') on a shared one, profiles.ts), the reasons as the caller may see them.
    return await service(deps).startPrepare(userId, request, 'mcp', { payer: options.payer, viewer: options.viewer });
  },

  async finish(deps, userId, applicationId, startedBy) {
    const finished = await service(deps).finishIfComplete(userId, applicationId, { startedBy });
    return { queued: finished?.state === 'queued', queueFull: finished?.queueFull === true };
  },

  async cancel(deps, userId, prepareId, actorId) {
    await service(deps).cancel(userId, prepareId, { actorId });
  },

  async resumeMode(deps, userId) {
    const row = await deps.db.one<{ mode: string }>('SELECT prepare_resume_mode AS mode FROM user_settings WHERE user_id = ?', [
      userId,
    ]);
    if (row && isResumeMode(row.mode)) return row.mode;
    const fallback = constantsOf(deps).get('PREPARE_RESUME_MODE_DEFAULT');
    return isResumeMode(fallback) ? fallback : (CONSTANTS.PREPARE_RESUME_MODE_DEFAULT.default as PrepareResumeMode);
  },

  async letter(deps, userId, job, prepare) {
    const mode = prepare?.letterMode ?? (await readAutofillProfile(deps, userId)).value.documents.coverLetters;
    const questions = (await prepareService.questions(deps, userId, job.applicationId)).map(({ question }) => question);
    // v2.0 (INT): P2's decideLetter, the server path's own rule (the job's facts and its known questions).
    const decision = await decideLetter(deps, mode, job.jobId, questions);
    // A Prepare that decided already keeps its decision.
    return prepare?.letterWanted === null || prepare?.letterWanted === undefined
      ? decision
      : { wanted: prepare.letterWanted, reason: decision.reason };
  },

  async draft(deps, userId, applicationId) {
    const draft = await draftView(deps, userId, applicationId);
    return draft
      ? {
          resumeStatus: draft.resume.status,
          resumeId: draft.resume.resumeId,
          letterStatus: draft.letter.status,
          coverLetterId: draft.letter.coverLetterId,
          answersStatus: draft.answers.status,
        }
      : null;
  },

  async questions(deps, userId, applicationId) {
    return (await draftQuestions(deps, userId, applicationId)).questions;
  },

  async saveResume(deps, userId, applicationId, input, startedBy) {
    return await saveDraftResume(deps, userId, applicationId, input, 'mcp', { startedBy });
  },

  async saveLetter(deps, userId, applicationId, input, startedBy) {
    return await saveDraftLetter(deps, userId, applicationId, input, 'mcp', { startedBy });
  },

  async saveAnswers(deps, userId, applicationId, answers, startedBy) {
    const saved = await saveDraftAnswers(deps, userId, applicationId, answers, 'mcp', { startedBy });
    return { kept: saved.kept, ready: saved.ready, refused: saved.refused.map(({ questionId, reason }) => ({ questionId, reason })) };
  },

  async mark(deps, userId, applicationId, status, reason, part = 'all', startedBy) {
    await markDraft(deps, userId, applicationId, { part, status, error: reason }, { startedBy });
  },
};
