import type { Router } from 'express';
import { z } from 'zod';
import {
  AdminHostHoldBodySchema,
  AdminHostsQuerySchema,
  MINUTE_MS,
  type AdminHost,
  type AdminHostRow,
  type AdminHostsQuery,
  type ConstantKey,
  type Constants,
  type CrawlHostHoldReason,
  type SiteRobots,
} from '@tailorit/shared';
import { adminRouter, decodeCursor, encodeCursor, likeText, Where } from '../../core/admin/index';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries, SqlParams } from '../../core/db/types';
import { notFound, validationFailed } from '../../core/http/errors';
import { HostHeldError, sleepFor, type HostGate, type HostHoldReason, type HostOutcome } from './http';
import { ROBOTS_STALE_USE_MS, type RobotsStore, type StoredRobots } from './robots';
import { BOARD_LANES, type RegisteredBoardLane } from '@tailorit/shared/sourcing'; // v38 FRAME: the lanes are the board registry's

// v30 S1-API: the hosts TailorIT reads, shared by every process (12-job-sourcing.md §9.2, §9.4; 11-database.md
// §5.3a). Two tables:
//   - crawl_hosts: each host's pace and holds. Before each request a reader takes the host's next slot with one
//     conditional statement (createHostGate's takeTurn), so the API process (Add job, Run now, the re-checks) and the
//     ingest worker together keep one pace per host: at least INGEST_HOST_MIN_INTERVAL_MS apart, or the host's
//     Crawl-delay. A held host (Retry-After, the breaker, a bot check, an admin) is not asked at all until its hold
//     ends; failures back it off and open its breaker (record);
//   - site_robots: each host's robots.txt as last read (createRobotsStore), used for 24 hours by every process, with
//     its Crawl-delay, its Content-Signal lines and its Sitemap lines. A host whose signals say `ai-input=no` keeps
//     its sources and their jobs out of AI (job_sources.ai_input, jobs.ai_input).
// Admin › Hosts reads both (createHostsRouter): the hosts, their holds and failures, their sources and robots.txt, and
// an admin's own hold or release.

/** The first backoff step after a failed request (1 minute), doubled per failure in a row (12 §9.4). */
export const HOST_BACKOFF_BASE_MS = 60_000;
/** v30 FIX-A: how often a turn waiting for a busy host looks again, and how many looks it makes at most. */
export const HOST_BUSY_POLL_MS = 250;
export const HOST_BUSY_TRIES = 2400;

// ------------------------------------------------------------------------------------------------- the lanes

// v37 LANE (SP v37 PLAN W1-W5): every Workday host (a tenant's <tenant>.wd<n>.myworkdayjobs.com, the shared
// wd<n>.myworkdaysite.com, a tenant's wd<n>.myworkday.com) takes its turns on ONE crawl_hosts row, the Workday lane
// (`workday.lane`): one request at a time to all of Workday, for every process, at least WORKDAY_MIN_INTERVAL_MS apart
// (a tenant's Crawl-delay makes its own requests' gap longer, never the lane's shorter). Workday answers one address's
// requests from one limit, so v3.5's "each tenant its own lane" made it answer 429 to nearly everything.
// v37 FIX-LANE (the coordinator's generic lane, after the v3.7 review's F1: BambooHR and iCIMS need lanes too): a lane
// is an entry of LANES below ({key, label, name, hosts, kinds, its least-gap constant, its discovery-cap constant});
// everything else here, in the scheduler, the worker, the link queue, discovery, the site reader and Admin › Hosts reads
// the registry, so a new platform's lane is one entry. Only Workday is registered in v3.6.1; v3.7 (INT-2b, SP v37
// FIXES-37 E1) registers BambooHR's and iCIMS's (the v3.7 review's F1: each answers all its companies from one limit
// too, and v3.7 read them in parallel across their hosts, 450-930 requests a minute in its busy hour). The adaptive rules and
// their constants (LANE_*) are shared by every lane; each lane keeps its own state on its own crawl_hosts row.
//   - The mapping is inside the host gate (createHostGate below: takeTurn, record, release, holdOf), so the ingest client
//     (http.ts), its robots.txt and sitemap reads, the shared site reader (core/http/reader) and every caller of them
//     are on the lane without knowing it.
//   - A site's own row keeps what is the site's: an admin's hold, a bot check (401, 403, a challenge), its failures'
//     backoff and breaker (5xx, no answer) and its Crawl-delay; it is checked before the lane's turn.
//   - v37 FIX-LANE (SP v37 FIXES-361 D3, the review's F1: a steady limit drew a 429 every ~1.5 minutes forever): the
//     pace adapts. A lane keeps its 429s of the last LANE_429_WINDOW_MINUTES (crawl_hosts.throttle_hits; a good answer
//     does not forget them, nor does an admin's Release). With k of them, a 429 pauses the whole lane (reason
//     retry_after) for max(Retry-After, 30 s x 2^(k-1)), the doubling capped at LANE_PAUSE_MAX_MINUTES, and widens the
//     lane's gap to its least gap x 2^k (at most LANE_MAX_INTERVAL_MS), which halves back after each LANE_EASE_MINUTES
//     without a 429, never below its least gap (lanePaceOf); at INGEST_HOST_BREAKER_FAILURES 429s in the window the
//     breaker holds it for LANE_BREAKER_HOLD_MINUTES (or a longer Retry-After). record() answers that pause as a
//     HostHeldError for the lane, which the request throws at once (no retry inside it).
//   - People first (W5): a turn taken with `priority: 'interactive'` (a person waiting: the API's own client) keeps the
//     row's priority_until a moment ahead while it waits; background turns let it go first. While a lane is paused,
//     every turn is refused at once with the pause's end (lanePauseOf). v37 FIX-LANE: a person's turn keeps the least
//     gap (next_slot_at) while background turns keep the widened one (paced_slot_at), so a person waits at most about
//     one least gap behind a running source whatever the pace (people's reads are few: rate-limited per account).
//   - v37 FIX-LANE (F3, the review's "no turn order"): background turns waiting for a lane take it oldest first. A
//     turn that finds the lane busy (or a person first) queues a ticket (crawl_host_waiters) and keeps it fresh at each
//     look; a background turn never takes the lane over an older live ticket, so a loop that just gave the lane back
//     (a run's postings, a discovery pass) queues behind the link queue, the re-checks and the robots.txt reads that
//     waited. A ticket goes when its turn is taken or its wait ends (stopped, refused, run out); a process that stopped
//     leaves one that holds nobody once LANE_WAITER_STALE_MS passed.
//   - v37 FIX-LANE (F2): a turn that finds the lane given back between its try and its look takes it (never "on hold").
//   - v37 FIX-LANE (F5, W2): a site's robots.txt Crawl-delay paces that site's own requests (its row's next_slot_at),
//     never the lane's gap.

/** v37 FIX-LANE: an int constant's key (a lane's least gap and discovery cap are read at each use). */
type IntConstantKey = { [K in ConstantKey]: Constants[K]['kind'] extends 'int' ? K : never }[ConstantKey];

/** v37 FIX-LANE: a platform lane: one crawl_hosts row every one of its hosts takes its turns on. */
export interface LaneSpec {
  /** The lane's crawl_hosts row (it passes HostIdSchema): `workday.lane`. */
  readonly key: string;
  /** The lane in words as a row (Admin › Hosts, the lane's HostHeldError): "Workday (all sites)". */
  readonly label: string;
  /** The platform in a sentence (people's pause words, a run waiting for it, Admin › Hosts): "Workday". */
  readonly name: string;
  /**
   * Its hosts: a pattern over a URL's host name (lower case, no port, no trailing dot) that reads the same in
   * JavaScript and in PostgreSQL (non-capturing groups, `\.`; no quote).
   */
  readonly hosts: string;
  /** The source kinds whose sources are the lane's whatever their host (Admin › Hosts counts them on its row). */
  readonly kinds: readonly string[];
  /** The constant of its least gap (ms). */
  readonly minIntervalKey: IntConstantKey;
  /** The constant of how many of its boards discovery may check in a clock hour (0 stops those checks). */
  readonly discoveryPerHourKey: IntConstantKey;
}

// v38 FRAME (SP v38 PLAN A4): the lanes are the board registry's (@tailorit/shared/sourcing BOARD_LANES: each board
// descriptor's `lane`, once per key, in the registry's order, its kinds those that declare it). A lane that names no
// constants of its own takes LANE_DEFAULT_MIN_INTERVAL_MS and LANE_DEFAULT_DISCOVERY_PER_HOUR. Workday's, BambooHR's and
// iCIMS's keep v3.7's words, hosts, kinds and constants.

/**
 * v38 FRAME (SP v38 PLAN A4): the lanes with constants of their own, by key (a platform that adds its own gap and
 * discovery cap to the constants adds its line here); every other lane takes LANE_DEFAULT_MIN_INTERVAL_MS and
 * LANE_DEFAULT_DISCOVERY_PER_HOUR. (Never in the shared descriptor: the web's bundle holds no server-only constant.)
 */
const LANE_CONSTANTS: Readonly<Record<string, Pick<LaneSpec, 'minIntervalKey' | 'discoveryPerHourKey'>>> = {
  'workday.lane': { minIntervalKey: 'WORKDAY_MIN_INTERVAL_MS', discoveryPerHourKey: 'WORKDAY_DISCOVERY_PER_HOUR' },
  'bamboohr.lane': { minIntervalKey: 'BAMBOOHR_MIN_INTERVAL_MS', discoveryPerHourKey: 'BAMBOOHR_DISCOVERY_PER_HOUR' },
  'icims.lane': { minIntervalKey: 'ICIMS_MIN_INTERVAL_MS', discoveryPerHourKey: 'ICIMS_DISCOVERY_PER_HOUR' },
};

/** v38 FRAME: a registered board lane as the host gate reads it. */
function laneSpecOf(lane: RegisteredBoardLane): LaneSpec {
  return {
    key: lane.key,
    label: lane.label,
    name: lane.name,
    hosts: lane.hosts,
    kinds: lane.kinds,
    minIntervalKey: LANE_CONSTANTS[lane.key]?.minIntervalKey ?? 'LANE_DEFAULT_MIN_INTERVAL_MS',
    discoveryPerHourKey: LANE_CONSTANTS[lane.key]?.discoveryPerHourKey ?? 'LANE_DEFAULT_DISCOVERY_PER_HOUR',
  };
}

/** v37 FIX-LANE: the lanes (v38 FRAME: the board registry's). Read at each use, never copied at load. */
const LANES: LaneSpec[] = BOARD_LANES.map(laneSpecOf);

/** A registered lane by its key (one every Workday, BambooHR or iCIMS descriptor declares). */
const registered = (key: string): LaneSpec => {
  const lane = LANES.find((known) => known.key === key);
  if (!lane) throw new Error(`The board registry declares no lane ${key}.`);
  return lane;
};

/** v37 LANE: the crawl_hosts row every Workday request takes its turn on (it passes HostIdSchema). */
export const WORKDAY_LANE = 'workday.lane';
/** v37 FIX-LANE: the Workday lane's entry (v38 FRAME: the Workday descriptors'). */
export const WORKDAY_LANE_SPEC: LaneSpec = registered(WORKDAY_LANE);
/** v37 LANE: the Workday lane in words (Admin › Hosts, the lane's HostHeldError). */
export const WORKDAY_LANE_LABEL = WORKDAY_LANE_SPEC.label;

/**
 * v37 INT-2b (E1): BambooHR's lane: every company's careers host, <company>.bamboohr.com (one DNS label; the list, each
 * opening's detail and the careers page alike), at least BAMBOOHR_MIN_INTERVAL_MS apart (v38 FRAME: its descriptor's).
 */
export const BAMBOOHR_LANE_SPEC: LaneSpec = registered('bamboohr.lane');

/**
 * v37 INT-2b (E1): iCIMS's lane: every employer's iCIMS host (ICIMS_BOARD_HOST: never iCIMS's own www, api, login or
 * internal- hosts; its lookahead reads the same in PostgreSQL), at least ICIMS_MIN_INTERVAL_MS apart. A turned-on career
 * site on such a host (kept as it was by 0063) takes it too (v38 FRAME: its descriptor's).
 */
export const ICIMS_LANE_SPEC: LaneSpec = registered('icims.lane');
/** Each lane's host pattern, compiled once. */
const LANE_PATTERNS = new Map<LaneSpec, RegExp>();
const patternOf = (lane: LaneSpec): RegExp => {
  let pattern = LANE_PATTERNS.get(lane);
  if (!pattern) {
    pattern = new RegExp(lane.hosts);
    LANE_PATTERNS.set(lane, pattern);
  }
  return pattern;
};

/** v37 FIX-LANE: every registered lane, in order. */
export function registeredLanes(): readonly LaneSpec[] {
  return LANES;
}

/**
 * v37 FIX-LANE: registers one more lane until the answer is called. For tests only (a test-only platform proves the
 * lanes are independent); product lanes are entries of LANES.
 */
export function registerLaneForTest(lane: LaneSpec): () => void {
  if (LANES.some((known) => known.key === lane.key)) throw new Error(`The lane ${lane.key} is registered already.`);
  LANES.push(lane);
  return () => {
    const at = LANES.indexOf(lane);
    if (at >= 0) LANES.splice(at, 1);
    LANE_PATTERNS.delete(lane);
  };
}

/** A URL's host as the lanes' patterns read it: a name, lower case, without its port or a trailing dot. */
const hostNameOf = (host: string) => host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');

/** v37 FIX-LANE: the lane a host's requests take their turns on (a host with or without its port), or null. */
export function laneOfHost(host: string): LaneSpec | null {
  const name = hostNameOf(host);
  return LANES.find((lane) => patternOf(lane).test(name)) ?? null;
}

/** v37 FIX-LANE: the lane whose crawl_hosts row is `key`, or null (a host's own row). */
export function laneByKey(key: string): LaneSpec | null {
  return LANES.find((lane) => lane.key === key) ?? null;
}

/** v37 FIX-LANE: whether a host's requests take a lane's turns (any registered lane). */
export function isLaneHost(host: string): boolean {
  return laneOfHost(host) !== null;
}

/** v37 LANE: whether a host (a URL's host, with or without its port) is Workday's: its requests take the Workday lane. */
export function isWorkdayLaneHost(host: string): boolean {
  return patternOf(WORKDAY_LANE_SPEC).test(hostNameOf(host));
}

/** v37 LANE: the crawl_hosts row a host's requests take their turns on: its lane's (v37 FIX-LANE: any lane), else the host. */
export function laneKeyOf(host: string): string {
  return laneOfHost(host)?.key ?? host;
}

/** A text as a SQL literal (the registry's own constants: keys and patterns). */
const sqlText = (text: string) => `'${text.replace(/'/g, "''")}'`;

/**
 * v37 LANE: SQL for the lane key of a host column (`s.host`): its lane's key (v37 FIX-LANE: any registered lane:
 * 'workday.lane' for Workday's hosts), else the column.
 */
export function laneSql(column: string): string {
  if (LANES.length === 0) return `(${column})`;
  return `(CASE ${LANES.map((lane) => `WHEN ${column} ~ ${sqlText(lane.hosts)} THEN ${sqlText(lane.key)}`).join(' ')} ELSE ${column} END)`;
}

/** v37 FIX-LANE: SQL true for a host column on any registered lane; false (never null) for any other host or none. */
export function onLaneSql(column: string): string {
  if (LANES.length === 0) return 'false';
  return `COALESCE(${LANES.map((lane) => `${column} ~ ${sqlText(lane.hosts)}`).join(' OR ')}, false)`;
}

/** v37 FIX-LANE: SQL true for two host columns on the same registered lane; false (never null) otherwise. */
export function sameLaneSql(a: string, b: string): string {
  if (LANES.length === 0) return 'false';
  return `COALESCE(${LANES.map((lane) => `(${a} ~ ${sqlText(lane.hosts)} AND ${b} ~ ${sqlText(lane.hosts)})`).join(' OR ')}, false)`;
}

/** v37 LANE: SQL true for a host column that is Workday's; false (never null) for any other host or none. */
export function isWorkdayLaneSql(column: string): string {
  return `COALESCE(${column} ~ ${sqlText(WORKDAY_LANE_SPEC.hosts)}, false)`;
}

/** v37 FIX-LANE: a lane's pause (or hold) a read met: until when (ISO), why, and the lane. */
export interface LanePause {
  until: string;
  reason: HostHoldReason;
  lane: LaneSpec;
}

/**
 * v37 FIX-LANE: the pause (or hold) of a lane a read met, for "Workday asked us to slow down. Try again after {time}."
 * (the lane's name), a run waiting for it, a queued link's wait; null for any other error (a site's own hold, a failure).
 */
export function lanePauseOf(error: unknown): LanePause | null {
  if (!(error instanceof HostHeldError)) return null;
  const lane = laneByKey(error.host);
  return lane ? { until: error.until, reason: error.reason, lane } : null;
}

/**
 * v37 LANE (SP v37 PLAN W5): the Workday lane's pause (or hold) a read met: until when (ISO) and why; null for any other
 * error (a tenant's own hold, a failure, another lane's pause: lanePauseOf names any lane's).
 */
export function workdayPauseOf(error: unknown): { until: string; reason: HostHoldReason } | null {
  const pause = lanePauseOf(error);
  return pause && pause.lane.key === WORKDAY_LANE ? { until: pause.until, reason: pause.reason } : null;
}

/**
 * v37 FIX-LANE (F7): the error code of a run that met its lane's pause before it read its postings: `<platform>_paused`
 * from the lane's key (`workday_paused`: @tailorit/shared RUN_WAITING_FOR_WORKDAY, "Waiting for Workday").
 */
export function laneWaitingCodeOf(lane: LaneSpec): string {
  return `${lane.key.replace(/\.lane$/, '').replace(/[^a-z0-9]+/g, '_')}_paused`;
}

/** v37 LANE: the first pause after a 429 on a lane, doubled at each further 429 in the window (W3, D3). */
export const LANE_PAUSE_BASE_MS = 30_000;
/** v37 LANE: how long a waiting person's turn keeps background turns behind it after its last look (4 looks). */
export const PRIORITY_HOLD_MS = 4 * HOST_BUSY_POLL_MS;
/** v37 FIX-LANE (F3): how long a waiting turn's ticket holds its place in the lane's line after its last look (20 looks). */
export const LANE_WAITER_STALE_MS = 20 * HOST_BUSY_POLL_MS;
/** v37 FIX-LANE (W5 with D3): how long a background turn waiting for its widened gap's slot sleeps between looks. */
export const LANE_EARLY_LOOK_MS = 4 * HOST_BUSY_POLL_MS;

/** v37 FIX-LANE (D3): the constants a lane's pace reads (an admin's change applies at the next turn). */
export interface LanePaceRules {
  /** The lane's least gap (its minIntervalKey: WORKDAY_MIN_INTERVAL_MS for Workday). */
  minMs: number;
  /** LANE_MAX_INTERVAL_MS (never below the least gap): the widest gap. */
  maxMs: number;
  /** LANE_EASE_MINUTES: a widened gap halves after each of these without a 429. */
  easeMs: number;
  /** LANE_429_WINDOW_MINUTES: how far back 429s count. */
  windowMs: number;
}

/** v37 FIX-LANE (D3): a lane's pace rules from the constants (Workday's when no lane is named). */
export function lanePaceRules(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, lane: LaneSpec = WORKDAY_LANE_SPEC): LanePaceRules {
  const c = constantsOf(deps);
  const minMs = c.get(lane.minIntervalKey);
  return {
    minMs,
    maxMs: Math.max(minMs, c.get('LANE_MAX_INTERVAL_MS')),
    easeMs: c.get('LANE_EASE_MINUTES') * MINUTE_MS,
    windowMs: c.get('LANE_429_WINDOW_MINUTES') * MINUTE_MS,
  };
}

/** v37 FIX-LANE (D3): a lane's pace at a moment. */
export interface LanePace {
  /** The gap between two background requests now (ms): the least gap, or wider after 429s. */
  gapMs: number;
  /** When the widened gap next halves (ISO); null at the least gap. */
  easesAt: string | null;
  /** The 429s within the window now. */
  recent: number;
}

/**
 * v37 FIX-LANE (D3): a lane's pace from its kept 429s (`hits`, crawl_hosts.throttle_hits): after its latest 429, with
 * k 429s in the window then, the gap is its least gap x 2^k (at most the widest), halved after each LANE_EASE_MINUTES
 * since, never below the least gap. Pure: Admin › Hosts shows the same numbers the turns keep.
 */
export function lanePaceOf(hits: readonly string[] | null | undefined, at: number, rules: LanePaceRules): LanePace {
  const times = (hits ?? []).map((hit) => Date.parse(hit)).filter((time) => Number.isFinite(time));
  const recent = times.filter((time) => time > at - rules.windowMs).length;
  if (times.length === 0) return { gapMs: rules.minMs, easesAt: null, recent };
  const last = Math.max(...times);
  const k = times.filter((time) => time > last - rules.windowMs).length;
  const widest = Math.max(rules.minMs, Math.min(rules.maxMs, rules.minMs * 2 ** Math.min(k, 30)));
  const halvings = Math.max(0, Math.floor((at - last) / rules.easeMs));
  const gapMs = Math.max(rules.minMs, Math.round(widest / 2 ** Math.min(halvings, 30)));
  return { gapMs, easesAt: gapMs > rules.minMs ? new Date(last + (halvings + 1) * rules.easeMs).toISOString() : null, recent };
}

/** The pace and holds of crawl_hosts, for every process (see the top). `now` is the readers' clock (deps.now). */
export function createHostGate(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  options: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): HostGate {
  const db = deps.db;
  const sleep = options.sleep ?? sleepFor;
  const now = () => deps.now().getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const constants = () => constantsOf(deps);

  /** Gives the row's busy mark back (the request that took it is over). */
  const giveBack = (key: string) => db.run('UPDATE crawl_hosts SET busy_until = NULL WHERE host = ? AND busy_until IS NOT NULL', [key]);

  /**
   * Sleeps until a slot taken on row `key`. v37 LANE (SP v37 PLAN W9): a turn taken but never used (its wait was
   * stopped) is given back at once, so a stopped wait never leaves the host (or the whole Workday lane) busy until its
   * mark runs out.
   */
  async function waitForSlot(key: string, slot: number, busy: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await sleep(slot - now(), signal);
    } catch (error) {
      if (busy > 0) await giveBack(key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Takes the next slot of crawl_hosts row `key` (a host) `floor` ms after the one before (or the row's own
   * min_interval_ms when larger), unless it is held, busy, or its slot is more than `maxWaitMs` ahead; then sleeps until
   * the slot.
   */
  async function takeOn(key: string, floor: number, options: { maxWaitMs: number; signal?: AbortSignal; busy: number }): Promise<void> {
    const { maxWaitMs, signal, busy } = options;
    const started = now();
    for (let tries = 0; ; tries += 1) {
      const at = now();
      // Takes the next slot unless the row is held, busy or its slot is too far ahead: one statement, so two readers
      // in two processes take two slots one interval apart.
      const taken = await db.one<{ slot: string }>(
        `INSERT INTO crawl_hosts AS h (host, min_interval_ms, next_slot_at, updated_at, busy_until)
         VALUES (@host, @floor, CAST(@now AS timestamptz) + CAST(@floor AS integer) * interval '1 millisecond', CAST(@now AS timestamptz),
           CASE WHEN CAST(@busy AS integer) > 0 THEN CAST(@now AS timestamptz) + CAST(@busy AS integer) * interval '1 millisecond' END)
         ON CONFLICT (host) DO UPDATE SET
           next_slot_at = GREATEST(h.next_slot_at, CAST(@now AS timestamptz))
             + GREATEST(h.min_interval_ms, CAST(@floor AS integer)) * interval '1 millisecond',
           busy_until = CASE WHEN CAST(@busy AS integer) > 0
             THEN GREATEST(h.next_slot_at, CAST(@now AS timestamptz)) + CAST(@busy AS integer) * interval '1 millisecond' ELSE h.busy_until END,
           updated_at = CAST(@now AS timestamptz)
         WHERE (h.hold_until IS NULL OR h.hold_until <= CAST(@now AS timestamptz)) AND h.next_slot_at <= CAST(@latest AS timestamptz)
           AND (h.busy_until IS NULL OR h.busy_until <= CAST(@now AS timestamptz))
         RETURNING next_slot_at - GREATEST(min_interval_ms, CAST(@floor AS integer)) * interval '1 millisecond' AS slot`,
        { host: key, floor, busy, now: iso(at), latest: iso(at + maxWaitMs) },
      );
      if (taken) return waitForSlot(key, Date.parse(taken.slot), busy, signal);
      const row = await db.one<{ hold_until: string | null; hold_reason: CrawlHostHoldReason | null; next_slot_at: string; busy_until: string | null }>(
        'SELECT hold_until, hold_reason, next_slot_at, busy_until FROM crawl_hosts WHERE host = ?',
        [key],
      );
      if (row?.hold_until && Date.parse(row.hold_until) > at) throw new HostHeldError(key, row.hold_until, row.hold_reason ?? 'admin');
      const busyUntil = row?.busy_until ? Date.parse(row.busy_until) : 0;
      const slotOk = row ? Date.parse(row.next_slot_at) <= at + maxWaitMs : true;
      const waiting = tries < HOST_BUSY_TRIES && now() - started < maxWaitMs;
      // v37 FIX-LANE (F2): the request that held the host gave it back between this turn's try and its look: try again.
      if (!(busyUntil > at) && slotOk && waiting) continue;
      if (busyUntil > at && slotOk && waiting) {
        // Another request is in flight to the host: wait a moment and look again.
        await sleep(Math.min(HOST_BUSY_POLL_MS, busyUntil - at), signal);
        continue;
      }
      throw new HostHeldError(key, busyUntil > at ? iso(busyUntil) : (row?.next_slot_at ?? iso(at)), 'backoff');
    }
  }

  /** v37 FIX-LANE: a lane's row as a turn looks at it. */
  interface LaneLook {
    hold_until: string | null;
    hold_reason: CrawlHostHoldReason | null;
    next_slot_at: string;
    paced_slot_at: string | null;
    busy_until: string | null;
    priority_until: string | null;
    throttle_hits: string[] | null;
    /** Live tickets older than this turn's (background turns only). */
    ahead: number;
  }

  /** v37 FIX-LANE (F3): the waiting tickets a background turn on the lane lets go first: older and still looking. */
  const OLDER_WAITERS = `SELECT 1 FROM crawl_host_waiters w WHERE w.host = @lane AND w.seen_until > CAST(@now AS timestamptz)
    AND (CAST(@ticket AS bigint) IS NULL OR w.ticket < CAST(@ticket AS bigint))`;
  /** The lane's next slot for this turn: a person's at the least gap (next_slot_at), background at the widened one too. */
  const LANE_SLOT = `GREATEST(h.next_slot_at, CASE WHEN CAST(@interactive AS boolean) THEN h.next_slot_at
    ELSE COALESCE(h.paced_slot_at, h.next_slot_at) END, CAST(@now AS timestamptz))`;

  /**
   * v37 LANE + FIX-LANE (W1, W5, D3, F2, F3): takes a lane's next slot and answers it (ms; the caller sleeps until it).
   * The slot's gap after it is `floor` for the next person and the lane's pace now (lanePaceOf) for the next background
   * turn. Refused at once while the lane is held (its pause or hold); waits while it is busy, a person waits for it
   * (background), or older background turns wait for it (their tickets, F3); refused once its slot is more than
   * `maxWaitMs` ahead or the wait runs out.
   */
  async function takeLane(lane: LaneSpec, floor: number, options: { maxWaitMs: number; signal?: AbortSignal; busy: number; interactive: boolean }): Promise<number> {
    const { maxWaitMs, signal, busy, interactive } = options;
    const started = now();
    const label = { label: lane.label };
    const rules = lanePaceRules(deps, lane);
    let ticket: number | null = null;
    try {
      for (let tries = 0; ; tries += 1) {
        const at = now();
        if (interactive) {
          // v37 LANE (W5): a person waits for the lane: background turns let them go first for a moment after each look.
          await db.run(
            `UPDATE crawl_hosts SET priority_until = CAST(@until AS timestamptz)
             WHERE host = @key AND (priority_until IS NULL OR priority_until < CAST(@until AS timestamptz))`,
            { key: lane.key, until: iso(at + PRIORITY_HOLD_MS) },
          );
        } else if (ticket !== null) {
          // F3: this turn still waits: its ticket keeps its place (cleared as stale meanwhile: it queues again).
          const kept = await db.run('UPDATE crawl_host_waiters SET seen_until = CAST(? AS timestamptz) WHERE ticket = ?', [iso(at + LANE_WAITER_STALE_MS), ticket]);
          if (kept.changes === 0) ticket = null;
        }
        const row = await db.one<LaneLook>(
          `SELECT h.hold_until, h.hold_reason, h.next_slot_at, h.paced_slot_at, h.busy_until, h.priority_until, h.throttle_hits,
             CASE WHEN CAST(@interactive AS boolean) THEN 0 ELSE (SELECT count(*) FROM (${OLDER_WAITERS}) o) END AS ahead
           FROM crawl_hosts h WHERE h.host = @lane`,
          { lane: lane.key, now: iso(at), ticket, interactive },
        );
        if (!row) {
          // The lane's first request: its row (its own gap 0: its constant applies).
          await db.run(
            `INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at) VALUES (?, 0, CAST(? AS timestamptz), CAST(? AS timestamptz))
             ON CONFLICT (host) DO NOTHING`,
            [lane.key, iso(at), iso(at)],
          );
          if (tries < 3) continue;
          throw new HostHeldError(lane.key, iso(at), 'backoff', label);
        }
        if (row.hold_until && Date.parse(row.hold_until) > at) throw new HostHeldError(lane.key, row.hold_until, row.hold_reason ?? 'admin', label);
        const paced = Math.max(floor, lanePaceOf(row.throttle_hits, at, rules).gapMs);
        const slot = Math.max(Date.parse(row.next_slot_at), interactive ? 0 : Date.parse(row.paced_slot_at ?? row.next_slot_at), at);
        const busyUntil = row.busy_until ? Date.parse(row.busy_until) : 0;
        const left = maxWaitMs - (at - started);
        if (slot - at > left) throw new HostHeldError(lane.key, iso(slot), 'backoff', label);
        const yielding = !interactive && row.priority_until !== null && Date.parse(row.priority_until) > at;
        const behind = Number(row.ahead) > 0;
        // v37 FIX-LANE (W5 with D3): while 429s widened the gap, a background turn takes its slot only once it is at most
        // a least gap away. Until then the lane stays free, so a person who asks meanwhile goes after the least gap,
        // never behind a slot booked a widened gap ahead.
        const early = !interactive && paced > floor && slot - at > floor;
        if (!(busyUntil > at) && !yielding && !behind && !early) {
          // One statement: of two turns that saw the lane free, one takes the slot; the other looks again (F2).
          const taken = await db.one<{ slot: string }>(
            `UPDATE crawl_hosts h SET
               next_slot_at = ${LANE_SLOT} + CAST(@floor AS integer) * interval '1 millisecond',
               paced_slot_at = ${LANE_SLOT} + CAST(@paced AS integer) * interval '1 millisecond',
               busy_until = CASE WHEN CAST(@busy AS integer) > 0 THEN ${LANE_SLOT} + CAST(@busy AS integer) * interval '1 millisecond' ELSE h.busy_until END,
               updated_at = CAST(@now AS timestamptz)
             WHERE h.host = @lane AND (h.hold_until IS NULL OR h.hold_until <= CAST(@now AS timestamptz))
               AND (h.busy_until IS NULL OR h.busy_until <= CAST(@now AS timestamptz))
               AND ${LANE_SLOT} <= CAST(@latest AS timestamptz)
               AND (CAST(@interactive AS boolean) OR h.priority_until IS NULL OR h.priority_until <= CAST(@now AS timestamptz))
               AND (CAST(@interactive AS boolean) OR NOT EXISTS (${OLDER_WAITERS}))
             RETURNING next_slot_at - CAST(@floor AS integer) * interval '1 millisecond' AS slot`,
            { lane: lane.key, floor, paced, busy, now: iso(at), latest: iso(at + Math.max(0, left)), interactive, ticket },
          );
          if (taken) {
            if (ticket !== null) {
              const done = ticket;
              ticket = null;
              await db.run('DELETE FROM crawl_host_waiters WHERE ticket = ?', [done]);
            }
            return Date.parse(taken.slot);
          }
          if (tries < HOST_BUSY_TRIES) continue;
        }
        if (tries >= HOST_BUSY_TRIES || now() - started >= maxWaitMs) {
          throw new HostHeldError(lane.key, busyUntil > at ? iso(busyUntil) : iso(slot), 'backoff', label);
        }
        if (!interactive && ticket === null) {
          // F3: in line, behind the older tickets (one that stopped looking is cleared on the way).
          const queued = await db.one<{ ticket: number }>(
            `WITH gone AS (DELETE FROM crawl_host_waiters WHERE host = @lane AND seen_until <= CAST(@now AS timestamptz))
             INSERT INTO crawl_host_waiters(host, asked_at, seen_until) VALUES (@lane, CAST(@now AS timestamptz), CAST(@until AS timestamptz))
             RETURNING ticket`,
            { lane: lane.key, now: iso(at), until: iso(at + LANE_WAITER_STALE_MS) },
          );
          ticket = queued ? Number(queued.ticket) : null;
        }
        // Another request is in flight to the lane, a person waits for it, or older turns do: look again in a moment.
        // Early, nothing in the way: look again at its slot (at most a second away, its ticket kept fresh).
        const nothingElse = !(busyUntil > at) && !yielding && !behind;
        await sleep(
          nothingElse && early ? Math.min(slot - at - floor, LANE_EARLY_LOOK_MS) : busyUntil > at ? Math.min(HOST_BUSY_POLL_MS, busyUntil - at) : HOST_BUSY_POLL_MS,
          signal,
        );
      }
    } finally {
      if (ticket !== null) await db.run('DELETE FROM crawl_host_waiters WHERE ticket = ?', [ticket]).catch(() => undefined);
    }
  }

  /**
   * v37 LANE + FIX-LANE (W3, D3): a 429 from a lane's host pauses the whole lane (see the top): its 429s in the window
   * kept, its pause (or the breaker) set by how many there are, the longer hold standing (an admin's hold stays the
   * admin's). The site's own row notes the answer (its failures untouched). Answers the pause as the request's
   * HostHeldError.
   */
  async function pauseLane(lane: LaneSpec, host: string, outcome: HostOutcome): Promise<HostHeldError> {
    const c = constants();
    const at = now();
    const asked = Math.max(0, outcome.kind === 'wait' ? (outcome.retryAfterMs ?? 0) : 0);
    const windowMs = c.get('LANE_429_WINDOW_MINUTES') * MINUTE_MS;
    const state = await db.tx(
      async (t) => {
        await t.run(
          `INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at) VALUES (?, 0, CAST(? AS timestamptz), CAST(? AS timestamptz))
           ON CONFLICT (host) DO NOTHING`,
          [lane.key, iso(at), iso(at)],
        );
        const row = await t.one<{ hold_until: string | null; hold_reason: CrawlHostHoldReason | null; throttle_hits: string[] | null }>(
          'SELECT hold_until, hold_reason, throttle_hits FROM crawl_hosts WHERE host = ? FOR UPDATE',
          [lane.key],
        );
        const since = at - windowMs;
        const k = (row?.throttle_hits ?? []).filter((hit) => Date.parse(hit) > since).length + 1;
        const breaker = k >= c.get('INGEST_HOST_BREAKER_FAILURES');
        const pauseMs = breaker
          ? Math.max(c.get('LANE_BREAKER_HOLD_MINUTES') * MINUTE_MS, asked)
          : Math.max(asked, Math.min(c.get('LANE_PAUSE_MAX_MINUTES') * MINUTE_MS, LANE_PAUSE_BASE_MS * 2 ** Math.min(k - 1, 30)));
        const before = row?.hold_until ? Date.parse(row.hold_until) : 0;
        const until = Math.max(at + pauseMs, before);
        const reason: CrawlHostHoldReason = before > at && row?.hold_reason === 'admin' ? 'admin' : breaker ? 'breaker' : 'retry_after';
        await t.run(
          `UPDATE crawl_hosts SET
             throttle_hits = ARRAY(SELECT hit FROM unnest(COALESCE(throttle_hits, CAST('{}' AS timestamptz[]))) AS hit
               WHERE hit > CAST(@since AS timestamptz) ORDER BY hit) || CAST(@now AS timestamptz),
             consecutive_failures = CAST(@k AS integer), last_status = 429, hold_until = CAST(@until AS timestamptz), hold_reason = @reason,
             updated_at = CAST(@now AS timestamptz)
           WHERE host = @lane`,
          { lane: lane.key, since: iso(since), now: iso(at), k: Math.min(k, 32000), until: iso(until), reason },
        );
        // v37 FIX-LANE (F6): the site's own row shows the 429 it got as its last answer.
        await t.run('UPDATE crawl_hosts SET last_status = 429, updated_at = CAST(? AS timestamptz) WHERE host = ?', [iso(at), host]);
        return { until, reason, k };
      },
      { label: 'lane 429' },
    );
    deps.log.warn(
      `[ingest] ${host} answered 429: every ${lane.name} site waits until ${iso(state.until)} ` +
        `(${state.k} in the last ${c.get('LANE_429_WINDOW_MINUTES')} minutes${state.reason === 'breaker' ? ', the breaker' : ''})`,
    );
    return new HostHeldError(lane.key, iso(state.until), state.reason, { label: lane.label, answered: outcome.status });
  }

  /** A request's outcome on one crawl_hosts row (a host's own). */
  async function recordOn(host: string, outcome: HostOutcome): Promise<void> {
    const at = now();
    const params = { host, status: outcome.status, now: iso(at) };
    if (outcome.kind === 'answered') {
      // A success closes the breaker and ends the failures in a row; nothing is written when nothing changes.
      await db.run(
        `UPDATE crawl_hosts SET consecutive_failures = 0, last_status = CAST(@status AS smallint), updated_at = CAST(@now AS timestamptz),
           hold_until = CASE WHEN hold_reason = 'breaker' THEN NULL ELSE hold_until END,
           hold_reason = CASE WHEN hold_reason = 'breaker' THEN NULL ELSE hold_reason END
         WHERE host = @host AND (consecutive_failures <> 0 OR last_status IS DISTINCT FROM CAST(@status AS smallint) OR hold_reason = 'breaker')`,
        params,
      );
    } else if (outcome.kind === 'failed') {
      const c = constants();
      await db.run(
        `UPDATE crawl_hosts SET consecutive_failures = LEAST(consecutive_failures + 1, 32000), last_status = CAST(@status AS smallint),
           updated_at = CAST(@now AS timestamptz),
           next_slot_at = GREATEST(next_slot_at, CAST(@now AS timestamptz)
             + random() * LEAST(CAST(@capMs AS double precision), CAST(@baseMs AS double precision) * power(2, LEAST(consecutive_failures, 30)))
             * interval '1 millisecond'),
           hold_until = CASE WHEN consecutive_failures + 1 >= @breaker THEN CAST(@breakerUntil AS timestamptz) ELSE hold_until END,
           hold_reason = CASE WHEN consecutive_failures + 1 >= @breaker THEN 'breaker' ELSE hold_reason END
         WHERE host = @host`,
        {
          ...params,
          capMs: c.get('INGEST_BACKOFF_MAX_HOURS') * 3_600_000,
          baseMs: HOST_BACKOFF_BASE_MS,
          breaker: c.get('INGEST_HOST_BREAKER_FAILURES'),
          breakerUntil: iso(at + c.get('INGEST_HOST_BREAKER_HOLD_MINUTES') * 60_000),
        },
      );
    } else if (outcome.kind === 'wait' && !outcome.hold) {
      await db.run(
        `UPDATE crawl_hosts SET next_slot_at = GREATEST(next_slot_at, CAST(@until AS timestamptz)), updated_at = CAST(@now AS timestamptz),
           last_status = CASE WHEN @status = 0 THEN last_status ELSE CAST(@status AS smallint) END
         WHERE host = @host`,
        { ...params, until: iso(at + outcome.waitMs) },
      );
    } else {
      const reason: CrawlHostHoldReason = outcome.kind === 'wait' ? 'retry_after' : 'bot_check';
      const until =
        outcome.kind === 'wait' ? at + outcome.waitMs : at + constants().get('INGEST_BOT_CHECK_HOLD_HOURS') * 3_600_000;
      if (outcome.kind === 'bot_check') deps.log.warn(`[ingest] ${host} refused TailorIT (HTTP ${outcome.status}): held until ${iso(until)}`);
      // The longer hold stands; a bot check names itself whatever held the host before.
      await db.run(
        `UPDATE crawl_hosts SET last_status = CAST(@status AS smallint), updated_at = CAST(@now AS timestamptz),
           hold_reason = CASE WHEN @reason = 'bot_check' OR hold_until IS NULL OR hold_until < CAST(@until AS timestamptz)
             THEN @reason ELSE hold_reason END,
           hold_until = GREATEST(COALESCE(hold_until, CAST(@until AS timestamptz)), CAST(@until AS timestamptz))
         WHERE host = @host`,
        { ...params, reason, until: iso(until) },
      );
    }
  }

  return {
    async takeTurn(host, { minIntervalMs, maxWaitMs, signal, busyMs, priority }) {
      const floor = Math.max(0, Math.round(minIntervalMs));
      // v30 FIX-A (REV-BEH's per-host note): a turn taken with busyMs holds the host until release (or until it passes),
      // and no turn is taken while another request holds it: one request in flight per host, for every process.
      const busy = Math.max(0, Math.round(busyMs ?? 0));
      const lane = laneOfHost(host);
      if (!lane) return takeOn(host, floor, { maxWaitMs, signal, busy });
      // v37 LANE (W1): a lane's host (v37 FIX-LANE: any registered lane's). Its own row first: an admin's hold or a bot
      // check, its failures' backoff, its Crawl-delay's wait (its row's next_slot_at). Made once, so its failures and
      // holds have a row.
      const started = now();
      let own = await db.one<{ hold_until: string | null; hold_reason: CrawlHostHoldReason | null; next_slot_at: string; min_interval_ms: number }>(
        'SELECT hold_until, hold_reason, next_slot_at, min_interval_ms FROM crawl_hosts WHERE host = ?',
        [host],
      );
      if (!own) {
        await db.run(
          `INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at) VALUES (?, ?, CAST(? AS timestamptz), CAST(? AS timestamptz))
           ON CONFLICT (host) DO NOTHING`,
          [host, constants().get('INGEST_HOST_MIN_INTERVAL_MS'), iso(started), iso(started)],
        );
        own = { hold_until: null, hold_reason: null, next_slot_at: iso(started), min_interval_ms: 0 };
      }
      if (own.hold_until && Date.parse(own.hold_until) > started) throw new HostHeldError(host, own.hold_until, own.hold_reason ?? 'admin');
      const notBefore = Date.parse(own.next_slot_at);
      if (notBefore - started > maxWaitMs) throw new HostHeldError(host, own.next_slot_at, 'backoff');
      if (notBefore > started) await sleep(notBefore - started, signal);
      // The lane's turn, its least gap the larger of the caller's and the lane's constant (WORKDAY_MIN_INTERVAL_MS for
      // Workday; read now: an admin's change applies at once; the lane row's own min_interval_ms stays 0); background
      // turns at its pace (D3).
      const floorOnLane = Math.max(floor, constants().get(lane.minIntervalKey));
      const slot = await takeLane(lane, floorOnLane, {
        maxWaitMs: Math.max(0, maxWaitMs - (now() - started)),
        signal,
        busy,
        interactive: priority === 'interactive',
      });
      // v37 FIX-LANE (F5, W2): a site whose Crawl-delay is longer than the lane's least gap waits it after this request
      // (its own row), never the lane's other sites.
      if (own.min_interval_ms > floorOnLane) {
        await db.run(
          `UPDATE crawl_hosts SET next_slot_at = GREATEST(next_slot_at, CAST(@slot AS timestamptz) + CAST(@gap AS integer) * interval '1 millisecond')
           WHERE host = @host`,
          { host, slot: iso(slot), gap: own.min_interval_ms },
        );
      }
      return waitForSlot(lane.key, slot, busy, signal);
    },

    async release(host) {
      await giveBack(laneKeyOf(host));
    },

    async record(host, outcome) {
      // v37 LANE (W3): a lane's 429 pauses the lane; its other answers are noted on the lane (v37 FIX-LANE, D3: they
      // never forget its 429s); its failures, waits and bot checks are the site's own.
      const lane = laneOfHost(host);
      if (lane) {
        if (outcome.status === 429) return pauseLane(lane, host, outcome);
        if (outcome.status > 0) {
          await db.run(
            `UPDATE crawl_hosts SET last_status = CAST(? AS smallint), updated_at = CAST(? AS timestamptz)
             WHERE host = ? AND last_status IS DISTINCT FROM CAST(? AS smallint)`,
            [outcome.status, iso(now()), lane.key, outcome.status],
          );
        }
      }
      await recordOn(host, outcome);
    },

    laneOf: laneKeyOf,
  };
}

/**
 * A host's hold now, if any (Admin › Hosts, the scheduler, the re-checks). v37 LANE: a Workday host's own hold or its
 * lane's, whichever ends later.
 */
export async function holdOf(db: DbQueries, host: string, at: string): Promise<{ until: string; reason: HostHoldReason } | null> {
  const row = await db.one<{ hold_until: string | null; hold_reason: CrawlHostHoldReason | null }>(
    `SELECT hold_until, hold_reason FROM crawl_hosts WHERE host IN (@host, @lane) AND hold_until > CAST(@at AS timestamptz)
     ORDER BY hold_until DESC LIMIT 1`,
    { host, lane: laneKeyOf(host), at },
  );
  return row?.hold_until ? { until: row.hold_until, reason: row.hold_reason ?? 'admin' } : null;
}

interface RobotsRow {
  host: string;
  fetched_at: string;
  status: StoredRobots['status'];
  http_status: number | null;
  rules: string | null;
  crawl_delay_s: number | null;
  content_signals: string | null;
  ai_input: boolean | null;
  sitemaps: string | null;
  failed_at?: string | null; // v37 LANE (migration 0062)
  failed_status?: number | null;
}

function toStoredRobots(row: RobotsRow): StoredRobots {
  let sitemaps: string[] = [];
  try {
    const parsed = JSON.parse(row.sitemaps ?? '[]') as unknown;
    if (Array.isArray(parsed)) sitemaps = parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    /* none */
  }
  return {
    host: row.host,
    fetchedAt: row.fetched_at,
    status: row.status,
    httpStatus: row.http_status,
    rules: row.rules,
    crawlDelaySeconds: row.crawl_delay_s,
    contentSignals: row.content_signals,
    aiInput: row.ai_input,
    sitemaps,
    failedAt: row.failed_at ?? null,
    failedStatus: row.failed_status ?? null,
  };
}

/** A host's robots.txt as kept (site_robots), or null. */
export async function storedRobots(db: DbQueries, host: string): Promise<StoredRobots | null> {
  const row = await db.one<RobotsRow>('SELECT * FROM site_robots WHERE host = ?', [host]);
  return row ? toStoredRobots(row) : null;
}

/**
 * The jobs and sources of a host follow its content signal (12 §1 test 5): a source is AI input when its kind is and
 * its host does not say `ai-input=no`; a job is when none of its sources says no. In one transaction; only rows that
 * change are written (a signal changes rarely; the jobs of a busy API host are many).
 */
export async function applyHostAiInput(deps: Pick<AppDeps, 'db' | 'now'>, host: string, allowed: boolean): Promise<number> {
  return deps.db.tx(
    async (t) => {
      const sources = await t.all<{ id: number }>(
        `UPDATE job_sources s SET ai_input = (k.ai_input AND @allowed), updated_at = CAST(@now AS timestamptz)
         FROM job_source_kinds k
         WHERE k.kind = s.kind AND s.host = @host AND s.ai_input IS DISTINCT FROM (k.ai_input AND @allowed) RETURNING s.id`,
        { host, allowed, now: nowIso(deps) },
      );
      if (sources.length === 0) return 0;
      const jobs = await t.run(
        `UPDATE jobs j SET ai_input = x.allowed
         FROM (SELECT l.job_id, bool_and(s.ai_input) AS allowed FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
               WHERE l.job_id IN (SELECT l2.job_id FROM job_source_links l2 JOIN job_sources s2 ON s2.id = l2.source_id WHERE s2.host = @host)
               GROUP BY l.job_id) x
         WHERE j.id = x.job_id AND j.ai_input IS DISTINCT FROM x.allowed`,
        { host },
      );
      return sources.length + jobs.changes;
    },
    { label: 'host content signal' },
  );
}

/**
 * site_robots for every process (robots.ts RobotsStore): a file read is kept with its extras, its Crawl-delay paces
 * the host (crawl_hosts.min_interval_ms: at least INGEST_HOST_MIN_INTERVAL_MS), and a changed ai-input signal reaches
 * the host's sources and jobs (applyHostAiInput).
 */
export function createRobotsStore(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): RobotsStore {
  const db = deps.db;
  return {
    read: (host) => storedRobots(db, host),
    async write(robots) {
      const before = await db.one<{ ai_input: boolean | null }>('SELECT ai_input FROM site_robots WHERE host = ?', [robots.host]);
      // v37 LANE (SP v37 PLAN W7): a read that failed (unreachable) is remembered (failed_at, failed_status) without
      // wiping the file's last good rules while they are at most ROBOTS_STALE_USE_MS old: they keep applying meanwhile
      // (robots.ts keptRobotsUse). A good read clears the failure.
      const keepsGood = `(EXCLUDED.status = 'unreachable' AND r.status <> 'unreachable' AND r.fetched_at >= CAST(@goodSince AS timestamptz))`;
      const column = (name: string) => `${name} = CASE WHEN ${keepsGood} THEN r.${name} ELSE EXCLUDED.${name} END`;
      await db.run(
        `INSERT INTO site_robots AS r (host, fetched_at, status, http_status, rules, crawl_delay_s, content_signals, ai_input, sitemaps, failed_at, failed_status)
         VALUES (@host, CAST(@fetchedAt AS timestamptz), @status, @httpStatus, @rules, @crawlDelay, @signals, @aiInput, CAST(@sitemaps AS jsonb),
           CASE WHEN @status = 'unreachable' THEN CAST(@fetchedAt AS timestamptz) END,
           CASE WHEN @status = 'unreachable' THEN CAST(@httpStatus AS smallint) END)
         ON CONFLICT (host) DO UPDATE SET
           ${['fetched_at', 'status', 'http_status', 'rules', 'crawl_delay_s', 'content_signals', 'ai_input', 'sitemaps'].map(column).join(',\n           ')},
           failed_at = EXCLUDED.failed_at, failed_status = EXCLUDED.failed_status`,
        {
          host: robots.host,
          fetchedAt: robots.fetchedAt,
          status: robots.status,
          httpStatus: robots.httpStatus,
          rules: robots.rules,
          crawlDelay: robots.crawlDelaySeconds,
          signals: robots.contentSignals,
          aiInput: robots.aiInput,
          sitemaps: JSON.stringify(robots.sitemaps),
          goodSince: new Date(Date.parse(robots.fetchedAt) - ROBOTS_STALE_USE_MS).toISOString(),
        },
      );
      if (robots.status !== 'unreachable') {
        const floor = constantsOf(deps).get('INGEST_HOST_MIN_INTERVAL_MS');
        const interval = Math.max(floor, (robots.crawlDelaySeconds ?? 0) * 1000);
        await db.run(
          `INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at) VALUES (?, ?, CAST(? AS timestamptz), CAST(? AS timestamptz))
           ON CONFLICT (host) DO UPDATE SET min_interval_ms = EXCLUDED.min_interval_ms, updated_at = EXCLUDED.updated_at
           WHERE crawl_hosts.min_interval_ms <> EXCLUDED.min_interval_ms`,
          [robots.host, interval, robots.fetchedAt, robots.fetchedAt],
        );
        // A signal that changed (or a first read that says no) reaches the host's sources and jobs.
        const allowed = robots.aiInput !== false;
        const was = before ? before.ai_input !== false : true;
        if (allowed !== was) await applyHostAiInput(deps, robots.host, allowed);
      }
    },
  };
}

// ------------------------------------------------------------------------------------------------- Admin › Hosts

/** A host as the admin pages write it: a name, lower case. */
export const HostIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/, 'That is not a host name.');

interface HostRow {
  host: string;
  min_interval_ms: number;
  next_slot_at: string;
  hold_until: string | null;
  hold_reason: CrawlHostHoldReason | null;
  consecutive_failures: number;
  last_status: number | null;
  updated_at: string;
  sources: number;
  failing_sources: number;
  opted_out: boolean;
  /** v37 FIX-LANE (D3): a lane's 429s in its window, and its background turns' next slot. */
  throttle_hits: string[] | null;
  paced_slot_at: string | null;
}

/**
 * v37 LANE (W10): the sources a row paces: a host's own; a lane's every source of its platform (its kinds, or a host on
 * the lane: v37 FIX-LANE, any registered lane). Built at each use (the registry is read then).
 */
function laneSourcesSql(lane: LaneSpec): string {
  const kinds = lane.kinds.length > 0 ? `s.kind IN (${lane.kinds.map(sqlText).join(', ')}) OR ` : '';
  return `(${kinds}COALESCE(s.host ~ ${sqlText(lane.hosts)}, false))`;
}
function sourcesOfRowSql(): string {
  const lanes = registeredLanes();
  if (lanes.length === 0) return 's.host = h.host';
  return `CASE ${lanes.map((lane) => `WHEN h.host = ${sqlText(lane.key)} THEN ${laneSourcesSql(lane)}`).join(' ')} ELSE s.host = h.host END`;
}

function hostColumnsSql(): string {
  const sourcesOfRow = sourcesOfRowSql();
  return `h.host, h.min_interval_ms, h.next_slot_at, h.hold_until, h.hold_reason, h.consecutive_failures, h.last_status,
  h.updated_at, h.throttle_hits, h.paced_slot_at,
  (SELECT count(*) FROM job_sources s WHERE ${sourcesOfRow}) AS sources,
  (SELECT count(*) FROM job_sources s WHERE ${sourcesOfRow} AND (s.consecutive_failures > 0 OR s.tier = 'failing')) AS failing_sources,
  EXISTS (SELECT 1 FROM crawl_opt_outs o WHERE h.host = o.domain OR h.host LIKE '%.' || o.domain) AS opted_out`;
}

type ConstantsDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** v37 FIX-LANE (D3, F6): what every row of a page needs of a lane: its pace and its hold now. */
interface LaneContext {
  lane: LaneSpec;
  at: string;
  rules: LanePaceRules;
  /** The lane's pace now (its gap, when it eases, its 429s in the window). */
  pace: LanePace;
  /** The lane's pause or hold now, if any. */
  hold: { until: string; reason: CrawlHostHoldReason } | null;
  /** The 429s in the window that hold the whole lane, and for how long (Admin › Hosts says when its breaker holds it). */
  breakerAfter: number;
  breakerMinutes: number;
  windowMinutes: number;
}

function laneContextOf(deps: ConstantsDeps, lane: LaneSpec, row: HostRow | null, at: string): LaneContext {
  const rules = lanePaceRules(deps, lane);
  const c = constantsOf(deps);
  const held = row?.hold_until && Date.parse(row.hold_until) > Date.parse(at) ? { until: row.hold_until, reason: row.hold_reason ?? 'admin' } : null;
  return {
    lane,
    at,
    rules,
    pace: lanePaceOf(row?.throttle_hits, Date.parse(at), rules),
    hold: held,
    breakerAfter: c.get('INGEST_HOST_BREAKER_FAILURES'),
    breakerMinutes: c.get('LANE_BREAKER_HOLD_MINUTES'),
    windowMinutes: c.get('LANE_429_WINDOW_MINUTES'),
  };
}

/** The later of ISO times (nulls skipped). */
function latest(...times: Array<string | null | undefined>): string {
  const known = times.filter((time): time is string => Boolean(time));
  return known.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** v37 FIX-LANE: every lane's row and its context, for one page (laneRow, laneContextOf). */
interface LaneView {
  row: HostRow | null;
  context: LaneContext;
}

/**
 * A crawl_hosts row for Admin › Hosts. v37 LANE (W10): a lane is named (its label, "Workday (all sites)", and its
 * platform, "Workday"); a lane's site names its lane and paces at the lane's gap or its own Crawl-delay, whichever is
 * longer.
 * v37 FIX-LANE (D3, F6, the ux review's M3): a lane's gap is its pace now (wider after 429s), with when it eases back,
 * its failures are its 429s in the window (LANE_429_WINDOW_MINUTES), and it says when its breaker holds the whole lane;
 * a held row's next free slot is the hold's end; a lane's site carries the lane's pause or hold.
 */
function toHostRow(row: HostRow, lanes: ReadonlyMap<string, LaneView>, at: string): AdminHostRow {
  const now = Date.parse(at);
  const held = row.hold_until !== null && Date.parse(row.hold_until) > now;
  const own = lanes.get(row.host)?.context ?? null;
  const site = own ? null : laneOfHost(row.host);
  const of = site ? (lanes.get(site.key)?.context ?? null) : null;
  const nextSlotAt = latest(row.next_slot_at, own ? row.paced_slot_at : null, held ? row.hold_until : null);
  return {
    host: row.host,
    minIntervalMs: own ? own.pace.gapMs : of ? Math.max(row.min_interval_ms, of.pace.gapMs) : row.min_interval_ms,
    nextSlotAt: of?.hold ? latest(nextSlotAt, of.hold.until) : nextSlotAt,
    holdUntil: held ? row.hold_until : null,
    holdReason: held ? row.hold_reason : null,
    consecutiveFailures: own ? own.pace.recent : row.consecutive_failures,
    lastStatus: row.last_status,
    updatedAt: row.updated_at,
    sources: Number(row.sources),
    failingSources: Number(row.failing_sources),
    optedOut: Boolean(row.opted_out),
    ...(own
      ? {
          label: own.lane.label,
          platform: own.lane.name,
          easesAt: own.pace.easesAt,
          leastGapMs: own.rules.minMs,
          windowMinutes: own.windowMinutes,
          breakerAfter: own.breakerAfter,
          breakerMinutes: own.breakerMinutes,
        }
      : {}),
    ...(of ? { lane: of.lane.label, platform: of.lane.name, laneHoldUntil: of.hold?.until ?? null, laneHoldReason: of.hold?.reason ?? null } : {}),
  };
}

/**
 * v37 LANE (W10): a lane's row: as kept, or (before its first request, while its sources exist) as it starts: never
 * held, no answer yet. Null while neither.
 */
async function laneRow(deps: Pick<AppDeps, 'db'>, lane: LaneSpec, at: string): Promise<HostRow | null> {
  const row = await deps.db.one<HostRow>(`SELECT ${hostColumnsSql()} FROM crawl_hosts h WHERE h.host = ?`, [lane.key]);
  if (row) return row;
  const counts = await deps.db.one<{ sources: number; failing_sources: number }>(
    `SELECT count(*) AS sources, count(*) FILTER (WHERE s.consecutive_failures > 0 OR s.tier = 'failing') AS failing_sources
     FROM job_sources s WHERE ${laneSourcesSql(lane)}`,
  );
  if (!counts || Number(counts.sources) === 0) return null;
  return {
    host: lane.key,
    min_interval_ms: 0,
    next_slot_at: at,
    hold_until: null,
    hold_reason: null,
    consecutive_failures: 0,
    last_status: null,
    updated_at: at,
    sources: Number(counts.sources),
    failing_sources: Number(counts.failing_sources),
    opted_out: false,
    throttle_hits: null,
    paced_slot_at: null,
  };
}

/** v37 FIX-LANE: every registered lane's row and context now (a lane with neither a row nor sources has row null). */
async function laneViews(deps: ConstantsDeps, at: string): Promise<Map<string, LaneView>> {
  const views = new Map<string, LaneView>();
  for (const lane of registeredLanes()) {
    const row = await laneRow(deps, lane, at);
    views.set(lane.key, { row, context: laneContextOf(deps, lane, row, at) });
  }
  return views;
}

/**
 * v37 LANE: whether a lane's row is one the list's filters keep (its key or its name searched, held, failing: v37
 * FIX-LANE, a 429 within its window).
 */
function laneMatches(row: HostRow, query: AdminHostsQuery, lane: LaneContext): boolean {
  const q = query.q?.trim().toLowerCase();
  if (q && !lane.lane.key.includes(q) && !lane.lane.label.toLowerCase().includes(q)) return false;
  if (query.held && !(row.hold_until !== null && Date.parse(row.hold_until) > Date.parse(lane.at))) return false;
  if (query.failing && lane.pace.recent <= 0) return false;
  return true;
}

function toSiteRobots(robots: StoredRobots): SiteRobots {
  return {
    host: robots.host,
    fetchedAt: robots.fetchedAt,
    status: robots.status,
    httpStatus: robots.httpStatus,
    crawlDelaySeconds: robots.crawlDelaySeconds,
    contentSignals: robots.contentSignals,
    aiInput: robots.aiInput,
    sitemaps: robots.sitemaps,
    rules: robots.rules,
  };
}

const STALE_CURSOR = 'This list changed. Load it again from the top.';

/**
 * Admin › Hosts: the hosts by name, filtered (q, held, failing), counted, a page at a time. v37 LANE (W10): the lanes'
 * rows ("Workday (all sites)"; v37 FIX-LANE: every registered lane's, in the registry's order) come first on the first
 * page when the filters keep them (counted in the total).
 */
export async function listHosts(deps: ConstantsDeps, query: AdminHostsQuery) {
  const at = nowIso(deps);
  const lanes = await laneViews(deps, at);
  const shown = [...lanes.values()].filter((view): view is LaneView & { row: HostRow } => view.row !== null && laneMatches(view.row, query, view.context));
  const where = new Where();
  const keys = registeredLanes().map((lane) => sqlText(lane.key));
  if (keys.length > 0) where.add(`h.host NOT IN (${keys.join(', ')})`);
  if (query.q) where.add("h.host ILIKE @q ESCAPE '\\'", { q: likeText(query.q.toLowerCase()) });
  if (query.held) where.add('h.hold_until > CAST(@at AS timestamptz)', { at });
  if (query.failing) where.add('h.consecutive_failures > 0');
  const hosts =
    (await deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM crawl_hosts h ${where.sql()}`, where.params as SqlParams))?.n ?? 0;
  const conditions = where.sql();
  let sql = `SELECT ${hostColumnsSql()} FROM crawl_hosts h ${conditions}`;
  // The lanes' rows take their places of the first page (one at least is left for the hosts).
  const first = shown.length > 0 && !query.cursor;
  const take = Math.max(1, query.limit - (first ? shown.length : 0));
  const params: Record<string, unknown> = { ...where.params, limit: take + 1 };
  if (query.cursor) {
    const { c } = decodeCursor(query.cursor, STALE_CURSOR);
    if (typeof c !== 'string') throw validationFailed(STALE_CURSOR);
    sql += `${conditions ? ' AND' : ' WHERE'} h.host > @after`;
    params.after = c;
  }
  const rows = await deps.db.all<HostRow>(`${sql} ORDER BY h.host LIMIT @limit`, params as SqlParams);
  const page = rows.slice(0, take).map((row) => toHostRow(row, lanes, at));
  const items = first ? [...shown.map((view) => toHostRow(view.row, lanes, at)), ...page] : page;
  return {
    items,
    total: Number(hosts) + shown.length,
    ...(rows.length > take ? { nextCursor: encodeCursor({ c: page[page.length - 1]!.host }) } : {}),
  };
}

/** One host with its robots.txt (Admin › Hosts › a host), or null. v37 LANE: a lane has no robots.txt of its own. */
export async function adminHost(deps: ConstantsDeps, host: string): Promise<AdminHost | null> {
  const at = nowIso(deps);
  const lanes = await laneViews(deps, at);
  const lane = lanes.get(host);
  if (lane) return lane.row ? { ...toHostRow(lane.row, lanes, at), robots: null } : null;
  const row = await deps.db.one<HostRow>(`SELECT ${hostColumnsSql()} FROM crawl_hosts h WHERE h.host = ?`, [host]);
  if (!row) return null;
  const robots = await storedRobots(deps.db, host);
  return { ...toHostRow(row, lanes, at), robots: robots ? toSiteRobots(robots) : null };
}

/**
 * An admin's hold of a host for some hours (reason `admin`), or the release of any hold (its failures forgiven).
 * v37 FIX-LANE (D2, the ux review's M4): a lane's release ends its pause or hold but keeps its 429s in the window (only
 * time forgets them), so its next 429 still pauses longer and its gap stays as wide as they made it; the web asks first
 * when the platform itself asked TailorIT to wait.
 */
export async function holdHost(
  deps: ConstantsDeps,
  host: string,
  body: z.infer<typeof AdminHostHoldBodySchema>,
): Promise<AdminHost | null> {
  const at = deps.now().getTime();
  const isLane = laneByKey(host) !== null;
  if (body.action === 'hold') {
    // v37 LANE (W10): a lane is held like a host (every one of its sites waits); its own gap stays 0 (its constant's).
    await deps.db.run(
      `INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, hold_until, hold_reason, updated_at)
       VALUES (@host, @interval, CAST(@now AS timestamptz), CAST(@until AS timestamptz), 'admin', CAST(@now AS timestamptz))
       ON CONFLICT (host) DO UPDATE SET hold_until = EXCLUDED.hold_until, hold_reason = 'admin', updated_at = EXCLUDED.updated_at`,
      {
        host,
        interval: isLane ? 0 : constantsOf(deps).get('INGEST_HOST_MIN_INTERVAL_MS'),
        now: new Date(at).toISOString(),
        until: new Date(at + body.hours * 3_600_000).toISOString(),
      },
    );
  } else {
    await deps.db.run(
      `UPDATE crawl_hosts SET hold_until = NULL, hold_reason = NULL,
         consecutive_failures = CASE WHEN CAST(@lane AS boolean) THEN consecutive_failures ELSE 0 END,
         next_slot_at = LEAST(next_slot_at, CAST(@now AS timestamptz)),
         paced_slot_at = LEAST(paced_slot_at, CAST(@now AS timestamptz)), updated_at = CAST(@now AS timestamptz)
       WHERE host = @host`,
      { host, lane: isLane, now: new Date(at).toISOString() },
    );
  }
  return adminHost(deps, host);
}

/** Mounted at /api/admin/hosts: the list, one host, and an admin's hold or release (POST /:host/hold). */
export function createHostsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'host',
    id: HostIdSchema,
    list: { query: AdminHostsQuerySchema, run: (_deps, query) => listHosts(deps, query) },
    get: (_deps, host) => adminHost(deps, host),
    routes(router, { handle, audit }) {
      router.post(
        '/:id/hold',
        handle(async (req, actor) => {
          const host = HostIdSchema.safeParse(req.params.id ?? '');
          if (!host.success) throw validationFailed('That is not a host name.');
          const body = AdminHostHoldBodySchema.safeParse(req.body ?? {});
          if (!body.success) throw validationFailed('Hold a host for 1 to 720 hours, or release it.');
          const held = await holdHost(deps, host.data, body.data);
          if (!held) throw notFound('That host');
          await audit({ action: body.data.action, ids: [host.data], actor, change: body.data });
          return held;
        }),
      );
    },
  });
}
