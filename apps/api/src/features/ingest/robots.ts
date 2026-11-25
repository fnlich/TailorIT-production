import { HostHeldError, IngestHttpError, nothingSent, type IngestHttp } from './http';

// A host's robots.txt, as RFC 9309 reads it, for the reads TailorIT makes on a site that is not a job board's public
// API: Workday's posting read (adapters/workday.ts), the read a posting's own page makes. Before such a read the
// host's robots.txt is fetched (once a day per host and client: one GET of /robots.txt) and both the read's own path
// and the posting page's path must be allowed for TailorIT (its product token, else `*`). As RFC 9309 2.3.1 says: a
// 4xx answer but 429 means the site has no rules (everything allowed); 429, a 5xx and no answer at all mean it cannot
// be reached, and the read is refused for now.
//
// The rules are matched without backtracking (a rule such as /*a*a*a*a*z never stalls the server), the path and the
// patterns each spelt one way first (an unreserved character written as %XX decoded: %52emote is Remote), at most
// ROBOTS_MAX_RULES rules of at most ROBOTS_MAX_PATTERN characters each are kept, and at most ROBOTS_KEPT_HOSTS hosts'
// files are kept at once (the least recently used goes first). A read under way is shared by every caller asking about
// its host; one caller giving up (its own abort) never fails it for the others.
//
// v30 S1-API (12-job-sourcing.md §1 tests 2 and 5, §9.4; 11 §5.3a): robots.txt for every keyless read, not only
// Workday's: the ingest client (http.ts) asks assertRobotsAllow before each read it sends (service.ts wires it), so
// the four board APIs' hosts, Add job's reads and the re-checks are held to their hosts' files too. A file read is kept
// for every process in site_robots (a RobotsStore: hosts.ts), with its Crawl-delay (the host's pace, crawl_hosts
// min_interval_ms), its Content-Signal lines (`ai-input=no` keeps the host's postings out of AI) and its Sitemap
// lines; an unreachable file is recorded too, but never used as rules. The product token stays `tailorit`.
//
// v37 LANE (SP v37 PLAN W7): a file that could not be read (429, a 5xx, no answer) is remembered so for
// ROBOTS_UNREACHABLE_RETRY_MS in site_robots (failed_at), for every process: no read of it again before that, and the
// reads that need it meanwhile are refused as held until then (HostHeldError, `backoff`: "not now"), never as a day-long
// error. A refresh that fails keeps the file's last good rules (read at most ROBOTS_STALE_USE_MS ago): they keep
// applying. A read that sent nothing (its host or lane held, its wait for a turn ran out: http.ts nothingSent) is never
// kept as unreachable; with no good rules to fall back on it is refused as held too.

/** TailorIT's product token, as its User-Agent starts ("TailorIT job ingest"). */
export const ROBOTS_PRODUCT_TOKEN = 'tailorit';
/** The most of a robots.txt read: the RFC's 500 KiB a crawler must parse. */
export const ROBOTS_MAX_BYTES = 512 * 1024;
/** How long a host's rules are kept before they are read again. */
export const ROBOTS_KEEP_MS = 24 * 60 * 60_000;
/** The most hosts whose rules are kept at once. */
export const ROBOTS_KEPT_HOSTS = 300;
/** The most rules one file's groups give TailorIT, and the longest pattern kept (longer ones are cut there). */
export const ROBOTS_MAX_RULES = 2000;
export const ROBOTS_MAX_PATTERN = 2048;
/** How long a shared read of a robots.txt may take, whoever waits for it. */
export const ROBOTS_READ_TIMEOUT_MS = 20_000;
/** The longest Crawl-delay honoured (seconds): a longer one paces the host at this. */
export const ROBOTS_MAX_CRAWL_DELAY_S = 120;
/** v37 LANE (W7): how long a file that could not be read is remembered so (no read of it again before that). */
export const ROBOTS_UNREACHABLE_RETRY_MS = 10 * 60_000;
/** v37 LANE (W7): how old a file's last good rules may be and still apply while its refresh fails. */
export const ROBOTS_STALE_USE_MS = 7 * 24 * 60 * 60_000;
/** The most Sitemap lines kept per host. */
export const ROBOTS_MAX_SITEMAPS = 50;

/** The 4xx answers that mean "no rules" (RFC 9309 2.3.1.3): every one but 429. */
const NO_RULES = Array.from({ length: 100 }, (_, n) => 400 + n).filter((status) => status !== 429);

interface Rule {
  allow: boolean;
  /** The pattern: '*' any characters (runs of '*' made one), a final '$' the end of the path. */
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  /** v30 S1-API: the group's Crawl-delay (seconds), and its Content-Signal lines as written. */
  crawlDelay: number | null;
  signals: string[];
}

/** A file read whole: its groups, and the lines outside any group (Sitemap; Content-Signal before the first group). */
interface ParsedFile {
  groups: Group[];
  sitemaps: string[];
  signals: string[];
}

/** The groups of a robots.txt: each run of user-agent lines and the rules after it. */
function parseFile(text: string): ParsedFile {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  const signals: string[] = [];
  let current: Group | null = null;
  let readingAgents = false;
  for (const raw of text.replace(/^\ufeff/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!readingAgents || !current) {
        current = { agents: [], rules: [], crawlDelay: null, signals: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      readingAgents = true;
    } else if (key === 'allow' || key === 'disallow') {
      readingAgents = false;
      // An empty Disallow allows everything: it adds no rule.
      if (current && value !== '') {
        const pattern = normalizedEscapes(value.slice(0, ROBOTS_MAX_PATTERN)).replace(/\*+/g, '*');
        current.rules.push({ allow: key === 'allow', pattern });
      }
    } else {
      // Sitemap and other lines end no group (RFC 9309 2.2.4), but a user-agent line after them starts a new one.
      readingAgents = false;
      if (key === 'sitemap' && /^https?:\/\//i.test(value) && sitemaps.length < ROBOTS_MAX_SITEMAPS) sitemaps.push(value.slice(0, 2048));
      else if (key === 'crawl-delay' && current) {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = Math.max(current.crawlDelay ?? 0, seconds);
      } else if (key === 'content-signal' && value) (current ? current.signals : signals).push(value.slice(0, 500));
    }
  }
  return { groups, sitemaps, signals };
}

/** The groups of a robots.txt (parseFile's). */
function groupsOf(text: string): Group[] {
  return parseFile(text).groups;
}

/** What a host's robots.txt says beyond its rules, for TailorIT (its own groups, else `*`'s). */
export interface RobotsExtras {
  /** Crawl-delay in whole seconds (at most ROBOTS_MAX_CRAWL_DELAY_S), or null. */
  crawlDelaySeconds: number | null;
  /** The Content-Signal lines that apply, as written (joined with a new line), or null. */
  contentSignals: string | null;
  /** False when they say ai-input=no, true when ai-input=yes, null when they say nothing about it. */
  aiInput: boolean | null;
  /** The Sitemap lines. */
  sitemaps: string[];
}

/** The groups TailorIT follows: its own, else those naming '*'. */
function chosenGroups(groups: readonly Group[]): Group[] {
  const own = groups.filter((group) => group.agents.includes(ROBOTS_PRODUCT_TOKEN));
  return own.length > 0 ? own : groups.filter((group) => group.agents.includes('*'));
}

/** A Content-Signal value's ai-input: `search=yes, ai-input=no` -> false. */
function aiInputOf(signal: string): boolean | null {
  for (const part of signal.split(',')) {
    const [name, value] = part.split('=').map((piece) => piece.trim().toLowerCase());
    if (name === 'ai-input' && (value === 'yes' || value === 'no')) return value === 'yes';
  }
  return null;
}

/** Crawl-delay, Content-Signal and Sitemap lines of a robots.txt, as they apply to TailorIT (12 §9.4). */
export function robotsExtras(text: string): RobotsExtras {
  const file = parseFile(text);
  const chosen = chosenGroups(file.groups);
  const delays = chosen.map((group) => group.crawlDelay).filter((delay): delay is number => delay !== null);
  const signals = [...file.signals, ...chosen.flatMap((group) => group.signals)];
  const inputs = signals.map(aiInputOf).filter((value): value is boolean => value !== null);
  return {
    crawlDelaySeconds: delays.length > 0 ? Math.min(ROBOTS_MAX_CRAWL_DELAY_S, Math.ceil(Math.max(...delays))) : null,
    contentSignals: signals.length > 0 ? signals.join('\n') : null,
    // Any "no" wins: a host that says ai-input=no anywhere TailorIT reads is kept out of AI.
    aiInput: inputs.length === 0 ? null : !inputs.includes(false),
    sitemaps: file.sitemaps,
  };
}

/**
 * A path or a pattern with one spelling of each character (RFC 9309 2.2.2, RFC 3986 6.2.2): an unreserved character
 * written percent-encoded (%52emote) decoded, every other escape's hex in upper case.
 */
export function normalizedEscapes(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9._~-]/.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * Whether `path` matches `pattern` ('*' any run of characters, a final '$' the end). The pattern's literal pieces
 * between its '*'s are found in order, each at its leftmost place after the one before (which leaves the most path to
 * the rest, so nothing is tried twice): the first at the path's start, the last (with '$') at its end. A pattern takes
 * at most a few passes over the path, never the pattern's length times the path's.
 */
export function wildcardMatches(pattern: string, path: string, ignoreCase = false): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const p = ignoreCase ? body.toLowerCase() : body;
  const s = ignoreCase ? path.toLowerCase() : path;
  const pieces = p.split('*');
  const head = pieces[0]!;
  if (!s.startsWith(head)) return false;
  // No '*': the pattern is the path's start (without '$') or the whole path (with it).
  if (pieces.length === 1) return !anchored || s.length === head.length;
  let at = head.length;
  const last = pieces.length - 1;
  for (let k = 1; k < last; k += 1) {
    const piece = pieces[k]!;
    if (piece === '') continue;
    const found = s.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  const tail = pieces[last]!;
  // A pattern without '$' matches any path that holds its last piece after the others: as if it ended in '*'.
  if (!anchored) return tail === '' || s.indexOf(tail, at) >= 0;
  return s.length - tail.length >= at && s.endsWith(tail);
}

/** The pattern's length as the RFC compares matches: its octets, percent-encoding folded. */
function lengthOf(pattern: string): number {
  return pattern.replace(/%[0-9a-f]{2}/gi, '_').length;
}

/** The rules TailorIT follows in a file: its own groups', else those naming '*', at most ROBOTS_MAX_RULES. */
function rulesFor(text: string): Rule[] {
  return chosenGroups(groupsOf(text))
    .flatMap((group) => group.rules)
    .slice(0, ROBOTS_MAX_RULES);
}

/** Whether `rules` allow `path`: the longest matching rule wins, an allow winning a tie; none matching allows it. */
function rulesAllow(rules: readonly Rule[], path: string, ignoreCase: boolean): boolean {
  const spelt = normalizedEscapes(path);
  if (spelt === '/robots.txt') return true;
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!wildcardMatches(rule.pattern, spelt, ignoreCase)) continue;
    const better =
      best === null ||
      lengthOf(rule.pattern) > lengthOf(best.pattern) ||
      (lengthOf(rule.pattern) === lengthOf(best.pattern) && rule.allow && !best.allow);
    if (better) best = rule;
  }
  return best === null || best.allow;
}

/**
 * Whether robots.txt `text` allows `path` (a path with its query, starting with '/') for TailorIT: the groups naming its
 * product token, else those naming '*', merged; the longest matching rule wins, an allow winning a tie; no matching
 * rule allows it. `ignoreCase` matches the patterns in any case, for a site whose paths are case-insensitive (Workday's
 * career sites: a Disallow of /NVIDIARecruitAds/ keeps /nvidiarecruitads/ out too). /robots.txt itself is always
 * allowed.
 */
export function robotsAllows(text: string, path: string, options: { ignoreCase?: boolean } = {}): boolean {
  return rulesAllow(rulesFor(text), path, options.ignoreCase === true);
}

/**
 * What a host's robots.txt says, read: its rules (none for a 4xx but 429), and the file as kept (v30 S1-API). v37 LANE:
 * `keepUntil`, until when a client keeps it in memory (a day after its read; the last good rules of a failed refresh
 * only until the failure may be retried).
 */
type Robots = { rules: Rule[]; stored: StoredRobots; keepUntil: number };

/** A host's robots.txt as kept for every process (site_robots, 11 §5.3a), read at `fetchedAt`. */
export interface StoredRobots extends RobotsExtras {
  host: string;
  fetchedAt: string;
  /** ok: rules read; no_rules: a 4xx but 429 (everything allowed); unreachable: 429, a 5xx or no answer ("not now"). */
  status: 'ok' | 'no_rules' | 'unreachable';
  httpStatus: number | null;
  /** The file as read (capped at ROBOTS_MAX_BYTES), or null. */
  rules: string | null;
  /**
   * v37 LANE (W7, migration 0062): the last read that failed (429, a 5xx, no answer) and its status, when it failed after
   * this file was read (a good file kept beside it), or this unreachable file's own read; null after a good read.
   */
  failedAt?: string | null;
  failedStatus?: number | null;
}

/**
 * Where robots.txt files are kept between processes (hosts.ts: site_robots). `read` answers the host's last read (any
 * age; the caller judges it); `write` keeps a new one and paces the host by its Crawl-delay.
 */
export interface RobotsStore {
  read(host: string): Promise<StoredRobots | null>;
  write(robots: StoredRobots): Promise<void>;
}

/** A read file's StoredRobots: `status` from its HTTP status, its extras when it has rules. */
export function storedRobotsOf(host: string, fetchedAt: string, httpStatus: number | null, text: string | null): StoredRobots {
  const status: StoredRobots['status'] =
    httpStatus === null || httpStatus === 429 || httpStatus >= 500 ? 'unreachable' : httpStatus >= 400 ? 'no_rules' : 'ok';
  const extras: RobotsExtras =
    status === 'ok' && text ? robotsExtras(text) : { crawlDelaySeconds: null, contentSignals: null, aiInput: null, sitemaps: [] };
  return {
    host,
    fetchedAt,
    status,
    httpStatus,
    rules: status === 'ok' ? text : null,
    ...extras,
    failedAt: status === 'unreachable' ? fetchedAt : null,
    failedStatus: status === 'unreachable' ? httpStatus : null,
  };
}

/** v37 LANE (W7): when the kept file's last read failed (its own read for an unreachable file kept before 0062), or null. */
function failedAtOf(kept: StoredRobots): number | null {
  const at = kept.failedAt ?? (kept.status === 'unreachable' ? kept.fetchedAt : null);
  return at ? Date.parse(at) : null;
}

/** v37 LANE (W7): the kept file's last good rules, while they may still apply (read at most ROBOTS_STALE_USE_MS ago). */
export function lastGoodRobots(kept: StoredRobots | null, now: number): StoredRobots | null {
  return kept && kept.status !== 'unreachable' && now - Date.parse(kept.fetchedAt) <= ROBOTS_STALE_USE_MS ? kept : null;
}

/**
 * v37 LANE (W7): what a kept file is good for now: `use` it (read within ROBOTS_KEEP_MS; or its last good rules while
 * its refresh failed within ROBOTS_UNREACHABLE_RETRY_MS), `unreachableUntil` (it could not be read lately and has no
 * good rules to use: not read again before then), or null (read it now).
 */
export function keptRobotsUse(
  kept: StoredRobots | null,
  now: number,
): { use: StoredRobots } | { unreachableUntil: string } | null {
  if (!kept) return null;
  if (kept.status !== 'unreachable' && now - Date.parse(kept.fetchedAt) <= ROBOTS_KEEP_MS) return { use: kept };
  const failed = failedAtOf(kept);
  if (failed === null || now - failed >= ROBOTS_UNREACHABLE_RETRY_MS) return null;
  const good = lastGoodRobots(kept, now);
  return good ? { use: good } : { unreachableUntil: new Date(failed + ROBOTS_UNREACHABLE_RETRY_MS).toISOString() };
}

/**
 * Whether a host's file allows each of `paths` for TailorIT: `allowed`, `disallowed` (a rule keeps one out), or
 * `unreachable` (the file could not be read: "not now"). For a source's robots_status (12 §12.1).
 */
export function robotsVerdict(robots: Pick<StoredRobots, 'status' | 'rules'>, paths: readonly string[]): 'allowed' | 'disallowed' | 'unreachable' {
  if (robots.status === 'unreachable') return 'unreachable';
  if (robots.status === 'no_rules' || !robots.rules) return 'allowed';
  const rules = rulesFor(robots.rules);
  return paths.every((path) => rulesAllow(rules, path, false)) ? 'allowed' : 'disallowed';
}

/** Each client's reads of each host's robots.txt (so a test's fake client starts afresh), least recently used first. */
const kept = new WeakMap<IngestHttp, Map<string, { at: number; reading: Promise<Robots>; until?: number }>>();

/** Why a read was refused by the site's robots.txt (or because it could not be read). */
export class RobotsRefusal extends Error {
  /** `disallowed`: the file disallows the read; `unreadable`: the file could not be read (try again later). */
  readonly reason: 'disallowed' | 'unreadable';
  constructor(reason: 'disallowed' | 'unreadable', message: string) {
    super(message);
    this.name = 'RobotsRefusal';
    this.reason = reason;
  }
}

/** The store a client keeps its hosts' files in (the service's client: site_robots); none for a test's fake client. */
const stores = new WeakMap<IngestHttp, RobotsStore>();

/** Keeps `http`'s robots.txt reads in `store` too (every process sees them), and reads them back from it first. */
export function useRobotsStore(http: IngestHttp, store: RobotsStore): void {
  stores.set(http, store);
}

/** A kept file's rules for TailorIT, and until when this client may use them without asking the store again. */
function robotsOfKept(kept: StoredRobots, keepUntil: number): Robots {
  return { rules: kept.status === 'ok' && kept.rules ? rulesFor(kept.rules) : [], stored: kept, keepUntil };
}

/**
 * One read of a host's robots.txt, on its own clock: no caller's abort reaches it. Kept in the client's store. v37 LANE
 * (W7): a failure is remembered for ROBOTS_UNREACHABLE_RETRY_MS (refused as held until then, no read), the last good
 * rules apply while a refresh fails, and a read that sent nothing is never kept (see the top).
 */
async function readRobots(
  http: IngestHttp,
  host: string,
  options: { allowRedirectHost?: (host: string) => boolean; now: () => number },
): Promise<Robots> {
  const store = stores.get(http);
  const now = options.now();
  /** The file as read, kept for every process, best effort (a failed write never fails the read). */
  const keepFor = async (status: number | null, text: string | null): Promise<StoredRobots> => {
    const stored = storedRobotsOf(host, new Date(options.now()).toISOString(), status, text);
    if (store) await store.write(stored).catch(() => undefined);
    return stored;
  };
  const kept = store ? await store.read(host).catch(() => null) : null;
  const known = keptRobotsUse(kept, now);
  if (known && 'use' in known) {
    // Fresh: until it is a day old. The last good rules of a failed refresh: until the failure may be retried.
    const readAt = Date.parse(known.use.fetchedAt);
    const failed = failedAtOf(known.use);
    return robotsOfKept(known.use, now - readAt <= ROBOTS_KEEP_MS ? readAt + ROBOTS_KEEP_MS : (failed ?? now) + ROBOTS_UNREACHABLE_RETRY_MS);
  }
  if (known) throw new HostHeldError(host, known.unreachableUntil, 'backoff');
  let answer;
  try {
    answer = await http.getJson(`https://${host}/robots.txt`, {
      signal: AbortSignal.timeout(ROBOTS_READ_TIMEOUT_MS),
      allow: NO_RULES,
      maxBytes: ROBOTS_MAX_BYTES,
      text: true,
      robots: false,
      ...(options.allowRedirectHost ? { allowRedirectHost: options.allowRedirectHost } : {}),
    });
  } catch (error) {
    const good = lastGoodRobots(kept, options.now());
    if (nothingSent(error)) {
      // Nothing was sent (a held host or lane, a wait for a turn that ran out): nothing to keep. The last good rules
      // still apply; with none, the read is refused as held: the site said nothing.
      if (good) return robotsOfKept(good, options.now() + ROBOTS_UNREACHABLE_RETRY_MS);
      if (error instanceof HostHeldError) throw error;
      throw new HostHeldError(host, new Date(options.now() + ROBOTS_READ_TIMEOUT_MS).toISOString(), 'backoff');
    }
    // Any other failure is "not now" (unreachable), remembered for ROBOTS_UNREACHABLE_RETRY_MS (the store keeps the
    // last good rules beside it, and they apply meanwhile).
    const status = error instanceof IngestHttpError && error.status > 0 ? error.status : error instanceof HostHeldError ? error.answered : null;
    await keepFor(status, null);
    if (good) return robotsOfKept(good, options.now() + ROBOTS_UNREACHABLE_RETRY_MS);
    throw error;
  }
  const text = typeof answer.data === 'string' ? answer.data : '';
  const stored = await keepFor(answer.status, answer.status >= 400 ? null : text);
  const until = options.now() + ROBOTS_KEEP_MS;
  if (answer.status >= 400) return { rules: [], stored, keepUntil: until };
  return { rules: rulesFor(text), stored, keepUntil: until };
}

/** `promise`, or a rejection with the signal's reason once `signal` aborts first (the promise itself goes on). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Resolves when `host`'s robots.txt allows every one of `paths` for TailorIT; rejects with RobotsRefusal otherwise:
 * `disallowed` when a rule keeps one out, `unreadable` when the file could not be read (429, a 5xx, no answer, a
 * timeout, an answer over ROBOTS_MAX_BYTES). The file is read once per host per ROBOTS_KEEP_MS for this client, shared
 * by the reads under way; a failed read is not kept. `signal` stops this caller's wait only; `allowRedirectHost` keeps
 * the read of the file on the hosts it allows (Workday's: its read follows a redirect to those alone).
 */
export async function assertRobotsAllow(
  http: IngestHttp,
  host: string,
  paths: readonly string[],
  options: RobotsReadOptions = {},
): Promise<void> {
  let robots: Robots;
  try {
    robots = await robotsOf(http, host, options);
  } catch (error) {
    if (options.signal?.aborted || error instanceof HostHeldError) throw error;
    const detail = error instanceof IngestHttpError && error.status > 0 ? ` (HTTP ${error.status})` : '';
    throw new RobotsRefusal('unreadable', `The site's robots.txt could not be read${detail}.`);
  }
  if (paths.some((path) => !rulesAllow(robots.rules, path, options.ignoreCase === true))) {
    throw new RobotsRefusal('disallowed', "The site's robots.txt asks automated readers not to read this posting.");
  }
}

/**
 * v30 S1-API: a host's robots.txt as kept (StoredRobots), read as assertRobotsAllow reads it (the same shared read and
 * keeping); rejects when it could not be read (HostHeldError for a held host). For the sources' verdicts (scheduler.ts).
 */
export async function hostRobots(http: IngestHttp, host: string, options: RobotsReadOptions = {}): Promise<StoredRobots> {
  return (await robotsOf(http, host, options)).stored;
}

export interface RobotsReadOptions {
  signal?: AbortSignal;
  ignoreCase?: boolean;
  now?: () => number;
  allowRedirectHost?: (host: string) => boolean;
}

/** The host's file for this client: kept for ROBOTS_KEEP_MS, a read under way shared, a failed read not kept. */
async function robotsOf(http: IngestHttp, host: string, options: RobotsReadOptions): Promise<Robots> {
  const now = options.now ?? Date.now;
  let hosts = kept.get(http);
  if (!hosts) {
    hosts = new Map();
    kept.set(http, hosts);
  }
  const key = host.toLowerCase();
  let entry = hosts.get(key);
  // v37 LANE (W7): a file read is kept until its own keepUntil (a fallback's, shortly), never past ROBOTS_KEEP_MS.
  if (!entry || now() - entry.at > ROBOTS_KEEP_MS || (entry.until !== undefined && now() >= entry.until)) {
    const reading = readRobots(http, key, { allowRedirectHost: options.allowRedirectHost, now });
    const made: { at: number; reading: Promise<Robots>; until?: number } = { at: now(), reading };
    entry = made;
    reading.then(
      (robots) => {
        made.until = robots.keepUntil;
      },
      () => {
        if (hosts.get(key)?.reading === reading) hosts.delete(key);
      },
    );
  }
  // Least recently used first: this host goes to the back, and the front goes past ROBOTS_KEPT_HOSTS.
  hosts.delete(key);
  hosts.set(key, entry);
  while (hosts.size > ROBOTS_KEPT_HOSTS) hosts.delete(hosts.keys().next().value!);
  return untilAborted(entry.reading, options.signal);
}
