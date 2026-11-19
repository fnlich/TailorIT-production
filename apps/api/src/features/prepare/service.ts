import { randomUUID } from 'node:crypto';
import {
  effectiveTemplateId,
  isActivePrepareState,
  isEditorDocument,
  normalizeResumeDocument,
  PREPARE_SKIP_MESSAGES,
  type FilterReason,
  type PrepareDraft,
  type PrepareJob,
  type PrepareJobState,
  type PrepareMode,
  type PrepareReason,
  type PrepareResumeMode,
  type PrepareSkipCode,
  type PrepareStartRequest,
  type PrepareStartResponse,
  type ResumeDocument,
} from '@tailorit/shared';
import type { AutofillKnownQuestion, AutofillSubmittedAnswerValue } from '@tailorit/shared/autofill';
import { entitlementsOf, resumeLimitError } from '../../core/accounts/index';
import { aiUnavailableError } from '../../core/accounts/refusals';
import { constantsOf } from '../../core/constants/service';
import { nowIso, type AppDeps } from '../../core/context';
import { conflict, notFound, validationFailed } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { assertServerAi } from '../../ai/gate';
import { upgradeLegacyDocument } from '../../core/resume-upgrade';
import { readAutofillProfile } from '../autofill/profile/repository';
import { letterProfile, visibleTemplate } from '../cover-letters/context';
import { createLetterRepository } from '../cover-letters/repository';
import { resumeCount } from '../resumes/counters';
import { getResumeEngine } from '../resumes/engine';
import { getResumeEvidence } from '../resumes/evidence';
import { assertRoomForResumes, insertResume } from '../resumes/repository';
import { keptFacts } from '../tailor/mapping';
import { letterHtml, tailoredTitle } from '../tailor/output';
import { sourceDocument } from '../tailor/source';
import { chooseResume, defaultResumeOf, resumeAvailable } from './chosen-resume';
import {
  answersStatusOf,
  draftViewOf,
  ensureDraft,
  entriesOf,
  entryProblem,
  filterReasonOf,
  finishKit,
  kitIsReusable,
  knownQuestions,
  linkToApplication,
  planKit,
  planNeedsAi,
  prepareJobView,
  provenanceOf,
  requireTarget,
  restoreDraft,
  valueScreen,
  type FinishResult,
  type KitPlan,
} from './kit';
import { planQuestions, refusalOfValue, type PlannedQuestion, type ValueRefusal } from './questions';
import { createPrepareRunner, type PrepareRunner } from './runner';
import { letterModeOf, resumeModeOf } from './settings';
import {
  activePrepareOf,
  answerRows,
  draftOf,
  draftsOf,
  getPrepare,
  insertPrepare,
  mcpActiveRows,
  mcpChoosingRows,
  prepareById,
  staleMcpRows,
  updateDraft,
  updatePrepare,
  withActivePrepare,
  writeAnswers,
  type DraftChanges,
  type DraftRow,
  type PrepareRow,
} from './store';
import type { PrepareService } from '../../core/seams';

// Prepare & Queue (v2.0, docs/design/v2.0/05-prepare-flow.md; DECISIONS A29, A30): one Prepare of one saved job (a
// Tracker entry at Saved with a job) at a time, its kit kept in the application's draft, the queue row inserted when
// the kit is ready. This module holds:
// - startPrepare, POST /api/prepare's and MCP prepare_start's service, its checks in the order the request gives:
//   the entries, the prepare filters (P4's service; verdicts recorded even when a later check refuses), the AI usage
//   (server path, and only when some part needs the AI), the resume limit (only the `tailor` mode makes a resume),
//   the queue room; then the prepare_jobs rows and the reusable kits queued, in one IMMEDIATE transaction;
// - cancel, and the MCP path's finishing rule (finishIfComplete);
// - the saves of the person's own AI over MCP (saveDraftResume, saveDraftLetter, saveDraftAnswers, markDraft), which
//   write only the kit of the application's active `mcp` Prepare: a queued kit is never edited in place (A30);
// - createPrepareService, deps.services.prepare (core/seams.ts PrepareService), with the server runner (runner.ts).
// The log names the account, the Prepare and counts; never a question, an answer, a resume, a letter or a posting.
// v3.0 D2-F: on the async client.

export const FACTS_CHANGED =
  'This resume changes facts of the resume it was tailored from (an employer, a title or a date), so it was not kept.';
/** An MCP save with no Prepare of the job waiting for the person's own AI (A30: a queued kit is never edited). */
export const NOT_PREPARING =
  'This saved job has no Prepare waiting for your own AI. Start one with prepare_start, then save its parts.';
/** An MCP resume save for a Prepare whose resume mode keeps an existing resume (A29). */
export const MODE_KEEPS_RESUME =
  "This Prepare uses the resume the person's resume mode chose, as it is. Save its cover letter and answers only.";
/** An MCP letter or answers save before the kit has its resume (A29: they are written from it). */
export const RESUME_FIRST =
  "Save this job's resume first (or wait a moment while TailorIT chooses it): the cover letter and the answers are " +
  'written from it.';

const MAX_ERROR = 2000;
const LETTER_PARAGRAPHS = { min: 1, max: 6, length: 3000 } as const;
/**
 * An MCP letter save outside LETTER_PARAGRAPHS (v30 INT-0, audit B10: its numbers from the caps, written once): "A cover
 * letter needs 1 to 6 paragraphs of at most 3,000 characters each." An MCP tool's input refusal (A18, MCP_INPUT).
 */
export const BAD_LETTER =
  `A cover letter needs ${LETTER_PARAGRAPHS.min} to ${LETTER_PARAGRAPHS.max} paragraphs of at most ` +
  `${LETTER_PARAGRAPHS.length.toLocaleString('en-US')} characters each.`;

type Result = PrepareStartResponse['results'][number];

/** The MCP tools' reads of a kit (kept here, where the MCP adapter has always imported them). */
export { applicationDraft, draftView, draftViewOf } from './kit';

// ----------------------------------------------------------------------------------------------- shared steps

/**
 * Ends an active Prepare (`cancelled` or `failed`): the parts its kit still had to make go back to what they were. The
 * caller holds the transaction.
 */
export async function endPrepare(
  deps: Pick<AppDeps, 'db'>,
  row: PrepareRow,
  state: Extract<PrepareJobState, 'cancelled' | 'failed' | 'filtered'>,
  now: string,
  details: { error?: string | null; reason?: string | null } = {},
): Promise<void> {
  await updatePrepare(
    deps.db,
    row.id,
    {
      state,
      finished_at: now,
      ...(details.error !== undefined ? { error: details.error } : {}),
      ...(details.reason !== undefined ? { reason_code: details.reason } : {}),
    },
    now,
  );
  const draft = await draftOf(deps.db, row.user_id, row.application_id);
  if (draft?.prepare_id === row.id) await restoreDraft(deps, draft, now);
}

/** The kit of an active Prepare: the application's draft, taken over by the Prepare when another one last had it. */
async function kitDraftFor(deps: Pick<AppDeps, 'db'>, row: PrepareRow, now: string): Promise<DraftRow> {
  const draft = await ensureDraft(deps, row.user_id, row.application_id, row.mode, now);
  if (draft.prepare_id === row.id) return draft;
  await updateDraft(deps.db, draft.id, { prepare_id: row.id, built_by: row.mode }, now);
  return (await draftOf(deps.db, row.user_id, row.application_id))!;
}

// ---------------------------------------------------------------------------------------------------- the start

interface Passing {
  applicationId: string;
  jobId: number;
  customPending: boolean;
  draft: DraftRow | null;
  plan: KitPlan;
}

function skipReason(deps: AppDeps, code: PrepareSkipCode): PrepareReason {
  const key = PREPARE_SKIP_MESSAGES[code];
  return { code, label: key ? constantsOf(deps).message(key) : '' };
}

/** The account's jobs among `jobIds` whose queue row is live (queued or running): `already_queued`. */
async function liveQueueJobs(deps: Pick<AppDeps, 'db'>, userId: string, jobIds: readonly number[]): Promise<Set<number>> {
  if (jobIds.length === 0) return new Set();
  const rows = await deps.db.all<{ job_id: number }>(
    `SELECT job_id FROM autofill_agent_queue WHERE user_id = ? AND state IN ('queued', 'running')
         AND job_id IN (${deps.db.dialect.list(jobIds.length)})`,
    [userId, ...jobIds],
  );
  return new Set(rows.map((row) => row.job_id));
}

/**
 * Check 3, the resume storage, for a `tailor` Prepare (A29: the one mode that makes a resume): 403
 * resume_limit_reached when the account is at its plan's limit (`count >= limit`, so even a reusable kit waits), or
 * when the resumes it would make would not fit (`count + making > limit`); then the technical cap
 * (assertRoomForResumes).
 */
async function assertResumeRoom(deps: AppDeps, userId: string, making: number): Promise<void> {
  const entitlements = await entitlementsOf(deps, userId);
  const limit = entitlements.resumes;
  if (limit !== null) {
    const n = await resumeCount(deps.db, userId); // v30 DB-JOBS (D1d): the stored count the resume limit reads
    if (n >= limit || n + making > limit) throw resumeLimitError(deps, limit, { free: entitlements.type === 'free' });
  }
  if (making > 0) await assertRoomForResumes(deps, userId, making);
}

/** The queue room: the account's rows plus the passing jobs with no row yet, against QUEUE_SIZE_MAX (409). */
async function assertQueueRoom(deps: AppDeps, userId: string, jobIds: readonly number[]): Promise<void> {
  if (jobIds.length === 0) return;
  const constants = constantsOf(deps);
  const limit = constants.get('QUEUE_SIZE_MAX');
  const rows = await deps.db.all<{ job_id: number }>('SELECT job_id FROM autofill_agent_queue WHERE user_id = ?', [userId]);
  const held = new Set(rows.map((row) => row.job_id));
  const adding = new Set(jobIds.filter((jobId) => !held.has(jobId))).size;
  if (adding > 0 && rows.length + adding > limit) throw refuse(deps, 'conflict', 'MSG_PREPARE_QUEUE_FULL', { limit });
}

/** What startPrepare hands on once its transaction committed. */
export interface StartHooks {
  /** Wakes the server runner. */
  kick(): void;
  /** MCP Prepares in mode `similar` whose resume is chosen right after the start (the resume match is async). */
  chooseLater(prepareIds: readonly string[]): void;
}

const NO_HOOKS: StartHooks = { kick: () => undefined, chooseLater: () => undefined };

/**
 * A kit queued at once with no AI (kitIsReusable), unless its Custom verdict is pending (the server path; the MCP path
 * skips such a job as `custom_pending`): a pending verdict is never reusable (v2.0 FIX-B, SEC-2 = BEH-1).
 */
const reusable = (item: Passing) => kitIsReusable(item.plan) && !item.customPending;

/**
 * POST /api/prepare (mode `server`) and MCP prepare_start (mode `mcp`). Answers each job's outcome in the request's
 * order, or throws one AppError for the whole request (nothing started): 400 past PREPARE_BATCH_MAX or with no resume
 * to use (MSG_PREPARE_NO_RESUME); 503 ai_unavailable or 429 ai_usage_exhausted (server path); 403
 * resume_limit_reached (`tailor`); 409 conflict with MSG_PREPARE_QUEUE_FULL.
 */
export async function startPrepare(
  deps: AppDeps,
  userId: string,
  request: PrepareStartRequest,
  mode: PrepareMode,
  hooks: StartHooks = NO_HOOKS,
): Promise<PrepareStartResponse> {
  const constants = constantsOf(deps);
  const max = constants.get('PREPARE_BATCH_MAX');
  if (request.applicationIds.length > max) {
    const message = constants.message('MSG_PREPARE_BATCH_MAX', { max });
    throw refuse(deps, 'validation_failed', 'MSG_PREPARE_BATCH_MAX', { max }, { fields: { applicationIds: message } });
  }
  const ids = request.applicationIds;
  const results = new Map<string, Result>();
  const skip = (applicationId: string, code: PrepareSkipCode) =>
    results.set(applicationId, { applicationId, outcome: 'skipped', reason: skipReason(deps, code) });

  // 1. The entries.
  const entries = await entriesOf(deps, userId, ids);
  const active = await withActivePrepare(deps.db, ids);
  const live = await liveQueueJobs(deps, userId, [...entries.values()].flatMap((row) => (row.job_id === null ? [] : [row.job_id])));
  const kept: Array<{ applicationId: string; jobId: number }> = [];
  for (const applicationId of ids) {
    const row = entries.get(applicationId);
    if (!row) skip(applicationId, 'not_found');
    else if (entryProblem(row)) skip(applicationId, entryProblem(row)!);
    else if (active.has(applicationId)) skip(applicationId, 'active');
    else if (live.has(row.job_id!)) skip(applicationId, 'already_queued');
    else kept.push({ applicationId, jobId: row.job_id! });
  }

  // 2. Check 1, the prepare filters: each verdict is recorded (its own transaction, P4) before any later check.
  const filters = deps.services.prepareFilters;
  const checks = new Map(
    (filters && kept.length > 0 ? await filters.evaluate(userId, kept.map((entry) => entry.applicationId), { record: true }) : []).map(
      (check) => [check.applicationId, check],
    ),
  );
  const passingEntries: Array<{ applicationId: string; jobId: number; customPending: boolean }> = [];
  for (const entry of kept) {
    const check = checks.get(entry.applicationId);
    const first = check?.verdict.verdict === 'fail' ? check.verdict.reasons[0] : undefined;
    if (first || check?.custom === 'fail') {
      const reason = filterReasonOf(deps, first ?? { code: 'custom' satisfies FilterReason });
      results.set(entry.applicationId, { applicationId: entry.applicationId, outcome: 'filtered', reason });
    } else if (check?.custom === 'pending' && mode === 'mcp') {
      // The person's own AI judges the Custom filter first (custom_filter_verdicts), never the start.
      skip(entry.applicationId, 'custom_pending');
    } else {
      passingEntries.push({ ...entry, customPending: check?.custom === 'pending' });
    }
  }

  // 3. Split: the reusable kits (queued now, no AI) and the jobs to prepare. v2.0 FIX-B (SEC-2 = BEH-1): a kit whose
  // Custom verdict is pending is never reusable: it goes through the runner, whose step a judges it before anything is
  // queued (and then reuses the kit's parts), and it counts in the AI check below.
  const resumeMode = await resumeModeOf(deps, userId);
  const letterMode = await letterModeOf(deps, userId);
  const drafts = await draftsOf(deps.db, userId, passingEntries.map((entry) => entry.applicationId));
  const passing: Passing[] = [];
  for (const entry of passingEntries) {
    const draft = drafts.get(entry.applicationId) ?? null;
    passing.push({ ...entry, draft, plan: await planKit(deps, userId, { jobId: entry.jobId, draft, letterMode, resumeMode, rebuild: request.rebuild }) });
  }
  const toPrepare = passing.filter((item) => !reusable(item));

  if (toPrepare.length > 0 && !(await resumeAvailable(deps, userId, resumeMode))) {
    const message = constants.message('MSG_PREPARE_NO_RESUME');
    throw refuse(deps, 'validation_failed', 'MSG_PREPARE_NO_RESUME', undefined, { fields: { resume: message } });
  }
  // 4. Check 2, the AI usage: the server path, and only when some part of some job needs the AI.
  if (mode === 'server' && toPrepare.some((item) => planNeedsAi(item.plan, resumeMode, item.customPending))) {
    if (!deps.services.ai || (resumeMode === 'tailor' && !deps.services.tailor)) throw aiUnavailableError(deps);
    await assertServerAi(deps, userId);
  }
  // 5. Check 3, the resume storage: only the `tailor` mode makes a resume (A29).
  if (resumeMode === 'tailor' && passing.length > 0) {
    await assertResumeRoom(deps, userId, toPrepare.filter((item) => !item.plan.resumeFits).length);
  }
  // 6. The queue room.
  await assertQueueRoom(deps, userId, passing.map((item) => item.jobId));

  // 7. Write, in one IMMEDIATE transaction. The checks above ran outside it, so two starts of one application at once
  // may both pass them: idx_prepare_jobs_active lets one insert, and the other answers `active` (insertPrepare's
  // ON CONFLICT DO NOTHING; v3.0 D2-F, 11 §9.3's concurrency audit).
  const now = nowIso(deps);
  const later: string[] = [];
  let started = 0;
  await deps.db.tx(async () => {
    for (const item of passing) {
      const row: PrepareRow = {
        id: randomUUID(),
        user_id: userId,
        application_id: item.applicationId,
        job_id: item.jobId,
        mode,
        letter_mode: letterMode,
        letter_wanted: mode === 'mcp' || reusable(item) ? item.plan.letter.wanted : null,
        rebuild: request.rebuild === true,
        state: reusable(item) ? 'building' : 'waiting',
        reason_code: null,
        error: null,
        queue_id: null,
        cost_micros: 0,
        resume_mode: resumeMode,
        resume_id: null,
        created_at: now,
        // v2.0 FIX-B (BEH-6): set when the work is taken up (the runner, the first MCP save); a reusable kit is queued
        // with no AI and never counts toward the Prepares an hour (FREE_/PAID_PREPARE_PER_HOUR).
        started_at: null,
        finished_at: null,
        updated_at: now,
      };
      // idx_prepare_jobs_active: a concurrent request made one first.
      if (!(await insertPrepare(deps.db, row))) {
        skip(item.applicationId, 'active');
        continue;
      }
      const outcome = reusable(item)
        ? await queueReusable(deps, row, item, now)
        : await startKit(deps, row, item, now, later);
      if (outcome === 'started') started += 1;
      results.set(item.applicationId, { applicationId: item.applicationId, outcome, prepareId: row.id });
    }
  });

  // 8. Kick the runner.
  if (mode === 'server' && started > 0) hooks.kick();
  if (later.length > 0) hooks.chooseLater(later);
  const counts = [...results.values()].reduce<Record<string, number>>((all, result) => {
    all[result.outcome] = (all[result.outcome] ?? 0) + 1;
    return all;
  }, {});
  deps.log.debug(
    `[prepare] account ${userId} Prepare & Queue (${mode}, ${resumeMode}, letters ${letterMode}` +
      `${request.rebuild ? ', rebuild' : ''}): ${Object.entries(counts).map(([outcome, n]) => `${n} ${outcome}`).join(', ')}`,
  );
  return { results: ids.map((applicationId) => results.get(applicationId)!) };
}

/** A reusable kit: the Prepare takes it over as it is and queues it (no AI). */
async function queueReusable(deps: AppDeps, row: PrepareRow, item: Passing, now: string): Promise<'queued' | 'started'> {
  const draft = await kitDraftFor(deps, row, now);
  if (!item.plan.letter.wanted && draft.letter_status !== 'off') {
    // No letter under the current mode: the kit holds none (A30: the queued kit is exactly what is used).
    await updateDraft(deps.db, draft.id, { letter_status: 'off', cover_letter_id: null }, now);
  }
  const finished = await finishKit(deps, (await prepareById(deps.db, row.id))!, (await draftOf(deps.db, row.user_id, row.application_id))!, now);
  return finished?.state === 'queued' ? 'queued' : 'started';
}

/** A job to prepare: its kit's parts to make go `pending`; the MCP path decides what it can now. */
async function startKit(deps: AppDeps, row: PrepareRow, item: Passing, now: string, later: string[]): Promise<'queued' | 'started'> {
  const draft = await kitDraftFor(deps, row, now);
  const { plan } = item;
  const changes: DraftChanges = {
    error: null,
    resume_status: plan.resumeFits ? 'ready' : 'pending',
    letter_status: plan.letterFits ? 'ready' : 'pending',
    answers_status: plan.answersFit ? draft.answers_status : 'pending',
  };
  if (row.mode === 'server') {
    await updateDraft(deps.db, draft.id, changes, now);
    return 'started';
  }
  // MCP: the letter is decided now (prepare_job_context's `letter`); answers are asked only for known questions.
  if (!plan.letter.wanted) Object.assign(changes, { letter_status: 'off', cover_letter_id: null });
  if (!plan.answersFit && plan.questionsToAnswer === 0) changes.answers_status = 'not_ready';
  if (!plan.resumeFits && row.resume_mode === 'default') {
    // A29: the default resume as it is, chosen now (no AI).
    const chosen = await defaultResumeOf(deps, row.user_id);
    Object.assign(changes, { resume_status: 'ready', resume_id: chosen });
    await updatePrepare(deps.db, row.id, { resume_id: chosen }, now);
    await linkToApplication(deps, row.user_id, row.application_id, { resumeId: chosen }, now);
  } else if (!plan.resumeFits && row.resume_mode === 'similar') {
    changes.resume_status = 'building';
    later.push(row.id);
  }
  await updateDraft(deps.db, draft.id, changes, now);
  // Nothing left for the person's own AI (the resume chosen, no letter, no question): queued at once.
  const finished = await finishKit(deps, (await prepareById(deps.db, row.id))!, (await draftOf(deps.db, row.user_id, row.application_id))!, now);
  return finished?.state === 'queued' ? 'queued' : 'started';
}

/**
 * MCP Prepares in mode `similar`: their resume, chosen by the rule-based resume match (async, no AI) right after the
 * start; the kit then finishes when nothing is left for the person's own AI.
 */
export async function chooseSimilarResumes(deps: AppDeps, prepareIds: readonly string[]): Promise<void> {
  for (const id of prepareIds) {
    const row = await prepareById(deps.db, id);
    if (!row || !isActivePrepareState(row.state) || row.job_id === null) continue;
    let chosen: string | null = null;
    try {
      chosen = await chooseResume(deps, row.user_id, 'similar', row.job_id);
    } catch (error) {
      deps.log.warn(`[prepare] Prepare ${id}: its resume could not be chosen`, error instanceof Error ? error.name : 'unknown');
    }
    await deps.db.tx(async () => {
      const fresh = await prepareById(deps.db, id);
      const draft = fresh && isActivePrepareState(fresh.state) ? await draftOf(deps.db, fresh.user_id, fresh.application_id) : null;
      if (!fresh || draft?.prepare_id !== id) return;
      const now = nowIso(deps);
      if (!chosen) {
        await endPrepare(deps, fresh, 'failed', now, { error: constantsOf(deps).message('MSG_PREPARE_NO_RESUME') });
        return;
      }
      await updateDraft(deps.db, draft.id, { resume_id: chosen, resume_status: 'ready' }, now);
      await updatePrepare(deps.db, id, { resume_id: chosen }, now);
      await linkToApplication(deps, fresh.user_id, fresh.application_id, { resumeId: chosen }, now);
      await finishKit(deps, (await prepareById(deps.db, id))!, (await draftOf(deps.db, fresh.user_id, fresh.application_id))!, now);
    });
  }
}

// ------------------------------------------------------------------------------------------- cancel and finish

/**
 * POST /api/prepare/:id/cancel: an active Prepare ends `cancelled` at once, its kit's parts not made going back to
 * what they were; `abort` cancels the AI task a server Prepare is waiting for (its cost so far is charged), and the
 * runner stops at its next step. A Prepare that is over is answered as it is. 404 for another account's.
 */
export async function cancelPrepare(deps: AppDeps, userId: string, prepareId: string, abort: (prepareId: string) => void): Promise<PrepareJob> {
  const now = nowIso(deps);
  let cancelled = false;
  const row = await deps.db.tx(async () => {
    const found = await getPrepare(deps.db, userId, prepareId);
    if (!found) throw notFound('That Prepare');
    if (!isActivePrepareState(found.state)) return found;
    await endPrepare(deps, found, 'cancelled', now);
    cancelled = true;
    return (await getPrepare(deps.db, userId, prepareId))!;
  });
  if (cancelled) {
    abort(prepareId);
    deps.log.debug(`[prepare] account ${userId} cancelled Prepare ${prepareId}`);
  }
  return prepareJobView(deps, row);
}

/**
 * After an MCP save: the application's active `mcp` Prepare finishes (step f) when its kit has no part left to make:
 * queued (insertPreparedRow, in this transaction), prepared (the queue is full), failed or cancelled. Null when there
 * is no such Prepare, or a part is still to make.
 */
export async function finishIfComplete(deps: AppDeps, userId: string, applicationId: string): Promise<FinishResult | null> {
  return deps.db.atomic(async () => {
    const row = await activePrepareOf(deps.db, applicationId);
    if (!row || row.user_id !== userId || row.mode !== 'mcp') return null;
    const draft = await draftOf(deps.db, userId, applicationId);
    if (!draft || draft.prepare_id !== row.id) return null;
    return finishKit(deps, row, draft, nowIso(deps));
  });
}

/**
 * The daily housekeeping's part (PREPARE_MCP_STALE_DAYS): every `mcp` Prepare still waiting for the person's own AI
 * after that many days is cancelled, so the Queue pane never shows a conversation that was abandoned. Answers how many.
 */
export async function cancelStaleMcpPrepares(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<number> {
  const days = constantsOf(deps).get('PREPARE_MCP_STALE_DAYS');
  const before = new Date(deps.now().getTime() - days * 24 * 60 * 60_000).toISOString();
  const now = nowIso(deps);
  return deps.db.tx(async () => {
    const rows = await staleMcpRows(deps.db, before);
    for (const row of rows) await endPrepare(deps, row, 'cancelled', now);
    if (rows.length > 0) deps.log.info(`[prepare] ${rows.length} Prepare(s) left waiting for an own AI were cancelled`);
    return rows.length;
  });
}

// ------------------------------------------------------------------------------- the person's own AI (MCP saves)

/** The application's active `mcp` Prepare, or 409: an MCP save writes only the kit of one (A30). */
async function requireMcpPrepare(deps: AppDeps, userId: string, applicationId: string): Promise<PrepareRow> {
  const row = await activePrepareOf(deps.db, applicationId);
  if (!row || row.user_id !== userId || row.mode !== 'mcp') throw conflict(NOT_PREPARING);
  return row;
}

/** The first save takes a waiting MCP Prepare up (`building`, its start time). */
async function takeUp(deps: AppDeps, row: PrepareRow, now: string): Promise<void> {
  if (row.state === 'waiting') await updatePrepare(deps.db, row.id, { state: 'building', started_at: now }, now);
}

/** For the MCP tools: the application's known questions, each `draft`, `not_ready` or `profile`. */
export async function draftQuestions(
  deps: AppDeps,
  userId: string,
  applicationId: string,
): Promise<{ jobId: number; questionsKnown: number; questions: Array<{ question: AutofillKnownQuestion; state: PlannedQuestion['state'] }> }> {
  const target = await requireTarget(deps, userId, applicationId);
  const planned = planQuestions(await knownQuestions(deps, target.jobId), await valueScreen(deps, userId));
  return {
    jobId: target.jobId,
    questionsKnown: planned.length,
    questions: planned.map(({ question, state }) => ({ question, state })),
  };
}

/** One `mcp` Prepare waiting for the person's own AI (prepare_queue's rows), oldest first. */
export interface McpPrepareItem {
  prepareId: string;
  applicationId: string;
  jobId: number | null;
  title: string;
  companyName: string;
  resumeMode: PrepareResumeMode;
  /** The resume the kit uses (null until saved for `tailor`, or while `similar` chooses it). */
  resumeId: string | null;
  letterWanted: boolean | null;
  draft: PrepareDraft | null;
}

/** For MCP prepare_queue: the account's `mcp` Prepares waiting for its own AI, oldest first. */
export async function mcpPrepares(deps: AppDeps, userId: string): Promise<McpPrepareItem[]> {
  const items: McpPrepareItem[] = [];
  for (const row of await mcpActiveRows(deps.db, userId)) {
    const app = await deps.db.one<{ title: string; company_name: string }>('SELECT title, company_name FROM applications WHERE id = ?', [
      row.application_id,
    ]);
    const draft = await draftOf(deps.db, userId, row.application_id);
    const kit = draft?.prepare_id === row.id ? draft : null;
    items.push({
      prepareId: row.id,
      applicationId: row.application_id,
      jobId: row.job_id,
      title: app?.title ?? '',
      companyName: app?.company_name ?? '',
      resumeMode: row.resume_mode,
      resumeId: kit?.resume_id ?? row.resume_id,
      letterWanted: row.letter_wanted === null ? null : deps.db.dialect.isTrue(row.letter_wanted),
      draft: kit ? await draftViewOf(deps, kit, row.job_id) : null,
    });
  }
  return items;
}

/**
 * MCP prepare_save_resume: the tailored resume of a `tailor` Prepare, stored as a new built resume made from
 * `sourceResumeId` (titled "<Company> - <Job title>" unless `title`) after the resume limit's check; one whose
 * protected facts (employers, titles, dates, education, every section but the tailored ones) differ from the
 * source's is refused. It becomes the kit's resume and the application's; a letter or answers made from an earlier
 * one are to be made again (A29).
 */
export async function saveDraftResume(
  deps: AppDeps,
  userId: string,
  applicationId: string,
  input: { document: ResumeDocument; sourceResumeId: string; title?: string },
  _by: PrepareMode = 'mcp',
): Promise<{ resumeId: string }> {
  const target = await requireTarget(deps, userId, applicationId);
  const prepare = await requireMcpPrepare(deps, userId, applicationId);
  if (prepare.resume_mode !== 'tailor') throw conflict(MODE_KEEPS_RESUME);
  const { document: stored } = await sourceDocument(deps, userId, input.sourceResumeId);
  const engine = getResumeEngine(deps);
  // An older document (no templateId) on the on-page editor first, as tailoring reads it; the same for both sides.
  const upgraded = async (doc: ResumeDocument) =>
    isEditorDocument(doc)
      ? doc
      : upgradeLegacyDocument(doc, { templates: engine.templates, skills: await engine.skillsFor(userId), into: effectiveTemplateId(doc) });
  const source = await upgraded(stored);
  const document = normalizeResumeDocument(await upgraded(normalizeResumeDocument(input.document)));
  if (!keptFacts(normalizeResumeDocument({ ...source, templateId: document.templateId }), document)) {
    throw validationFailed(FACTS_CHANGED);
  }
  const title = (input.title?.trim() || tailoredTitle(target.companyName, target.title)).slice(0, 200);
  const now = nowIso(deps);
  const resumeId = await deps.db.atomic(async () => {
    // A resume saved for a kit is a tailored one (made_by 'tailor'): Documents lists it in the Tailored folder.
    const id = await insertResume(deps, userId, { kind: 'built', title, document, sourceResumeId: input.sourceResumeId, madeBy: 'tailor' });
    const draft = await kitDraftFor(deps, prepare, now);
    const planned = planQuestions(await knownQuestions(deps, target.jobId), await valueScreen(deps, userId));
    const remake = (status: DraftRow['letter_status']) => status === 'ready' || status === 'not_ready' || status === 'failed';
    await linkToApplication(deps, userId, applicationId, { resumeId: id }, now);
    await updateDraft(
      deps.db,
      draft.id,
      {
        resume_id: id,
        resume_status: 'ready',
        built_by: 'mcp',
        ...(deps.db.dialect.isTrue(prepare.letter_wanted) && remake(draft.letter_status) ? { letter_status: 'pending' as const } : {}),
        ...(planned.some((item) => item.state === 'draft') && remake(draft.answers_status) ? { answers_status: 'pending' as const } : {}),
      },
      now,
    );
    await updatePrepare(deps.db, prepare.id, { resume_id: id }, now);
    await takeUp(deps, prepare, now);
    return id;
  });
  deps.log.debug(`[prepare] account ${userId}: Prepare ${prepare.id}'s resume saved (mcp)`);
  return { resumeId };
}

/** The kit's resume once it is ready, or 409 (RESUME_FIRST): the letter and the answers are written from it. */
async function requireKitResume(deps: AppDeps, prepare: PrepareRow, now: string): Promise<DraftRow> {
  const draft = await kitDraftFor(deps, prepare, now);
  if (draft.resume_status !== 'ready' || !draft.resume_id) throw conflict(RESUME_FIRST);
  return draft;
}

/**
 * MCP prepare_save_cover_letter: the letter's paragraphs, composed as tailoring composes them (on the profile's letter
 * template when it has a place for the body, else TailorIT's own layout) for the person of the kit's resume (the
 * profile filling what it lacks), stored (origin 'generated', written from that resume), linked to the application,
 * the kit's letter.
 */
export async function saveDraftLetter(
  deps: AppDeps,
  userId: string,
  applicationId: string,
  input: { paragraphs: readonly string[] },
  _by: PrepareMode = 'mcp',
): Promise<{ coverLetterId: string }> {
  const target = await requireTarget(deps, userId, applicationId);
  const prepare = await requireMcpPrepare(deps, userId, applicationId);
  const paragraphs = input.paragraphs.map((text) => text.trim()).filter(Boolean);
  if (
    paragraphs.length < LETTER_PARAGRAPHS.min ||
    paragraphs.length > LETTER_PARAGRAPHS.max ||
    paragraphs.some((text) => text.length > LETTER_PARAGRAPHS.length)
  ) {
    throw validationFailed(BAD_LETTER);
  }
  const now = nowIso(deps);
  const coverLetterId = await deps.db.atomic(async () => {
    const draft = await requireKitResume(deps, prepare, now);
    const documents = (await readAutofillProfile(deps, userId)).value.documents;
    const template = documents.coverLetterTemplateId ? await visibleTemplate(deps, userId, documents.coverLetterTemplateId) : null;
    const evidence = await getResumeEvidence(deps, userId, draft.resume_id);
    const account = await deps.db.one<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [userId]);
    const person = evidence
      ? letterProfile(evidence)
      : { fullName: account?.name ?? '', email: account?.email ?? '', phone: '', location: '', linkedin: '', portfolio: '', title: '' };
    const letter = letterHtml({ paragraphs, profile: person, company: target.companyName, jobTitle: target.title, today: deps.now(), template });
    const letters = createLetterRepository(deps);
    const row = await letters.create(userId, {
      title: tailoredTitle(target.companyName, target.title),
      origin: 'generated',
      contentHtml: letter.html,
      ...(letter.fontFamily ? { fontFamily: letter.fontFamily } : {}),
      applicationId,
      jobId: target.jobId,
      companyName: target.companyName.slice(0, 200),
      jobTitle: target.title.slice(0, 200),
      templateId: letter.templateId,
    });
    await letters.update(row.id, userId, { resumeId: draft.resume_id });
    await linkToApplication(deps, userId, applicationId, { coverLetterId: row.id }, now);
    await updateDraft(deps.db, draft.id, { cover_letter_id: row.id, letter_status: 'ready', built_by: 'mcp' }, now);
    await takeUp(deps, prepare, now);
    return row.id;
  });
  deps.log.debug(`[prepare] account ${userId}: Prepare ${prepare.id}'s cover letter saved (mcp)`);
  return { coverLetterId };
}

export interface SavedAnswers {
  kept: number;
  ready: number;
  refused: Array<{ questionId: number; reason: ValueRefusal | 'not_this_job' }>;
}

/**
 * MCP prepare_save_answers: keeps answers for the application's known questions, in the kit of its `mcp` Prepare. An
 * answer to a question that is not one of the job's (`not_this_job`), that is never drafted (`never_drafted`:
 * self-identification, legal, pay, consent, attention check, file, personal detail, link), that does not fit its field
 * or options (`does_not_fit`) or whose words the screens find sensitive (`sensitive`) is refused and never stored.
 * Every other question a kit answers that has no row yet gets a not-ready one; the answers' status is worked out again.
 */
export async function saveDraftAnswers(
  deps: AppDeps,
  userId: string,
  applicationId: string,
  answers: ReadonlyArray<{ questionId: number; answer: AutofillSubmittedAnswerValue | null }>,
  by: PrepareMode = 'mcp',
): Promise<SavedAnswers> {
  const target = await requireTarget(deps, userId, applicationId);
  const prepare = await requireMcpPrepare(deps, userId, applicationId);
  const planned = planQuestions(await knownQuestions(deps, target.jobId), await valueScreen(deps, userId));
  const byId = new Map(planned.map((item) => [item.question.id, item]));
  const refused: SavedAnswers['refused'] = [];
  const keep: Array<{ questionId: number; answer: AutofillSubmittedAnswerValue | null }> = [];
  for (const given of answers) {
    const item = byId.get(given.questionId);
    if (!item) {
      refused.push({ questionId: given.questionId, reason: 'not_this_job' });
      continue;
    }
    const why = item.state === 'profile' ? 'never_drafted' : given.answer === null ? null : refusalOfValue(item, given.answer);
    if (why) refused.push({ questionId: given.questionId, reason: why });
    else keep.push({ questionId: given.questionId, answer: given.answer });
  }
  const now = nowIso(deps);
  const result = await deps.db.atomic(async () => {
    const draft = await requireKitResume(deps, prepare, now);
    const provenance = provenanceOf(by);
    await writeAnswers(deps.db, draft.id, keep, provenance, now, { replace: false });
    const has = new Set((await answerRows(deps.db, draft.id)).map((row) => row.question_id));
    const missing = planned
      .filter((item) => item.state !== 'profile' && !has.has(item.question.id))
      .map((item) => ({ questionId: item.question.id, answer: null }));
    await writeAnswers(deps.db, draft.id, missing, provenance, now, { replace: false });
    // A row for a question that is never drafted (the rules grew since it was kept), or no longer the job's, goes.
    for (const row of await answerRows(deps.db, draft.id)) {
      const item = byId.get(row.question_id);
      if (!item || item.state === 'profile') (await deps.db.run('DELETE FROM application_draft_answers WHERE id = ?', [row.id]));
    }
    const rows = await answerRows(deps.db, draft.id);
    await updateDraft(
      deps.db,
      draft.id,
      { answers_status: answersStatusOf(planned, rows), questions_seen: planned.length, built_by: 'mcp' },
      now,
    );
    await takeUp(deps, prepare, now);
    return { kept: keep.length, ready: rows.filter((row) => row.status === 'ready').length };
  });
  deps.log.debug(`[prepare] account ${userId}: ${result.kept} kit answer(s) kept, ${refused.length} refused (mcp)`);
  return { ...result, refused };
}

/**
 * MCP prepare_mark: marks a part (or every part) of the kit failed or skipped, with the reason in words. Marking the
 * resume, or a wanted letter, ends the Prepare at once: `cancelled` when skipped, `failed` when failed. Answers are
 * never required: once nothing is left to make, finishIfComplete queues the kit.
 */
export async function markDraft(
  deps: AppDeps,
  userId: string,
  applicationId: string,
  mark: { part: 'resume' | 'letter' | 'answers' | 'all'; status: 'failed' | 'skipped'; error?: string },
): Promise<PrepareDraft> {
  const target = await requireTarget(deps, userId, applicationId);
  const prepare = await requireMcpPrepare(deps, userId, applicationId);
  const now = nowIso(deps);
  await deps.db.atomic(async () => {
    const draft = await kitDraftFor(deps, prepare, now);
    const parts = mark.part === 'all' ? (['resume', 'letter', 'answers'] as const) : ([mark.part] as const);
    const changes: DraftChanges = {};
    for (const part of parts) {
      // A letter that is off stays off when every part is marked.
      if (mark.part === 'all' && part === 'letter' && draft.letter_status === 'off') continue;
      changes[`${part}_status`] = mark.status;
    }
    const error = mark.error?.trim().slice(0, MAX_ERROR);
    await updateDraft(deps.db, draft.id, { ...changes, ...(error ? { error } : {}) }, now);
    await takeUp(deps, prepare, now);
    const ends = parts.includes('resume') || (parts.includes('letter') && deps.db.dialect.isTrue(prepare.letter_wanted));
    if (ends) {
      const state = mark.status === 'skipped' ? 'cancelled' : 'failed';
      await endPrepare(deps, (await prepareById(deps.db, prepare.id))!, state, now, state === 'failed' ? { error: error || null } : {});
    }
  });
  return draftViewOf(deps, (await draftOf(deps.db, userId, applicationId))!, target.jobId);
}

// ------------------------------------------------------------------------------------------------- the service

/**
 * The Prepare service on the async client: core/seams.ts PrepareService's methods, and what the feature and the tests
 * use beside them. The feature registers it (registerPrepareService): deps.services.prepare is this service, and
 * prepareServiceOf answers it with its own members.
 */
export interface PrepareServiceImpl extends PrepareService {
  startPrepare(userId: string, request: PrepareStartRequest, mode: PrepareMode): Promise<PrepareStartResponse>;
  cancel(userId: string, prepareId: string): Promise<PrepareJob>;
  finishIfComplete(userId: string, applicationId: string): Promise<FinishResult | null>;
  /** Wakes the server runner (after a start, a cancel, or a constant change). */
  kick(): void;
  readonly runner: PrepareRunner;
  /** What a start hands on once its transaction committed. */
  readonly hooks: StartHooks;
  /** Takes up the server Prepares a previous process left, and the MCP resume choices it cut; answers the stop. */
  start(): Promise<() => void>;
  /** Resolves once the runner and the MCP resume choices have nothing in flight (tests). */
  idle(): Promise<void>;
}

export function createPrepareService(deps: AppDeps): PrepareServiceImpl {
  const runner = createPrepareRunner(deps);
  const choosing = new Set<Promise<void>>();
  const hooks: StartHooks = {
    kick: () => runner.kick(),
    chooseLater(ids) {
      const done: Promise<void> = chooseSimilarResumes(deps, ids)
        .catch((error: unknown) => deps.log.error('[prepare] the resume choice of an MCP Prepare stopped on an error', error))
        .finally(() => choosing.delete(done));
      choosing.add(done);
    },
  };
  return {
    runner,
    hooks,
    startPrepare: (userId, request, mode) => startPrepare(deps, userId, request, mode, hooks),
    async cancel(userId, prepareId) {
      const view = await cancelPrepare(deps, userId, prepareId, (id) => runner.abort(id));
      runner.kick();
      return view;
    },
    finishIfComplete: (userId, applicationId) => finishIfComplete(deps, userId, applicationId),
    kick: () => runner.kick(),
    async start() {
      const stop = runner.start();
      // v2.0 FIX-B (BEH-10): an MCP `similar` Prepare whose resume choice a restart cut short is chosen again.
      const cut = await mcpChoosingRows(deps.db);
      if (cut.length > 0) hooks.chooseLater(cut);
      return stop;
    },
    async idle() {
      while (choosing.size > 0) await Promise.allSettled([...choosing]);
      await runner.idle();
    },
  };
}

const registered = new WeakMap<AppDeps, PrepareServiceImpl>();

/** The feature's services hook: the service is deps.services.prepare, and prepareServiceOf's. */
export function registerPrepareService(deps: AppDeps, service: PrepareServiceImpl): void {
  registered.set(deps, service);
  deps.services.prepare = service;
}

/** The Prepare service of these deps (set by the feature's services hook), for the routes. */
export function prepareServiceOf(deps: AppDeps): PrepareServiceImpl {
  const service = registered.get(deps);
  if (!service) throw aiUnavailableError(deps);
  return service;
}
