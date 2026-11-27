import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import type { PostingReadOptions } from './types';

// v38 FRAME (SP v38 PLAN A3): a feed-based platform's board feed (Breezy's /json, Pinpoint's postings.json, Teamtailor's
// jobs.rss, Gem's job_posts: every posting of a board in one answer) is read once per run, and a link's read of one of
// its postings reads the board's feed once and reuses it for a short time, never once per posting:
//   - a run makes its own cache (createFeedCache with no time limit), lives as long as the run, and passes it to its
//     descriptor's reads (PostingReadOptions.feeds);
//   - every link's read (jobs/add/board-link.ts) passes the process's cache (linkFeedCache): a feed read within
//     BOARD_FEED_CACHE_SECONDS is reused, at most BOARD_FEED_CACHE_MAX boards' feeds are kept (the oldest goes first);
//   - two reads of one board at once share one request, whatever the limits; a read that failed is never kept.
// A descriptor's readPosting reads its feed through readFeed(options, key, load), keyed by its kind and board.
// v38 FIX-C (REVIEW38-beh M2): a link's read never closes a posting from a kept feed alone: jobs/add/board-link.ts reads
// through linkFeedReads, and a posting missing from a feed kept from an earlier read has the feed read again (fresh) once
// before the read answers closed; Retry read and Edit job's "Read this link" use no kept feed (freshFeed).

/** A cache of whole board feeds (see the top). */
export interface FeedCache<T = unknown> {
  /** The feed under `key`: a kept or in-flight read of it, else `load()`'s (kept once it answers, if the rules keep any). */
  read(key: string, load: () => Promise<T>): Promise<T>;
  /**
   * v38 FIX-C (REVIEW38-beh M2): as read, saying whether the feed is one kept from an earlier read (`reused`); with
   * `fresh`, a kept feed is never used (an in-flight read is shared: it is no older than this one) and the new read
   * replaces it.
   */
  lookup(key: string, load: () => Promise<T>, options?: { fresh?: boolean }): { value: Promise<T>; reused: boolean };
  /** Drops every kept feed. */
  clear(): void;
  /** The feeds kept or in flight now. */
  readonly size: number;
}

/** How long a cache keeps a feed (ms; Infinity: as long as it lives) and how many it keeps at most. */
export interface FeedCacheRules {
  ttlMs: number;
  max: number;
}

/** A feed cache under `rules` (read at each use: an admin's change applies at once), on the clock `now` (ms). */
export function createFeedCache<T = unknown>(rules: () => FeedCacheRules, now: () => number = Date.now): FeedCache<T> {
  const entries = new Map<string, { at: number | null; value: Promise<T> }>();
  /** A read that answered: kept (the oldest kept ones going first past `max`), or dropped when the rules keep none. */
  const keep = (key: string, value: Promise<T>) => {
    if (entries.get(key)?.value !== value) return; // cleared or read again meanwhile
    const { ttlMs, max } = rules();
    if (!(ttlMs > 0) || !(max > 0)) {
      entries.delete(key);
      return;
    }
    // A read still in flight is never dropped (it is shared until it answers).
    const kept = [...entries.entries()].filter(([, entry]) => entry.at !== null).sort(([, a], [, b]) => a.at! - b.at!);
    while (kept.length >= max) entries.delete(kept.shift()![0]);
    entries.set(key, { at: now(), value });
  };
  const lookup: FeedCache<T>['lookup'] = (key, load, options = {}) => {
    const known = entries.get(key);
    if (known && known.at === null) return { value: known.value, reused: false }; // in flight: shared, never stale
    if (known && !options.fresh && now() - known.at! < rules().ttlMs) return { value: known.value, reused: true };
    if (known) entries.delete(key);
    const value = load();
    entries.set(key, { at: null, value });
    value.then(
      () => keep(key, value),
      () => {
        if (entries.get(key)?.value === value) entries.delete(key);
      },
    );
    return { value, reused: false };
  };
  return {
    read: (key, load) => lookup(key, load).value,
    lookup, // v38 FIX-C (beh-M2)
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** A run's cache: each board's feed read once for the whole run. */
export const runFeedCache = <T = unknown>(): FeedCache<T> => createFeedCache<T>(() => ({ ttlMs: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY }));

/** The process's caches for links' reads, one per app (its services). */
const LINK_CACHES = new WeakMap<object, FeedCache>();

/** The process's cache for links' reads (BOARD_FEED_CACHE_SECONDS, BOARD_FEED_CACHE_MAX; see the top). */
export function linkFeedCache(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): FeedCache {
  let cache = LINK_CACHES.get(deps.services);
  if (!cache) {
    const constants = () => constantsOf(deps);
    cache = createFeedCache(
      () => ({ ttlMs: constants().get('BOARD_FEED_CACHE_SECONDS') * 1000, max: constants().get('BOARD_FEED_CACHE_MAX') }),
      () => deps.now().getTime(),
    );
    LINK_CACHES.set(deps.services, cache);
  }
  return cache;
}

/**
 * v38 FIX-C (REVIEW38-beh M2): one link read's view of the process's cache (linkFeedCache). A posting missing from a feed
 * kept from another link's read is no sign it closed (it may be newer than that read): `reused()` says whether any feed
 * this read was given was kept, so the reader reads the feed again (fresh) once before answering closed. With `fresh`
 * (Retry read, Edit job's "Read this link": pipeline.ts ReadLinkOptions.freshFeed) no kept feed is used.
 */
export function linkFeedReads(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  options: { fresh?: boolean } = {},
): { feeds: NonNullable<PostingReadOptions['feeds']>; reused(): boolean } {
  const cache = linkFeedCache(deps);
  let reused = false;
  return {
    feeds: {
      read(key, load) {
        const hit = cache.lookup(key, load, { fresh: options.fresh === true });
        if (hit.reused) reused = true;
        return hit.value;
      },
    },
    reused: () => reused,
  };
}

/** A board's feed for a descriptor's readPosting: through the read's cache when it has one, else read now. */
export function readFeed<T>(options: Pick<PostingReadOptions, 'feeds'>, key: string, load: () => Promise<T>): Promise<T> {
  return options.feeds ? (options.feeds as FeedCache<T>).read(key, load) : load();
}

// v38 FIX-A (SP v38 FIXES-38 item 12, REVIEW38-beh L18): a feed read another caller may share (through the read's cache)
// is sent with no caller's signal (the request keeps its own timeout), so a second caller never inherits the first's
// time limit or cancel; each caller waits for it under its own signal. With no cache, the read takes the caller's signal.

/** `promise`, or the abort of `signal` first (its reason); the listener is dropped once either settles. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('The read was stopped.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('The read was stopped.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** A board's feed as readFeed reads it, its shared read carrying no caller's signal (see above). */
export function readSharedFeed<T>(
  options: Pick<PostingReadOptions, 'feeds' | 'signal'>,
  key: string,
  load: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!options.feeds) return load(options.signal);
  return untilAborted(readFeed(options, key, () => load(undefined)), options.signal);
}
