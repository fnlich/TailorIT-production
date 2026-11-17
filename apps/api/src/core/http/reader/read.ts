import { createHostGate, createRobotsStore, holdOf } from '../../../features/ingest/hosts';
import { HostHeldError, retryAfterMs, sleepFor, type HostGate, type HostOutcome } from '../../../features/ingest/http';
import { robotsVerdict, type RobotsStore } from '../../../features/ingest/robots';
import { registrableDomain } from '../../../features/companies/domain';
import { constantsOf } from '../../constants/index';
import type { AppDeps } from '../../context';
import type { DbQueries } from '../../db/types';
import type { SiteReader, SiteReadRefusal, SiteReadRequest, SiteReadResult } from '../../seams';
import { assertNewReadAllowed, NewReadRefusedError } from '../identity';
import { assertRedirectAllowed, OutboundRefusedError } from '../outbound';
import { isAddressRefused } from './address';
import { isChallengeAnswer, wallOf } from './detect';
import { robotsForHost, type RobotsReadContext } from './robots';
import { defaultSiteTransport, type SiteAnswer, type SiteTransport } from './transport';

// v30 E2: the shared polite reader (core/seams.ts SiteReader; docs/design/part2/13-company-enrichment.md §4, 12 §3.4,
// 11 §5.3a). One reader for every outside page TailorIT reads on its own: company homepages and their logos (E2,
// features/companies/site and logos) and career pages (S5). Outside any transaction. A read, in order:
//   1. its purpose's switch: SITE_READER_COMPANY_SITES or SITE_READER_CAREER_PAGES (both off until the lawyer's view,
//      owner question 8): off answers `switch_off`, nothing sent;
//   2. the identity guard (assertNewReadAllowed 'site_reader'): BOT_USER_AGENT still a placeholder answers
//      `identity_placeholder`, nothing sent; otherwise every request says BOT_USER_AGENT;
//   3. the address: https, a dotted name (never an IP address or a local name), never LinkedIn or a refused board
//      (outbound.ts), else `held`;
//   4. crawl_opt_outs (the domain and every host under it): `opted_out`;
//   5. the host's hold (crawl_hosts.hold_until: Retry-After, the breaker, a bot check, an admin): `held` with retryAt;
//   6. robots.txt (robots.ts: site_robots, 24 hours): a disallow, or a file that cannot be read now, answers `robots`;
//   7. the host's pace (crawl_hosts, one statement per request): at least SITE_READER_HOST_GAP_SECONDS apart, or the
//      host's Crawl-delay; a slot further away than a few gaps answers `held` with retryAt;
//   8. the request, through transport.ts (undici): its connection only to a public address, checked when it is made
//      (`held` otherwise, nothing sent), SITE_READER_TIMEOUT_MS, at most SITE_READER_MAX_BYTES (an image also at most
//      COMPANY_LOGO_MAX_BYTES), a conditional GET when the caller has the last validators (a 304 is `notModified`);
//   9. its answer: a redirect is followed here, at most SITE_READER_MAX_REDIRECTS, each hop https and on the first address's
//      registrable domain, and each hop goes through steps 3-8 again; 401, 403, a bot check (Cloudflare's header, a
//      challenge page, a CAPTCHA wall, a login wall) holds the host (INGEST_BOT_CHECK_HOLD_HOURS) and answers
//      `blocked`; 429 holds it for its Retry-After (else INGEST_HOST_BREAKER_HOLD_MINUTES) and answers `blocked`; a
//      5xx or no answer backs the host off (its breaker) and answers `failed`; any other status, a body too large, or
//      a body that is not the kind asked for answers `failed` with the status.
// A refusal is never retried with another identity, a headless browser, a proxy or a faster pace.

// v30 INT-4: the most redirects one read follows (13 §4 rule 3) is SITE_READER_MAX_REDIRECTS; a read waits at most
// SITE_READER_TURN_WAIT_GAPS of the host's gaps for its slot (past it the read answers `held` with retryAt).

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml', 'application/xml', 'text/xml']);
/** v30 INT-4 (S5's edit A): a sitemap (accept 'xml') comes as XML, as a plain list of addresses, or gzip-packed. */
const XML_TYPES = new Set(['application/xml', 'text/xml', 'text/plain', 'application/gzip', 'application/x-gzip']);
const ACCEPT = {
  html: 'text/html,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.1',
  image: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.1',
  xml: 'application/xml,text/xml;q=0.9,text/plain;q=0.5,application/gzip;q=0.5,*/*;q=0.1',
} as const;

/** What the default reader is built from; tests give a fake transport and no waiting. */
export interface SiteReaderOptions {
  /** The transport (default: deps.services.siteReaderTransport, else the process's undici transport). */
  transport?: SiteTransport;
  /** The hosts' pace and holds (default: crawl_hosts, createHostGate). */
  gate?: (deps: AppDeps) => HostGate;
  /** Where robots.txt files are kept (default: site_robots, createRobotsStore). */
  robotsStore?: (deps: AppDeps) => RobotsStore;
  /** How a slot is waited for (default: a timer). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const refusal = (reason: SiteReadRefusal, extra: { status?: number; retryAt?: string } = {}): SiteReadResult => ({
  ok: false,
  refusal: reason,
  ...(extra.status !== undefined ? { status: extra.status } : {}),
  ...(extra.retryAt ? { retryAt: extra.retryAt } : {}),
});

/** Whether a host (a name, lower case) is under a domain on crawl_opt_outs. */
export async function isOptedOut(db: DbQueries, hostname: string): Promise<boolean> {
  const row = await db.one<{ hit: number }>(
    "SELECT 1 AS hit FROM crawl_opt_outs WHERE domain = @host OR right(@host, char_length(domain) + 1) = '.' || domain LIMIT 1",
    { host: hostname },
  );
  return row !== undefined;
}

/** A response's media type ("text/html; charset=utf-8" -> "text/html"), or ''. */
function mediaTypeOf(answer: SiteAnswer): string {
  return (answer.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
}

/** Whether a 2xx body is the kind the read asked for (`url`: the address that answered). */
function isKindAsked(accept: 'html' | 'image' | 'xml', answer: SiteAnswer, url: URL): boolean {
  const type = mediaTypeOf(answer);
  if (accept === 'image') return type === '' || type.startsWith('image/') || type === 'application/octet-stream';
  if (accept === 'xml') {
    // v30 INT-4: XML (any +xml type too), a text list, gzip (by its type, or a .gz path sent as bytes); no type: markup
    // or gzip's magic bytes. A page (text/html) is not a sitemap. The caller unpacks gzip (career/sitemap.ts).
    const gzipped = answer.body[0] === 0x1f && answer.body[1] === 0x8b;
    if (type === 'application/octet-stream') return /\.gz$/i.test(url.pathname) || gzipped;
    if (type) return XML_TYPES.has(type) || type.endsWith('+xml');
    return gzipped || /^\s*</.test(answer.body.subarray(0, 512).toString('utf8'));
  }
  if (type) return HTML_TYPES.has(type);
  // No type: markup only.
  return /^\s*</.test(answer.body.subarray(0, 512).toString('utf8'));
}

/** The shared site reader (see the top). */
export function createSiteReader(options: SiteReaderOptions = {}): SiteReader {
  return {
    async read(deps: AppDeps, request: SiteReadRequest): Promise<SiteReadResult> {
      deps.db.assertNoTx('the site reader');
      const c = constantsOf(deps);
      // 1. The purpose's switch.
      if (!c.get(request.purpose === 'company_site' ? 'SITE_READER_COMPANY_SITES' : 'SITE_READER_CAREER_PAGES')) return refusal('switch_off');
      // 2. The identity guard.
      try {
        assertNewReadAllowed(deps, 'site_reader');
      } catch (error) {
        if (error instanceof NewReadRefusedError) return refusal('identity_placeholder');
        throw error;
      }
      let url: URL;
      try {
        url = new URL(request.url);
        assertRedirectAllowed(url);
      } catch {
        return refusal('held');
      }
      const domain = registrableDomain(url.hostname);
      if (!domain) return refusal('held');

      const accept = request.accept ?? 'html';
      const now = () => deps.now().getTime();
      const iso = (ms: number) => new Date(ms).toISOString();
      const gapMs = c.get('SITE_READER_HOST_GAP_SECONDS') * 1000;
      const timeoutMs = c.get('SITE_READER_TIMEOUT_MS');
      const maxBytes = accept === 'image' ? Math.min(c.get('SITE_READER_MAX_BYTES'), c.get('COMPANY_LOGO_MAX_BYTES')) : c.get('SITE_READER_MAX_BYTES');
      const userAgent = deps.config.outside.botUserAgent;
      const transport = options.transport ?? deps.services.siteReaderTransport ?? defaultSiteTransport();
      const gate = options.gate?.(deps) ?? createHostGate(deps, { sleep: options.sleep ?? sleepFor });
      const robots: RobotsReadContext = {
        transport,
        gate,
        store: options.robotsStore?.(deps) ?? createRobotsStore(deps),
        userAgent,
        timeoutMs,
        gapMs,
        maxTurnWaitMs: gapMs * c.get('SITE_READER_TURN_WAIT_GAPS'),
        now,
      };
      const record = (host: string, outcome: HostOutcome) => gate.record(host, outcome).catch(() => undefined);

      for (let hop = 0; ; hop += 1) {
        const host = url.host.toLowerCase();
        const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
        // 4. The opt-out list.
        if (await isOptedOut(deps.db, hostname)) return refusal('opted_out');
        // 5. The host's hold.
        const hold = await holdOf(deps.db, host, iso(now()));
        if (hold) return refusal('held', { retryAt: hold.until });
        // 6. robots.txt.
        try {
          const file = await robotsForHost(robots, host);
          const verdict = robotsVerdict(file, [`${url.pathname}${url.search}`]);
          if (verdict === 'unreachable') {
            return refusal('robots', { retryAt: iso(now() + c.get('INGEST_HOST_BREAKER_HOLD_MINUTES') * 60_000) });
          }
          if (verdict === 'disallowed') return refusal('robots');
          // 7. The host's pace.
          await gate.takeTurn(host, { minIntervalMs: gapMs, maxWaitMs: gapMs * c.get('SITE_READER_TURN_WAIT_GAPS') });
        } catch (error) {
          if (error instanceof HostHeldError) return refusal('held', { retryAt: error.until });
          if (isAddressRefused(error)) return refusal('held');
          throw error;
        }
        // 8. The request.
        const headers: Record<string, string> = { 'User-Agent': userAgent, Accept: ACCEPT[accept], 'Accept-Language': 'en' };
        if (request.etag) headers['If-None-Match'] = request.etag;
        if (request.lastModified) headers['If-Modified-Since'] = request.lastModified;
        let answer: SiteAnswer;
        try {
          answer = await transport.get(url.href, { headers, signal: AbortSignal.timeout(timeoutMs), maxBytes });
        } catch (error) {
          if (isAddressRefused(error)) return refusal('held');
          await record(host, { kind: 'failed', status: 0 });
          return refusal('failed');
        }
        // 9. The answer.
        const { status } = answer;
        const location = status >= 300 && status < 400 && status !== 304 ? answer.headers.get('location') : null;
        if (location) {
          await record(host, { kind: 'answered', status });
          if (hop >= c.get('SITE_READER_MAX_REDIRECTS')) return refusal('failed', { status });
          let next: URL;
          try {
            next = new URL(location, url);
            assertRedirectAllowed(next);
          } catch (error) {
            if (error instanceof OutboundRefusedError || error instanceof TypeError) return refusal('held', { status });
            throw error;
          }
          // A redirect stays on the registrable domain it started on.
          if (registrableDomain(next.hostname) !== domain) return refusal('failed', { status });
          url = next;
          continue;
        }
        if (status === 401 || status === 403 || isChallengeAnswer(answer.headers)) {
          await record(host, { kind: 'bot_check', status });
          return refusal('blocked', { status, retryAt: iso(now() + c.get('INGEST_BOT_CHECK_HOLD_HOURS') * 3_600_000) });
        }
        if (status === 429) {
          const waitMs = retryAfterMs(answer.headers.get('retry-after'), now()) ?? c.get('INGEST_HOST_BREAKER_HOLD_MINUTES') * 60_000;
          await record(host, { kind: 'wait', status, waitMs, hold: true });
          return refusal('blocked', { status, retryAt: iso(now() + waitMs) });
        }
        if (status >= 500) {
          await record(host, { kind: 'failed', status });
          return refusal('failed', { status });
        }
        await record(host, { kind: 'answered', status });
        const etag = answer.headers.get('etag');
        const lastModified = answer.headers.get('last-modified');
        if (status === 304 && (request.etag || request.lastModified)) {
          return { ok: true, status, finalUrl: url.href, contentType: '', body: Buffer.alloc(0), notModified: true, etag, lastModified };
        }
        if (status < 200 || status >= 300 || answer.tooLarge || !isKindAsked(accept, answer, url)) return refusal('failed', { status });
        if (accept === 'html' && wallOf(answer.body.toString('utf8')) !== null) {
          await record(host, { kind: 'bot_check', status });
          return refusal('blocked', { status, retryAt: iso(now() + c.get('INGEST_BOT_CHECK_HOLD_HOURS') * 3_600_000) });
        }
        return {
          ok: true,
          status,
          finalUrl: url.href,
          contentType: mediaTypeOf(answer),
          body: answer.body,
          notModified: false,
          etag,
          lastModified,
        };
      }
    },
  };
}
