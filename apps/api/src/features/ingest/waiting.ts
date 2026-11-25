import type { JobSourceWaiting } from '@tailorit/shared';
import { newReadsAllowed } from '../../core/http/identity';
import { nowIso, type AppDeps } from '../../core/context';
import { ADAPTERS } from './adapters/index';
import { missingOutsideKey } from './adapters/define';
import { careerPagesOn } from './career/switch';
import { optedOutSources } from './opt-out-gate';
import { runsPaused } from './pause-state';
import { NEW_READ_KIND_OF, runnableKinds } from './scheduler';
import { laneKeyOf } from './hosts'; // v37 LANE
import { SCHEDULED_KINDS, type SourceKind } from './types';

// v35 ADMIN (PLAN H7): why a switched-on source does not run now, for Admin › Sources' rows and sheet and an import
// run's Sources found. The due queue (scheduler.ts dueSources) takes a source when it is enabled, due, of a kind the
// worker may run, allowed by its recorded terms and its host's robots.txt, not paused, not of a company that opted out,
// on a host that is not held, while ingest is on and no admin paused every run. A source the worker runs (a scheduled
// kind) that is on but misses one of these is `waiting`, with the first reason that holds in this order:
//   ingest_off         INGEST_ENABLED is off on this server (the worker reads no source);
//   runs_paused        an admin paused every run (Admin › Runs);
//   paused             an admin paused this source;
//   opted_out          its company asked TailorIT not to read its jobs;
//   not_built          no adapter reads its kind on this server;
//   identity           a new kind of read (a Workday career site, the feeds, career sites) waits for BOT_USER_AGENT;
//   outside_key        a feed that needs its API key (USAJOBS, Himalayas) has none;
//   career_pages_off   a career site waits for "Read career pages" (SITE_READER_CAREER_PAGES);
//   terms              its terms are not recorded as allowing automated access;
//   robots_pending     its host's robots.txt has not been read for it yet (the worker reads it at its next look);
//   robots_disallowed  robots.txt disallows the paths it reads (read again daily);
//   robots_unreadable  robots.txt could not be read (tried again daily);
//   host_held          its host is held (a Retry-After, the breaker, a bot check, an admin), until when.
// Each clears by itself (a daily robots.txt verdict, a hold's end; the worker looks every DUE_TICK_MS) or by the admin's
// own change, and the source then runs at once on its schedule: next_run_at stays in the past while it waits (a source
// turned on is due now: sources.ts enableSources, the one writer of "on" since v3.6), so no Run now is needed. A source
// that is off never waits here: v3.6's "Waiting for an admin" (sources.ts isWaitingForAdmin) is a source discovery or an
// import found that no admin turned on yet.

/** A source as its waiting reason reads it (a SourceRecord's fields, or a listed row's). */
export interface WaitingSource {
  id: number;
  kind: SourceKind | string;
  enabled: boolean;
  host?: string | null;
  termsStatus?: string;
  robotsStatus?: string;
  pausedAt?: string | null;
}

type WaitingDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** What the reasons of a page of sources read once: the switches, the holds of their hosts, their opt-outs. */
export interface WaitingContext {
  ingestOn: boolean;
  runsPaused: boolean;
  runnable: ReadonlySet<string>;
  identity: boolean;
  careerPages: boolean;
  /** Each held host's hold end (ISO). */
  held: ReadonlyMap<string, string>;
  optedOut: ReadonlySet<number>;
  deps: Pick<AppDeps, 'config'>;
}

/** Reads what the reasons of these sources need (one statement for their hosts' holds, one for their opt-outs). */
export async function waitingContextOf(deps: WaitingDeps, sources: readonly WaitingSource[]): Promise<WaitingContext> {
  const on = sources.filter((source) => source.enabled && SCHEDULED_KINDS.includes(source.kind as SourceKind));
  // v37 LANE (W1): a Workday source's host is held while its own row or the Workday lane is.
  const hosts = [...new Set(on.flatMap((source) => (source.host ? [source.host, laneKeyOf(source.host)] : [])))];
  const held = new Map<string, string>();
  if (hosts.length > 0) {
    const rows = await deps.db.all<{ host: string; hold_until: string }>(
      `SELECT host, hold_until FROM crawl_hosts WHERE host = ANY(string_to_array(?, ',')) AND hold_until > CAST(? AS timestamptz)`,
      [hosts.join(','), nowIso(deps)],
    );
    for (const row of rows) held.set(row.host, row.hold_until);
  }
  return {
    ingestOn: deps.config.ingest.enabled,
    runsPaused: on.length > 0 ? await runsPaused(deps) : false,
    runnable: new Set(runnableKinds(deps)),
    identity: newReadsAllowed(deps),
    careerPages: careerPagesOn(deps),
    held,
    optedOut: on.length > 0 ? await optedOutSources(deps.db, on.map((source) => source.id)) : new Set(),
    deps,
  };
}

/** Why the kind cannot run on this server now (it is not in runnableKinds). */
function kindReason(kind: string, context: WaitingContext): JobSourceWaiting['reason'] {
  const adapter = ADAPTERS[kind as SourceKind];
  if (!adapter) return 'not_built';
  if (NEW_READ_KIND_OF[kind] && !context.identity) return 'identity';
  if (missingOutsideKey(adapter, context.deps)) return 'outside_key';
  if (kind === 'career_site' && !context.careerPages) return 'career_pages_off';
  return 'not_built';
}

/** Why this switched-on source does not run now (see the top), or null: it is off, runs by hand, or can run. */
export function waitingOf(source: WaitingSource, context: WaitingContext): JobSourceWaiting | null {
  if (!source.enabled || !SCHEDULED_KINDS.includes(source.kind as SourceKind)) return null;
  if (!context.ingestOn) return { reason: 'ingest_off' };
  if (context.runsPaused) return { reason: 'runs_paused' };
  if (source.pausedAt) return { reason: 'paused' };
  if (context.optedOut.has(source.id)) return { reason: 'opted_out' };
  if (!context.runnable.has(source.kind)) return { reason: kindReason(source.kind, context) };
  if (!['allowed', 'allowed_with_conditions'].includes(source.termsStatus ?? 'unchecked')) return { reason: 'terms' };
  const robots = source.robotsStatus ?? 'unchecked';
  if (robots === 'unchecked') return { reason: 'robots_pending' };
  if (robots === 'disallowed') return { reason: 'robots_disallowed' };
  if (robots === 'error') return { reason: 'robots_unreadable' };
  const holds = source.host ? [context.held.get(source.host), context.held.get(laneKeyOf(source.host))] : [];
  const holdUntil = holds.filter((until): until is string => Boolean(until)).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (holdUntil) return { reason: 'host_held', until: holdUntil };
  return null;
}

/** Each of these sources' waiting reason (by id; a source that is not waiting has none). */
export async function waitingOfSources(deps: WaitingDeps, sources: readonly WaitingSource[]): Promise<Map<number, JobSourceWaiting>> {
  const context = await waitingContextOf(deps, sources);
  const out = new Map<number, JobSourceWaiting>();
  for (const source of sources) {
    const waiting = waitingOf(source, context);
    if (waiting) out.set(source.id, waiting);
  }
  return out;
}
