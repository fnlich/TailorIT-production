import { randomUUID } from 'node:crypto';
import {
  FILTER_REASON_LABELS,
  FILTER_REASONS,
  isActivePrepareState,
  letterDecision,
  STATUS,
  type ApplicationDraftAnswer,
  type ApplicationDraftResponse,
  type CoverLetterMode,
  type FilterReason,
  type LetterReason,
  type PrepareDraft,
  type PrepareJob,
  type PrepareJobState,
  type PrepareMode,
  type PreparePartStatus,
  type PrepareReason,
  type PrepareResumeMode,
  type PrepareStep,
} from '@tailorit/shared';
import type { AutofillKnownQuestion } from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { constantsOf } from '../../core/constants/service';
import { notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { logoUrlOf } from '../applications/store';
import { insertPreparedRow } from '../autofill/agent/prepared';
import type { AnswerScreen as ValueScreen } from '../autofill/ai/pick';
import { findForm, formPlace, formQuestions } from '../autofill/forms/store';
import { JOB_ANALYSIS_PROMPT_VERSION } from '../../ai/prompts/job-analysis/job-analysis';
import { readableForAi } from '../job-analysis/service';
import { readJobText } from '../jobs/text';
import { defaultResumeOf } from './chosen-resume';
import { parsedValue, planQuestions, refusalOfValue, type PlannedQuestion } from './questions';
import {
  answerRows,
  draftOf,
  insertDraft,
  prepareThatChose,
  updateDraft,
  updatePrepare,
  type DraftAnswerRow,
  type DraftRow,
  type PrepareRow,
} from './store';
import { sensitiveAnswerScreen } from '../autofill/profile/sensitive-screen';
import { notifyPrepareBatch } from '../notifications/emitters'; // v31 NOTIFY

// What Prepare's two paths share (docs/design/v2.0/05-prepare-flow.md): the saved job a Prepare is for, its known
// questions, the letter decision (A6), what of an earlier kit a new Prepare may keep (A29: the letter and the answers
// are written from the resume the kit uses), the kit's views, and the finishing rule (step f) that queues a kit
// through insertPreparedRow. Nothing here calls the AI.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Who prepared a kit's answers, by the Prepare's mode. */
export const provenanceOf = (by: PrepareMode): 'mcp' | 'server-ai' => (by === 'mcp' ? 'mcp' : 'server-ai');

const isOpen = (status: PreparePartStatus) => status === 'pending' || status === 'building';

// ------------------------------------------------------------------------------------------------- the saved job

/** A Tracker entry a Prepare is for. */
export interface DraftTarget {
  applicationId: string;
  jobId: number;
  title: string;
  companyName: string;
  logoUrl: string | null;
}

interface EntryRow {
  id: string;
  job_id: number | null;
  title: string;
  company_name: string;
  current_status: number;
  archived_at: string | null;
  logo_path: string | null;
}

const ENTRY_SQL = `SELECT a.id, a.job_id, a.title, a.company_name, a.current_status, a.archived_at, (SELECT cp.logo_path FROM company_profiles cp WHERE cp.company_id = c.id) AS logo_path
  FROM applications a LEFT JOIN companies c ON c.id = a.company_id`;

const targetOf = (row: EntryRow): DraftTarget => ({
  applicationId: row.id,
  jobId: row.job_id!,
  title: row.title,
  companyName: row.company_name,
  logoUrl: logoUrlOf(row.logo_path),
});

/** The account's entries among `ids` (others are left out), by id. */
export async function entriesOf(deps: Pick<AppDeps, 'db'>, userId: string, ids: readonly string[]): Promise<Map<string, EntryRow>> {
  if (ids.length === 0) return new Map();
  const rows = await deps.db.all<EntryRow>(`${ENTRY_SQL} WHERE a.user_id = ? AND a.id IN (${deps.db.dialect.list(ids.length)})`, [userId, ...ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Why an entry cannot be prepared (`no_job`, `not_saved`), or null. */
export function entryProblem(row: Pick<EntryRow, 'job_id' | 'current_status' | 'archived_at'>): 'no_job' | 'not_saved' | null {
  if (row.current_status !== STATUS.saved || row.archived_at !== null) return 'not_saved';
  if (row.job_id === null) return 'no_job';
  return null;
}

/** The application as a Prepare target: 404 when it is not the account's; 400 when it has no job or left Saved. */
export async function requireTarget(deps: Deps, userId: string, applicationId: string): Promise<DraftTarget> {
  const row = await deps.db.one<EntryRow>(`${ENTRY_SQL} WHERE a.id = ? AND a.user_id = ?`, [applicationId, userId]);
  if (!row) throw notFound('That application');
  const problem = entryProblem(row);
  if (problem === 'no_job') throw refuse(deps, 'validation_failed', 'MSG_PREPARE_NO_JOB');
  if (problem === 'not_saved') throw refuse(deps, 'validation_failed', 'MSG_PREPARE_NOT_SAVED');
  return targetOf(row);
}

/** The application while it is still at Saved with a job, or null (it left Saved, lost its job, or went). */
export async function currentTarget(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string): Promise<DraftTarget | null> {
  const row = await deps.db.one<EntryRow>(`${ENTRY_SQL} WHERE a.id = ? AND a.user_id = ?`, [applicationId, userId]);
  return row && entryProblem(row) === null ? targetOf(row) : null;
}

// ------------------------------------------------------------------------------------------------- the questions

/** The job's known questions (v1.3's job_form_questions, Greenhouse's included), in form order. */
export async function knownQuestions(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<AutofillKnownQuestion[]> {
  const place = await formPlace(deps.db, jobId, null);
  const form = place ? await findForm(deps.db, place) : null;
  return form ? formQuestions(deps.db, form.id) : [];
}

/** How many questions TailorIT knows of the job now. */
export async function questionCountOf(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<number> {
  const place = await formPlace(deps.db, jobId, null);
  const form = place ? await findForm(deps.db, place) : null;
  if (!form) return 0;
  return (await deps.db.one<{ n: number }>('SELECT count(*) AS n FROM job_form_questions WHERE form_id = ?', [form.id]))?.n ?? 0;
}

/**
 * The person's sensitive answers as a screen of option labels (profile/sensitive-screen.ts: the answers read once, when
 * the screen is made): a question offering one of them is never drafted.
 */
export async function valueScreen(deps: Pick<AppDeps, 'db'>, userId: string): Promise<ValueScreen> {
  return sensitiveAnswerScreen(deps, userId);
}

/** The answers' status from the plan and the rows: ready when every question a kit answers has a ready answer. */
export function answersStatusOf(planned: readonly PlannedQuestion[], rows: readonly DraftAnswerRow[]): 'ready' | 'not_ready' {
  if (planned.length === 0) return 'not_ready';
  const ready = new Set(rows.filter((row) => row.status === 'ready').map((row) => row.question_id));
  return planned.every((item) => item.state === 'profile' || ready.has(item.question.id)) ? 'ready' : 'not_ready';
}

// ------------------------------------------------------------------------------------------- the letter decision

/** What the job's facts say of a letter (job_facts.cover_letter_required, 0825), or null with no facts row. */
export async function letterFactsOf(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<{ coverLetterRequired: boolean | null } | null> {
  const row = await deps.db.one<{ cover_letter_required: number | null }>('SELECT cover_letter_required FROM job_facts WHERE job_id = ?', [jobId]);
  if (!row) return null;
  return { coverLetterRequired: row.cover_letter_required === null ? null : deps.db.dialect.isTrue(row.cover_letter_required) };
}

/** Step c: whether this Prepare makes a letter under `mode` (A6), and why, from the job's facts and known questions. */
export async function decideLetter(
  deps: Pick<AppDeps, 'db'>,
  mode: CoverLetterMode,
  jobId: number,
  known?: readonly AutofillKnownQuestion[],
): Promise<{ wanted: boolean; reason: LetterReason }> {
  const questions = known ?? (await knownQuestions(deps, jobId));
  return letterDecision(
    mode,
    await letterFactsOf(deps, jobId),
    questions.map((question) => ({ label: question.label, kind: question.kind, required: question.required })),
  );
}

// --------------------------------------------------------------------------------------------- the job's analysis

/**
 * Step b: whether a Prepare has the job read again by the AI first (charged to the person, A7): Claude's analysis of
 * its text is older than the current version (JOB_ANALYSIS_PROMPT_VERSION; 2 once the v2 analysis lands) or missing,
 * its text is readable, and AI_JOB_ANALYSIS is not `off`.
 */
export async function analysisNeeded(deps: Pick<AppDeps, 'db' | 'config'>, jobId: number): Promise<{ contentHash: string } | null> {
  if (deps.config.ai.jobAnalysis === 'off') return null;
  const row = await deps.db.one<{ content_hash: string | null; current: number }>(
    `SELECT j.content_hash,
         CASE WHEN EXISTS (SELECT 1 FROM job_analyses a WHERE a.content_hash = j.content_hash AND a.source = 'ai' AND a.version >= ?)
           THEN 1 ELSE 0 END AS current
         FROM jobs j WHERE j.id = ?`,
    [JOB_ANALYSIS_PROMPT_VERSION, jobId],
  );
  if (!row?.content_hash || row.current === 1) return null;
  // v3.0 PG-F: the posting text through features/jobs/text.ts (job_texts), read only when it decides.
  if (!readableForAi((await readJobText(deps.db, jobId))?.text ?? '')) return null;
  return { contentHash: row.content_hash };
}

// ----------------------------------------------------------------------------------------------- what a kit keeps

async function resumeExists(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<boolean> {
  return (await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [id, userId])) !== undefined;
}

/** The letter's id when it is still there and was written from `resumeId` (A29), else null. */
async function letterFrom(deps: Pick<AppDeps, 'db'>, userId: string, letterId: string | null, resumeId: string | null): Promise<string | null> {
  if (!letterId || !resumeId) return null;
  const row = await deps.db.one<{ resume_id: string | null }>('SELECT resume_id FROM cover_letters WHERE id = ? AND user_id = ?', [letterId, userId]);
  return row?.resume_id === resumeId ? letterId : null;
}

/**
 * Whether the kit's resume serves a Prepare in `mode` as it is: ready and still there, chosen by a Prepare of the same
 * mode (a kit from before A29 was tailored), and for `default` still the default resume.
 */
export async function kitResumeFits(deps: Pick<AppDeps, 'db'>, userId: string, draft: DraftRow | null, mode: PrepareResumeMode): Promise<boolean> {
  if (!draft || draft.resume_status !== 'ready' || !draft.resume_id) return false;
  if (!await resumeExists(deps, userId, draft.resume_id)) return false;
  const chooser = await prepareThatChose(deps.db, draft.application_id, draft.resume_id);
  if ((chooser?.resume_mode ?? 'tailor') !== mode) return false;
  return mode !== 'default' || draft.resume_id === await defaultResumeOf(deps, userId);
}

/** Whether the kit's letter is ready, still there, and written from the kit's resume. */
export async function kitLetterFits(deps: Pick<AppDeps, 'db'>, userId: string, draft: DraftRow | null): Promise<boolean> {
  return (
    draft !== null &&
    draft.letter_status === 'ready' &&
    await letterFrom(deps, userId, draft.cover_letter_id, draft.resume_id) !== null
  );
}

/** What a new Prepare of a saved job can keep of its kit, and what it has to make. */
export interface KitPlan {
  /** The kit's resume serves the Prepare's mode as it is. */
  resumeFits: boolean;
  letter: { wanted: boolean; reason: LetterReason };
  /** The kit's letter is ready and written from that resume. */
  letterFits: boolean;
  /** Known questions a kit answers ahead (`draft` state): answers are made only for these. */
  questionsToAnswer: number;
  /** The kit's answers were made from that resume for the questions known now. */
  answersFit: boolean;
  /** The job is read again by the AI first (step b). */
  analysis: boolean;
}

export async function planKit(
  deps: Pick<AppDeps, 'db' | 'config'>,
  userId: string,
  input: { jobId: number; draft: DraftRow | null; letterMode: CoverLetterMode; resumeMode: PrepareResumeMode; rebuild: boolean },
): Promise<KitPlan> {
  const questions = await knownQuestions(deps, input.jobId);
  const planned = planQuestions(questions, await valueScreen(deps, userId));
  const resumeFits = !input.rebuild && await kitResumeFits(deps, userId, input.draft, input.resumeMode);
  const made = input.draft?.answers_status === 'ready' || input.draft?.answers_status === 'not_ready';
  return {
    resumeFits,
    letter: await decideLetter(deps, input.letterMode, input.jobId, questions),
    letterFits: resumeFits && await kitLetterFits(deps, userId, input.draft),
    questionsToAnswer: planned.filter((item) => item.state === 'draft').length,
    answersFit: resumeFits && made && input.draft!.questions_seen === planned.length,
    analysis: await analysisNeeded(deps, input.jobId) !== null,
  };
}

/** A kit queued at once, with no AI: the resume fits, and the letter does or none is wanted. */
export const kitIsReusable = (plan: KitPlan) => plan.resumeFits && (!plan.letter.wanted || plan.letterFits);

/** Whether a server Prepare of this plan uses the AI (A29: `default` and `similar` make no resume with it). */
export function planNeedsAi(plan: KitPlan, resumeMode: PrepareResumeMode, customPending: boolean): boolean {
  return (
    customPending ||
    plan.analysis ||
    (!plan.resumeFits && resumeMode === 'tailor') ||
    (plan.letter.wanted && !plan.letterFits) ||
    (plan.questionsToAnswer > 0 && !plan.answersFit)
  );
}

// ------------------------------------------------------------------------------------------------------ the draft

/** The application's draft, made (every part pending, by `by`) when it has none. */
export async function ensureDraft(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string, by: PrepareMode, now: string): Promise<DraftRow> {
  const found = await draftOf(deps.db, userId, applicationId);
  if (found) return found;
  await insertDraft(deps.db, {
    id: randomUUID(),
    user_id: userId,
    application_id: applicationId,
    resume_status: 'pending',
    letter_status: 'pending',
    answers_status: 'pending',
    resume_id: null,
    cover_letter_id: null,
    built_by: by,
    prepare_id: null,
    questions_seen: 0,
    error: null,
    created_at: now,
    updated_at: now,
    built_at: null,
  });
  return (await draftOf(deps.db, userId, applicationId))!;
}

/**
 * A Prepare ended before its parts were made (cancelled, or its entry left Saved): each part still pending or being
 * made goes back to what it was: ready with its document or answers, else skipped.
 */
export async function restoreDraft(deps: Pick<AppDeps, 'db'>, draft: DraftRow, now: string): Promise<void> {
  const rows = await answerRows(deps.db, draft.id);
  const answers: PreparePartStatus =
    rows.length > 0 ? (rows.every((row) => row.status === 'ready') ? 'ready' : 'not_ready') : draft.built_at ? 'not_ready' : 'skipped';
  const back = (status: PreparePartStatus, made: boolean): PreparePartStatus =>
    isOpen(status) ? (made ? 'ready' : 'skipped') : status;
  await updateDraft(
    deps.db,
    draft.id,
    {
      resume_status: back(draft.resume_status, draft.resume_id !== null),
      letter_status: back(draft.letter_status, draft.cover_letter_id !== null),
      answers_status: isOpen(draft.answers_status) ? answers : draft.answers_status,
    },
    now,
  );
}

/**
 * Links the kit's documents to the application (the person's choice, as tailoring links them), so the extension
 * attaches them and the queue row takes the kit's resume (insertPreparedRow reads the entry's resume_id).
 */
export async function linkToApplication(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  applicationId: string,
  documents: { resumeId?: string | null; coverLetterId?: string | null },
  now: string,
): Promise<void> {
  if (documents.resumeId) {
    await deps.db.run(
      `UPDATE applications SET resume_id = ?, resume_origin = 'user', resume_matched_at = ?,
           resume_match_due = ${deps.db.dialect.false}, updated_at = ? WHERE id = ? AND user_id = ?`,
      [documents.resumeId, now, now, applicationId, userId],
    );
  }
  if (documents.coverLetterId) {
    await deps.db.run('UPDATE applications SET cover_letter_id = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
      documents.coverLetterId,
      now,
      applicationId,
      userId,
    ]);
  }
}

// ------------------------------------------------------------------------------------------------------ the views

/** A draft as the pages and the MCP tools read it. */
export async function draftViewOf(deps: Pick<AppDeps, 'db'>, row: DraftRow, jobId: number | null): Promise<PrepareDraft> {
  const rows = await answerRows(deps.db, row.id);
  const prepare = row.prepare_id
    ? (await deps.db.one<{ resume_mode: PrepareResumeMode }>('SELECT resume_mode FROM prepare_jobs WHERE id = ?', [row.prepare_id]))
    : undefined;
  return {
    id: row.id,
    applicationId: row.application_id,
    builtBy: row.built_by,
    prepareId: row.prepare_id,
    resume: { status: row.resume_status, resumeId: row.resume_id, resumeMode: prepare?.resume_mode ?? null },
    letter: { status: row.letter_status, coverLetterId: row.cover_letter_id },
    answers: {
      status: row.answers_status,
      ready: rows.filter((answer) => answer.status === 'ready').length,
      total: rows.length,
      questionsKnown: jobId === null ? 0 : await questionCountOf(deps, jobId),
    },
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    builtAt: row.built_at,
  };
}

/** The application's draft, or null (404 when the application is not the account's). */
export async function draftView(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string): Promise<PrepareDraft | null> {
  const app = await deps.db.one<{ job_id: number | null }>('SELECT job_id FROM applications WHERE id = ? AND user_id = ?', [applicationId, userId]);
  if (!app) throw notFound('That application');
  const row = await draftOf(deps.db, userId, applicationId);
  return row ? draftViewOf(deps, row, app.job_id) : null;
}

/** GET /api/applications/:id/draft: the kit and every known question of its job, each ready, not ready or profile. */
export async function applicationDraft(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string): Promise<ApplicationDraftResponse> {
  const app = await deps.db.one<{ job_id: number | null }>('SELECT job_id FROM applications WHERE id = ? AND user_id = ?', [applicationId, userId]);
  if (!app) throw notFound('That application');
  const row = await draftOf(deps.db, userId, applicationId);
  const planned = app.job_id === null ? [] : planQuestions(await knownQuestions(deps, app.job_id), await valueScreen(deps, userId));
  const rows = new Map((row ? await answerRows(deps.db, row.id) : []).map((answer) => [answer.question_id, answer]));
  const answers: ApplicationDraftAnswer[] = planned.map((item) => {
    const kept = item.state === 'profile' ? undefined : rows.get(item.question.id);
    const value = kept?.status === 'ready' ? parsedValue(kept.answer) : null;
    const ready = value !== null && refusalOfValue(item, value) === null;
    return {
      questionId: item.question.id,
      label: item.question.label,
      section: item.question.section,
      step: item.question.step,
      required: item.question.required,
      kind: item.question.kind,
      state: item.state === 'profile' ? 'profile' : ready ? 'ready' : 'not_ready',
      answer: ready ? value : null,
      provenance: kept?.provenance ?? null,
    };
  });
  const title = async (sql: string, id: string | null) =>
    id ? ((await deps.db.one<{ title: string | null }>(sql, [id, userId]))?.title ?? null) : null;
  return {
    draft: row ? await draftViewOf(deps, row, app.job_id) : null,
    resumeTitle: await title('SELECT title FROM resumes WHERE id = ? AND user_id = ?', row?.resume_id ?? null),
    coverLetterTitle: await title('SELECT title FROM cover_letters WHERE id = ? AND user_id = ?', row?.cover_letter_id ?? null),
    answers,
  };
}

/** A filter reason as the page shows it: "Filtered: on-site". */
export function filterReasonOf(deps: Deps, entry: { code: FilterReason; value?: string }): PrepareReason {
  const constants = constantsOf(deps);
  const reason = constants.message(FILTER_REASON_LABELS[entry.code], { value: entry.value ?? '' });
  return { code: entry.code, label: constants.message('MSG_FILTERED', { reason }) };
}

/** A stored reason code in words (a filter's, an interrupted or a left-Saved Prepare's). */
export function reasonOf(deps: Deps, code: string | null): PrepareReason | null {
  if (code === null) return null;
  if ((FILTER_REASONS as readonly string[]).includes(code)) return filterReasonOf(deps, { code: code as FilterReason });
  const constants = constantsOf(deps);
  if (code === 'interrupted') return { code, label: constants.message('MSG_PREPARE_INTERRUPTED') };
  if (code === 'not_saved') return { code, label: constants.message('MSG_PREPARE_NOT_SAVED') };
  return { code, label: code };
}

/** What an active server Prepare is doing (the Queue pane's "Preparing" line); null otherwise. */
export function stepOf(row: PrepareRow, draft: DraftRow | null): PrepareStep | null {
  if (row.mode !== 'server') return null;
  if (row.state === 'filtering') return 'filters';
  if (row.state === 'analyzing') return 'analysis';
  if (row.state !== 'building') return null;
  const mine = draft?.prepare_id === row.id ? draft : null;
  if (mine && isOpen(mine.letter_status) && !isOpen(mine.resume_status)) return 'letter';
  if (mine && isOpen(mine.answers_status) && !isOpen(mine.resume_status) && !isOpen(mine.letter_status)) return 'answers';
  return 'resume';
}

/** A Prepare as the person sees it (never its cost). */
export async function prepareJobView(deps: Deps, row: PrepareRow): Promise<PrepareJob> {
  return {
    id: row.id,
    applicationId: row.application_id,
    jobId: row.job_id,
    mode: row.mode,
    letterMode: row.letter_mode,
    resumeMode: row.resume_mode,
    resumeId: row.resume_id,
    letterWanted: row.letter_wanted === null ? null : deps.db.dialect.isTrue(row.letter_wanted),
    rebuild: deps.db.dialect.isTrue(row.rebuild),
    state: row.state,
    step: isActivePrepareState(row.state) ? stepOf(row, await draftOf(deps.db, row.user_id, row.application_id)) : null,
    reason: reasonOf(deps, row.reason_code),
    error: row.error,
    queueId: row.queue_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

// ------------------------------------------------------------------------------------------------ the finishing rule

/** What finishing a Prepare came to (PrepareService.finishIfComplete's answer). */
export interface FinishResult {
  prepareId: string;
  state: PrepareJobState;
  queueId: string | null;
  queueFull: boolean;
}

/**
 * Step f, inside the caller's transaction, for a Prepare whose kit is the draft (`draft.prepare_id = row.id`): null
 * while a part is still to make. Otherwise:
 * - the entry left Saved meanwhile: `cancelled`, reason `not_saved` (never queued);
 * - the resume skipped, or a wanted letter skipped: `cancelled` (the person's own AI marked it so);
 * - the resume not ready, or a wanted letter not ready: `failed`, with what went wrong;
 * - else the kit is frozen as it is (A30): its resume and letter (or none) are the application's, the Prepare names its
 *   resume, and insertPreparedRow inserts (or re-links) the queue row: `queued`, or `prepared` with MSG_PREPARE_QUEUE_FULL
 *   when the queue is full now.
 * Answers are never required: those not made are made during the application.
 */
export async function finishKit(deps: AppDeps, row: PrepareRow, draft: DraftRow, now: string): Promise<FinishResult | null> {
  const finished = await finishKitSteps(deps, row, draft, now);
  // v31 NOTIFY: the batch's summary when this was its last active Prepare, in the caller's transaction.
  if (finished) await notifyPrepareBatch(deps, row);
  return finished;
}

async function finishKitSteps(deps: AppDeps, row: PrepareRow, draft: DraftRow, now: string): Promise<FinishResult | null> {
  if ([draft.resume_status, draft.letter_status, draft.answers_status].some(isOpen)) return null;
  // v2.0 FIX-B (BEH-3): an entry that left Saved (Applied, archived, its job gone) while its kit was made is never
  // queued: `cancelled`, reason `not_saved`; the parts made stay in the kit.
  if (!await currentTarget(deps, row.user_id, row.application_id)) {
    await updatePrepare(deps.db, row.id, { state: 'cancelled', reason_code: 'not_saved', finished_at: now }, now);
    return { prepareId: row.id, state: 'cancelled', queueId: null, queueFull: false };
  }
  const constants = constantsOf(deps);
  const wanted = deps.db.dialect.isTrue(row.letter_wanted);
  const resumeReady = draft.resume_status === 'ready' && draft.resume_id !== null && await resumeExists(deps, row.user_id, draft.resume_id);
  const letterReady =
    draft.letter_status === 'ready' &&
    draft.cover_letter_id !== null &&
    (await deps.db.one('SELECT 1 FROM cover_letters WHERE id = ? AND user_id = ?', [draft.cover_letter_id, row.user_id])) !== undefined;
  const end = async (state: PrepareJobState, changes: { error?: string | null; queue_id?: string | null } = {}): Promise<FinishResult> => {
    await updatePrepare(deps.db, row.id, { state, finished_at: now, ...changes }, now);
    await updateDraft(deps.db, draft.id, { built_at: now }, now);
    return { prepareId: row.id, state, queueId: changes.queue_id ?? null, queueFull: state === 'prepared' };
  };
  if (draft.resume_status === 'skipped' || (wanted && draft.letter_status === 'skipped')) return end('cancelled');
  if (row.job_id === null) return end('failed', { error: constants.message('MSG_PREPARE_NO_JOB') });
  if (!resumeReady) return end('failed', { error: draft.error ?? constants.message('MSG_PREPARE_RESUME_FAILED') });
  if (wanted && !letterReady) return end('failed', { error: draft.error ?? constants.message('MSG_PREPARE_LETTER_FAILED') });

  const documents = { resumeId: draft.resume_id, coverLetterId: letterReady ? draft.cover_letter_id : null };
  await linkToApplication(deps, row.user_id, row.application_id, documents, now);
  // v2.0 FIX-B (BEH-2): a kit with no letter leaves the entry with none either, so no reader falls back to an earlier
  // kit's letter (written from another resume, A29): the queued kit is exactly what is used (A30).
  if (!letterReady) {
    await deps.db.run(
      'UPDATE applications SET cover_letter_id = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND cover_letter_id IS NOT NULL',
      [now, row.application_id, row.user_id],
    );
  }
  await updatePrepare(deps.db, row.id, { resume_id: draft.resume_id }, now);
  const inserted = await insertPreparedRow(deps, {
    userId: row.user_id,
    jobId: row.job_id,
    applicationId: row.application_id,
    prepareId: row.id,
  });
  if (inserted === 'full') {
    return end('prepared', { error: constants.message('MSG_PREPARE_QUEUE_FULL', { limit: constants.get('QUEUE_SIZE_MAX') }) });
  }
  return end('queued', { queue_id: inserted.queueId });
}
