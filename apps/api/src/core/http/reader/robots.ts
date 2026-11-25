import { isLaneHost } from '../../../features/ingest/hosts'; // v37 LANE; v37 FIX-LANE (any lane)
import { HostHeldError, type HostGate } from '../../../features/ingest/http';
import {
  keptRobotsUse,
  lastGoodRobots,
  ROBOTS_MAX_BYTES,
  storedRobotsOf,
  type RobotsStore,
  type StoredRobots,
} from '../../../features/ingest/robots';
import { assertRedirectAllowed, MAX_REDIRECTS, OutboundRefusedError } from '../outbound';
import { isAddressRefused } from './address';
import type { SiteTransport } from './transport';

// v30 E2: robots.txt for the shared site reader (docs/design/part2/13-company-enrichment.md §4 rule 2, 12 §1 test 2,
// RFC 9309). The same file and the same rules as the ingest client's (features/ingest/robots.ts): TailorIT's product
// token, else `*`; a 4xx but 429 is no rules; a 429, a 5xx or no answer is "not now" (everything disallowed for this
// pass); Crawl-delay paces the host. The file is kept in site_robots for every process (S1-API's RobotsStore) and used
// for at most ROBOTS_KEEP_MS (24 hours); an unreachable file is kept too, but never used as rules: it is read again.
// It is read through the reader's own transport (the connect-time address check) under the host's pace (crawl_hosts),
// with BOT_USER_AGENT; its redirects are followed (RFC 9309 2.3.1.2), at most MAX_REDIRECTS, each hop https, a name
// TailorIT reads, and paced on its own host.
// v37 LANE (SP v37 PLAN W7, W1): as the ingest client's (features/ingest/robots.ts keptRobotsUse): a file that could not
// be read is not read again for ROBOTS_UNREACHABLE_RETRY_MS (any process), and a failed refresh keeps the last good
// rules (at most ROBOTS_STALE_USE_MS old), which apply meanwhile. A Workday host's read takes the Workday lane's turn
// and holds it until its answer (one request at a time to all of Workday).

/** What the reader's robots.txt read needs. */
export interface RobotsReadContext {
  transport: SiteTransport;
  gate: HostGate;
  store: RobotsStore;
  userAgent: string;
  timeoutMs: number;
  /** The host's least gap between two requests (ms): SITE_READER_HOST_GAP_SECONDS. */
  gapMs: number;
  /** The longest wait for the host's slot before the read is refused instead (HostHeldError). */
  maxTurnWaitMs: number;
  now: () => number;
}

/**
 * The host's robots.txt (`host` as a URL's host: a name, with its port when not 443): the kept one when fresh, else
 * read now and kept. Rejects with HostHeldError (a held or busy host: nothing sent) or an address refusal (the
 * connect-time check: nothing sent); every other failure is an `unreachable` file.
 */
export async function robotsForHost(ctx: RobotsReadContext, host: string): Promise<StoredRobots> {
  const kept = await ctx.store.read(host).catch(() => null);
  // v37 LANE (W7): fresh, or the last good rules while a recent failure is remembered; a remembered failure with no good
  // rules is the unreachable file as kept (not read again before ROBOTS_UNREACHABLE_RETRY_MS).
  const known = keptRobotsUse(kept, ctx.now());
  if (known && 'use' in known) return known.use;
  if (known && kept) return { ...kept, status: 'unreachable', rules: null };
  const keep = async (status: number | null, text: string | null): Promise<StoredRobots> => {
    const stored = storedRobotsOf(host, new Date(ctx.now()).toISOString(), status, text);
    await ctx.store.write(stored).catch(() => undefined);
    // A failed refresh keeps applying the last good rules (the store keeps them beside the failure).
    return stored.status === 'unreachable' ? (lastGoodRobots(kept, ctx.now()) ?? stored) : stored;
  };
  let url = new URL(`https://${host}/robots.txt`);
  for (let hop = 0; ; hop += 1) {
    // v37 LANE (W1): a Workday host's turn is the lane's, held until the answer (one request at a time to Workday; v37
    // FIX-LANE: to any lane's platform).
    const lane = isLaneHost(url.host);
    const turnHost = url.host;
    await ctx.gate.takeTurn(turnHost, { minIntervalMs: ctx.gapMs, maxWaitMs: ctx.maxTurnWaitMs, ...(lane ? { busyMs: ctx.timeoutMs } : {}) });
    let answer;
    try {
      answer = await ctx.transport.get(url.href, {
        headers: { 'User-Agent': ctx.userAgent, Accept: 'text/plain,*/*;q=0.1' },
        signal: AbortSignal.timeout(ctx.timeoutMs),
        maxBytes: ROBOTS_MAX_BYTES,
      });
    } catch (error) {
      if (lane) await ctx.gate.release?.(turnHost).catch(() => undefined);
      if (isAddressRefused(error) || error instanceof HostHeldError) throw error;
      await ctx.gate.record(url.host, { kind: 'failed', status: 0 }).catch(() => undefined);
      return keep(null, null);
    }
    if (lane) await ctx.gate.release?.(turnHost).catch(() => undefined);
    const { status } = answer;
    await ctx.gate.record(url.host, status === 429 || status >= 500 ? { kind: 'failed', status } : { kind: 'answered', status }).catch(() => undefined);
    const location = status >= 300 && status < 400 ? answer.headers.get('location') : null;
    if (location) {
      if (hop >= MAX_REDIRECTS) return keep(null, null);
      try {
        const next = new URL(location, url);
        assertRedirectAllowed(next);
        url = next;
      } catch (error) {
        if (error instanceof OutboundRefusedError || error instanceof TypeError) return keep(null, null);
        throw error;
      }
      continue;
    }
    // An answer over ROBOTS_MAX_BYTES is no file TailorIT can read: "not now".
    if (status >= 200 && status < 300 && answer.tooLarge) return keep(null, null);
    return keep(status, status >= 200 && status < 300 ? answer.body.toString('utf8') : null);
  }
}
