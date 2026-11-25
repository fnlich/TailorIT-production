import { newReadsAllowed, type NewReadKind } from '../../core/http/identity';
import { robotsForHost, type RobotsReadContext } from '../../core/http/reader/robots'; // v30 FIX-A (SEC-7)
import { defaultSiteTransport } from '../../core/http/reader/transport'; // v30 FIX-A (SEC-7)
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { ADAPTERS } from './adapters/index';
import { isDefinedAdapter, missingOutsideKey } from './adapters/define';
import { HostHeldError, nothingSent, type IngestHttp } from './http';
import { createHostGate, createRobotsStore, laneSql, onLaneSql, sameLaneSql } from './hosts'; // v30 FIX-A (SEC-7); v37 LANE; v37 FIX-LANE (any lane)
import { hostRobots, robotsVerdict, type StoredRobots } from './robots';
import { toSourceRecord, type SourceRow } from './sources';
import { SCHEDULED_KINDS, type SourceKind } from './types';
import { careerPagesOn } from './career/switch'; // v30 S5
import { optedOutSourceSql } from './opt-out-gate'; // v30 FIX-A
import { RUNS_PAUSED_SQL } from './pause-state'; // v31 RUNS

// v30 S1-API: the ingest worker's due queue (12-job-sourcing.md §9.3), replacing v2.0's one daily run of every
// source, two at a time (croner at INGEST_DAILY_AT, then the 200-a-day check of jobs no enabled source lists: both
// retired, 12 §8.6, §13).
//
// Each source has a cadence tier and a next_run_at. The worker (worker.ts, the `ingest:worker` process) asks every
// DUE_TICK_MS for the due sources (idx_job_sources_due: enabled, due, allowed by their terms and robots.txt, not leased;
// v36 SOURCES: and turned on by an admin, enabled_at, which migration 0060's CHECK already holds of every enabled row),
// most important first, and starts them: at most INGEST_HOSTS_IN_FLIGHT hosts at once, one source per host at a time
// (each host is also paced per request: http.ts and hosts.ts). A source whose host is held waits for the hold's end
// instead of failing. Each run takes the source's lease (lease_until, INGEST_LEASE_MINUTES: service.ts), so two workers
// (or the API's Run now and the worker) never run one source at once, and a crashed worker's lease runs out.
//
// After each run the source's tier and next run are set (nextScheduleOf, below):
//   hot       changed in 2 of its last 3 runs, INGEST_HOT_OPEN_JOBS open jobs or more, or a job someone has saved or
//             queued: every INGEST_CADENCE_HOT_HOURS (6);
//   normal    changed in the last QUIET_AFTER_DAYS (14): every INGEST_CADENCE_NORMAL_HOURS (24);
//   quiet     no change for QUIET_AFTER_DAYS: every INGEST_CADENCE_QUIET_DAYS (3);
//   empty     no open jobs: every INGEST_CADENCE_EMPTY_DAYS (7);
//   failing   FAILING_AFTER (3) failures in a row: the normal cadence doubled at each further failure, up to 7 days;
//             turned off (Admin › Sources' failing filter shows it) after INGEST_SOURCE_DISABLE_AFTER_FAILURES;
//   not_found the board answers 404: every NOT_FOUND_DAYS (30), turned off after NOT_FOUND_DROP_AFTER (3) of them.
// Each next run moves by up to JITTER (10 %) either way, so the runs spread over the day.
//
// Before a source is first due, its robots.txt verdict must be in (robots_status `unchecked` is never due):
// refreshRobotsStatuses reads each host's file once (shared by every process for 24 hours: site_robots) and gives every
// source of that host its verdict for the paths its adapter reads (defineAdapter's robotsPaths), again each day.
//
// v37 LANE (SP v37 PLAN W1, W4, W6, W7): a Workday source's host is held while its own row or the Workday lane is
// (hosts.ts laneSql: every Workday host's turns are the lane's), so a paused lane postpones every Workday source past
// the pause; one Workday source runs at a time (worker.ts takes the lane as their in-flight key, and a Workday source
// is not due while another one holds an unexpired lease: the API's Run now and Test too); and a robots.txt read that
// sent nothing (a held lane, a turn's wait that ran out) gives no verdict, never a day-long `error`.

/** How often the worker looks for due sources (it is also woken at once when a run ends). */
export const DUE_TICK_MS = 15_000;
/** The most due sources one look reads (12 §9.3's LIMIT). */
export const DUE_BATCH = 200;
/** The share a next run moves either way, so runs spread over the day (12 §13's "10 % jitter"). */
export const JITTER = 0.1;
/** Days without a change after which a source is quiet. */
export const QUIET_AFTER_DAYS = 14;
/** Failures in a row before a source is in the failing tier. */
export const FAILING_AFTER = 3;
/** The longest a failing source waits between runs. */
export const FAILING_MAX_DAYS = 7;
/** A board that answers 404 is read again after this many days, and turned off after NOT_FOUND_DROP_AFTER of them. */
export const NOT_FOUND_DAYS = 30;
export const NOT_FOUND_DROP_AFTER = 3;
/** A source whose host was held is due this long after the hold ends. */
export const AFTER_HOLD_MS = 60_000;
/** Sources whose robots.txt verdict one pass of refreshRobotsStatuses gives (each host read once). */
export const ROBOTS_REFRESH_BATCH = 500;
/** How long a source's robots.txt verdict stands before it is given again. */
export const ROBOTS_VERDICT_MAX_AGE_MS = 24 * 3_600_000;

/**
 * The kinds whose reads are a NEW kind of outside read (PLAN §5, DECISIONS P1 question 7): they run only once
 * BOT_USER_AGENT names TailorIT's public bot page and a role mailbox (core/http/identity.ts assertNewReadAllowed), and
 * then read with that identity. v2.0's kinds keep today's (INGEST_USER_AGENT). Wave 4's adapters (S3, S4, S5) land on
 * these entries; a kind with no adapter never runs.
 */
export const NEW_READ_KIND_OF: Readonly<Partial<Record<string, NewReadKind>>> = {
  workday_site: 'feed_read',
  personio: 'feed_read',
  recruitee: 'feed_read',
  breezy: 'feed_read',
  bamboohr: 'feed_read',
  icims: 'feed_read', // v37 BOARDS (SP v37 PLAN I2): robots.txt, the sitemap and each posting's page, with BOT_USER_AGENT
  career_site: 'site_reader',
  usajobs: 'usajobs',
  himalayas: 'remote_api',
  jobicy: 'remote_api',
  jobtech: 'board_read',
  nav: 'board_read',
  tyomarkkinatori: 'board_read',
};

/**
 * The kinds the worker may run now: scheduled, with an adapter, (a new kind of read) allowed by the identity, and (v30
 * S4) with the outside key its adapter reads with (USAJOBS_API_KEY, HIMALAYAS_API_KEY: off while empty).
 * v30 S5: career sites also wait for their admin switch (SITE_READER_CAREER_PAGES, owner question 8).
 */
export function runnableKinds(deps: ConstantDeps): string[] {
  const kinds = new Set<string>(SCHEDULED_KINDS);
  for (const kind of Object.keys(NEW_READ_KIND_OF)) kinds.add(kind);
  return [...kinds].filter(
    (kind) =>
      ADAPTERS[kind as SourceKind] &&
      (!NEW_READ_KIND_OF[kind] || newReadsAllowed(deps)) &&
      !missingOutsideKey(ADAPTERS[kind as SourceKind], deps) && // v30 S4
      (kind !== 'career_site' || careerPagesOn(deps)), // v30 S5
  );
}

/** What one run says about its source, for its next schedule. */
export interface RunOutcome {
  /** succeeded, partial, not_modified: the source answered. */
  ok: boolean;
  /** The board answered 404 (SourceNotFoundError). */
  notFound: boolean;
  /** The run stopped because its host is held (HostHeldError, ISO until): the source waits, it did not fail. */
  heldUntil: string | null;
  /** It created, changed, closed or reopened a posting. */
  changed: boolean;
  /** Open jobs after it (job_sources.open_jobs). */
  openJobs: number;
}

export interface ScheduleInput {
  now: number;
  /** The source before the run: its failures in a row, its tier, its last change. */
  consecutiveFailures: number;
  tier: string;
  lastChangeAt: string | null;
  /** Of its last runs before this one (newest first), whether each changed a posting (two are read). */
  recentChanges: readonly boolean[];
  /** A job of it is in someone's Saved Jobs or queue. */
  holdsSavedJob: boolean;
  outcome: RunOutcome;
  /** A random number in [0, 1) for the jitter (tests give their own). */
  random?: () => number;
}

export type ScheduleTier = 'hot' | 'normal' | 'quiet' | 'empty' | 'failing' | 'not_found';

export interface NextSchedule {
  tier: ScheduleTier;
  /** The tier's cadence (job_sources.cadence), in ms. */
  cadenceMs: number;
  /** ISO. */
  nextRunAt: string;
  consecutiveFailures: number;
  /** Turned off: too many failures, or a board gone for good. */
  disable: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type ConstantDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** A healthy tier's cadence, from the constants. */
function cadenceOf(deps: ConstantDeps, tier: ScheduleTier): number {
  const c = constantsOf(deps);
  if (tier === 'hot') return c.get('INGEST_CADENCE_HOT_HOURS') * HOUR;
  if (tier === 'quiet') return c.get('INGEST_CADENCE_QUIET_DAYS') * DAY;
  if (tier === 'empty') return c.get('INGEST_CADENCE_EMPTY_DAYS') * DAY;
  return c.get('INGEST_CADENCE_NORMAL_HOURS') * HOUR;
}

/** A source's tier and next run after a run (see the top), read from the constants. */
export function nextScheduleOf(deps: ConstantDeps, input: ScheduleInput): NextSchedule {
  const c = constantsOf(deps);
  const random = input.random ?? Math.random;
  const jittered = (ms: number) => Math.round(ms * (1 - JITTER + 2 * JITTER * random()));
  const at = (ms: number) => new Date(input.now + ms).toISOString();
  const normal = c.get('INGEST_CADENCE_NORMAL_HOURS') * HOUR;
  const known = ['hot', 'normal', 'quiet', 'empty', 'failing', 'not_found'].includes(input.tier) ? (input.tier as ScheduleTier) : 'normal';
  const { outcome } = input;
  if (outcome.heldUntil) {
    // The host's hold, not the source, stopped the run: due again just after the hold, nothing else changes.
    const wait = Math.max(0, Date.parse(outcome.heldUntil) - input.now) + AFTER_HOLD_MS;
    return { tier: known, cadenceMs: cadenceOf(deps, known), nextRunAt: at(wait), consecutiveFailures: input.consecutiveFailures, disable: false };
  }
  if (!outcome.ok) {
    const failures = input.consecutiveFailures + 1;
    if (outcome.notFound) {
      const notFoundRuns = known === 'not_found' ? failures : 1;
      return {
        tier: 'not_found',
        cadenceMs: NOT_FOUND_DAYS * DAY,
        nextRunAt: at(jittered(NOT_FOUND_DAYS * DAY)),
        consecutiveFailures: failures,
        disable: notFoundRuns >= NOT_FOUND_DROP_AFTER,
      };
    }
    const disable = failures >= c.get('INGEST_SOURCE_DISABLE_AFTER_FAILURES');
    if (failures < FAILING_AFTER) {
      // A failure or two: read again at the tier's own pace (a board's bad hour is not a failing board).
      const tier: ScheduleTier = ['hot', 'normal', 'quiet', 'empty'].includes(known) ? known : 'normal';
      const cadence = cadenceOf(deps, tier);
      return { tier, cadenceMs: cadence, nextRunAt: at(jittered(cadence)), consecutiveFailures: failures, disable };
    }
    const cadence = Math.min(FAILING_MAX_DAYS * DAY, normal * 2 ** (failures - FAILING_AFTER));
    return { tier: 'failing', cadenceMs: cadence, nextRunAt: at(jittered(cadence)), consecutiveFailures: failures, disable };
  }
  let tier: ScheduleTier;
  const changedRecently = [outcome.changed, ...input.recentChanges.slice(0, 2)].filter(Boolean).length >= 2;
  const lastChange = outcome.changed ? input.now : input.lastChangeAt ? Date.parse(input.lastChangeAt) : null;
  if (outcome.openJobs === 0) tier = 'empty';
  else if (outcome.openJobs >= c.get('INGEST_HOT_OPEN_JOBS') || changedRecently || input.holdsSavedJob) tier = 'hot';
  else if (lastChange !== null && input.now - lastChange <= QUIET_AFTER_DAYS * DAY) tier = 'normal';
  else tier = 'quiet';
  const cadence = cadenceOf(deps, tier);
  return { tier, cadenceMs: cadence, nextRunAt: at(jittered(cadence)), consecutiveFailures: 0, disable: false };
}

/** A due source as the worker reads it. */
export interface DueSource {
  id: number;
  kind: string;
  host: string | null;
}

/**
 * The due sources (12 §9.3): enabled, due, allowed by their terms and robots.txt (idx_job_sources_due's condition),
 * not leased, of a kind the worker may run, on a host that is not held. Most important first, then the longest due.
 * v30 S5: takes the constants' deps (runnableKinds reads SITE_READER_CAREER_PAGES).
 * v30 FIX-A (SEC-2, BEH-3): never a source of a company that opted out (opt-out-gate.ts), whatever its enabled flag.
 * v31 RUNS: none while every run is paused, and never a source an admin paused (pause-state.ts).
 * v36 SOURCES (SP v36 PLAN S5): only a source an admin turned on (enabled_at; the CHECK of migration 0060 holds it of
 * every enabled row, and this holds even without it).
 */
export async function dueSources(deps: ConstantDeps, limit = DUE_BATCH): Promise<DueSource[]> {
  const kinds = runnableKinds(deps);
  if (kinds.length === 0) return [];
  return deps.db.all<DueSource>(
    `SELECT s.id, s.kind, s.host FROM job_sources s
     WHERE s.enabled AND s.enabled_at IS NOT NULL AND s.next_run_at <= CAST(@now AS timestamptz)
       AND s.terms_status IN ('allowed', 'allowed_with_conditions') AND s.robots_status IN ('allowed', 'not_applicable')
       AND (s.lease_until IS NULL OR s.lease_until < CAST(@now AS timestamptz))
       AND s.kind = ANY(string_to_array(@kinds, ','))
       AND NOT EXISTS (SELECT 1 FROM crawl_hosts h WHERE h.host IN (s.host, ${laneSql('s.host')}) AND h.hold_until > CAST(@now AS timestamptz))
       AND NOT (${onLaneSql('s.host')} AND EXISTS (SELECT 1 FROM job_sources o
         WHERE o.id <> s.id AND o.lease_until > CAST(@now AS timestamptz) AND ${sameLaneSql('o.host', 's.host')})) -- v37 LANE (W6); v37 FIX-LANE: per lane
       AND NOT ${optedOutSourceSql('s')}
       AND s.paused_at IS NULL AND NOT ${RUNS_PAUSED_SQL}
     ORDER BY s.priority DESC, s.next_run_at
     LIMIT @limit`,
    { now: nowIso(deps), kinds: kinds.join(','), limit },
  );
}

/**
 * The enabled sources of held hosts wait for the hold's end (next_run_at moved past it), so the due queue's look never
 * fills with sources it cannot start. Answers how many moved. v37 LANE: a Workday source waits for its lane's pause too
 * (the later of the two holds).
 */
export async function postponeHeldSources(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  return (
    await deps.db.run(
      `UPDATE job_sources s SET next_run_at = x.until + CAST(@after AS integer) * interval '1 millisecond'
       FROM (SELECT s2.id, max(h.hold_until) AS until FROM job_sources s2
             JOIN crawl_hosts h ON h.host IN (s2.host, ${laneSql('s2.host')}) AND h.hold_until > CAST(@now AS timestamptz)
             WHERE s2.enabled AND s2.enabled_at IS NOT NULL GROUP BY s2.id) x
       WHERE s.id = x.id AND s.next_run_at < x.until`,
      { now: nowIso(deps), after: AFTER_HOLD_MS },
    )
  ).changes;
}

/** Whether one of the source's live jobs is in someone's Saved Jobs or queue (the hot tier's third rule). */
export async function holdsSavedJob(db: DbQueries, sourceId: number): Promise<boolean> {
  const row = await db.one<{ found: number }>(
    `SELECT 1 AS found FROM job_source_links l
     WHERE l.source_id = ? AND l.missing_since IS NULL
       AND (EXISTS (SELECT 1 FROM applications a WHERE a.job_id = l.job_id AND a.current_status = 1 AND a.archived_at IS NULL)
         OR EXISTS (SELECT 1 FROM autofill_agent_queue q WHERE q.job_id = l.job_id AND q.state IN ('queued', 'running')))
     LIMIT 1`,
    [sourceId],
  );
  return Boolean(row);
}

/**
 * v30 FIX-A (REV-SEC SEC-7): a career site's robots.txt read through the shared site reader's transport (its
 * connect-time address check refuses a name that points at a private address), with BOT_USER_AGENT under the reader's
 * pace, kept in site_robots like every file. Career sites' hosts come from discovery (pages people opened), so their
 * robots.txt never goes through the ingest client, whose checks are on names only.
 */
export function readerRobotsOf(deps: ConstantDeps): (host: string) => Promise<Pick<StoredRobots, 'status' | 'rules'>> {
  const c = constantsOf(deps);
  const gapMs = c.get('SITE_READER_HOST_GAP_SECONDS') * 1000;
  const context: RobotsReadContext = {
    transport: deps.services.siteReaderTransport ?? defaultSiteTransport(),
    gate: createHostGate(deps),
    store: createRobotsStore(deps),
    userAgent: deps.config.outside.botUserAgent,
    timeoutMs: c.get('SITE_READER_TIMEOUT_MS'),
    gapMs,
    maxTurnWaitMs: gapMs * c.get('SITE_READER_TURN_WAIT_GAPS'),
    now: () => deps.now().getTime(),
  };
  return (host) => robotsForHost(context, host);
}

/**
 * Gives sources their robots.txt verdict (12 §12.1: robots_status, for the paths each reads): those never judged first,
 * then the oldest verdicts past ROBOTS_VERDICT_MAX_AGE_MS, at most ROBOTS_REFRESH_BATCH per pass. Each host's file is read
 * once (assertRobotsAllow: kept in site_robots for every process); a held host waits; a source whose adapter names no
 * paths stays unchecked (it never runs). Answers how many verdicts were written. v36 SOURCES (PLAN S5): only sources an
 * admin turned on (a source waiting for an admin reads no robots.txt).
 */
export async function refreshRobotsStatuses(
  deps: ConstantDeps,
  http: IngestHttp,
  options: {
    limit?: number;
    signal?: AbortSignal;
    /**
     * v30 INT-4 (S3's edit B, S5's edit D): the client of the new kinds' hosts (NEW_READ_KIND_OF: S3's, S4's, S5's), which
     * read with BOT_USER_AGENT (the service's botHttp); today's kinds keep `http` (INGEST_USER_AGENT). Absent: `http`.
     */
    newKindsHttp?: IngestHttp;
    /** v30 FIX-A (SEC-7): how a career site's robots.txt is read (default: through the site reader's transport). */
    careerRobots?: (host: string) => Promise<Pick<StoredRobots, 'status' | 'rules'>>;
  } = {},
): Promise<number> {
  const db = deps.db;
  const at = nowIso(deps);
  const kinds = runnableKinds(deps);
  if (kinds.length === 0) return 0;
  const rows = await db.all<SourceRow>(
    `SELECT * FROM job_sources
     WHERE enabled AND enabled_at IS NOT NULL AND host IS NOT NULL AND kind = ANY(string_to_array(@kinds, ','))
       AND robots_status <> 'not_applicable' -- v30 S4: a keyed API's terms govern (12 §1: USAJOBS), never its robots.txt
       AND (robots_status = 'unchecked' OR robots_checked_at IS NULL OR robots_checked_at < CAST(@stale AS timestamptz))
     ORDER BY robots_checked_at NULLS FIRST, id LIMIT @limit`,
    {
      kinds: kinds.join(','),
      stale: new Date(deps.now().getTime() - ROBOTS_VERDICT_MAX_AGE_MS).toISOString(),
      limit: options.limit ?? ROBOTS_REFRESH_BATCH,
    },
  );
  // A host's sources by the identity that reads them: a new kind's with BOT_USER_AGENT, today's with today's; a career
  // site's through the site reader's transport (v30 FIX-A, SEC-7).
  const byHost = new Map<string, { host: string; client: IngestHttp; site: boolean; sources: SourceRow[] }>();
  for (const row of rows) {
    const site = row.kind === 'career_site';
    const fresh = NEW_READ_KIND_OF[row.kind] !== undefined;
    const key = `${site ? 'site' : fresh ? 'new' : 'v20'} ${row.host!}`;
    const group = byHost.get(key) ?? { host: row.host!, client: fresh ? (options.newKindsHttp ?? http) : http, site, sources: [] };
    group.sources.push(row);
    byHost.set(key, group);
  }
  let careerRobots = options.careerRobots ?? null;
  let written = 0;
  for (const { host, client, site, sources } of byHost.values()) {
    if (options.signal?.aborted) break;
    let robots: Pick<StoredRobots, 'status' | 'rules'>;
    try {
      // Reads the file when no process read it within 24 hours (one paced request), else uses the kept one.
      if (site) {
        careerRobots ??= readerRobotsOf(deps);
        robots = await careerRobots(host);
      } else {
        robots = await hostRobots(client, host, { signal: options.signal, now: () => deps.now().getTime() });
      }
    } catch (error) {
      if (options.signal?.aborted) break;
      // v37 LANE (W7): a held host or lane, or a read that sent nothing (its turn's wait ran out): no verdict now.
      if (error instanceof HostHeldError || nothingSent(error)) continue;
      // An unreadable file (429, a 5xx, no answer): "not now", so every source of the host says `error`.
      robots = { status: 'unreachable', rules: null };
    }
    const verdicts = new Map<string, number[]>();
    for (const row of sources) {
      const source = toSourceRecord(row);
      const adapter = ADAPTERS[source.kind];
      const paths = adapter && isDefinedAdapter(adapter) ? adapter.robotsPaths?.(source) : undefined;
      const verdict =
        !paths
          ? 'unchecked'
          : ({ allowed: 'allowed', disallowed: 'disallowed', unreachable: 'error' } as const)[robotsVerdict(robots, paths)];
      verdicts.set(verdict, [...(verdicts.get(verdict) ?? []), source.id]);
    }
    for (const [verdict, ids] of verdicts) {
      written += (
        await db.run(
          `UPDATE job_sources SET robots_status = @verdict, robots_checked_at = CAST(@at AS timestamptz)
           WHERE id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))`,
          { verdict, at, ids: ids.join(',') },
        )
      ).changes;
    }
  }
  return written;
}
