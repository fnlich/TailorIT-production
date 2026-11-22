import { isEligibilityReason, STATUS, type FilterReasonEntry } from '@tailorit/shared';
import { PrepareFiltersExtraSchema, type PrepareFiltersExtra } from '@tailorit/shared/filters';
import type { PrepareStartResponse } from '@tailorit/shared/prepare';
import type { FilterCheck } from '../../core/seams';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError, validationFailed } from '../../core/http/errors';
import { untrustedText } from '../autofill/ai/untrusted';
import { reasonsFor } from '../prepare/kit'; // v33 SHARE-8
import { unreadInstructions } from './instructions';
import { mcpJobOf } from './job';
import { finishIfDone } from './next';
import { assertRoomForResumes } from './limits';
import { filterTextFenced } from './profiles'; // v33 SHARE-8; v34 MCPFAN: filterTextFenced
import { loadResultSet, readSetCursor, saveResultSet, setCursor, SET_GONE, type SetScope } from './result-sets';
import { refuseFencedData, type SaveContext } from './save';
import { refuseWrittenLeaks } from './written'; // v34 MCPDIR

// v2.0 P5 (07-mcp.md "New"; 06-filters-analysis.md): which saved jobs the person's own AI prepares is decided by the
// platform, never by that AI (R1).
// - filter_jobs runs the person's saved prepare filters (P4's PrepareFilterService.evaluate) over their Saved jobs, a
//   search set or the ids they named, with `extra` on top: what the person asked for in this chat, which can only
//   narrow (PrepareFiltersExtraSchema holds no way to loosen, and P4's mergeExtra intersects). It reports compactly
//   ([job id, 1|0, first reason code]) and keeps the run (mcp_result_sets, source `filter`, 24 h): its passing ids, and
//   its rows for the next pages. It records nothing: a chat's extra values never label a Saved job.
// - custom_filter_verdicts takes the AI's Custom filter verdicts only for jobs a filter run of this person listed as
//   pending under the current prompt, and only while they are still pending: the one judgment the AI makes (R3).
// - prepare_start runs the saved filters again (without extra) whatever ids it is given, and starts exactly the jobs
//   that pass with P2's startPrepare (mode `mcp`): a failing job is `filtered`, an unjudged one `skipped`
//   (custom_pending). The resume limit is checked before (the `tailor` mode makes a resume, A29); no AI budget, since
//   no server AI runs. A custom instruction such as "prepare every job" changes nothing here.
// v33 SHARE-8 (PLAN-sharing.md §4 "Sensitive facts", §7): on another person's profile the runs are the caller's on that
// profile (its result sets, ctx.sets), the owner's Custom filter prompt comes in the profile's wrapper with the grant's
// tripwire, a reason from an eligibility answer reads as one `eligibility` without `sensitive:view` (maskEligibility),
// verdict reasons holding a tripwire of the caller's grants are refused, and prepare_start starts the caller's Prepares
// there, paid by the caller under the grant (payerOfGrant(grant, 'mcp')).
// v34 MCPFAN (the MCPFAN security review, M1 and M2; the coordinator's decisions 1 and 2): on EVERY profile, the
// caller's own included and with Sensitive answers' See too, the Custom filter prompt comes fenced as the profile's data
// (filterTextFenced: someone the profile is shared with may have written it), and a reason from an eligibility answer
// (sponsorship, clearance, a citizenship) reads as one `eligibility` in filter_jobs and prepare_start
// (REASONS_TO_AI): the person's AI never reads those answers, nor a filter switch that states them.

/**
 * v34 MCPFAN (the coordinator's decision 2): how MCP's filter reasons read on every profile: an eligibility reason as
 * one `eligibility` (prepare/kit.ts reasonsFor, as for a share without Sensitive answers' See).
 */
const REASONS_TO_AI = { sensitive: false } as const;

/** One row of a run: [job id, 1 pass | 0 fail, the first reason code or ""]. */
type FilterRow = [number, 0 | 1, string];

interface FilterRun {
  scope?: 'saved';
  setId?: string;
  jobIds?: number[];
  extra?: PrepareFiltersExtra;
  rows: FilterRow[];
  /** Passing jobs the Custom filter has not judged, under `promptHash`. */
  pending: number[];
  promptHash: string | null;
  /**
   * v33 SHARE-8 (review): whether the rows name eligibility reasons (made by a caller who could see them). Its later
   * pages are gone for a caller who cannot (any more); missing (a run made before this): as if true. v34 MCPFAN: false
   * for every run made now (REASONS_TO_AI); an earlier run that named them is gone on every profile.
   */
  sensitive?: boolean;
}

const FILTER_COLUMNS = ['id', 'ok', 'why'] as const;

// v33 SHARE-8 (review; PLAN-sharing.md §4 "Sensitive facts and what can be inferred") ---------------------------------

/** Which failing reasons a caller may not have the filters read from the owner's sensitive answers (null: none). */
type UnknownToViewer = ((entry: FilterReasonEntry) => boolean) | null;

/**
 * Without Sensitive answers' See, an eligibility switch the AI adds in `extra` never reads the owner's citizenships or
 * clearance, since whether a job passes would tell them (two owners differing only there must get the same rows): that
 * part counts as unknown, so it passes, as in the web's preview (prepare-filters preview's `sensitive: false`). A
 * switch the owner saved on decides the row without `extra` already (the documented leak: `eligibility`, never why) and
 * stays as it is. The sponsorship switch reads the job alone. Each filter gives at most one reason, and the
 * qualification filter's citizenship part only when its degree and years parts pass, so leaving that reason out is the
 * check with the answer unknown.
 */
async function unknownToViewer(ctx: SaveContext, extra: PrepareFiltersExtra | undefined): Promise<UnknownToViewer> {
  if (ctx.profile.sensitive || !extra || (extra.qualificationMismatch !== true && extra.clearanceMismatch !== true)) return null;
  const { filters: saved } = await filters(ctx.deps).filtersOf(ctx.userId);
  const citizenship = extra.qualificationMismatch === true && saved.qualificationMismatch !== true;
  const clearance = extra.clearanceMismatch === true && saved.clearanceMismatch !== true;
  if (!citizenship && !clearance) return null;
  return (entry) => (citizenship && entry.code === 'qualification' && isEligibilityReason(entry)) || (clearance && entry.code === 'clearance');
}

/** A check as it reads with the reasons `unknown` names left out (no reason left: a pass). */
function withUnknown(check: FilterCheck, unknown: UnknownToViewer): FilterCheck {
  if (!unknown || check.verdict.verdict !== 'fail') return check;
  const reasons = check.verdict.reasons.filter((entry) => !unknown(entry));
  if (reasons.length === check.verdict.reasons.length) return check;
  return { ...check, verdict: reasons.length > 0 ? { verdict: 'fail', reasons } : { verdict: 'pass', reasons: [] } };
}
// end v33 SHARE-8 (review)
/** The why of a job the Custom filter has not judged yet. */
export const CUSTOM_PENDING = 'custom_pending';

/** P4's service; refused plainly while a server has none (a build before INT wires it). */
function filters(deps: AppDeps) {
  const service = deps.services.prepareFilters;
  if (!service) {
    // v34 MCPDIR: what to do.
    throw new AppError('internal', 'The prepare filters are not available on this TailorIT server: tell the person (its operator turns them on).');
  }
  return service;
}

interface Entry {
  applicationId: string;
  jobId: number;
}

/** The person's Saved entries that have a job, newest first. */
function savedEntries(deps: Pick<AppDeps, 'db'>, userId: string): Promise<Entry[]> {
  return deps.db.all<Entry>(
    `SELECT id AS "applicationId", job_id AS "jobId" FROM applications
      WHERE user_id = ? AND job_id IS NOT NULL AND current_status = ? AND archived_at IS NULL
      ORDER BY tracked_on DESC, created_at DESC, id`,
    [userId, STATUS.saved],
  );
}

/** The person's entry of each job (its Saved one when it has several), in the jobs' order; jobs with none left out. */
async function entriesOfJobs(deps: Pick<AppDeps, 'db'>, userId: string, jobIds: readonly number[]): Promise<Map<number, string>> {
  const d = deps.db.dialect;
  // The list's values are text on PostgreSQL (jsonEach): cast to compare with the job id on both engines.
  const rows = await deps.db.all<{ id: string; job_id: number }>(
    `SELECT id, job_id FROM applications
      WHERE user_id = ? AND job_id IN (SELECT CAST(value AS INTEGER) FROM ${d.jsonEach('?')})
      ORDER BY (current_status = ? AND archived_at IS NULL) DESC, updated_at DESC, id`,
    [userId, JSON.stringify([...new Set(jobIds)]), STATUS.saved],
  );
  const out = new Map<number, string>();
  for (const row of rows) if (!out.has(row.job_id)) out.set(row.job_id, row.id);
  return out;
}

/**
 * A check's row: pass, a failing filter's first reason, the Custom filter's fail, or not judged yet. v33 SHARE-8: the
 * reason as the caller may see it on the profile (`sensitive` false: an eligibility reason is one `eligibility`).
 */
function rowOf(check: FilterCheck): FilterRow {
  if (check.verdict.verdict === 'fail') return [check.jobId, 0, reasonsFor(REASONS_TO_AI, check.verdict.reasons)[0]?.code ?? 'filtered'];
  if (check.custom === 'fail') return [check.jobId, 0, 'custom'];
  return [check.jobId, 1, check.custom === 'pending' ? CUSTOM_PENDING : ''];
}

async function pageOf(
  ctx: SaveContext,
  runId: string,
  run: FilterRun,
  offset: number,
  prompt: string | null,
) {
  const { deps } = ctx;
  const size = constantsOf(deps).get('MCP_FILTER_PAGE_MAX');
  const rows = run.rows.slice(offset, offset + size);
  const pendingHere = rows.filter((row) => row[2] === CUSTOM_PENDING).map((row) => row[0]);
  const pass = run.rows.filter((row) => row[1] === 1).length;
  return {
    runId,
    total: run.rows.length,
    pass,
    fail: run.rows.length - pass,
    cols: FILTER_COLUMNS,
    rows,
    // v33 SHARE-8: the owner's prompt in the profile's wrapper. v34 MCPFAN: on every profile (filterTextFenced).
    ...(pendingHere.length > 0 && prompt !== null ? { custom: { prompt: filterTextFenced(ctx.profile, prompt), pending: pendingHere } } : {}),
    ...(offset + size < run.rows.length ? { nextCursor: setCursor(runId, offset + size) } : {}),
    ...(await unreadInstructions(deps, ctx.caller.id, ctx.tokenId ?? null)), // v34 MCPDIR: neutral metadata
  };
}

export interface FilterJobsInput {
  scope?: 'saved';
  setId?: string;
  jobIds?: number[];
  /** Read with PrepareFiltersExtraSchema (strict, narrowing only) before anything runs. */
  extra?: unknown;
  cursor?: string;
}

/** `extra` as PrepareFiltersExtraSchema reads it: refused, with what each field takes, when it would loosen anything. */
function extraOf(value: unknown): PrepareFiltersExtra | undefined {
  if (value === undefined) return undefined;
  const parsed = PrepareFiltersExtraSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues.map((issue) => issue.path.join('.') || 'extra').join(', ');
  throw validationFailed(
    `extra (${where}): only narrowing values the person asked for: locationTypes, jobTypes, experienceLevels (lists), ` +
      'industries {mode, ids}, minSalaryUsd, autoApplySupport "supported", or locationMismatch, qualificationMismatch, ' +
      'certificationMismatch, noSponsorship, clearanceMismatch set true.',
  );
}

/** filter_jobs. */
export async function filterJobs(ctx: SaveContext, input: FilterJobsInput) {
  const { deps, userId } = ctx;
  const extra = extraOf(input.extra);
  const service = filters(deps);
  if (input.cursor !== undefined) {
    const { setId, offset } = readSetCursor(input.cursor);
    const set = await loadResultSet(deps, ctx.sets, setId);
    if (set.source !== 'filter') throw validationFailed('cursor: that cursor is not a filter_jobs cursor.');
    const run = set.query as FilterRun;
    // v33 SHARE-8 (review): rows made while the caller saw eligibility reasons are not paged to one who no longer does.
    // v34 MCPFAN: no run names them now (REASONS_TO_AI): one made before is gone on every profile.
    if (run.sensitive !== false) throw new AppError('not_found', SET_GONE);
    const custom = await service.customPrompt(userId);
    return pageOf(ctx, set.id, run, offset, custom && custom.hash === run.promptHash ? custom.prompt : null);
  }
  const named = [input.scope !== undefined, input.setId !== undefined, input.jobIds !== undefined].filter(Boolean).length;
  if (named !== 1) {
    throw validationFailed('Send one of scope ("saved"), setId (a search_jobs set) or jobIds (the jobs the person named).');
  }
  let entries: Entry[];
  let notSaved = 0;
  if (input.scope === 'saved') {
    entries = await savedEntries(deps, userId);
  } else {
    const jobIds = input.setId !== undefined ? (await loadResultSet(deps, ctx.sets, input.setId)).ids : [...new Set(input.jobIds!)];
    const saved = new Map((await savedEntries(deps, userId)).map((entry) => [entry.jobId, entry.applicationId]));
    entries = jobIds.flatMap((jobId) => {
      const applicationId = saved.get(jobId);
      return applicationId ? [{ applicationId, jobId }] : [];
    });
    notSaved = jobIds.length - entries.length;
  }
  const checks = await service.evaluate(
    userId,
    entries.map((entry) => entry.applicationId),
    { ...(extra ? { extra } : {}), record: false },
  );
  const byApplication = new Map(checks.map((check) => [check.applicationId, check]));
  const unknown = await unknownToViewer(ctx, extra); // v33 SHARE-8 (review)
  const rows = entries.flatMap((entry) => {
    const check = byApplication.get(entry.applicationId);
    return check ? [rowOf(withUnknown(check, unknown))] : [];
  });
  const custom = await service.customPrompt(userId);
  const run: FilterRun = {
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.setId ? { setId: input.setId } : {}),
    ...(input.jobIds ? { jobIds: [...new Set(input.jobIds)] } : {}),
    ...(extra ? { extra } : {}),
    rows,
    pending: rows.filter((row) => row[2] === CUSTOM_PENDING).map((row) => row[0]),
    promptHash: custom?.hash ?? null,
    sensitive: REASONS_TO_AI.sensitive, // v33 SHARE-8 (review); v34 MCPFAN: never by name
  };
  const passing = rows.filter((row) => row[1] === 1).map((row) => row[0]);
  const set = await saveResultSet(deps, ctx.sets, 'filter', run, passing, passing.length);
  deps.log.debug(`[mcp] account ${userId}: filter_jobs ran over ${rows.length} job(s), ${passing.length} pass`);
  return {
    ...(await pageOf(ctx, set.id, run, 0, custom?.prompt ?? null)),
    ...(notSaved > 0 ? { notSaved } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------- the verdicts

/** The most verdicts one call takes, and the longest reason kept. */
export const VERDICTS_MAX = 100;
export const VERDICT_REASON_MAX = 80;

/**
 * The jobs this person's live filter runs listed as pending under `promptHash`. v33 SHARE-8: the caller's runs on this
 * profile (under this grant: a run on another profile, or under an earlier grant, lists nothing here).
 */
async function listedPending(deps: Pick<AppDeps, 'db' | 'now'>, sets: SetScope, promptHash: string): Promise<Set<number>> {
  const shared = sets.grantId !== null;
  const rows = await deps.db.all<{ query: string }>(
    `SELECT query FROM mcp_result_sets WHERE user_id = ? AND source = 'filter' AND expires_at > ?
        AND ${shared ? 'grant_id = ? AND profile_user_id = ?' : 'grant_id IS NULL'}`,
    shared
      ? [sets.callerId, deps.now().toISOString(), sets.grantId, sets.profileUserId]
      : [sets.callerId, deps.now().toISOString()],
  );
  const out = new Set<number>();
  for (const row of rows) {
    try {
      const run = JSON.parse(row.query) as Partial<FilterRun>;
      if (run.promptHash !== promptHash || !Array.isArray(run.pending)) continue;
      for (const id of run.pending) if (Number.isSafeInteger(id)) out.add(id);
    } catch {
      /* a row this code did not write: nothing listed */
    }
  }
  return out;
}

/** custom_filter_verdicts. */
export async function customFilterVerdicts(
  ctx: SaveContext,
  verdicts: ReadonlyArray<{ jobId: number; pass: boolean; reason?: string }>,
) {
  const { deps, userId } = ctx;
  refuseFencedData(ctx, verdicts.map((verdict) => verdict.reason ?? '')); // v33 SHARE-8
  await refuseWrittenLeaks(ctx, verdicts.map((verdict) => verdict.reason ?? '')); // v34 MCPDIR
  const service = filters(deps);
  const custom = await service.customPrompt(userId);
  const ignored: number[] = [];
  if (!custom) return { saved: 0, ignored: verdicts.map((verdict) => verdict.jobId), why: 'The custom filter is off.' };
  const listed = await listedPending(deps, ctx.sets, custom.hash);
  const seen = new Set<number>();
  const candidates: Array<{ jobId: number; pass: boolean; reason?: string }> = [];
  for (const verdict of verdicts) {
    if (seen.has(verdict.jobId) || !listed.has(verdict.jobId)) {
      ignored.push(verdict.jobId);
      continue;
    }
    seen.add(verdict.jobId);
    const reason = verdict.reason === undefined ? '' : untrustedText(verdict.reason, VERDICT_REASON_MAX);
    candidates.push({ jobId: verdict.jobId, pass: verdict.pass, ...(reason ? { reason } : {}) });
  }
  // Still pending now: still a Saved job of theirs, and not judged since the run listed it.
  const entries = await entriesOfJobs(deps, userId, candidates.map((candidate) => candidate.jobId));
  const checks = await service.evaluate(userId, [...entries.values()], { record: false });
  const pending = new Set(checks.filter((check) => check.custom === 'pending').map((check) => check.jobId));
  const accepted = candidates.filter((candidate) => {
    if (pending.has(candidate.jobId)) return true;
    ignored.push(candidate.jobId);
    return false;
  });
  const result = accepted.length > 0 ? await service.saveCustomVerdicts(userId, accepted, 'mcp') : { saved: 0, ignored: [] };
  deps.log.debug(`[mcp] account ${userId}: ${result.saved} custom filter verdict(s) saved`);
  return { saved: result.saved, ignored: [...ignored, ...result.ignored] };
}

// ---------------------------------------------------------------------------------------------------- prepare_start

export interface PrepareStartInput {
  runId?: string;
  applicationIds?: string[];
  jobIds?: number[];
  rebuild?: boolean;
}

type Outcome = PrepareStartResponse['results'][number]['outcome'];
type StartRow = [number | string, Outcome, string];

/** Finishes a just-started Prepare whose kit is complete already (finishIfDone); true when it queued the job. */
async function doneAlready(ctx: SaveContext, jobId: number): Promise<boolean> {
  try {
    return (await finishIfDone(ctx, await mcpJobOf(ctx.deps, ctx.userId, jobId))).queued;
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return false;
    throw error;
  }
}

/** prepare_start. */
export async function prepareStart(ctx: SaveContext, input: PrepareStartInput) {
  const { deps, userId } = ctx;
  const service = filters(deps);
  const named = [input.runId !== undefined, input.applicationIds !== undefined, input.jobIds !== undefined].filter(Boolean);
  if (named.length !== 1) throw validationFailed('Send one of runId (from filter_jobs), applicationIds or jobIds.');
  const batch = constantsOf(deps).get('PREPARE_BATCH_MAX');
  if ((input.applicationIds?.length ?? 0) > batch || (input.jobIds?.length ?? 0) > batch) {
    // v2.0 FIX-C (REQ-3): the limit's words are MSG_PREPARE_BATCH_MAX (the web's); then what the AI does instead.
    const limit = constantsOf(deps).message('MSG_PREPARE_BATCH_MAX', { max: batch });
    throw validationFailed(`${limit} For more, use filter_jobs and its runId.`);
  }

  // The entries, in the order named: [application id, job id (null: not known)].
  let entries: Array<{ applicationId: string | null; jobId: number | null; key: number | string }>;
  if (input.applicationIds !== undefined) {
    const ids = [...new Set(input.applicationIds)];
    const rows = await deps.db.all<{ id: string; job_id: number | null }>(
      `SELECT id, job_id FROM applications WHERE user_id = ? AND id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
      [userId, JSON.stringify(ids)],
    );
    const jobs = new Map(rows.map((row) => [row.id, row.job_id]));
    entries = ids.map((id) => ({ applicationId: jobs.has(id) ? id : null, jobId: jobs.get(id) ?? null, key: jobs.get(id) ?? id }));
  } else {
    let jobIds: number[];
    if (input.runId !== undefined) {
      const set = await loadResultSet(deps, ctx.sets, input.runId);
      if (set.source !== 'filter') throw validationFailed('runId: use the runId filter_jobs answered.');
      jobIds = set.ids;
    } else {
      jobIds = [...new Set(input.jobIds!)];
    }
    const byJob = await entriesOfJobs(deps, userId, jobIds);
    entries = jobIds.map((jobId) => ({ applicationId: byJob.get(jobId) ?? null, jobId, key: jobId }));
  }

  const rows = new Map<string, StartRow>();
  const order: string[] = [];
  const keyOf = (entry: (typeof entries)[number]) => entry.applicationId ?? `missing:${entry.key}`;
  for (const entry of entries) order.push(keyOf(entry));
  for (const entry of entries) if (!entry.applicationId) rows.set(keyOf(entry), [entry.key, 'skipped', 'not_found']);

  // The saved filters again, whatever the ids: the AI's choice is never trusted (the verdicts are recorded).
  const known = entries.filter((entry) => entry.applicationId !== null) as Array<{ applicationId: string; jobId: number | null; key: number | string }>;
  const checks = new Map(
    (await service.evaluate(userId, known.map((entry) => entry.applicationId), { record: true })).map((check) => [
      check.applicationId,
      check,
    ]),
  );
  const toStart: string[] = [];
  for (const entry of known) {
    const check = checks.get(entry.applicationId);
    if (!check) {
      // Not one the filters read (no job, or past Saved): P2's checks answer it.
      toStart.push(entry.applicationId);
      continue;
    }
    const [, ok, why] = rowOf(check); // v34 MCPFAN: REASONS_TO_AI
    if (ok === 0) rows.set(entry.applicationId, [entry.key, 'filtered', why]);
    else if (why === CUSTOM_PENDING) rows.set(entry.applicationId, [entry.key, 'skipped', CUSTOM_PENDING]);
    else toStart.push(entry.applicationId);
  }

  // A29: the resume limit refuses a Prepare that makes a resume (`tailor`) at or over the plan's limit, before any start.
  // v33 SHARE-8: the caller's room on another person's profile keeps the owner's last places (the reserve).
  if (toStart.length > 0 && (await ctx.prepare.resumeMode(deps, userId)) === 'tailor') await assertRoomForResumes(deps, userId, 1, ctx.profile.payer);

  const keys = new Map(known.map((entry) => [entry.applicationId, entry.key]));
  let stopped: { code: string; message: string } | undefined;
  for (let at = 0; at < toStart.length && !stopped; at += batch) {
    const chunk = toStart.slice(at, at + batch);
    try {
      // v33 SHARE-8 (SHARE-5's edit 7): the caller starts and pays (under the grant on another person's profile).
      const answer = await ctx.prepare.start(
        deps,
        userId,
        { applicationIds: chunk, rebuild: input.rebuild ?? false },
        { payer: ctx.profile.payer, viewer: REASONS_TO_AI }, // v34 MCPFAN: an eligibility reason as one word
      );
      for (const result of answer.results) {
        const key = keys.get(result.applicationId) ?? result.applicationId;
        // A kit that needs nothing of the person's AI (a chosen resume, no letter wanted, no question to answer) is
        // queued at once.
        const outcome =
          result.outcome === 'started' && typeof key === 'number' && (await doneAlready(ctx, key)) ? 'queued' : result.outcome;
        rows.set(result.applicationId, [key, outcome, result.reason?.code ?? '']);
      }
    } catch (error) {
      // The first refusal refuses the whole call; a later one keeps what started before it.
      if (at === 0 || !(error instanceof AppError) || error.status >= 500) throw error;
      stopped = { code: error.code, message: error.message };
    }
  }
  const list = order.map((key) => rows.get(key)).filter((row): row is StartRow => row !== undefined);
  const count = (outcome: Outcome) => list.filter((row) => row[1] === outcome).length;
  const started = count('started');
  deps.log.debug(`[mcp] account ${userId}: prepare_start started ${started} of ${list.length}`);
  return {
    started,
    queued: count('queued'),
    filtered: count('filtered'),
    skipped: count('skipped'),
    cols: ['id', 'outcome', 'why'] as const,
    rows: list,
    ...(stopped ? { stopped } : {}),
    next:
      started > 0
        ? 'Call prepare_queue: it lists the jobs waiting for your AI.'
        : ctx.hint
          ? 'No job was started for your AI on this profile: tell the person, with the outcomes above, then go on with the next profile.'
          : 'No job was started for your AI: tell the person, with the outcomes above.',
  };
}
