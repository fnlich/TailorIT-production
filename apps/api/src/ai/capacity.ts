import { dayKeyOf, nextResetAt, MINUTE_MS, HOUR_MS, type AiCapacity, type AiCapacityReading, type AiCapacitySource } from '@tailorit/shared';
import { dayKeyAt } from '../core/constants/day';
import { constantsOf } from '../core/constants/service';
import type { AppDeps } from '../core/context';
import type { RateLimitInfo } from './provider/events';
import { hourOf, microsOf } from './usage';

// v2.0: the server seat's usage and the capacity block (docs/design/v2.0/03-ai-usage.md, "The capacity block"; A10).
// The readings come from what the Claude CLI itself reports, in this order of trust:
//   1. its `rate_limit_event` (claudeCli.ts passes each one here): `utilization` (a fraction; above 1 a percent), a
//      `rejected` status reading 1;
//   2. its limit texts ("You've used 85% of your session limit", "You've hit your weekly limit"), read only from the
//      channels the CLI writes (provider/classify.ts cliChannelParts), never from a successful answer;
//   3. a fallback ledger of TailorIT's own metered spend (ai_usage_hourly) over SERVER_AI_CAPACITY_WINDOW_HOURS against
//      SERVER_AI_CAPACITY_USD_PER_WINDOW, only while that constant is set (UNLIMITED: no fallback).
// One reading per usage window (the CLI's rateLimitType: five_hour, seven_day, ...; `unknown`), the newest replacing the
// older whatever its source; kept in memory and mirrored in ai_capacity_readings, so a restart keeps the block. A
// reading is live until its reset time, or SERVER_AI_READING_TTL_MINUTES after it was seen when it has none. The
// utilization is the highest live CLI reading (an event or a text), else the ledger's; at SERVER_AI_BLOCK_THRESHOLD or
// above, every server-AI action is refused (ai/gate.ts) with the vague message. Only admins ever see any of this
// (GET /api/admin/ai/capacity).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The ledger's window name. */
export const LEDGER_WINDOW = 'ledger';
/** The ledger reading is computed on demand and kept this long (a technical constant: the design's 30 s). */
export const LEDGER_CACHE_MS = 30_000;
/** While a ledger reading blocks, background work looks again this much later. */
const LEDGER_RECHECK_MS = 5 * 60_000;
/** A reset time given as a date is looked for this many days ahead at most. */
const RESET_DATE_HORIZON_DAYS = 62;

/** One reading, as kept. */
export interface CapacityReading {
  window: string;
  /** 0..1. */
  utilization: number;
  status: string;
  source: AiCapacitySource;
  resetsAtMs: number | null;
  seenAtMs: number;
}

/** The seat's state now: the reading that sets it, and whether it blocks. */
export interface CapacityState {
  utilization: number | null;
  blocked: boolean;
  threshold: number;
  /** The reading that sets the utilization; null with no live reading. */
  top: CapacityReading | null;
  /** Every live reading (the ledger's only when it was needed or asked for). */
  readings: CapacityReading[];
  /** When the block can lift on its own (epoch ms): the last of the blocking readings' ends; null when not blocked. */
  blockedUntilMs: number | null;
}

export interface AiCapacityService {
  /** A `rate_limit_event`'s rate_limit_info, from any CLI call (a task's or the admin test's). */
  noteEvent(info: RateLimitInfo): void;
  /** The text the CLI wrote about one call (cliChannelParts): its usage limit sentences, if any. */
  noteText(parts: readonly string[]): void;
  /** v3.0 D2: async (the stored readings load, and the fallback ledger is read, through deps.db). */
  state(options?: { withLedger?: boolean }): Promise<CapacityState>;
  /** state().blocked. */
  blocked(): Promise<boolean>;
  /**
   * v3.0 D2: the state without waiting: the fallback ledger's last reading (kept LEDGER_CACHE_MS; a stale one is read
   * again in the background for the next call). For synchronous callers: the background gate.
   */
  stateNow(options?: { withLedger?: boolean }): CapacityState;
  /** stateNow().blocked. */
  blockedNow(): boolean;
  /** GET /api/admin/ai/capacity. */
  view(): Promise<AiCapacity>;
  /** Resolves once the readings stored by an earlier run are loaded (state() waits for it). */
  readonly ready: Promise<void>;
}

declare module '../core/context' {
  interface AppServices {
    /** v2.0, P1: the server seat's usage readings and the capacity block (ai/capacity.ts). */
    aiCapacity?: AiCapacityService;
  }
}

/** The capacity service of these deps, made on first use (the AI queue, the gate, the admin route, tests). */
export function capacityOf(deps: Deps): AiCapacityService {
  deps.services.aiCapacity ??= createAiCapacity(deps);
  return deps.services.aiCapacity;
}

// ------------------------------------------------------------------------------------------------ the texts

/** "You've used 85% of your session limit": the share used of a named limit. */
const USED_TEXT = /\bused (\d{1,3})\s?% of your ([a-z0-9 -]{1,30}?) limit\b/gi;
/** "You've hit your session limit": that limit is used up. */
const HIT_TEXT = /\bhit your ([a-z0-9 -]{1,30}?) limit\b/gi;
/**
 * "resets 3pm (America/Los_Angeles)", "resets at 3:30 pm (UTC)", "resets Nov 14, 3pm (Europe/London)": a time with a
 * zone, and maybe a date. A reset time without a zone is not read (the reading then lives its TTL).
 */
const RESETS_TEXT =
  /\bresets\s+(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z0-9_+\-/]{1,64})\)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The usage window a limit's name stands for (03: session, weekly, Opus, Sonnet; else `unknown`). */
export function windowOfLimitName(name: string): string {
  const words = name.toLowerCase();
  if (words.includes('opus')) return 'seven_day_opus';
  if (words.includes('sonnet')) return 'seven_day_sonnet';
  if (/\bsession\b/.test(words)) return 'five_hour';
  if (/\bweekly\b/.test(words)) return 'seven_day';
  return 'unknown';
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The instant a "resets ..." text names, after `nowMs`; null when it names no time with a zone. */
export function parseResetsText(text: string, nowMs: number): number | null {
  const match = RESETS_TEXT.exec(text);
  if (!match) return null;
  const [, month, day, hourText, minuteText, meridiem, zone] = match;
  if (!zone || !validZone(zone)) return null;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  let at = nextResetAt(nowMs, time, zone);
  if (month === undefined || day === undefined) return at.getTime();
  const wanted = `${String(MONTHS.indexOf(month.toLowerCase()) + 1).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
  for (let i = 0; i < RESET_DATE_HORIZON_DAYS; i += 1) {
    if (dayKeyOf(at, '00:00', zone).slice(5) === wanted) return at.getTime();
    at = nextResetAt(at, time, zone);
  }
  return null;
}

/** The text readings in the CLI's own words: one per limit it names (the last word on a window wins). */
export function readingsOfText(text: string, nowMs: number): Array<Omit<CapacityReading, 'seenAtMs' | 'source' | 'status'>> {
  const found: Array<Omit<CapacityReading, 'seenAtMs' | 'source' | 'status'>> = [];
  const restOfLine = (from: number) => {
    const end = text.indexOf('\n', from);
    return text.slice(from, end === -1 ? undefined : end);
  };
  for (const match of text.matchAll(USED_TEXT)) {
    const percent = Number(match[1]);
    const after = restOfLine(match.index + match[0].length);
    found.push({ window: windowOfLimitName(match[2]!), utilization: Math.min(1, percent / 100), resetsAtMs: parseResetsText(after, nowMs) });
  }
  for (const match of text.matchAll(HIT_TEXT)) {
    const after = restOfLine(match.index + match[0].length);
    found.push({ window: windowOfLimitName(match[1]!), utilization: 1, resetsAtMs: parseResetsText(after, nowMs) });
  }
  return found;
}

/** An event's utilization: a fraction, a value above 1 a percent, `rejected` 1; null when it says no number. */
export function utilizationOfEvent(info: RateLimitInfo): number | null {
  if (info.status === 'rejected') return 1;
  const value = info.utilization;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(1, value > 1 ? value / 100 : value);
}

// ------------------------------------------------------------------------------------------------ the service

interface Row {
  window_type: string;
  utilization: number;
  status: string;
  source: AiCapacitySource;
  resets_at: string | null;
  seen_at: string;
}

export function createAiCapacity(deps: Deps): AiCapacityService {
  const { log } = deps;
  const constants = constantsOf(deps);
  const nowMs = () => deps.now().getTime();
  const sql = {
    put:
      'INSERT INTO ai_capacity_readings(window_type, utilization, status, source, resets_at, seen_at) ' +
      'VALUES (@window, @utilization, @status, @source, @resetsAt, @seenAt) ON CONFLICT(window_type) DO UPDATE SET ' +
      'utilization = excluded.utilization, status = excluded.status, source = excluded.source, ' +
      'resets_at = excluded.resets_at, seen_at = excluded.seen_at',
    drop: 'DELETE FROM ai_capacity_readings WHERE window_type = ?',
    spent: 'SELECT coalesce(sum(cost_usd), 0) AS cost FROM ai_usage_hourly WHERE hour >= ?',
    today:
      'SELECT coalesce(sum(daily_spent_micros + credit_spent_micros + written_off_micros), 0) AS charged, ' +
      'coalesce(sum(written_off_micros), 0) AS "writtenOff" FROM ai_spend_daily WHERE day_key = ?',
  };

  /** The CLI's readings (events and texts), by window. The ledger's row is recomputed, never read back. */
  const readings = new Map<string, CapacityReading>();
  // v3.0 D2: the readings an earlier run stored, loaded through deps.db; a window a CLI call reported meanwhile keeps
  // its newer reading.
  /** The stored readings were read (by the start-up read, or by a transaction that could not wait for it: state()). */
  let loaded = false;
  async function loadStored(): Promise<void> {
    for (const row of await deps.db.all<Row>('SELECT * FROM ai_capacity_readings')) {
      if (row.source === 'ledger' || readings.has(row.window_type)) continue;
      const seenAtMs = Date.parse(row.seen_at);
      const resetsAtMs = row.resets_at === null ? null : Date.parse(row.resets_at);
      if (!Number.isFinite(seenAtMs) || (resetsAtMs !== null && !Number.isFinite(resetsAtMs))) continue;
      readings.set(row.window_type, {
        window: row.window_type,
        utilization: row.utilization,
        status: row.status,
        source: row.source,
        resetsAtMs,
        seenAtMs,
      });
    }
    loaded = true;
  }
  const ready = (async () => {
    try {
      await loadStored();
    } catch (error) {
      log.warn('[ai] could not read the stored capacity readings', error);
    } finally {
      loaded = true;
    }
  })();
  let ledger: { reading: CapacityReading | null; key: string; atMs: number } | null = null;
  /** The ledger's read in flight (one at a time). */
  let ledgerRead: Promise<CapacityReading | null> | null = null;
  let wasBlocked: boolean | null = null;

  const ttlMs = () => constants.get('SERVER_AI_READING_TTL_MINUTES') * MINUTE_MS;
  /** When a reading stops counting (epoch ms). */
  const endOf = (reading: CapacityReading) => reading.resetsAtMs ?? reading.seenAtMs + ttlMs();
  const isLive = (reading: CapacityReading, at: number) =>
    reading.source === 'ledger' || (reading.resetsAtMs !== null ? reading.resetsAtMs > at : reading.seenAtMs > at - ttlMs());

  /** Stores a reading: in memory at once, in ai_capacity_readings after (a write that fails is logged). */
  function store(reading: CapacityReading): void {
    readings.set(reading.window, reading);
    deps.db
      .run(sql.put, {
        window: reading.window,
        utilization: reading.utilization,
        status: reading.status,
        source: reading.source,
        resetsAt: reading.resetsAtMs === null ? null : new Date(reading.resetsAtMs).toISOString(),
        seenAt: new Date(reading.seenAtMs).toISOString(),
      })
      .catch((error: unknown) => log.warn('[ai] could not store a capacity reading', error));
  }

  const ledgerKey = () => `${constants.get('SERVER_AI_CAPACITY_USD_PER_WINDOW')}:${constants.get('SERVER_AI_CAPACITY_WINDOW_HOURS')}`;
  /** The cached ledger reading while it is fresh (LEDGER_CACHE_MS, same constants); undefined when stale. */
  function freshLedger(at: number): CapacityReading | null | undefined {
    if (ledger && ledger.key === ledgerKey() && at - ledger.atMs < LEDGER_CACHE_MS && at >= ledger.atMs) return ledger.reading;
    return undefined;
  }

  /** The fallback ledger's reading, while SERVER_AI_CAPACITY_USD_PER_WINDOW is set; read again after LEDGER_CACHE_MS. */
  async function readLedger(at: number): Promise<CapacityReading | null> {
    const capacity = constants.get('SERVER_AI_CAPACITY_USD_PER_WINDOW');
    const hours = constants.get('SERVER_AI_CAPACITY_WINDOW_HOURS');
    const key = ledgerKey();
    let reading: CapacityReading | null = null;
    try {
      if (capacity === null) {
        if (ledger?.reading || ledger === null) await deps.db.run(sql.drop, [LEDGER_WINDOW]);
      } else {
        const spentMicros = microsOf((await deps.db.one<{ cost: number }>(sql.spent, [hourOf(at - hours * HOUR_MS)]))?.cost ?? 0);
        const utilization = capacity <= 0 ? 1 : Math.min(1, spentMicros / capacity);
        reading = { window: LEDGER_WINDOW, utilization, status: '', source: 'ledger', resetsAtMs: null, seenAtMs: at };
        await deps.db.run(sql.put, {
          window: LEDGER_WINDOW,
          utilization,
          status: '',
          source: 'ledger',
          resetsAt: null,
          seenAt: new Date(at).toISOString(),
        });
      }
    } catch (error) {
      log.warn('[ai] could not read the AI spend for the capacity fallback', error);
    }
    ledger = { reading, key, atMs: at };
    return reading;
  }

  /** The ledger reading, read again when stale (awaited). */
  async function ledgerReading(at: number): Promise<CapacityReading | null> {
    const fresh = freshLedger(at);
    if (fresh !== undefined) return fresh;
    // v3.0 PG-0: inside a transaction (the AI queue's enqueue) the read runs on that transaction's own connection. The
    // shared read belongs to whoever started it: on PostgreSQL another request's statements run on another connection,
    // and waiting for them inside a transaction is waiting on outside I/O (two enqueues at once tripped the guard).
    if (deps.db.inTx()) return readLedger(at);
    ledgerRead ??= readLedger(at).finally(() => {
      ledgerRead = null;
    });
    return ledgerRead;
  }

  /** The ledger reading without waiting: the last one, and a read for the next call when it is stale. */
  function ledgerReadingNow(at: number): CapacityReading | null {
    const fresh = freshLedger(at);
    if (fresh !== undefined) return fresh;
    void ledgerReading(at);
    return ledger?.key === ledgerKey() ? ledger.reading : null;
  }

  function stateOf(at: number, cli: CapacityReading[], fallback: CapacityReading | null): CapacityState {
    const threshold = constants.get('SERVER_AI_BLOCK_THRESHOLD');
    const live = fallback ? [...cli, fallback] : cli;
    const deciding = cli.length > 0 ? cli : fallback ? [fallback] : [];
    let top: CapacityReading | null = null;
    for (const reading of deciding) if (!top || reading.utilization > top.utilization) top = reading;
    const blocked = top !== null && top.utilization >= threshold;
    let blockedUntilMs: number | null = null;
    if (blocked) {
      for (const reading of deciding) {
        if (reading.utilization < threshold) continue;
        const end = reading.source === 'ledger' ? at + LEDGER_RECHECK_MS : endOf(reading);
        if (blockedUntilMs === null || end > blockedUntilMs) blockedUntilMs = end;
      }
    }
    if (wasBlocked !== blocked) {
      if (blocked) {
        log.warn(`[ai] the server AI capacity block is on: ${top!.source} reading of ${top!.window} at ${Math.round(top!.utilization * 100)}%`);
      } else if (wasBlocked) {
        log.info('[ai] the server AI capacity block is off');
      }
      wasBlocked = blocked;
    }
    return { utilization: top?.utilization ?? null, blocked, threshold, top, readings: live, blockedUntilMs };
  }

  const liveCli = (at: number) => [...readings.values()].filter((reading) => isLive(reading, at));

  async function state(options: { withLedger?: boolean } = {}): Promise<CapacityState> {
    // v3.0 INT-2: inside a transaction (the AI queue's enqueue: its capacity check) the start-up read is never awaited.
    // It runs on another connection, and waiting for it inside a transaction is waiting on outside I/O: the guard
    // rolled back the first enqueue after a start whenever that read was slow (a loaded machine: resumes-ai's "two at
    // once" answered [500, 202, 202]). The transaction reads the stored readings on its own connection instead, as the
    // ledger's read does (PG-0); the start-up read, finishing later, keeps what is already there.
    if (!loaded && deps.db.inTx()) await loadStored();
    else await ready;
    const at = nowMs();
    const cli = liveCli(at);
    // The ledger counts only while the CLI reports nothing (03: the CLI's own readings first).
    const fallback = cli.length === 0 || options.withLedger ? await ledgerReading(at) : null;
    return stateOf(at, cli, fallback);
  }

  function stateNow(options: { withLedger?: boolean } = {}): CapacityState {
    const at = nowMs();
    const cli = liveCli(at);
    const fallback = cli.length === 0 || options.withLedger ? ledgerReadingNow(at) : null;
    return stateOf(at, cli, fallback);
  }

  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const viewOf = (reading: CapacityReading): AiCapacityReading => ({
    window: reading.window,
    utilization: reading.utilization,
    status: reading.status,
    source: reading.source,
    resetsAt: iso(reading.resetsAtMs),
    seenAt: new Date(reading.seenAtMs).toISOString(),
  });


  return {
    ready,

    noteEvent(info) {
      const at = nowMs();
      const window = typeof info.rateLimitType === 'string' && info.rateLimitType.trim() ? info.rateLimitType.trim().slice(0, 40) : 'unknown';
      const status = typeof info.status === 'string' ? info.status.slice(0, 40) : '';
      let utilization = utilizationOfEvent(info);
      // A plain "allowed" with no number says the window is fine: it replaces a live reading of that window (a block
      // that window caused lifts), and makes none of its own, so a text reading keeps counting where events say no
      // number.
      if (utilization === null && status === 'allowed') {
        const known = readings.get(window);
        if (known && isLive(known, at)) utilization = 0;
      }
      if (utilization === null) return;
      const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0 ? info.resetsAt * 1000 : null;
      store({ window, utilization, status, source: 'event', resetsAtMs: resetsAt, seenAtMs: at });
    },

    noteText(parts) {
      const text = parts.filter((part) => typeof part === 'string' && part.trim()).join('\n');
      if (!text) return;
      const at = nowMs();
      for (const found of readingsOfText(text, at)) {
        store({ ...found, window: found.window.slice(0, 40), status: '', source: 'text', seenAtMs: at });
      }
    },

    state,

    blocked: async () => (await state()).blocked,

    stateNow,

    blockedNow: () => stateNow().blocked,

    async view() {
      const now = await state({ withLedger: true });
      const dayKey = dayKeyAt(deps);
      const today = (await deps.db.one<{ charged: number; writtenOff: number }>(sql.today, [dayKey])) ?? { charged: 0, writtenOff: 0 };
      return {
        utilization: now.utilization,
        blocked: now.blocked,
        threshold: now.threshold,
        source: now.top?.source ?? null,
        window: now.top?.window ?? null,
        resetsAt: now.top ? iso(now.top.source === 'ledger' ? null : endOf(now.top)) : null,
        readings: now.readings.map(viewOf),
        today: { dayKey, chargedMicros: today.charged, writtenOffMicros: today.writtenOff },
        checkedAt: deps.now().toISOString(),
      };
    },
  };
}
