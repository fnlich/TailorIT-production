import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import { assertNewReadAllowed, NewReadRefusedError } from '../../../core/http/identity';
import { assertRedirectAllowed } from '../../../core/http/outbound';
// The reader's modules themselves (not its index, which a test of another package may mock with siteReader alone).
import { isAddressRefused } from '../../../core/http/reader/address';
import { defaultSiteTransport, type SiteAnswer, type SiteTransport } from '../../../core/http/reader/transport';
import { createHostGate, holdOf } from '../../ingest/hosts';
import { HostHeldError, retryAfterMs, sleepFor, type HostGate } from '../../ingest/http';
import { minConfidenceOf, recomputeProfile, upsertSource } from '../profile';
import { stepDone, stepRetry, type EnrichmentStepInput, type EnrichmentStepOutcome } from '../site/outcome';
import { copyLogo } from './pipeline';
import type { LogoRasterizer } from './rasterize';
import { DAY_MS } from '@tailorit/shared';

// v30 E2: logo.dev for the logos a company's own site does not give (docs/design/part2/13-company-enrichment.md §3.1,
// §6.1 "logo_path" third, §9; owner question 20: the paid plan, no credit link). Off while LOGO_DEV_KEY is empty, and a
// new kind of outside read (assertNewReadAllowed 'logo_dev'): nothing is sent while BOT_USER_AGENT is a placeholder.
//
// logo.dev's API (its docs, read 2026-11-16: www.logo.dev/docs, "Get a logo" of the v2 API): GET
// https://api.logo.dev/v2/brands/logo?domain=<domain> with `Authorization: Bearer <secret key>` (sk_, server side
// only) answers JSON whose data.url is a temporary signed download address (format=png may be added to it); 404 is "no
// brand or no logo", 202 "not indexed yet, retry after Retry-After". Its terms let TailorIT store what the API returns
// (13 [S30]); its CDN (img.logo.dev, the publishable key) is for hot-linking and is never used. The file is copied
// through the logo pipeline (decoded and drawn again, stored by storeLogo) and kept as a `logo_dev` company_sources
// row (licence vendor_contract, purge group logo_dev: deleted together if the plan ends), ranked after the site's own
// logo. Both requests go through the reader's undici transport (the connect-time address check) under each host's pace
// (crawl_hosts) with BOT_USER_AGENT; a keyed API's host has no robots.txt read (12 §1, "Keyed APIs").

export const LOGO_DEV_API = 'https://api.logo.dev/v2/brands/logo';
/** The one host the keyed API call may reach (v30 FIX-C SEC-1: a redirect away from it is refused, never followed). */
const LOGO_DEV_API_HOST = new URL(LOGO_DEV_API).hostname;
/** The source rows' purge group: every logo.dev row goes together if the plan ends. */
export const LOGO_DEV_PURGE_GROUP = 'logo_dev';
/** The most bytes of logo.dev's JSON answer. */
const API_ANSWER_BYTES = 100_000;
const DEFAULT_CONFIDENCE = 90;

export interface LogoDevOptions {
  transport?: SiteTransport;
  rasterizer?: LogoRasterizer;
  gate?: HostGate;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface Row {
  owner_user_id: string | null;
  merged_into_id: number | null;
  do_not_fetch: boolean;
  domain: string | null;
  logo_path: string | null;
  confidence: string | null;
  dev_status: string | null;
  dev_expires_at: string | null;
}

class Held extends Error {
  constructor(readonly retryAt: string) {
    super('held');
  }
}

/** The `logo_dev` step for one company (see the module's note). Outside any transaction. */
export async function runLogoDevStep(deps: AppDeps, input: EnrichmentStepInput, options: LogoDevOptions = {}): Promise<EnrichmentStepOutcome> {
  deps.db.assertNoTx('the logo.dev step');
  const c = constantsOf(deps);
  const at = Date.parse(input.at);
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = await deps.db.one<Row>(
    `SELECT c.owner_user_id, c.merged_into_id, c.do_not_fetch, p.domain, p.logo_path, p.confidence::text AS confidence,
       s.status AS dev_status, s.expires_at AS dev_expires_at
     FROM companies c
     LEFT JOIN company_profiles p ON p.company_id = c.id
     LEFT JOIN company_sources s ON s.company_id = c.id AND s.kind = 'logo_dev' AND s.ref = ''
     WHERE c.id = ?`,
    [input.companyId],
  );
  if (!row) return stepDone('no such company');
  if (row.owner_user_id !== null || row.merged_into_id !== null || row.do_not_fetch) return stepDone('not read: an own, merged or opted-out company');
  const key = deps.config.outside.logoDevKey;
  if (!key) return stepDone('off: LOGO_DEV_KEY is empty');
  try {
    assertNewReadAllowed(deps, 'logo_dev');
  } catch (error) {
    if (error instanceof NewReadRefusedError) return stepDone('off: BOT_USER_AGENT is a placeholder');
    throw error;
  }
  if (!row.domain) return stepDone('no domain to ask for');
  if (row.logo_path) return stepDone('the company has a logo');
  if (row.dev_status === 'not_found' && row.dev_expires_at && Date.parse(row.dev_expires_at) > at) return stepDone('logo.dev had none lately');

  const transport = options.transport ?? deps.services.siteReaderTransport ?? defaultSiteTransport();
  const gate = options.gate ?? createHostGate(deps, { sleep: options.sleep ?? sleepFor });
  const userAgent = deps.config.outside.botUserAgent;
  const floor = c.get('INGEST_HOST_MIN_INTERVAL_MS');

  /**
   * One GET under its host's pace and holds (redirects followed, at most 3, each hop checked). v30 FIX-C SEC-1: with
   * `pinHost` every hop must stay on that host (the keyed API call); once a hop leaves the first address's origin it
   * carries none of the headers the caller added (the key above all), even back on that origin.
   */
  const get = async (address: string, headers: Record<string, string>, maxBytes: number, pinHost?: string): Promise<SiteAnswer> => {
    let url = new URL(address);
    const origin = url.origin;
    let added = headers;
    for (let hop = 0; ; hop += 1) {
      assertRedirectAllowed(url, pinHost === undefined ? undefined : (host) => host === pinHost);
      if (url.origin !== origin) added = {};
      const hold = await holdOf(deps.db, url.host, iso(deps.now().getTime()));
      if (hold) throw new Held(hold.until);
      try {
        await gate.takeTurn(url.host, { minIntervalMs: floor, maxWaitMs: 60_000 });
      } catch (error) {
        if (error instanceof HostHeldError) throw new Held(error.until);
        throw error;
      }
      let answer: SiteAnswer;
      try {
        answer = await transport.get(url.href, { headers: { 'User-Agent': userAgent, ...added }, signal: AbortSignal.timeout(c.get('SITE_READER_TIMEOUT_MS')), maxBytes });
      } catch (error) {
        if (!isAddressRefused(error)) await gate.record(url.host, { kind: 'failed', status: 0 }).catch(() => undefined);
        throw error;
      }
      const location = answer.status >= 300 && answer.status < 400 ? answer.headers.get('location') : null;
      if (answer.status === 401 || answer.status === 403) await gate.record(url.host, { kind: 'bot_check', status: answer.status }).catch(() => undefined);
      else if (answer.status === 429 || answer.status === 202) {
        const waitMs = retryAfterMs(answer.headers.get('retry-after'), deps.now().getTime()) ?? 30_000;
        await gate.record(url.host, { kind: 'wait', status: answer.status, waitMs, hold: answer.status === 429 }).catch(() => undefined);
      } else await gate.record(url.host, answer.status >= 500 ? { kind: 'failed', status: answer.status } : { kind: 'answered', status: answer.status }).catch(() => undefined);
      if (!location || hop >= 3) return answer;
      url = new URL(location, url);
    }
  };

  /** The logo_dev row and the profile, in one transaction. */
  const save = async (fields: Record<string, unknown>, status: 'ok' | 'not_found' | 'error', days: number) => {
    const confidence = (() => {
      try {
        const parsed = JSON.parse(row.confidence ?? '{}') as Record<string, unknown>;
        return typeof parsed.domain === 'number' ? parsed.domain : DEFAULT_CONFIDENCE;
      } catch {
        return DEFAULT_CONFIDENCE;
      }
    })();
    await deps.db.tx(
      async (t) => {
        const source = await upsertSource(
          t,
          input.companyId,
          { kind: 'logo_dev', ref: '', licence: 'vendor_contract', matchConfidence: confidence, status, expiresAt: iso(at + days * DAY_MS), purgeGroup: LOGO_DEV_PURGE_GROUP },
          fields,
          input.at,
        );
        if (!source.changed) {
          await t.run('UPDATE company_sources SET status = ?, retrieved_at = ?, expires_at = ? WHERE id = ?', [status, input.at, iso(at + days * DAY_MS), source.sourceId]);
        }
        await recomputeProfile(t, input.companyId, input.at, minConfidenceOf(deps));
      },
      { label: 'logo.dev' },
    );
  };

  try {
    const api = new URL(LOGO_DEV_API);
    api.searchParams.set('domain', row.domain);
    const answer = await get(api.href, { Accept: 'application/json', Authorization: `Bearer ${key}` }, API_ANSWER_BYTES, LOGO_DEV_API_HOST);
    if (answer.status === 404) {
      await save({}, 'not_found', c.get('COMPANY_REFRESH_DAYS_CLOSED'));
      return stepDone('logo.dev has no logo for the domain');
    }
    if (answer.status === 202 || answer.status === 429) {
      return stepRetry(iso(at + (retryAfterMs(answer.headers.get('retry-after'), at) ?? 30_000)), 'logo.dev asked to wait');
    }
    if (answer.status === 401 || answer.status === 403) {
      deps.log.warn(`[companies] logo.dev refused LOGO_DEV_KEY (HTTP ${answer.status}): it must be the secret key (sk_)`);
      return stepRetry(iso(at + c.get('INGEST_BOT_CHECK_HOLD_HOURS') * 3_600_000), 'logo.dev refused the key');
    }
    if (answer.status !== 200 || answer.tooLarge) return stepRetry(iso(at + c.get('INGEST_HOST_BREAKER_HOLD_MINUTES') * 60_000), `logo.dev answered HTTP ${answer.status}`);
    const data = (() => {
      try {
        const json = JSON.parse(answer.body.toString('utf8')) as { data?: { url?: unknown; brand_id?: unknown; etag?: unknown } };
        return json.data ?? null;
      } catch {
        return null;
      }
    })();
    if (!data || typeof data.url !== 'string') return stepRetry(iso(at + DAY_MS), 'logo.dev answered without a download address');
    const download = new URL(data.url);
    if (!download.searchParams.has('format')) download.searchParams.set('format', 'png');
    const file = await get(download.href, { Accept: 'image/png,image/*;q=0.8' }, c.get('COMPANY_LOGO_MAX_BYTES'));
    if (file.status !== 200 || file.tooLarge) return stepRetry(iso(at + c.get('INGEST_HOST_BREAKER_HOLD_MINUTES') * 60_000), `the logo download answered HTTP ${file.status}`);
    const copied = await copyLogo(deps, file.body, { rasterizer: options.rasterizer, wordmark: true });
    if ('refused' in copied) {
      await save({ refused: copied.refused }, 'error', c.get('COMPANY_REFRESH_DAYS_CLOSED'));
      return stepDone(`logo.dev's logo is no logo TailorIT keeps (${copied.refused})`);
    }
    await save(
      {
        logoUrl: copied.path,
        logoFiles: copied.files,
        logoSha256: copied.sourceSha256,
        ...(typeof data.brand_id === 'string' ? { brandId: data.brand_id } : {}),
      },
      'ok',
      c.get('COMPANY_REFRESH_DAYS_CLOSED'),
    );
    return stepDone('read: logo.dev');
  } catch (error) {
    if (error instanceof Held) return stepRetry(error.retryAt, 'the host is held');
    if (isAddressRefused(error)) return stepDone('not read: no public address');
    // No answer, a refused address, or no browser to draw the logo: try again later.
    return stepRetry(iso(at + c.get('INGEST_HOST_BREAKER_HOLD_MINUTES') * 60_000), `logo.dev could not be read: ${(error as Error).message}`);
  }
}
