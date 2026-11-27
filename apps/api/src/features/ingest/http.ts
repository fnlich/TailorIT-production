import { assertOutboundAllowed, assertRedirectAllowed, crossOriginHeaders, MAX_REDIRECTS, OutboundRefusedError } from '../../core/http/outbound';
import { isRobotsExempt } from '../../core/http/robots-exemptions';
import { neverReadPlatformOfHost } from './career/platforms'; // v38 FIX-C (D3)

/**
 * v38 FIX-C (SP v38 FIXES-38 D3; REVIEW38-beh H2): a host TailorIT never reads (SAP SuccessFactors, Phenom, JobDiva:
 * career/platforms.ts) is refused before anything is sent, its robots.txt too, by this client whoever calls it (a
 * redirect hop to one as well). The links are answered before they reach here (jobs/add/board-link.ts); this is the
 * last word for any other path.
 */
function assertNotNeverRead(address: string | URL): void {
  let host: string;
  try {
    host = (typeof address === 'string' ? new URL(address) : address).hostname;
  } catch {
    return; // assertOutboundAllowed refuses an address that is none
  }
  const platform = neverReadPlatformOfHost(host);
  if (platform) throw new OutboundRefusedError(`TailorIT never sends a request to ${platform.label}: it doesn't read that platform.`);
}

// The job boards' HTTP client: one request a second per host (shared by every run in this process, so two sources
// on one host take turns), a contact User-Agent, a per-request timeout, Retry-After honoured on 429, and a lenient
// JSON reader (some boards embed raw control characters in their strings). It never sends a request to LinkedIn or a
// refused job board (core/http/outbound.ts): such an address is refused before anything is sent.
//
// v30 S1-API (12-job-sourcing.md §9.2, §9.4): Part 2's polite reading, through a host gate (HostGate below):
//   - the pace per host is shared by every process when the gate is the database's (features/ingest/hosts.ts:
//     crawl_hosts.next_slot_at, one conditional statement per request); in this client's memory otherwise;
//   - Retry-After: a short wait (up to maxRetryAfterMs) is waited and the request tried again, as before; a longer one
//     holds the whole host (crawl_hosts.hold_until), so the sources behind it wait instead of failing one by one;
//   - a request that fails for good (a 5xx, a timeout, no answer, its retries spent) backs its host off (full jitter, 1
//     minute x 2^n up to INGEST_BACKOFF_MAX_HOURS); INGEST_HOST_BREAKER_FAILURES of them in a row hold it for
//     INGEST_HOST_BREAKER_HOLD_MINUTES (the breaker), after which one request decides;
//   - a 401, a 403 or a bot check (`cf-mitigated: challenge`) is a stop: the host is held for INGEST_BOT_CHECK_HOLD_HOURS
//     and shown to an admin (Admin › Hosts). Never another identity, proxy or faster retry. A status the caller
//     `allow`s (robots.txt's 4xx) is its answer, not a bot check;
//   - a held host, or one whose next slot is more than maxTurnWaitMs ahead, refuses the request at once (HostHeldError);
//   - conditional GETs (`etag`, `lastModified`: If-None-Match, If-Modified-Since): a 304 is an answer;
//   - robots.txt before every read (the `robots` hook: features/ingest/service.ts wires robots.ts to it), but the read
//     of robots.txt itself (`robots: false`);
//   - every answer read to at most `maxBytes` (INGEST_ANSWER_MAX_BYTES for the service's reads); gzip is accepted
//     (fetch asks for it and unpacks it).
//
// v30 FIX-A (REV-SEC SEC-1, SEC-6): a redirect hop is a request of its own. Each hop takes its own host's turn (the
// pace, and a held or backed-off host refuses it), asks robots.txt for its own path (a disallowed hop is refused), and
// its answer is recorded against its own host. Once a hop leaves the first request's origin, it carries no credential
// header and none of the headers the request added (`headers`: a keyed API's key; core/http/outbound.ts
// crossOriginHeaders).
// v30 FIX-A (REV-BEH's per-host note, 12 §9.3 "one request in flight per host"): each request (each hop) takes its
// host's turn with `busyMs` (the request's timeout): the host stays busy for every process until the answer is read
// and the client gives it back (HostGate.release), so the API's Run now, Add job and re-checks and the worker never
// have two requests in flight to one host, however slow its answers.

export class IngestHttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'IngestHttpError';
    this.status = status;
    this.url = url;
  }
}

export interface HttpAnswer {
  status: number;
  data: unknown;
  /** v38 ATS-C: a redirect's Location, resolved against the request (followRedirects: false), else absent. */
  location?: string | null;
}

/** What the client tells a caller about each answer it read (GetJsonOptions.meta): its size and validators. */
export interface HttpAnswerMeta {
  status: number;
  /** The body's bytes as read (0 for a 304 or an empty body). */
  bytes: number;
  /** The answer's ETag and Last-Modified (a conditional GET sends them next time). */
  etag: string | null;
  lastModified: string | null;
}

/** Why a host is not read now: crawl_hosts.hold_reason, or `backoff` (its next slot is too far ahead). */
export type HostHoldReason = 'retry_after' | 'breaker' | 'bot_check' | 'admin' | 'backoff';

const HOLD_WORDS: Record<HostHoldReason, string> = {
  retry_after: 'it asked TailorIT to wait',
  breaker: 'its requests failed too often',
  bot_check: 'it refused TailorIT or showed a bot check',
  admin: 'an admin held it',
  backoff: 'it failed recently',
};

/**
 * A request refused, nothing sent, because its host is held (Retry-After, the breaker, a bot check, an admin) or backed off.
 * v37 LANE (SP v37 PLAN W3): or the request's own answer held its lane (a 429 from Workday pauses every Workday site:
 * hosts.ts WORKDAY_LANE); `answered` then names that answer's status. `host` is the crawl_hosts row held (a lane's key,
 * `workday.lane`, for a lane), `label` its name in words ("Workday (all sites)"; the host itself otherwise).
 */
export class HostHeldError extends IngestHttpError {
  readonly host: string;
  /** Until when (ISO). */
  readonly until: string;
  readonly reason: HostHoldReason;
  /** v37 LANE: the held row in words (a lane's name, else the host). */
  readonly label: string;
  /** v37 LANE: the status of this request's own answer that held the host or its lane (429), or null: nothing was sent. */
  readonly answered: number | null;
  constructor(host: string, until: string, reason: HostHoldReason, extra: { label?: string; answered?: number } = {}) {
    const label = extra.label ?? host;
    super(`${label} is on hold until ${until} (${HOLD_WORDS[reason]}); TailorIT reads it again after that.`, 0, `https://${host}/`);
    this.name = 'HostHeldError';
    this.host = host;
    this.until = until;
    this.reason = reason;
    this.label = label;
    this.answered = extra.answered ?? null;
  }
}

/** v37 LANE: failures thrown before their request sent anything (a turn's wait that ran out or was stopped). */
const unsentFailures = new WeakSet<object>();

/**
 * v37 LANE (SP v37 PLAN W7): whether a request failed without sending anything: its host or lane was held (and not by
 * its own answer), or its wait for the host's turn ran out or was stopped. Such a failure says nothing about the site
 * (robots.ts never keeps it as an unreachable robots.txt).
 */
export function nothingSent(error: unknown): boolean {
  if (error instanceof HostHeldError) return error.answered === null;
  return error !== null && typeof error === 'object' && unsentFailures.has(error);
}

/** v37 LANE (SP v37 PLAN W5): a turn for a person waiting (Add job and its kin) or for background work (runs, queues). */
export type TurnPriority = 'interactive' | 'background';

/** What happened to one request, for its host's record (HostGate.record). */
export type HostOutcome =
  /** It answered (any status the caller takes, a 304, a 404). */
  | { kind: 'answered'; status: number }
  /** It failed for good: a 5xx, a timeout or no answer, its retries spent. */
  | { kind: 'failed'; status: number }
  /**
   * It asked to wait (429 or 5xx, Retry-After or the client's own pause): `hold` when longer than the client waits.
   * v37 LANE: `retryAfterMs`, the wait the answer asked for itself (Retry-After), when it named one.
   */
  | { kind: 'wait'; status: number; waitMs: number; hold: boolean; retryAfterMs?: number | null }
  /** 401, 403 or a bot check. */
  | { kind: 'bot_check'; status: number };

/**
 * The pace and holds of the hosts a client reads (12 §9.2): in memory (createMemoryHostGate: this client only), or the
 * database's crawl_hosts (features/ingest/hosts.ts createHostGate: every process).
 */
export interface HostGate {
  /**
   * Waits for the host's next slot and takes it (`minIntervalMs` after the slot before, or more when the host asks for
   * more: its Crawl-delay). Throws HostHeldError, taking nothing, while the host is held or its next slot is more than
   * `maxWaitMs` ahead (a backed-off host).
   */
  takeTurn(
    host: string,
    options: { minIntervalMs: number; maxWaitMs: number; signal?: AbortSignal; busyMs?: number; priority?: TurnPriority },
  ): Promise<void>;
  /**
   * Records a request's outcome: failures and backoff, the breaker, Retry-After and bot-check holds. v37 LANE: answers
   * the hold the outcome put on the request's lane (a 429 from Workday pauses all of Workday), which the request then
   * throws instead of trying again; nothing otherwise.
   */
  record(host: string, outcome: HostOutcome): Promise<HostHeldError | void>;
  /**
   * v30 FIX-A: the request that took the host's turn with `busyMs` is over (answered, failed or given up): the host is
   * free for the next one at once (otherwise when `busyMs` has passed).
   */
  release?(host: string): Promise<void>;
  /**
   * v37 FIX-LANE (the review's F4): the lane a host's requests take their turns on (the database gate's Workday lane for
   * every Workday host), else the host itself. A 429 on a lane is never tried again inside the request, whether or not
   * its record could be written. Absent: every host is its own lane.
   */
  laneOf?(host: string): string;
}

export interface GetJsonOptions {
  signal?: AbortSignal;
  /** Statuses answered instead of thrown (e.g. 404 for "no such board"). */
  allow?: readonly number[];
  /**
   * The most bytes of the answer read: past it the reading stops and the request fails (IngestHttpError, status 413),
   * never retried. Absent: the client's own cap (none unless it was given one).
   */
  maxBytes?: number;
  /** Answer the body as text, unparsed (`data` is a string): a site's robots.txt (robots.ts). */
  text?: boolean;
  /**
   * v37 FIX-37A (REVIEW37-beh F7): the Accept header, for a read of a page (text/html) or a sitemap (XML); absent:
   * text/plain for a `text` read, else application/json.
   */
  accept?: string;
  /**
   * The hosts a redirect may lead to (lower case, no trailing dot): Workday's reads stay on Workday's hosts. Any host
   * assertRedirectAllowed allows when absent.
   */
  allowRedirectHost?: (host: string) => boolean;
  /**
   * v38 ATS-C: false answers a redirect as it is (its status, `location` the address it names, its body when `text`) and
   * sends nothing more: a platform whose "gone" is a redirect (Jobvite's 303 to ?error=404, Paylocity's 302 to
   * JobNotFound, Avature's 302 to /careers/Error) reads that without following it. Default: followed (allowRedirectHost).
   */
  followRedirects?: boolean;
  /** v30 S1-API: a conditional GET: the last answer's ETag and Last-Modified. A 304 is then an answer. */
  etag?: string | null;
  lastModified?: string | null;
  /** v30 S1-API: false skips the client's robots.txt check (the read of robots.txt itself). */
  robots?: boolean;
  /** v30 S1-API: told each answer's size and validators (a run counts its requests and bytes; a listing keeps its ETag). */
  meta?: (meta: HttpAnswerMeta) => void;
  /**
   * v30 S4: more request headers (a keyed API's key: USAJOBS' Authorization-Key). They never replace the client's
   * User-Agent or Accept, nor a conditional GET's validators.
   */
  headers?: Readonly<Record<string, string>>;
}

export interface IngestHttp {
  getJson(url: string, options?: GetJsonOptions): Promise<HttpAnswer>;
}

export interface IngestHttpOptions {
  userAgent: string;
  timeoutMs: number;
  /**
   * Minimum gap between two requests to one host (INGEST_HOST_MIN_INTERVAL_MS: a function reads the constant at each
   * request, so an admin's change applies at once). Default 1000 ms.
   */
  minIntervalMs?: number | (() => number);
  /** Retries after a 429 or a 5xx. Default 3. */
  maxRetries?: number;
  /**
   * The longest wait honoured within the request; a longer Retry-After fails the request and holds the host for that
   * long (v30 S1-API). Default 120 s.
   */
  maxRetryAfterMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** v30 S1-API: the hosts' pace and holds (default: this client's memory). */
  gate?: HostGate;
  /** v30 S1-API: the longest wait for a host's slot; past it the request is refused (HostHeldError). Default 5 min. */
  maxTurnWaitMs?: number;
  /** v30 S1-API: the most bytes any answer is read to unless its request says otherwise (default: no cap). */
  maxBytes?: number | (() => number);
  /** v30 S1-API: checks robots.txt before every read but `robots: false` ones (rejects with robots.ts RobotsRefusal). */
  robots?: (url: URL, signal: AbortSignal | undefined) => Promise<void>;
  /**
   * v37 LANE (SP v37 PLAN W5): whose reads these are, read at each request: `interactive` for a person waiting (the API's
   * own client: Add job, the extension, Add by link, MCP add), whose turns go ahead of background ones on a lane.
   * Default `background`.
   */
  priority?: () => TurnPriority;
}

/** v30 S4: the headers the client sets itself, which a request's own `headers` never give. */
const OWN_HEADERS = /^(?:user-agent|accept|if-none-match|if-modified-since)$/i;

/** The longest wait for a host's slot before a request is refused instead (a backed-off host). */
export const MAX_TURN_WAIT_MS = 5 * 60_000;
/** How long a bot check holds a host in a memory gate (the database gate reads INGEST_BOT_CHECK_HOLD_HOURS). */
const MEMORY_BOT_CHECK_HOLD_MS = 24 * 3_600_000;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The run was stopped.');
}

export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(abortError(signal)) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A HostGate in this client's memory: one pace per host, reserved in call order (so waiters keep their turn), as
 * v2.0's client kept it, and the holds a Retry-After or a bot check asks for. No other process sees them.
 */
export function createMemoryHostGate(options: { now?: () => number; sleep?: IngestHttpOptions['sleep'] } = {}): HostGate {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  /** The earliest time each host may be asked again. */
  const nextSlot = new Map<string, number>();
  const holds = new Map<string, { until: number; reason: HostHoldReason }>();
  /** v30 FIX-A: the request in flight to each host (its turn's end), and the turns waiting for it. */
  const busy = new Map<string, { until: number; waiting: Array<() => void> }>();
  /** The host's turn is over: the next waiting turn goes; the others wait for its release in turn. */
  const giveBack = (host: string) => {
    const current = busy.get(host);
    if (!current) return;
    busy.delete(host);
    const [next, ...rest] = current.waiting;
    if (rest.length > 0) busy.set(host, { until: 0, waiting: rest });
    next?.();
  };
  return {
    async takeTurn(host, { minIntervalMs, maxWaitMs, signal, busyMs }) {
      const hold = holds.get(host);
      if (hold && hold.until > now()) throw new HostHeldError(host, new Date(hold.until).toISOString(), hold.reason);
      // One request in flight per host: wait for the one there (its release, or its time running out).
      for (let current = busy.get(host); current && current.until > now(); current = busy.get(host)) {
        await new Promise<void>((resolve) => current!.waiting.push(resolve));
      }
      const at = Math.max(now(), nextSlot.get(host) ?? 0);
      if (at - now() > maxWaitMs) throw new HostHeldError(host, new Date(at).toISOString(), 'backoff');
      nextSlot.set(host, at + minIntervalMs);
      if (busyMs && busyMs > 0) busy.set(host, { until: at + busyMs, waiting: busy.get(host)?.waiting ?? [] });
      try {
        await sleep(at - now(), signal);
      } catch (error) {
        // v37 LANE (SP v37 PLAN W9): a turn taken but never used (its wait was stopped) is given back at once.
        if (busyMs && busyMs > 0) giveBack(host);
        throw error;
      }
    },
    async release(host) {
      giveBack(host);
    },
    async record(host, outcome) {
      if (outcome.kind === 'wait') {
        if (outcome.hold) holds.set(host, { until: now() + outcome.waitMs, reason: 'retry_after' });
        else nextSlot.set(host, Math.max(nextSlot.get(host) ?? 0, now() + outcome.waitMs));
      } else if (outcome.kind === 'bot_check') {
        holds.set(host, { until: now() + MEMORY_BOT_CHECK_HOLD_MS, reason: 'bot_check' });
      }
    },
  };
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const text = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * JSON.parse, and when that fails, again with raw control characters inside strings escaped (Ashby boards have sent
 * literal tabs and form feeds in descriptions). Throws when the text is not JSON either way.
 */
export function parseJsonLenient(text: string): unknown {
  const body = text.replace(/^\ufeff/, '');
  try {
    return JSON.parse(body);
  } catch (error) {
    let inString = false;
    let escaped = false;
    let out = '';
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index]!;
      const code = char.charCodeAt(0);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        } else if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
          continue;
        }
      } else if (char === '"') {
        inString = true;
      } else if (code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t') {
        out += ' ';
        continue;
      }
      out += char;
    }
    try {
      return JSON.parse(out);
    } catch {
      throw error;
    }
  }
}

/** v38 ATS-C: a redirect's Location resolved against its request's address, or null (none, or not an address). */
function resolvedLocation(location: string | null, url: string): string | null {
  if (!location) return null;
  try {
    return new URL(location, url).href;
  } catch {
    return null;
  }
}

/** Whether an answer is a bot check by its headers (Cloudflare's challenge); a 401 or 403 is one by its status. */
function isBotCheck(response: Response): boolean {
  // v38 ATS-D (SP v38 EVIDENCE.md §23): AWS WAF's challenge or CAPTCHA (Phenom's sites answer 202 with it) is one too.
  return (response.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge' || isAwsWafCheck(response.headers);
}

/** v38 ATS-D: an AWS WAF answer that is a bot check (`x-amzn-waf-action: challenge` or `captcha`), never a page. */
export function isAwsWafCheck(headers: { get(name: string): string | null }): boolean {
  return /^(?:challenge|captcha)$/i.test((headers.get('x-amzn-waf-action') ?? '').trim());
}

export function createIngestHttp(options: IngestHttpOptions): IngestHttp {
  const minInterval = () => (typeof options.minIntervalMs === 'function' ? options.minIntervalMs() : (options.minIntervalMs ?? 1000));
  const clientMaxBytes = () => (typeof options.maxBytes === 'function' ? options.maxBytes() : options.maxBytes);
  const maxRetries = options.maxRetries ?? 3;
  const maxRetryAfter = options.maxRetryAfterMs ?? 120_000;
  const maxTurnWait = options.maxTurnWaitMs ?? MAX_TURN_WAIT_MS;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const gate = options.gate ?? createMemoryHostGate({ now, sleep });

  /** v30 FIX-A: the host the request is at is free again (best effort: its busy time runs out anyway). */
  async function release(host: string): Promise<void> {
    try {
      await gate.release?.(host);
    } catch {
      /* the busy mark runs out on its own */
    }
  }

  /** Errors a redirect hop's own checks threw (robots.txt's refusal, a held host): the request fails with them as they are. */
  const hopRefusals = new WeakSet<object>();

  /**
   * The host's record of an outcome, best effort: a failed write never fails the read. v37 LANE: answers the hold the
   * outcome put on the host's lane (the request throws it), or null.
   */
  async function record(host: string, outcome: HostOutcome): Promise<HostHeldError | null> {
    try {
      return (await gate.record(host, outcome)) ?? null;
    } catch {
      /* the pace and holds are advice; the answer stands */
      return null;
    }
  }
  /** v37 LANE: whose turns this client's requests take (read at each request). */
  const priority = (): TurnPriority => options.priority?.() ?? 'background';
  /** v37 FIX-LANE (F4): whether a host's turns are a lane's (Workday's, on the database gate). */
  const onLane = (host: string): boolean => {
    const lane = gate.laneOf?.(host);
    return lane !== undefined && lane !== host;
  };

  /**
   * The answer to `url`, redirects followed here (at most MAX_REDIRECTS) so that every hop passes the outbound guard
   * before it is sent (assertRedirectAllowed: https, a name, never LinkedIn's or a refused board's): a board that
   * redirected to LinkedIn, to http, to an IP address or to a local name would be refused there. A 3xx with no
   * Location is the answer as it is.
   *
   * v30 FIX-A: each hop after the first asks robots.txt for its own path (unless `robots: false`, the read of robots.txt
   * itself) and takes its own host's turn (the caller took the first one); `hop.host` names the host the request is at,
   * so a failure or an answer is recorded against it, and `hop.held` whether the request holds that host's turn now.
   * A hop that leaves the first origin carries no credential header nor any of `added` (crossOriginHeaders).
   */
  async function fetchFollowing(
    url: string,
    init: RequestInit,
    hop: { host: string; held: boolean },
    rules: { allowHost?: (host: string) => boolean; robots: boolean; added: readonly string[]; signal?: AbortSignal; follow?: boolean },
  ): Promise<Response> {
    const origin = new URL(url).origin;
    let current = url;
    let hopInit: RequestInit = { ...init, redirect: 'manual' };
    for (let count = 0; ; count += 1) {
      const response = await doFetch(current, hopInit);
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null;
      if (!location || rules.follow === false) return response; // v38 ATS-C: followRedirects false answers it as it is
      await response.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new IngestHttpError(`${url} redirected to an address that is not one.`, response.status, url);
      }
      if (count >= MAX_REDIRECTS) throw new IngestHttpError(`${url} redirected too often.`, response.status, url);
      assertRedirectAllowed(next, rules.allowHost);
      assertNotNeverRead(next); // v38 FIX-C (D3)
      // The hop's answer (the redirect) was the previous host's, which is free again.
      await record(hop.host, { kind: 'answered', status: response.status });
      await release(hop.host);
      hop.held = false;
      if (next.origin !== origin) {
        // Once the request has left its origin, it carries no credential again (even back on the first origin).
        hopInit = { ...hopInit, headers: crossOriginHeaders(hopInit.headers, rules.added) };
      }
      // The hop is a request of its own: robots.txt for its path, then its host's turn (held hosts refuse it). Their
      // refusals are the request's answer, never retried.
      try {
        if (rules.robots && options.robots) await options.robots(next, rules.signal);
        await gate.takeTurn(next.host, {
          minIntervalMs: minInterval(),
          maxWaitMs: maxTurnWait,
          signal: rules.signal,
          busyMs: options.timeoutMs,
          priority: priority(),
        });
        hop.host = next.host;
        hop.held = true;
      } catch (error) {
        if (error !== null && typeof error === 'object') hopRefusals.add(error);
        throw error;
      }
      current = next.href;
    }
  }

  /** The body as text, at most `maxBytes` of it: past the cap the stream is cancelled and the request refused. */
  async function textOf(response: Response, url: string, maxBytes: number | undefined): Promise<string> {
    if (maxBytes === undefined || !response.body) return response.text();
    const declared = Number(response.headers.get('Content-Length'));
    const tooLarge = () => new IngestHttpError(`${url} answered with more than ${maxBytes} bytes.`, 413, url);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function getJson(url: string, request: GetJsonOptions = {}): Promise<HttpAnswer> {
    const { signal, allow = [], text: asText, allowRedirectHost, etag, lastModified, meta } = request;
    const maxBytes = request.maxBytes ?? clientMaxBytes();
    assertOutboundAllowed(url);
    assertNotNeverRead(url); // v38 FIX-C (D3): before robots.txt, before anything
    const parsed = new URL(url);
    const host = parsed.host;
    // v30 FIX-C SEC-5 (DECISIONS P6.2; applied by FIX-INT): robots.txt is skipped only for an address on the one
    // exemption list (robots.txt itself, USAJOBS' keyed search, Wikidata's two APIs); any other `robots: false` is refused.
    if (request.robots === false && !isRobotsExempt(parsed)) {
      throw new OutboundRefusedError('robots.txt is skipped only for an address on the robots exemption list (core/http/robots-exemptions.ts).');
    }
    // robots.txt first (its own read says `robots: false`): a refusal sends nothing.
    if (request.robots !== false && options.robots) await options.robots(parsed, signal);
    // v30 S4: the request's own headers, never one the client sets itself: its identity always wins.
    const own = Object.entries(request.headers ?? {}).filter(([header]) => !OWN_HEADERS.test(header));
    const headers: Record<string, string> = {
      ...Object.fromEntries(own),
      'User-Agent': options.userAgent,
      Accept: request.accept ?? (asText ? 'text/plain' : 'application/json'), // v37 FIX-37A (F7)
    };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    /** The request's own headers' names (they never follow a hop to another origin: SEC-1). */
    const added = own.map(([header]) => header);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await gate.takeTurn(host, { minIntervalMs: minInterval(), maxWaitMs: maxTurnWait, signal, busyMs: options.timeoutMs, priority: priority() });
      } catch (error) {
        // v37 LANE (W7): a first turn's wait that ran out or was stopped sent nothing (nothingSent). The gate gave back
        // a turn it took but whose wait was stopped (W9).
        if (attempt === 0 && error !== null && typeof error === 'object') unsentFailures.add(error);
        throw error;
      }
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      let text: string;
      /** The host the request is at (a redirect moves it): its outcome is recorded against it. */
      const hop = { host, held: true };
      // v30 FIX-A: the host is given back however the attempt ends.
      try {
        try {
          response = await fetchFollowing(url, { headers, signal: combined }, hop, {
            allowHost: allowRedirectHost,
            robots: request.robots !== false,
            added,
            signal,
            follow: request.followRedirects, // v38 ATS-C
          });
          // A bot check, a 401 or a 403 is a stop (12 §9.4): the host is held, the request never retried.
          if (isBotCheck(response) || ((response.status === 401 || response.status === 403) && !allow.includes(response.status))) {
            await response.body?.cancel().catch(() => undefined);
            await record(hop.host, { kind: 'bot_check', status: response.status });
            throw new IngestHttpError(
              `${hop.host} refused TailorIT (HTTP ${response.status}); TailorIT does not read it again for a while.`,
              response.status,
              url,
            );
          }
          if (response.status === 429 || response.status >= 500) {
            const asked = retryAfterMs(response.headers.get('Retry-After'), now());
            const wait = asked ?? (response.status === 429 ? 30_000 : 2000 * (attempt + 1));
            await response.body?.cancel().catch(() => undefined);
            if (asked !== null && asked > maxRetryAfter) {
              // A long Retry-After holds the whole host: the sources behind it wait instead of failing one by one.
              const held = await record(hop.host, { kind: 'wait', status: response.status, waitMs: asked, hold: true, retryAfterMs: asked });
              throw held ?? new HostHeldError(hop.host, new Date(now() + asked).toISOString(), 'retry_after', { answered: response.status });
            }
            if (attempt >= maxRetries || wait > maxRetryAfter) {
              const held = await record(
                hop.host,
                response.status === 429
                  ? { kind: 'wait', status: 429, waitMs: wait, hold: false, retryAfterMs: asked }
                  : { kind: 'failed', status: response.status },
              );
              if (held) throw held; // v37 LANE: the answer paused the host's lane
              const what = response.status === 429 ? 'is rate limiting us' : `answered HTTP ${response.status}`;
              throw new IngestHttpError(`${hop.host} ${what}; try the run again later.`, response.status, url);
            }
            const held = await record(hop.host, { kind: 'wait', status: response.status, waitMs: wait, hold: false, retryAfterMs: asked });
            // v37 LANE (SP v37 PLAN W3): a 429 on a lane (Workday) is never tried again inside the request: the whole
            // lane is paused, and the request says until when.
            if (held) throw held;
            // v37 FIX-LANE (F4): nor when the pause could not be written (a database error): the 429 is the answer.
            if (response.status === 429 && onLane(hop.host)) {
              throw new IngestHttpError(`${hop.host} is rate limiting us; try the run again later.`, 429, url);
            }
            continue;
          }
          // The body counts toward the timeout too: a board that stalls mid-answer is retried like one that never answered.
          text = await textOf(response, url, maxBytes);
        } catch (error) {
          if (error instanceof IngestHttpError || error instanceof OutboundRefusedError) throw error;
          if (error !== null && typeof error === 'object' && hopRefusals.has(error)) throw error;
          if (signal?.aborted) throw abortError(signal);
          const problem = timeout.aborted
            ? `did not answer within ${Math.round(options.timeoutMs / 1000)} s`
            : `could not be reached: ${(error as Error).message}`;
          if (attempt < maxRetries) {
            await record(hop.host, { kind: 'wait', status: 0, waitMs: 2000 * (attempt + 1), hold: false });
            continue;
          }
          await record(hop.host, { kind: 'failed', status: 0 });
          throw new IngestHttpError(`${url} ${problem}.`, 0, url);
        }

        await record(hop.host, { kind: 'answered', status: response.status });
        meta?.({
          status: response.status,
          bytes: Buffer.byteLength(text, 'utf8'),
          etag: response.headers.get('ETag'),
          lastModified: response.headers.get('Last-Modified'),
        });
        if (response.status === 304 && (etag || lastModified)) return { status: 304, data: null };
        // v38 ATS-C: a redirect not followed is the answer, with the address it names.
        if (request.followRedirects === false && response.status >= 300 && response.status < 400) {
          return { status: response.status, data: asText ? text : null, location: resolvedLocation(response.headers.get('Location'), url) };
        }
        if (!response.ok && !allow.includes(response.status)) {
          throw new IngestHttpError(`${url} answered HTTP ${response.status}.`, response.status, url);
        }
        if (asText) return { status: response.status, data: text };
        if (!text.trim()) return { status: response.status, data: null };
        try {
          return { status: response.status, data: parseJsonLenient(text) };
        } catch {
          if (!response.ok) return { status: response.status, data: null };
          throw new IngestHttpError(`${url} did not answer with JSON.`, response.status, url);
        }
      } finally {
        // Only a host this request holds (never one another request took meanwhile).
        if (hop.held) await release(hop.host);
      }
    }
  }

  return { getJson };
}
