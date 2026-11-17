import {
  chooseResume,
  compareResumeFits,
  scoreResumeFit,
  type ApplicationDetail,
  type FitResume,
  type ResumeFit,
  type ResumeMatchItem,
  type ResumeMatchList,
} from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries, Dialect } from '../../core/db/index';
import { conflict, notFound } from '../../core/http/errors';
import { getDetail } from '../applications/store';
import type { StoredResumeAnalysis } from '../resumes/analysis/store';
import {
  buildCandidate,
  candidateProbe,
  candidateSetOf,
  candidateSources,
  createMatchCaches,
  fitOf,
  readingsOf,
  resumeLabels,
  type Candidate,
  type CandidateSet,
  type MatchCaches,
} from './candidates';
import { descriptionJob, postingJob, type MatchJob } from './jobs';
import type {
  ChooseOptions,
  ChooseResult,
  EnsureChoicesResult,
  MatchTiming,
  ResumeChoice,
  ResumeMatchService,
} from './types';
import { createMatchWorker, Slicer } from './worker';

// Choosing the best resume for a saved job, and keeping the choice current (work package WP5). It is all local
// computation over stored data: nothing here queues AI work, and the job side is read without a single write.
//
// How a choice is made. The account's resumes (./candidates.ts) are pre-ranked by how many of the job's keywords their
// stored hard skills name; the top EXACT_SCORED (plus the default resume, and the one linked now) are scored exactly
// with the shared fit (the hard part is the Jobs card's own match), and the best is chosen (`chooseResume`): the
// higher unrounded fit, then the default resume, then precision, then the newer last edit, then the id. "Let TailorIT
// choose" and the picker score every resume. The weighted fit only orders; the numbers people see are the card's.
//
// How work is cut. Everything runs in cooperative slices (`Slicer`): an account's resumes are read a few at a time,
// each resume is prepared and scored on its own, the event loop running in between, and a choice is written in one
// final step at the end, a transaction (`MatchCore.settle`). That step reads the application again, writes the choice
// through the guard, and then reads again what the choice depends on (the job's analysis, and the account's resumes
// through a cheap fingerprint); when any of it changed, the write is rolled back and the choice is made again.
//
// Every automatic write goes through the full guard (AUTO_WRITE): the application is the account's, still of that
// job, Saved, not archived, chosen by TailorIT or not yet, and the resume is the same account's. `updated_at` is
// never touched: a system annotation does not reorder anyone's lists.
//
// Why the write comes before the checks (v3.0 PG-E). Every statement is I/O on PostgreSQL, and other writers run
// beside a choice at READ COMMITTED (SQLite's single writer used to hold them off, and v2.0 trusted what it had read
// until the event loop had a turn). The guarded write takes the application's row lock and holds it to COMMIT, and
// the checks run after it, so a change that matters is never lost: one committed before the checks is seen by them
// (the choice is made again); one committed after them marks the application due again when its trigger reaches the
// row, which waits for this transaction (migration 0006: the triggers lock every row they would mark, already due or
// not). A change that marks nothing (a title, Claude's backlog) and lands after the checks is as if it came just
// after the choice.

/** Resumes scored exactly for a job (after the pre-rank by hard-skill overlap). */
export const EXACT_SCORED = 40;

export const DEFAULT_MATCH_TIMING: MatchTiming = {
  sliceMs: 15,
  firstRunMs: 3_000,
  pollMs: 3_000,
  nudgeMs: 250,
  retryFailedMs: 60_000,
};

/** The candidate sets kept between passes; each is read again when its fingerprint changes, or after SET_TTL_MS. */
const SETS_MAX = 64;
/** Years of experience grow with the calendar (a role "to Present"): a set is read again at least this often. */
const SET_TTL_MS = 10 * 60_000;
/** A choice whose inputs changed while it was made is made again, up to this many times; a set, read again. */
const ATTEMPTS = 3;
/** Resumes whose stored readings are read at a time. */
const READINGS_CHUNK = 50;

const NOT_CHOOSABLE =
  'TailorIT chooses a resume only for a job you saved from the Jobs page and have not applied to yet. Pick one yourself for this application.';
const RESUMES_CHANGED = 'Your resumes changed while TailorIT was choosing. Please try again.';

/**
 * The full guard of every automatic write: the account's application, still of that job, Saved, not archived, chosen
 * by TailorIT or not yet; and a resume of the same account (or none). The predicates are written out literally, so
 * the partial indexes of migration 0301 apply. Never touches updated_at.
 */
const AUTO_WRITE = (d: Dialect) => `UPDATE applications
  SET resume_id = @resumeId,
      resume_origin = CASE WHEN CAST(@resumeId AS TEXT) IS NULL THEN NULL ELSE 'auto' END,
      resume_matched_at = @now,
      resume_match_due = ${d.false}
  WHERE id = @id AND user_id = @userId AND job_id = @jobId
    AND current_status = 1 AND archived_at IS NULL
    AND (resume_origin IS NULL OR resume_origin = 'auto')
    AND (CAST(@resumeId AS TEXT) IS NULL
      OR EXISTS (SELECT 1 FROM resumes r WHERE r.id = @resumeId AND r.user_id = applications.user_id))`;

/**
 * Every automatic write of a choice (the worker, the resume ZIP's due rows, "Let TailorIT choose"; the save paths may
 * use it too): links `resumeId` with origin 'auto' (none: origin NULL), clears the due flag and stamps the time, only
 * through the full guard (AUTO_WRITE). Returns whether it was written.
 */
export async function writeAutoChoice(
  db: DbQueries,
  target: { id: string; userId: string; jobId: number },
  resumeId: string | null,
  now: string,
): Promise<boolean> {
  const result = await db.run(AUTO_WRITE(db.dialect), { id: target.id, userId: target.userId, jobId: target.jobId, resumeId, now });
  return result.changes === 1;
}

/** "Let TailorIT choose": the person hands their choice back, so the automatic write (and its guard) applies. */
const HAND_BACK = `UPDATE applications SET resume_origin = NULL
  WHERE id = @id AND user_id = @userId AND resume_origin = 'user'
    AND job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL`;

const MATCH_COLUMNS =
  'id, user_id, job_id, resume_id, resume_origin, resume_matched_at, resume_match_due, current_status, archived_at';

/** An application as a choice reads it. */
interface MatchRow {
  id: string;
  user_id: string;
  job_id: number | null;
  resume_id: string | null;
  resume_origin: 'auto' | 'user' | null;
  resume_matched_at: string | null;
  /** A flag: a boolean on PostgreSQL, 0/1 on SQLite (read through `dialect.isTrue`). */
  resume_match_due: boolean | number;
  current_status: number;
  archived_at: string | null;
}

interface RankRow extends MatchRow {
  title: string;
  description_html: string;
}

/**
 * How a choice ended. 'matched': chosen and written. 'released': the row is no longer TailorIT's to choose (a due flag
 * is cleared). 'gone': the application is gone, or another pass settled it. 'refused': the guard refused the write, or
 * its inputs kept changing (a due row stays due).
 */
export type Settled = 'matched' | 'released' | 'gone' | 'refused';

/** 'auto': a due row (the worker, the resume ZIP). 'explicit': "Let TailorIT choose" (every resume scored). */
type SettleMode = 'auto' | 'explicit';

/** Whether TailorIT may choose for the application now. */
function choosable(row: MatchRow, mode: SettleMode): boolean {
  if (row.job_id === null || row.current_status !== 1 || row.archived_at !== null) return false;
  return mode === 'explicit' || row.resume_origin === null || row.resume_origin === 'auto';
}

function overlapOf(keys: ReadonlySet<string>, keywordKeys: ReadonlySet<string>): number {
  let count = 0;
  for (const key of keys) if (keywordKeys.has(key)) count += 1;
  return count;
}

/**
 * The resumes scored exactly for a job: every one when there are EXACT_SCORED or fewer; else the top EXACT_SCORED by
 * how many of the job's keywords their stored hard skills name (then the default, the newer last edit, the id), plus
 * the ones in `keep` (the default resume, the one linked now) so a choice never flips for want of being scored.
 */
export function exactSetFor(set: CandidateSet, job: MatchJob, keep: ReadonlyArray<string | null>): Candidate[] {
  const pool = set.eligible;
  if (pool.length <= EXACT_SCORED) return [...pool];
  const keywordKeys = job.prepared.keywordKeys;
  const ranked = pool
    .map((candidate) => ({ candidate, overlap: overlapOf(candidate.hardKeys, keywordKeys) }))
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        Number(b.candidate.isDefault) - Number(a.candidate.isDefault) ||
        (a.candidate.editedAt === b.candidate.editedAt ? 0 : a.candidate.editedAt < b.candidate.editedAt ? 1 : -1) ||
        (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0),
    );
  const chosen = ranked.slice(0, EXACT_SCORED).map((entry) => entry.candidate);
  for (const id of keep) {
    const candidate = id ? set.byId.get(id) : undefined;
    if (candidate && !candidate.excluded && !chosen.includes(candidate)) chosen.push(candidate);
  }
  return chosen;
}

/** What a job's fit depends on: when it changes while a choice is made (Claude's analysis landed), it is made again. */
function jobKey(job: MatchJob): string {
  return JSON.stringify(job.prepared.job);
}

/** A detail with the match fields, until the tracker's own detail carries them (work package WP6). */
async function detailOf(deps: AppDeps, userId: string, id: string): Promise<ApplicationDetail> {
  const detail = await getDetail(deps.db, userId, id);
  if ('resumeOrigin' in detail) return detail;
  const row = await deps.db.one<Pick<MatchRow, 'resume_origin' | 'resume_matched_at' | 'resume_match_due'>>(
    'SELECT resume_origin, resume_matched_at, resume_match_due FROM applications WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  return {
    ...detail,
    resumeOrigin: row?.resume_origin ?? null,
    resumeMatchedAt: row?.resume_matched_at ?? null,
    resumeMatchPending: deps.db.dialect.isTrue(row?.resume_match_due),
  };
}

function uniqueJobIds(jobIds: readonly number[]): number[] {
  return [...new Set(jobIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
}

const ID_CHUNK = 500;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < list.length; start += ID_CHUNK) out.push(list.slice(start, start + ID_CHUNK));
  return out;
}

const REFUSED = Symbol('refused');
/** Thrown in a choice's final step to roll its write back: what the choice depends on changed while it was made. */
const AGAIN = Symbol('again');

/** 404 "That application was not found." unless the application is the account's. */
async function requireOwnApplication(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<void> {
  if (!(await deps.db.one('SELECT 1 FROM applications WHERE id = ? AND user_id = ?', [id, userId]))) {
    throw notFound('That application');
  }
}

/**
 * The account's resumes for one run. The set this matcher last found current is trusted when it starts a choice: every
 * choice that writes (and every read-only choice but its last attempt) reads the fingerprint again at its end, so a
 * stale set costs one choice made again, never a wrong write. A new matcher (one per request) checks first.
 */
export class UserMatcher {
  private trusted: CandidateSet | null = null;

  constructor(
    private readonly core: MatchCore,
    readonly userId: string,
  ) {}

  /** Whether `set` is still the account's: its fingerprint, read now (inside a choice's final step, in its transaction). */
  async isFresh(set: CandidateSet): Promise<boolean> {
    const fresh = this.core.knownSet(this.userId) === set && set.probe === (await this.core.probe(this.userId));
    this.trusted = fresh ? set : null;
    return fresh;
  }

  /**
   * The account's candidates now: the set known, when this matcher last found it current or finds it so now; else
   * read again cooperatively. A set that kept changing while it was read is returned unchecked, so the final step of a
   * choice finds it stale and chooses again.
   */
  async candidates(slicer: Slicer): Promise<CandidateSet> {
    const known = this.core.knownSet(this.userId);
    if (known && (known === this.trusted || (await this.isFresh(known)))) return known;
    for (let attempt = 1; ; attempt += 1) {
      const set = await this.core.readSet(this.userId, slicer);
      if ((await this.isFresh(set)) || attempt >= ATTEMPTS) return set;
    }
  }
}

const SQL = {
  row: `SELECT ${MATCH_COLUMNS} FROM applications WHERE id = ? AND user_id = ?`,
  rankRow: `SELECT ${MATCH_COLUMNS}, title, description_html FROM applications WHERE id = ? AND user_id = ?`,
  release: (d: Dialect) =>
    `UPDATE applications SET resume_match_due = ${d.false} WHERE id = ? AND user_id = ? AND resume_match_due = ${d.true}`,
  jobExists: 'SELECT id FROM jobs WHERE id = ?',
};

/** A choice's final step: what it decided, or 'again' when its inputs changed while it was made. */
type FinalStep = Settled | 'again';

/** The matcher's state and its steps (shared by the service and the worker). */
export class MatchCore {
  private readonly caches: MatchCaches;
  private readonly sets = new Map<string, { set: CandidateSet; readAt: number }>();

  constructor(
    readonly deps: AppDeps,
    cacheBytes?: number,
  ) {
    this.caches = createMatchCaches(cacheBytes);
  }

  matcherFor(userId: string): UserMatcher {
    return new UserMatcher(this, userId);
  }

  // -------------------------------------------------------------------------------------- the account's resumes

  knownSet(userId: string): CandidateSet | undefined {
    const known = this.sets.get(userId);
    return known && Date.now() - known.readAt < SET_TTL_MS ? known.set : undefined;
  }

  probe(userId: string): Promise<string> {
    return candidateProbe(this.deps.db, userId);
  }

  /**
   * Reads the account's candidate set, a few resumes at a time with the event loop running in between: its rows and
   * fingerprint at once, then the stored readings READINGS_CHUNK at a time, then one candidate per step (a resume
   * whose text changed is read and prepared then). The set carries the fingerprint of its first moment, so a change
   * while it was read makes it stale at the next check.
   */
  async readSet(userId: string, slicer: Slicer): Promise<CandidateSet> {
    const { probe, rows, defaultId } = await candidateSources(this.deps.db, userId);
    const readings = new Map<string, StoredResumeAnalysis>();
    for (let start = 0; start < rows.length; start += READINGS_CHUNK) {
      await slicer.pause();
      const ids = rows.slice(start, start + READINGS_CHUNK).map((row) => row.id);
      for (const [id, stored] of await readingsOf(this.deps, userId, ids)) readings.set(id, stored);
    }
    const now = this.deps.now();
    const all: Candidate[] = [];
    for (const row of rows) {
      await slicer.pause();
      all.push(await buildCandidate(this.deps.db, this.caches, userId, row, defaultId, readings.get(row.id), now));
    }
    const set = candidateSetOf(userId, probe, defaultId, all);
    this.sets.delete(userId);
    this.sets.set(userId, { set, readAt: Date.now() });
    if (this.sets.size > SETS_MAX) {
      const oldest = this.sets.keys().next().value;
      if (oldest !== undefined) this.sets.delete(oldest);
    }
    return set;
  }

  private fit(userId: string, candidate: Candidate): Promise<FitResume> {
    return fitOf(this.deps.db, this.caches, userId, candidate);
  }

  /**
   * Each candidate's fit for a job, one candidate at a time with the event loop running in between (a resume not in
   * the cache is read and prepared then). Only the fits are kept, so an account's texts need not all fit the cache.
   */
  private async fitsFor(
    userId: string,
    job: MatchJob,
    candidates: readonly Candidate[],
    bestKnownYears: number | null,
    slicer: Slicer,
  ): Promise<ResumeFit[]> {
    const fits: ResumeFit[] = [];
    for (const candidate of candidates) {
      await slicer.pause();
      fits.push(scoreResumeFit(job.prepared, await this.fit(userId, candidate), { bestKnownYears }));
    }
    return fits.sort(compareResumeFits);
  }

  // -------------------------------------------------------------------------------------- choosing

  /**
   * The application read now, or why there is nothing to choose: 'gone' (no such application, or a due row another
   * pass settled) or 'released' (no longer TailorIT's to choose: a due row is let go).
   */
  private async currentRow(userId: string, id: string, mode: SettleMode): Promise<MatchRow | Settled> {
    const { db } = this.deps;
    const row = await db.one<MatchRow>(SQL.row, [id, userId]);
    if (!row) return 'gone';
    if (mode === 'auto' && !db.dialect.isTrue(row.resume_match_due)) return 'gone';
    if (choosable(row, mode)) return row;
    if (mode === 'auto') await db.run(SQL.release(db.dialect), [id, userId]);
    return 'released';
  }

  /** The application and its job, read now; or why there is nothing to choose (a due row no longer choosable is let go). */
  private async readRow(userId: string, id: string, mode: SettleMode): Promise<{ row: MatchRow; job: MatchJob } | Settled> {
    const row = await this.currentRow(userId, id, mode);
    if (typeof row === 'string') return row;
    const job = row.job_id !== null ? await postingJob(this.deps, row.job_id) : null;
    if (!job) {
      if (mode === 'auto') await this.deps.db.run(SQL.release(this.deps.db.dialect), [id, userId]);
      return 'released';
    }
    return { row, job };
  }

  private exactFor(set: CandidateSet, job: MatchJob, row: MatchRow, mode: SettleMode): Candidate[] {
    if (mode === 'explicit') return [...set.eligible];
    return exactSetFor(set, job, [set.defaultId, row.resume_origin === 'auto' ? row.resume_id : null]);
  }

  /** The guarded write of a choice ('explicit': after handing the person's choice back; both or neither). */
  private async write(row: MatchRow, resumeId: string | null, mode: SettleMode): Promise<boolean> {
    if (row.job_id === null) return false;
    const { db } = this.deps;
    const target = { id: row.id, userId: row.user_id, jobId: row.job_id };
    const now = nowIso(this.deps);
    if (mode === 'auto') return writeAutoChoice(db, target, resumeId, now);
    try {
      return await db.atomic(
        async (t) => {
          await t.run(HAND_BACK, { id: row.id, userId: row.user_id });
          if (!(await writeAutoChoice(t, target, resumeId, now))) throw REFUSED;
          return true;
        },
        { label: 'resume match hand-back' },
      );
    } catch (error) {
      if (error === REFUSED) return false;
      throw error;
    }
  }

  /**
   * Chooses the resume of one application and writes it through the guard. The resumes are scored cooperatively; the
   * write is one final step in a transaction: the application read again, the guarded write (its row lock held to
   * COMMIT), then the job and the account's resumes checked against what the choice was made from. A change rolls the
   * write back and the choice is made again.
   */
  async settle(matcher: UserMatcher, applicationId: string, slicer: Slicer, mode: SettleMode): Promise<Settled> {
    const userId = matcher.userId;
    for (let attempt = 1; ; attempt += 1) {
      await slicer.pause();
      const set = await matcher.candidates(slicer);
      const first = await this.readRow(userId, applicationId, mode);
      if (typeof first === 'string') return first;
      const fits = await this.fitsFor(userId, first.job, this.exactFor(set, first.job, first.row, mode), set.bestKnownYears, slicer);
      const step = await this.deps.db
        .tx(
          async (): Promise<FinalStep> => {
            const row = await this.currentRow(userId, applicationId, mode);
            if (typeof row === 'string') return row;
            if (!(await this.write(row, chooseResume(fits).resumeId, mode))) return 'refused';
            // Read after the write (see the header): the job as the choice read it, the resumes by their fingerprint.
            const job = row.job_id === null ? null : await postingJob(this.deps, row.job_id);
            if (!job || jobKey(job) !== jobKey(first.job) || !(await matcher.isFresh(set))) throw AGAIN;
            return 'matched';
          },
          { label: 'resume match choice' },
        )
        .catch((error: unknown) => {
          if (error === AGAIN) return 'again' as const;
          throw error;
        });
      if (step !== 'again') return step;
      if (attempt >= ATTEMPTS) return 'refused';
    }
  }

  /**
   * The best resume for one job, read-only. Null when the job does not exist. `quiet`: the job's analysis is read as
   * `postingJob` reads it quietly (a failure names no job).
   */
  async chooseFor(matcher: UserMatcher, jobId: number, slicer: Slicer, quiet = false): Promise<ResumeChoice | null> {
    const userId = matcher.userId;
    for (let attempt = 1; ; attempt += 1) {
      await slicer.pause();
      const set = await matcher.candidates(slicer);
      if (set.eligible.length === 0) {
        return (await this.deps.db.one(SQL.jobExists, [jobId])) ? { jobId, resumeId: null, fit: null, reason: 'none' } : null;
      }
      const job = await postingJob(this.deps, jobId, { quiet });
      if (!job) return null;
      const fits = await this.fitsFor(userId, job, exactSetFor(set, job, [set.defaultId]), set.bestKnownYears, slicer);
      if (attempt < ATTEMPTS) {
        // What the choice was made from, read again: anything may have changed while it was scored.
        if (!(await matcher.isFresh(set))) continue;
        const fresh = await postingJob(this.deps, jobId, { quiet });
        if (!fresh) return null;
        if (jobKey(fresh) !== jobKey(job)) continue;
      }
      return { jobId, ...chooseResume(fits) };
    }
  }

  /** Every resume of the account ranked for one application (the picker). Read-only. */
  async rank(matcher: UserMatcher, applicationId: string, slicer: Slicer): Promise<ResumeMatchList> {
    const userId = matcher.userId;
    const set = await matcher.candidates(slicer);
    const row = await this.deps.db.one<RankRow>(SQL.rankRow, [applicationId, userId]);
    if (!row) throw notFound('That application');
    const job = (row.job_id !== null ? await postingJob(this.deps, row.job_id) : null) ?? descriptionJob(row);
    // Unedited AI copies are listed (they can be picked) after every resume TailorIT may choose.
    const ranked = [
      ...(await this.fitsFor(userId, job, set.eligible, set.bestKnownYears, slicer)),
      ...(await this.fitsFor(userId, job, set.all.filter((candidate) => candidate.excluded), set.bestKnownYears, slicer)),
    ];
    const labels = await resumeLabels(this.deps.db, userId);
    return {
      applicationId: row.id,
      basis: job.basis,
      scored: job.prepared.plan.groups.length > 0,
      requiredYears: job.requiredYears,
      refining: job.refining,
      chosen: { resumeId: row.resume_id, origin: row.resume_origin, matchedAt: row.resume_matched_at },
      items: ranked.map((fit) => itemOf(fit, set.byId.get(fit.resumeId), labels.get(fit.resumeId))),
    };
  }
}

function itemOf(fit: ResumeFit, candidate: Candidate | undefined, label: string | undefined): ResumeMatchItem {
  return {
    resumeId: fit.resumeId,
    label: label ?? 'Untitled resume',
    kind: candidate?.kind ?? 'built',
    isDefault: fit.isDefault,
    fit: Math.min(100, Math.max(0, fit.fit)),
    matchedCount: fit.keywordMatch.matchedCount,
    total: fit.keywordMatch.total,
    percentage: fit.keywordMatch.percentage,
    softMatched: fit.softMatched.length,
    softTotal: fit.softMatched.length + fit.softMissing.length,
    yearsExperience: fit.years === null ? null : Math.min(80, Math.max(0, fit.years)),
    parts: {
      hard: fit.parts.hard,
      title: fit.parts.title,
      years: fit.parts.years,
      soft: fit.parts.soft,
      keywords: fit.parts.keywords,
    },
    readable: fit.readable,
    refining: candidate?.refining ?? false,
  };
}

export interface ResumeMatchServiceOptions {
  timing?: Partial<MatchTiming>;
  /** The prepared-evidence cache's budget (default 32 MB). */
  cacheBytes?: number;
}

/** The service on `deps.services.resumeMatch`, with the worker's `start` (the feature's start hook calls it). */
export function createResumeMatchService(
  deps: AppDeps,
  options: ResumeMatchServiceOptions = {},
): ResumeMatchService & { start(): () => Promise<void> } {
  const timing: MatchTiming = { ...DEFAULT_MATCH_TIMING, ...options.timing };
  const core = new MatchCore(deps, options.cacheBytes);
  const worker = createMatchWorker(deps, core, timing);
  const { log, db } = deps;

  return {
    async chooseForJobs(userId, jobIds, choose: ChooseOptions): Promise<ChooseResult> {
      const slicer = new Slicer(timing.sliceMs, { budgetMs: choose.budgetMs, signal: choose.signal });
      const ids = uniqueJobIds(jobIds);
      const choices = new Map<number, ResumeChoice>();
      const matcher = core.matcherFor(userId);
      const quiet = choose.quiet === true;
      /** A quiet call's failure: its name only, never an id or the error's text. */
      const nameOf = (error: unknown) => (error instanceof Error ? error.name : 'unknown');
      if (ids.length === 0 || slicer.over) return { choices, unfinished: ids };
      try {
        await matcher.candidates(slicer);
      } catch (error) {
        // The account's resumes could not be read: every job is left for the worker (never a failed save).
        if (quiet) log.warn('[resume-match] could not read the resumes; the choices are left for the worker', nameOf(error));
        else log.warn(`[resume-match] could not read the resumes of account ${userId}; the choices are left for the worker`, error);
        return { choices, unfinished: ids };
      }
      const unfinished: number[] = [];
      for (let index = 0; index < ids.length; index += 1) {
        const jobId = ids[index]!;
        if (slicer.over) {
          unfinished.push(...ids.slice(index));
          break;
        }
        try {
          const choice = await core.chooseFor(matcher, jobId, slicer, quiet);
          if (choice) choices.set(jobId, choice);
        } catch (error) {
          if (quiet) log.warn('[resume-match] could not choose a resume; it is left for the worker', nameOf(error));
          else log.warn(`[resume-match] could not choose a resume for job ${jobId}; it is left for the worker`, error);
          unfinished.push(jobId);
        }
      }
      return { choices, unfinished };
    },

    async rank(userId, applicationId) {
      await requireOwnApplication(deps, userId, applicationId);
      return core.rank(core.matcherFor(userId), applicationId, new Slicer(timing.sliceMs));
    },

    async autoMatch(userId, applicationId) {
      await requireOwnApplication(deps, userId, applicationId);
      const matcher = core.matcherFor(userId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await core.settle(matcher, applicationId, new Slicer(timing.sliceMs), 'explicit');
        if (outcome === 'matched') return detailOf(deps, userId, applicationId);
        if (outcome === 'gone') throw notFound('That application');
        if (outcome === 'released') throw conflict(NOT_CHOOSABLE);
        // 'refused': a resume went away, or the inputs kept changing, while it was chosen; choose once more.
      }
      throw conflict(RESUMES_CHANGED);
    },

    async ensureChoices(userId, applicationIds, choose: ChooseOptions): Promise<EnsureChoicesResult> {
      const ids = uniqueIds(applicationIds);
      const slicer = new Slicer(timing.sliceMs, { budgetMs: choose.budgetMs, signal: choose.signal });
      const matcher = core.matcherFor(userId);
      const placeholders = (chunk: readonly string[]) => db.dialect.list(chunk.length);
      const due: string[] = [];
      for (const chunk of chunks(ids)) {
        const rows = await db.all<{ id: string }>(
          `SELECT id FROM applications WHERE user_id = ? AND resume_match_due = ${db.dialect.true} AND id IN (${placeholders(chunk)})`,
          [userId, ...chunk],
        );
        due.push(...rows.map((row) => row.id));
      }
      for (const id of due) {
        if (slicer.over) break;
        try {
          await core.settle(matcher, id, slicer, 'auto');
        } catch (error) {
          log.warn(`[resume-match] could not choose a resume for application ${id}; it is left for the worker`, error);
        }
      }
      const resumeByApplication = new Map<string, string | null>();
      let pending = 0;
      for (const chunk of chunks(ids)) {
        const rows = await db.all<{ id: string; resume_id: string | null; resume_match_due: boolean | number }>(
          `SELECT id, resume_id, resume_match_due FROM applications WHERE user_id = ? AND id IN (${placeholders(chunk)})`,
          [userId, ...chunk],
        );
        for (const row of rows) {
          resumeByApplication.set(row.id, row.resume_id);
          if (db.dialect.isTrue(row.resume_match_due)) pending += 1;
        }
      }
      return { resumeByApplication, pending };
    },

    runDue(runOptions) {
      return worker.runDue(runOptions);
    },

    nudge() {
      worker.nudge();
    },

    start() {
      return worker.start();
    },
  };
}
