import type { Router } from 'express';
import { z } from 'zod';
import {
  AdminHostHoldBodySchema,
  AdminHostsQuerySchema,
  type AdminHost,
  type AdminHostRow,
  type AdminHostsQuery,
  type CrawlHostHoldReason,
  type SiteRobots,
} from '@tailorit/shared';
import { adminRouter, decodeCursor, encodeCursor, likeText, Where } from '../../core/admin/index';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries, SqlParams } from '../../core/db/types';
import { notFound, validationFailed } from '../../core/http/errors';
import { HostHeldError, sleepFor, type HostGate, type HostHoldReason } from './http';
import type { RobotsStore, StoredRobots } from './robots';

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

  return {
    async takeTurn(host, { minIntervalMs, maxWaitMs, signal, busyMs }) {
      const floor = Math.max(0, Math.round(minIntervalMs));
      // v30 FIX-A (REV-BEH's per-host note): a turn taken with busyMs holds the host until release (or until it passes),
      // and no turn is taken while another request holds it: one request in flight per host, for every process.
      const busy = Math.max(0, Math.round(busyMs ?? 0));
      const started = now();
      for (let tries = 0; ; tries += 1) {
        const at = now();
        // Takes the next slot unless the host is held, busy, or its slot is too far ahead: one statement, so two readers
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
          { host, floor, busy, now: iso(at), latest: iso(at + maxWaitMs) },
        );
        if (taken) {
          await sleep(Date.parse(taken.slot) - now(), signal);
          return;
        }
        const row = await db.one<{ hold_until: string | null; hold_reason: CrawlHostHoldReason | null; next_slot_at: string; busy_until: string | null }>(
          'SELECT hold_until, hold_reason, next_slot_at, busy_until FROM crawl_hosts WHERE host = ?',
          [host],
        );
        if (row?.hold_until && Date.parse(row.hold_until) > at) throw new HostHeldError(host, row.hold_until, row.hold_reason ?? 'admin');
        const busyUntil = row?.busy_until ? Date.parse(row.busy_until) : 0;
        const slotOk = row ? Date.parse(row.next_slot_at) <= at + maxWaitMs : true;
        if (busyUntil > at && slotOk && tries < HOST_BUSY_TRIES && now() - started < maxWaitMs) {
          // Another request is in flight to the host: wait a moment for its answer.
          await sleep(Math.min(HOST_BUSY_POLL_MS, busyUntil - at), signal);
          continue;
        }
        throw new HostHeldError(host, busyUntil > at ? iso(busyUntil) : (row?.next_slot_at ?? iso(at)), 'backoff');
      }
    },

    async release(host) {
      await db.run('UPDATE crawl_hosts SET busy_until = NULL WHERE host = ? AND busy_until IS NOT NULL', [host]);
    },

    async record(host, outcome) {
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
    },
  };
}

/** A host's hold now, if any (Admin › Hosts, the scheduler, the re-checks). */
export async function holdOf(
  db: DbQueries,
  host: string,
  at: string,
): Promise<{ until: string; reason: HostHoldReason } | null> {
  const row = await db.one<{ hold_until: string | null; hold_reason: CrawlHostHoldReason | null }>(
    'SELECT hold_until, hold_reason FROM crawl_hosts WHERE host = ? AND hold_until > CAST(? AS timestamptz)',
    [host, at],
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
      await db.run(
        `INSERT INTO site_robots(host, fetched_at, status, http_status, rules, crawl_delay_s, content_signals, ai_input, sitemaps)
         VALUES (@host, CAST(@fetchedAt AS timestamptz), @status, @httpStatus, @rules, @crawlDelay, @signals, @aiInput, CAST(@sitemaps AS jsonb))
         ON CONFLICT (host) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, status = EXCLUDED.status, http_status = EXCLUDED.http_status,
           rules = EXCLUDED.rules, crawl_delay_s = EXCLUDED.crawl_delay_s, content_signals = EXCLUDED.content_signals,
           ai_input = EXCLUDED.ai_input, sitemaps = EXCLUDED.sitemaps`,
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
}

const HOST_COLUMNS = `h.host, h.min_interval_ms, h.next_slot_at, h.hold_until, h.hold_reason, h.consecutive_failures, h.last_status,
  h.updated_at,
  (SELECT count(*) FROM job_sources s WHERE s.host = h.host) AS sources,
  (SELECT count(*) FROM job_sources s WHERE s.host = h.host AND (s.consecutive_failures > 0 OR s.tier = 'failing')) AS failing_sources,
  EXISTS (SELECT 1 FROM crawl_opt_outs o WHERE h.host = o.domain OR h.host LIKE '%.' || o.domain) AS opted_out`;

function toHostRow(row: HostRow, at: string): AdminHostRow {
  const held = row.hold_until !== null && Date.parse(row.hold_until) > Date.parse(at);
  return {
    host: row.host,
    minIntervalMs: row.min_interval_ms,
    nextSlotAt: row.next_slot_at,
    holdUntil: held ? row.hold_until : null,
    holdReason: held ? row.hold_reason : null,
    consecutiveFailures: row.consecutive_failures,
    lastStatus: row.last_status,
    updatedAt: row.updated_at,
    sources: row.sources,
    failingSources: row.failing_sources,
    optedOut: Boolean(row.opted_out),
  };
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

/** Admin › Hosts: the hosts by name, filtered (q, held, failing), counted, a page at a time. */
export async function listHosts(deps: Pick<AppDeps, 'db' | 'now'>, query: AdminHostsQuery) {
  const at = nowIso(deps);
  const where = new Where();
  if (query.q) where.add("h.host ILIKE @q ESCAPE '\\'", { q: likeText(query.q.toLowerCase()) });
  if (query.held) where.add('h.hold_until > CAST(@at AS timestamptz)', { at });
  if (query.failing) where.add('h.consecutive_failures > 0');
  const total =
    (await deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM crawl_hosts h ${where.sql()}`, where.params as SqlParams))?.n ?? 0;
  const conditions = where.sql();
  let sql = `SELECT ${HOST_COLUMNS} FROM crawl_hosts h ${conditions}`;
  const params: Record<string, unknown> = { ...where.params, limit: query.limit + 1 };
  if (query.cursor) {
    const { c } = decodeCursor(query.cursor, STALE_CURSOR);
    if (typeof c !== 'string') throw validationFailed(STALE_CURSOR);
    sql += `${conditions ? ' AND' : ' WHERE'} h.host > @after`;
    params.after = c;
  }
  const rows = await deps.db.all<HostRow>(`${sql} ORDER BY h.host LIMIT @limit`, params as SqlParams);
  const items = rows.slice(0, query.limit).map((row) => toHostRow(row, at));
  return {
    items,
    total,
    ...(rows.length > query.limit ? { nextCursor: encodeCursor({ c: items[items.length - 1]!.host }) } : {}),
  };
}

/** One host with its robots.txt (Admin › Hosts › a host), or null. */
export async function adminHost(deps: Pick<AppDeps, 'db' | 'now'>, host: string): Promise<AdminHost | null> {
  const row = await deps.db.one<HostRow>(`SELECT ${HOST_COLUMNS} FROM crawl_hosts h WHERE h.host = ?`, [host]);
  if (!row) return null;
  const robots = await storedRobots(deps.db, host);
  return { ...toHostRow(row, nowIso(deps)), robots: robots ? toSiteRobots(robots) : null };
}

/** An admin's hold of a host for some hours (reason `admin`), or the release of any hold (its failures forgiven). */
export async function holdHost(
  deps: Pick<AppDeps, 'db' | 'now'>,
  host: string,
  body: z.infer<typeof AdminHostHoldBodySchema>,
): Promise<AdminHost | null> {
  const at = deps.now().getTime();
  if (body.action === 'hold') {
    await deps.db.run(
      `INSERT INTO crawl_hosts(host, next_slot_at, hold_until, hold_reason, updated_at)
       VALUES (@host, CAST(@now AS timestamptz), CAST(@until AS timestamptz), 'admin', CAST(@now AS timestamptz))
       ON CONFLICT (host) DO UPDATE SET hold_until = EXCLUDED.hold_until, hold_reason = 'admin', updated_at = EXCLUDED.updated_at`,
      { host, now: new Date(at).toISOString(), until: new Date(at + body.hours * 3_600_000).toISOString() },
    );
  } else {
    await deps.db.run(
      `UPDATE crawl_hosts SET hold_until = NULL, hold_reason = NULL, consecutive_failures = 0,
         next_slot_at = LEAST(next_slot_at, CAST(@now AS timestamptz)), updated_at = CAST(@now AS timestamptz) WHERE host = @host`,
      { host, now: new Date(at).toISOString() },
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
