import type { JobSourceCandidateStatus, JobSourceDiscoveredVia, JobSourceKind } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries, DbTx } from '../../../core/db/types';
import { assertNewReadAllowed, newReadsAllowed } from '../../../core/http/identity';
import { OutboundRefusedError } from '../../../core/http/outbound';
import { ADAPTERS } from '../adapters/index';
import { HostHeldError, IngestHttpError, type IngestHttp } from '../http';
import { laneKeyOf, laneOfHost, WORKDAY_LANE_SPEC, type LaneSpec } from '../hosts'; // v37 LANE; v37 FIX-LANE (any lane)
import { RobotsRefusal } from '../robots';
import { NOT_FOUND_DAYS, NOT_FOUND_DROP_AFTER, runnableKinds } from '../scheduler';
import { requireIngest } from '../service';
import { hostOf, KIND_TERMS, NEW_SOURCE_COLUMNS, NEW_SOURCE_PLACEHOLDERS, newSourceValues, termsForbidReads } from '../sources'; // v37 INT-B gate; v37 INT-2b: the terms that say no
import { IngestError, SourceNotFoundError, type SourceAdapter, type SourceKind, type SourceRecord } from '../types';
import { BOARD_KINDS } from './boards';
import { isLinkKeeper, optedOut, sourcesOfBoard } from './offer';
import { claimCount, counterOf, discoveryDayOf, releaseCount, VALIDATIONS_COUNTER } from './state';
import { DAY_MS } from '@tailorit/shared';

// v30 S2: validation (docs/design/part2/12-job-sourcing.md §4.2): a candidate becomes a source after one read through
// its adapter in listingOnly mode (today's Test), at most DISCOVERY_VALIDATIONS_PER_DAY reads a day (an exact count per
// day key: state.ts claimCount), at the hosts' normal pace (the ingest client's crawl_hosts gate), so validation never
// starves the scheduled runs. A NEW kind of outside read: it runs only once BOT_USER_AGENT is set
// (assertNewReadAllowed 'discovery_validation') and reads with that identity (the ingest service's botHttp, robots.txt
// before every read, the refused hosts never), and only while INGEST_ENABLED.
// v30 FIX-A (DECISIONS P6.1): a board of the four v2.0 public-API kinds (V2_BOARD_KINDS) is read the way v2.0's ingest
// reads it, with today's identity (the service's http, INGEST_USER_AGENT; paced, robots.txt, opt-outs, the day's cap),
// while DISCOVERY_VALIDATE_V2_KINDS_TODAY is on (its default): a board Add job found gets its listing (and its jobs a
// liveness signal) before the owner sets BOT_USER_AGENT. Every other kind still waits for BOT_USER_AGENT.
//
// The outcomes (12 §4.2; v36 SOURCES, SP v36 PLAN S2: a source validation makes is OFF and not due, "Waiting for an
// admin" in Admin › Sources, until an admin turns it on there; validation never turns a source on):
//   valid, open jobs       a job_sources row, off, not due, tier `normal`; robots.txt allowed (validation just read its
//                          paths); discovered_via the candidate's
//   valid, no open jobs    a source, off, not due, tier `empty` (its cadence INGEST_CADENCE_EMPTY_DAYS once turned on)
//   404, no such board     `not_found`, tried again in NOT_FOUND_DAYS (30), `dropped` after NOT_FOUND_DROP_AFTER (3)
//                          in a row; a name probe's wrong guess is dropped at once
//   robots.txt, terms      `forbidden` (robots.txt disallows the listing, a refused host, an opted-out company): never
//                          run; a kind whose terms are not recorded waits instead (its candidates are not due)
//   error (5xx, timeout)   `error`, backed off as a run is (1 minute x 2^n, up to INGEST_BACKOFF_MAX_HOURS); `dropped`
//                          after INGEST_SOURCE_DISABLE_AFTER_FAILURES in a row
//   host held              not a try: due again after the hold, its place under the cap given back
// A source that reads the board already (an admin added it meanwhile) is linked, unread; Add job's disabled keeper of
// the board's links is adopted: promoted to the board's source (its mark goes, its links kept) and left off, waiting for
// an admin like a new one (v36 SOURCES; v36 FIX-SRC: a career site's keeper keeps its mark, and with it the weekly
// re-read of its pages, until an admin turns it on). A source an admin ever turned on is never a keeper (offer.ts isLinkKeeper), so
// validation never undoes an admin's off. The read stores no job: it counts the board's open postings, and nothing of
// the listing is kept. `attempts` counts the tries in a row that ended the same way. A candidate never names a person.
//
// v37 LANE (SP v37 PLAN W8): validation never takes the Workday lane from the runs: every Workday candidate reads on the
// one lane (one after another), and at most WORKDAY_DISCOVERY_PER_HOUR of them are read in a clock hour (an exact count
// per UTC hour: WORKDAY_HOUR_COUNTER); one past it waits for the next hour, not a try. v37 FIX-LANE: every registered
// lane alike, each with its own cap constant (LaneSpec.discoveryPerHourKey) and hourly counter (laneHourOf).

/** How long a candidate is held by the pass reading it (a crashed pass's candidate is due again after it). */
export const VALIDATION_LEASE_MS = 10 * 60_000;
/** The most candidates one pass reads (more wait for the next pass). */
export const VALIDATION_BATCH = 200;
/** The first backoff step after a failed read, doubled per failure in a row (12 §9.4, as a host's). */
export const VALIDATION_BACKOFF_BASE_MS = 60_000;
/** The longest time a read of a board may take (a listing of thousands of postings). */
export const VALIDATION_READ_TIMEOUT_MS = 60_000;
/** last_error's width (migration 0020's CHECK). */
const ERROR_MAX_CHARS = 500;
/**
 * v37 FIX-LANE (W8): a lane's hourly counter of validations (discovery_counters, keyed by the UTC day and this + its
 * hour): `<platform>_validations_h` from the lane's key.
 */
export function laneHourCounterOf(lane: LaneSpec): string {
  return `${lane.key.replace(/\.lane$/, '').replace(/[^a-z0-9]+/g, '_')}_validations_h`;
}
/** v37 LANE (W8): the hourly counter of Workday validations. */
export const WORKDAY_HOUR_COUNTER = laneHourCounterOf(WORKDAY_LANE_SPEC);

/** v37 FIX-LANE (W8): the UTC day and a lane's counter of the clock hour `at` is in, and that hour's end (ISO). */
export function laneHourOf(lane: LaneSpec, at: Date): { day: string; counter: string; end: string } {
  const text = at.toISOString();
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours() + 1));
  return { day: text.slice(0, 10), counter: `${laneHourCounterOf(lane)}${text.slice(11, 13)}`, end: end.toISOString() };
}

/** v37 LANE (W8): Workday's (laneHourOf). */
export function workdayHourOf(at: Date): { day: string; counter: string; end: string } {
  return laneHourOf(WORKDAY_LANE_SPEC, at);
}

/** What a validation did with one candidate. */
export const VALIDATION_OUTCOMES = ['valid', 'empty', 'not_found', 'dropped', 'forbidden', 'error', 'linked', 'waiting'] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

export interface ValidationPass {
  /** Board reads made (each one counted under the day's cap). */
  read: number;
  outcomes: Partial<Record<ValidationOutcome, number>>;
  /** Why the pass stopped before its batch was done: the day's cap reached, or a stop. */
  stopped: 'cap' | 'aborted' | null;
}

export interface ValidationOptions {
  /** The client to read new kinds with (default: the ingest service's botHttp, BOT_USER_AGENT). */
  http?: IngestHttp;
  /** v30 FIX-A (P6.1): the client to read the v2.0 kinds with while they read today (default: the service's http). */
  todayHttp?: IngestHttp;
  adapters?: Partial<Record<SourceKind, SourceAdapter>>;
  /** The most candidates to read this pass (default VALIDATION_BATCH). */
  limit?: number;
  signal?: AbortSignal;
  /** A number in [0, 1) for the jitters (tests give their own). */
  random?: () => number;
}

/** A due candidate as the pass reads it. */
interface DueCandidate {
  id: number;
  kind: JobSourceKind;
  name: string;
  discovered_via: JobSourceDiscoveredVia;
  status: JobSourceCandidateStatus;
  attempts: number;
  next_check_at: string;
}

/** v30 FIX-A (DECISIONS P6.1): the v2.0 public-API kinds, whose validation read is the read v2.0's ingest makes. */
export const V2_BOARD_KINDS: readonly JobSourceKind[] = ['greenhouse', 'lever', 'ashby', 'workable'];

/** Whether discovery validates the v2.0 kinds' boards with today's identity (DISCOVERY_VALIDATE_V2_KINDS_TODAY). */
export function v2KindsToday(deps: Parameters<typeof runnableKinds>[0]): boolean {
  return constantsOf(deps).get('DISCOVERY_VALIDATE_V2_KINDS_TODAY');
}

/** Whether a kind's validation reads with today's identity (no guard): a v2.0 kind while the switch is on. */
export function readsToday(deps: Parameters<typeof runnableKinds>[0], kind: JobSourceKind): boolean {
  return V2_BOARD_KINDS.includes(kind) && v2KindsToday(deps);
}

/** Whether validation may read anything now: BOT_USER_AGENT is set, or the v2.0 kinds are read with today's identity. */
export function validationAllowed(deps: Parameters<typeof runnableKinds>[0]): boolean {
  return newReadsAllowed(deps) || v2KindsToday(deps);
}

/**
 * The kinds validation reads now: board kinds whose adapter's config discovery writes (boards.ts `validates`), that the
 * worker may run (an adapter; a new kind of read only once the identity allows it), with their terms recorded; and
 * (v30 FIX-A, P6.1) of those, only the ones read with today's identity while BOT_USER_AGENT is a placeholder.
 */
export function validatableKinds(deps: Parameters<typeof runnableKinds>[0]): JobSourceKind[] {
  const runnable = new Set(runnableKinds(deps));
  const identity = newReadsAllowed(deps);
  return Object.values(BOARD_KINDS)
    .filter((board) => board !== undefined && board.validates && runnable.has(board.kind) && KIND_TERMS[board.kind] !== undefined)
    .map((board) => board!.kind)
    .filter((kind) => identity || readsToday(deps, kind));
}

/** The source config a candidate's board gets. */
export const candidateConfig = (kind: JobSourceKind, name: string): Record<string, unknown> => BOARD_KINDS[kind]?.configOf(name) ?? {};

/** A source record for the read (as the Test button makes one): nothing is stored by it, and nothing turns it on. */
function readRecord(kind: JobSourceKind, name: string, config: Record<string, unknown>): SourceRecord {
  return {
    id: -1,
    kind: kind as SourceKind,
    name,
    config,
    companyId: null,
    enabled: false, // v36 SOURCES: an adapter's read never asks; no record of a read is ever on
    deactivateMissing: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    createdAt: null,
    updatedAt: null,
  };
}

/** What one read said. */
type ReadAnswer =
  | { kind: 'listed'; open: number; config: Record<string, unknown> }
  | { kind: 'not_found'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'held'; until: string };

/** Words of an error an admin may read as they are (the readers' own); others are logged and summed up. */
function readableMessage(error: unknown): string {
  if (
    error instanceof IngestError ||
    error instanceof IngestHttpError ||
    error instanceof RobotsRefusal ||
    error instanceof OutboundRefusedError
  ) {
    return error.message.slice(0, ERROR_MAX_CHARS);
  }
  return 'The board could not be read. The details are in the server log.';
}

/** Reads the board once in listingOnly mode (a Lever site not on the global host is looked for on the EU one). */
async function readBoard(
  deps: AppDeps,
  candidate: DueCandidate,
  http: IngestHttp,
  adapter: SourceAdapter,
  signal: AbortSignal,
): Promise<ReadAnswer> {
  const attempt = async (config: Record<string, unknown>): Promise<ReadAnswer> => {
    const timeout = AbortSignal.timeout(VALIDATION_READ_TIMEOUT_MS);
    const both = AbortSignal.any([signal, timeout]);
    try {
      const result = await adapter.fetch(readRecord(candidate.kind, candidate.name, config), {
        deps,
        http,
        signal: both,
        log: () => undefined,
        needsPayCheck: () => false,
        listingOnly: true,
      });
      return { kind: 'listed', open: result.postings.length, config };
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof HostHeldError) return { kind: 'held', until: error.until };
      if (error instanceof SourceNotFoundError) return { kind: 'not_found', message: readableMessage(error) };
      if (error instanceof RobotsRefusal) {
        return error.reason === 'disallowed' ? { kind: 'forbidden', message: readableMessage(error) } : { kind: 'error', message: readableMessage(error) };
      }
      // A refused host (LinkedIn, a refused job board) is never read: forbidden. (The identity was checked first.)
      if (error instanceof OutboundRefusedError) return { kind: 'forbidden', message: readableMessage(error) };
      if (timeout.aborted) return { kind: 'error', message: 'The board did not answer in time.' };
      if (!(error instanceof IngestError || error instanceof IngestHttpError)) {
        deps.log.warn(`[discovery] reading ${candidate.kind} "${candidate.name}" failed`, error);
      }
      return { kind: 'error', message: readableMessage(error) };
    }
  };
  const base = candidateConfig(candidate.kind, candidate.name);
  const first = await attempt(base);
  if (first.kind === 'not_found' && candidate.kind === 'lever') {
    const eu = await attempt({ ...base, region: 'eu' });
    if (eu.kind !== 'not_found') return eu;
  }
  return first;
}

/** The next check after `failures` failed reads in a row: 1 minute x 2^(n-1), half of it jittered, at most the cap. */
function backoffMs(deps: AppDeps, failures: number, random: () => number): number {
  const capMs = constantsOf(deps).get('INGEST_BACKOFF_MAX_HOURS') * 3_600_000;
  const step = Math.min(capMs, VALIDATION_BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 30)));
  return Math.round(step / 2 + (step / 2) * random());
}

/** Records a candidate's outcome (its status, tries, next check and words). */
async function recordCandidate(
  db: DbQueries,
  id: number,
  change: { status: JobSourceCandidateStatus; attempts: number; nextCheckAt: string | null; checkedAt: string | null; lastError: string | null; openJobs?: number | null; sourceId?: number | null },
): Promise<void> {
  await db.run(
    `UPDATE job_source_candidates SET status = @status, attempts = CAST(@attempts AS smallint),
       next_check_at = CAST(@next AS timestamptz), checked_at = COALESCE(CAST(@checked AS timestamptz), checked_at),
       last_error = @error, open_jobs = COALESCE(CAST(@open AS integer), open_jobs), source_id = COALESCE(CAST(@source AS bigint), source_id)
     WHERE id = @id`,
    {
      id,
      status: change.status,
      attempts: Math.min(change.attempts, 32_000),
      next: change.nextCheckAt,
      checked: change.checkedAt,
      error: change.lastError,
      open: change.openJobs ?? null,
      source: change.sourceId ?? null,
    },
  );
}

/**
 * The board's source, made or adopted for a valid candidate (in the caller's transaction): a source that reads it
 * already (linked as it is, on or off), else Add job's keeper of its links (promoted: its mark goes, but a career site's
 * stays until an admin turns it on: v36 FIX-SRC), else a new one
 * named by the board ("acme", "acme (2)" when another source holds the name). v36 SOURCES (PLAN S2): either way it is
 * off and not due, waiting for an admin (only an admin's enableSources turns it on, and makes it due then). Valid: tier
 * normal; empty: tier empty. Answers its id and whether a source that read it already was found.
 */
export async function sourceForCandidate(
  deps: AppDeps,
  t: DbTx,
  candidate: { kind: JobSourceKind; name: string; via: JobSourceDiscoveredVia },
  found: { open: number; config: Record<string, unknown> },
): Promise<{ sourceId: number; linked: boolean }> {
  const at = nowIso(deps);
  const sources = await sourcesOfBoard(t, candidate.kind, candidate.name);
  const reading = sources.find((source) => !isLinkKeeper(source));
  if (reading) return { sourceId: reading.id, linked: true };
  const c = constantsOf(deps);
  const empty = found.open === 0;
  const cadenceMs = empty ? c.get('INGEST_CADENCE_EMPTY_DAYS') * DAY_MS : c.get('INGEST_CADENCE_NORMAL_HOURS') * 3_600_000;
  const host = hostOf(candidate.kind, found.config);
  const keeper = sources.find(isLinkKeeper);
  let sourceId: number;
  if (keeper) {
    // Add job's mark goes: the board's source now, off as it was (v36 SOURCES: waiting for an admin). v36 FIX-SRC (the
    // final data review's D2): a career site's keeper keeps its mark until an admin turns the site on (enableSources
    // drops it then), so the weekly re-read of its pages (jobs/add/recheck.ts) goes on while it waits, off: nothing else
    // reads them meanwhile. Its discovered_via makes it the board's source all the same (offer.ts isLinkKeeper).
    const kept =
      candidate.kind === 'career_site' ? keeper.config : Object.fromEntries(Object.entries(keeper.config).filter(([key]) => key !== 'addedBy'));
    await t.run('UPDATE job_sources SET config = CAST(? AS jsonb) WHERE id = ?', [JSON.stringify({ ...kept, ...found.config }), keeper.id]);
    sourceId = keeper.id;
  } else {
    let made: number | null = null;
    for (let n = 1; made === null; n += 1) {
      const name = n === 1 ? candidate.name : `${candidate.name} (${n})`;
      const row = await t.one<{ id: number }>(
        `INSERT INTO ${NEW_SOURCE_COLUMNS} VALUES (${NEW_SOURCE_PLACEHOLDERS}) ON CONFLICT(kind, name) DO NOTHING RETURNING id`,
        newSourceValues({ kind: candidate.kind as SourceKind, name, config: found.config }, at),
      );
      made = row?.id ?? null;
    }
    sourceId = made;
  }
  // v36 SOURCES (PLAN S2): not due (next_run_at NULL): enableSources makes it due when an admin turns it on.
  await t.run(
    `UPDATE job_sources SET tier = @tier, cadence = CAST(@cadenceMs AS bigint) * interval '1 millisecond', next_run_at = NULL,
       discovered_via = @via, host = COALESCE(host, @host),
       robots_status = CASE WHEN CAST(@host AS text) IS NULL THEN robots_status ELSE 'allowed' END,
       robots_checked_at = CASE WHEN CAST(@host AS text) IS NULL THEN robots_checked_at ELSE CAST(@at AS timestamptz) END,
       updated_at = CAST(@at AS timestamptz)
     WHERE id = @id`,
    { id: sourceId, tier: empty ? 'empty' : 'normal', cadenceMs, at, via: candidate.via, host },
  );
  return { sourceId, linked: false };
}

/**
 * One validation pass (see the top): the due candidates of the kinds it may read, oldest due first, one lane per host
 * (at most INGEST_HOSTS_IN_FLIGHT at once, each read paced by the host's gate), until the batch is done or the day's cap
 * is reached. Throws NewReadRefusedError (nothing read) while BOT_USER_AGENT is a placeholder; reads nothing while
 * INGEST_ENABLED is off.
 */
export async function validateCandidates(deps: AppDeps, options: ValidationOptions = {}): Promise<ValidationPass> {
  const pass: ValidationPass = { read: 0, outcomes: {}, stopped: null };
  // v30 FIX-A (P6.1): the guard refuses only when no kind may be read (no identity, and the v2.0 kinds' switch off).
  if (!validationAllowed(deps)) assertNewReadAllowed(deps, 'discovery_validation');
  if (!deps.config.ingest.enabled) return pass;
  const c = constantsOf(deps);
  const cap = c.get('DISCOVERY_VALIDATIONS_PER_DAY');
  const day = discoveryDayOf(deps);
  const room = cap - (await counterOf(deps.db, day, VALIDATIONS_COUNTER));
  if (room <= 0) return { ...pass, stopped: 'cap' };
  const kinds = validatableKinds(deps);
  if (kinds.length === 0) return pass;
  const http = options.http ?? requireIngest(deps).botHttp;
  const todayHttp = options.todayHttp ?? requireIngest(deps).http;
  /** The client a candidate's kind reads with: today's identity for a v2.0 kind while the switch is on (P6.1). */
  const clientOf = (kind: JobSourceKind) => (readsToday(deps, kind) ? todayHttp : http);
  const adapters = { ...ADAPTERS, ...options.adapters };
  const random = options.random ?? Math.random;
  const signal = options.signal ?? new AbortController().signal;
  const due = await deps.db.all<DueCandidate>(
    `SELECT id, kind, name, discovered_via, status, attempts, next_check_at FROM job_source_candidates
     WHERE status IN ('new', 'error', 'not_found') AND next_check_at <= CAST(@now AS timestamptz)
       AND kind = ANY(string_to_array(@kinds, ','))
     ORDER BY next_check_at, id LIMIT @limit`,
    { now: nowIso(deps), kinds: kinds.join(','), limit: Math.min(options.limit ?? VALIDATION_BATCH, room) },
  );
  const count = (outcome: ValidationOutcome) => (pass.outcomes[outcome] = (pass.outcomes[outcome] ?? 0) + 1);
  const state: { stop: ValidationPass['stopped'] } = { stop: null };

  /** Validates one candidate; false once the pass must stop (the cap, a stop). */
  async function validateOne(candidate: DueCandidate): Promise<boolean> {
    const now = nowIso(deps);
    // The candidate is this pass's for a while (a second pass, in this process or another, leaves it).
    const leased = await deps.db.one<{ id: number }>(
      `UPDATE job_source_candidates SET next_check_at = CAST(@until AS timestamptz)
       WHERE id = @id AND status IN ('new', 'error', 'not_found') AND next_check_at <= CAST(@now AS timestamptz) RETURNING id`,
      { id: candidate.id, now, until: new Date(deps.now().getTime() + VALIDATION_LEASE_MS).toISOString() },
    );
    if (!leased) return true;
    const giveBack = () => deps.db.run('UPDATE job_source_candidates SET next_check_at = CAST(? AS timestamptz) WHERE id = ?', [candidate.next_check_at, candidate.id]);
    // An opted-out company's board is never read; a board a source reads already is linked to it, unread.
    const unread = await deps.db.tx(async (t) => {
      if (await optedOut(t, candidate.kind, candidate.name)) {
        await recordCandidate(t, candidate.id, { status: 'forbidden', attempts: 0, nextCheckAt: null, checkedAt: null, lastError: null });
        return 'forbidden' as const;
      }
      const sources = await sourcesOfBoard(t, candidate.kind, candidate.name);
      // v37 INT-B (the terms gate): Add job's keeper of a board whose terms an admin set to not allowed is linked, unread,
      // as a reading source is: discovery never reads a board an admin's terms say no to. v37 FIX-37B (SP v37 FIXES-37
      // E2): every kind's, not only BambooHR's and iCIMS's (ingest/terms.ts).
      // v37 INT-2b (the coordinator's ruling): Forbidden and Needs a contract (termsForbidReads), not Not checked.
      const gated = (source: (typeof sources)[number]) => termsForbidReads(source.termsStatus);
      const reading = sources.find((source) => !isLinkKeeper(source)) ?? sources.find(gated);
      if (reading) {
        await recordCandidate(t, candidate.id, { status: 'valid', attempts: 0, nextCheckAt: null, checkedAt: null, lastError: null, sourceId: reading.id });
        return 'linked' as const;
      }
      return null;
    });
    if (unread) {
      count(unread);
      return true;
    }
    if (!(await claimCount(deps.db, day, VALIDATIONS_COUNTER, cap))) {
      await giveBack();
      state.stop = 'cap';
      return false;
    }
    // v37 LANE (W8): a Workday board also takes a place of its hour's WORKDAY_DISCOVERY_PER_HOUR (v37 FIX-LANE: a lane's
    // board, of its lane's cap); none left: it waits for the next hour (its day's place given back), and the pass goes on
    // with the other boards.
    const candidateHost = hostOf(candidate.kind, candidateConfig(candidate.kind, candidate.name));
    const onLane = candidateHost ? laneOfHost(candidateHost) : null;
    const hour = onLane ? laneHourOf(onLane, deps.now()) : null;
    if (onLane && hour && !(await claimCount(deps.db, hour.day, hour.counter, c.get(onLane.discoveryPerHourKey)))) {
      await releaseCount(deps.db, day, VALIDATIONS_COUNTER);
      await deps.db.run('UPDATE job_source_candidates SET next_check_at = CAST(? AS timestamptz) WHERE id = ?', [hour.end, candidate.id]);
      count('waiting');
      return true;
    }
    const releaseHour = () => (hour ? releaseCount(deps.db, hour.day, hour.counter) : Promise.resolve());
    const adapter = adapters[candidate.kind as SourceKind];
    if (!adapter) {
      // Not reachable through validatableKinds; kept so a kind's adapter removed meanwhile waits instead of failing.
      await releaseCount(deps.db, day, VALIDATIONS_COUNTER);
      await releaseHour();
      await giveBack();
      count('waiting');
      return true;
    }
    let answer: ReadAnswer;
    try {
      answer = await readBoard(deps, candidate, clientOf(candidate.kind), adapter, signal);
    } catch {
      await releaseCount(deps.db, day, VALIDATIONS_COUNTER);
      await releaseHour();
      await deps.db.run('UPDATE job_source_candidates SET next_check_at = CAST(? AS timestamptz) WHERE id = ?', [nowIso(deps), candidate.id]);
      state.stop = 'aborted';
      return false;
    }
    const at = nowIso(deps);
    const atMs = deps.now().getTime();
    if (answer.kind === 'held') {
      // Nothing was sent: not a try, and its place under the cap is given back (v37 LANE: and its hour's).
      await releaseCount(deps.db, day, VALIDATIONS_COUNTER);
      await releaseHour();
      await deps.db.run('UPDATE job_source_candidates SET next_check_at = CAST(? AS timestamptz) WHERE id = ?', [
        new Date(Math.max(Date.parse(answer.until), atMs) + 60_000).toISOString(),
        candidate.id,
      ]);
      count('waiting');
      return true;
    }
    pass.read += 1;
    const streak = (status: JobSourceCandidateStatus) => (candidate.status === status ? candidate.attempts + 1 : 1);
    if (answer.kind === 'listed') {
      const outcome = answer.open > 0 ? 'valid' : 'empty';
      await deps.db.tx(async (t) => {
        const made = await sourceForCandidate(deps, t, { kind: candidate.kind, name: candidate.name, via: candidate.discovered_via }, answer);
        await recordCandidate(t, candidate.id, {
          status: outcome,
          attempts: 0,
          nextCheckAt: null,
          checkedAt: at,
          lastError: null,
          openJobs: answer.open,
          sourceId: made.sourceId,
        });
      });
      count(outcome);
    } else if (answer.kind === 'not_found') {
      const tries = streak('not_found');
      const drop = tries >= NOT_FOUND_DROP_AFTER || candidate.discovered_via === 'probe';
      await recordCandidate(deps.db, candidate.id, {
        status: drop ? 'dropped' : 'not_found',
        attempts: tries,
        nextCheckAt: drop ? null : new Date(atMs + NOT_FOUND_DAYS * DAY_MS).toISOString(),
        checkedAt: at,
        lastError: answer.message,
      });
      count(drop ? 'dropped' : 'not_found');
    } else if (answer.kind === 'forbidden') {
      await recordCandidate(deps.db, candidate.id, { status: 'forbidden', attempts: 0, nextCheckAt: null, checkedAt: at, lastError: answer.message });
      count('forbidden');
    } else {
      const tries = streak('error');
      const drop = tries >= c.get('INGEST_SOURCE_DISABLE_AFTER_FAILURES');
      await recordCandidate(deps.db, candidate.id, {
        status: drop ? 'dropped' : 'error',
        attempts: tries,
        nextCheckAt: drop ? null : new Date(atMs + backoffMs(deps, tries, random)).toISOString(),
        checkedAt: at,
        lastError: answer.message,
      });
      count(drop ? 'dropped' : 'error');
    }
    return true;
  }

  // One lane per host: its candidates one after another (the gate paces each read); lanes side by side. v37 LANE (W8):
  // every Workday board is on the one Workday lane (v37 FIX-LANE: every board of a lane on its lane).
  const lanes = new Map<string, DueCandidate[]>();
  for (const candidate of due) {
    const host = hostOf(candidate.kind, candidateConfig(candidate.kind, candidate.name));
    const lane = host ? laneKeyOf(host) : `kind:${candidate.kind}`;
    lanes.set(lane, [...(lanes.get(lane) ?? []), candidate]);
  }
  const queue = [...lanes.values()];
  const width = Math.max(1, c.get('INGEST_HOSTS_IN_FLIGHT'));
  const runLane = async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (const candidate of lane) {
        if (state.stop || signal.aborted) return;
        if (!(await validateOne(candidate))) return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, runLane));
  if (signal.aborted && !state.stop) state.stop = 'aborted';
  if (pass.read > 0 || Object.keys(pass.outcomes).length > 0) {
    deps.log.info(`[discovery] validation: ${pass.read} boards read (${Object.entries(pass.outcomes).map(([key, n]) => `${key} ${n}`).join(', ')})`);
  }
  return { ...pass, stopped: state.stop };
}
