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
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
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

export interface PrepareAdapter {
  /** The person's `mcp` Prepares waiting for their AI, oldest first, whose entries are still at Saved. */
  waiting(deps: AppDeps, userId: string): Promise<WaitingJob[]>;
  /** The application's active Prepare (either mode), or null. */
  active(deps: AppDeps, userId: string, applicationId: string): Promise<McpPrepare | null>;
  /** prepare_start: P2's startPrepare in mode `mcp` (its checks; no AI check, since no server AI runs). */
  start(deps: AppDeps, userId: string, request: PrepareStartRequest): Promise<PrepareStartResponse>;
  /** Queues the application's `mcp` Prepare when its required parts are ready (P2's finishIfComplete). */
  finish(deps: AppDeps, userId: string, applicationId: string): Promise<Finished>;
  cancel(deps: AppDeps, userId: string, prepareId: string): Promise<void>;
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
  saveResume(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    input: { document: ResumeDocument; sourceResumeId: string; title?: string },
  ): Promise<{ resumeId: string }>;
  saveLetter(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    input: { paragraphs: string[] },
  ): Promise<{ coverLetterId: string }>;
  saveAnswers(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    answers: ReadonlyArray<{ questionId: number; answer: AutofillSubmittedAnswerValue | null }>,
  ): Promise<{ kept: number; ready: number; refused: Array<{ questionId: number; reason: DraftAnswerRefusal }> }>;
  mark(
    deps: AppDeps,
    userId: string,
    applicationId: string,
    status: 'failed' | 'skipped',
    reason: string,
    part?: 'resume' | 'letter' | 'answers' | 'all',
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
}

const PREPARE_COLUMNS = `p.id, p.application_id, p.job_id, p.mode, p.state, p.letter_mode, p.letter_wanted, p.resume_mode,
  p.resume_id, p.created_at`;
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
});

/** P2's service; refused plainly while a server has none (a build before INT wires it). */
function service(deps: AppDeps) {
  const prepare = deps.services.prepare;
  if (!prepare) throw new AppError('internal', 'Prepare & Queue is not available on this TailorIT server.');
  return prepare;
}

const isResumeMode = (value: unknown): value is PrepareResumeMode =>
  (PREPARE_RESUME_MODES as readonly unknown[]).includes(value);

export const prepareService: PrepareAdapter = {
  async waiting(deps, userId) {
    const rows = await deps.db.all<PrepareRow & { title: string; company_name: string }>(
      `SELECT ${PREPARE_COLUMNS}, a.title, a.company_name FROM prepare_jobs p
         JOIN applications a ON a.id = p.application_id AND a.user_id = p.user_id
        WHERE p.user_id = ? AND p.mode = 'mcp' AND p.state IN ${ACTIVE} AND p.job_id IS NOT NULL
          AND a.current_status = ? AND a.archived_at IS NULL
        ORDER BY p.created_at, p.id`,
      [userId, STATUS.saved],
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

  async start(deps, userId, request) {
    return await service(deps).startPrepare(userId, request, 'mcp');
  },

  async finish(deps, userId, applicationId) {
    const finished = await service(deps).finishIfComplete(userId, applicationId);
    return { queued: finished?.state === 'queued', queueFull: finished?.queueFull === true };
  },

  async cancel(deps, userId, prepareId) {
    await service(deps).cancel(userId, prepareId);
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

  async saveResume(deps, userId, applicationId, input) {
    return await saveDraftResume(deps, userId, applicationId, input, 'mcp');
  },

  async saveLetter(deps, userId, applicationId, input) {
    return await saveDraftLetter(deps, userId, applicationId, input, 'mcp');
  },

  async saveAnswers(deps, userId, applicationId, answers) {
    const saved = await saveDraftAnswers(deps, userId, applicationId, answers, 'mcp');
    return { kept: saved.kept, ready: saved.ready, refused: saved.refused.map(({ questionId, reason }) => ({ questionId, reason })) };
  },

  async mark(deps, userId, applicationId, status, reason, part = 'all') {
    await markDraft(deps, userId, applicationId, { part, status, error: reason });
  },
};
