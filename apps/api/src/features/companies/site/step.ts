import { createHash } from 'node:crypto';
import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import { newReadsAllowed } from '../../../core/http/identity';
import { siteReader, type SiteReader, type SiteReadResult } from '../../../core/seams';
import { storedRobots } from '../../ingest/hosts';
import { sleepFor } from '../../ingest/http';
import { offerLink } from '../../ingest/discovery/links';
import { addAlias } from '../aliases';
import { copyLogo } from '../logos/pipeline';
import type { LogoRasterizer } from '../logos/rasterize';
import { minConfidenceOf, recomputeProfile, upsertSource } from '../profile';
import { refreshCompanySearchIn } from '../search-refresh'; // v30 FIX-PERF (PGL-19)
import { processSiteBudget, type SiteBudget } from './budget';
import { leiOf, siteFields } from './facts';
import { stepDone, stepRetry, type EnrichmentStepInput, type EnrichmentStepOutcome } from './outcome';
import { parseSitePage, type LogoCandidate } from './page';
import { DAY_MS } from '@tailorit/shared';

// v30 E2: the `company_site` enrichment step (docs/design/part2/13-company-enrichment.md §3.3, §4, §6, §7, §11 phase 2),
// behind SITE_READER_COMPANY_SITES (off until the lawyer's view, owner question 8) and BOT_USER_AGENT (the shared
// reader refuses under the placeholder). One pass reads at most COMPANY_SITE_PAGES_PER_PASS pages through the shared polite reader
// (core/seams siteReader: robots.txt, the host's pace, the connect-time address check), each within the minute's
// COMPANY_SITE_FETCH_PER_MINUTE:
//   1. the homepage (the profile's website, else https://<domain>/), a conditional GET when the last pass kept its
//      validators;
//   2. one "about" page linked from it, only when the homepage has no description;
//   3. the logo: the best candidate (schema.org Organization.logo, the touch icon, a large or vector icon, a
//      JobPosting's hiringOrganization.logo, og:image last), copied through the logo pipeline (decoded and re-encoded by the headless browser, stored by storeLogo); an
//      unchanged address is read again only every second refresh (2 x COMPANY_REFRESH_DAYS_OPEN days), an unchanged
//      file (its hash) is not copied again; a candidate that is no logo gives way to the next while pages are left.
// Its values are one company_sources row (kind company_site, licence own_site, the domain's match confidence), the
// profile is recomputed, a schema.org leiCode becomes an `lei` key, and the open jobs are re-projected when a searched
// value moved. The row's expires_at is its next read: COMPANY_REFRESH_DAYS_OPEN while the company has open jobs, else
// COMPANY_REFRESH_DAYS_CLOSED; after a failure the ladder of 13 §7 (30, then 90, then 365 days by default: a third of
// COMPANY_REFRESH_DAYS_OPEN, then the open and the closed refresh). A refusal by the site (robots.txt, a wall, a 404)
// marks the row and stops using its values; a passing failure (a 5xx, a timeout) keeps them and tries again later.

/** At most this many pages a company per pass: the homepage, an about page, the logo (13 §4 rule 3). */
/** A website's match confidence when its profile says none (a domain the company stated, or an admin's). */
const DEFAULT_SITE_CONFIDENCE = 90;

export interface CompanySiteOptions {
  /** The shared reader (default: core/seams siteReader). */
  reader?: SiteReader;
  /** Draws logos (default: the shared headless browser). */
  rasterizer?: LogoRasterizer;
  /** The minute's budget (default: this process's). */
  budget?: SiteBudget;
  /** How a read waits for the minute's budget inside a pass (default: a timer). */
  sleep?: (ms: number) => Promise<void>;
}

interface CompanyRow {
  owner_user_id: string | null;
  merged_into_id: number | null;
  do_not_fetch: boolean;
  website: string | null;
  domain: string | null;
  confidence: string | null;
  site_id: number | null;
  site_fields: string | null;
  site_status: string | null;
  open_jobs: boolean;
}

/**
 * The row's fields: the site's values (profile field ids) and what the pass keeps beside them, never shown: siteUrl,
 * etag, lastModified, failures, aiInput, nosnippet, lei, parentName, parentUrl, and the logo's logoUrl (the profile's
 * field), logoFiles, logoSourceUrl, logoSha256, logoReadAt.
 */
type PassMemo = Record<string, unknown>;

function parseObject(text: string | null): PassMemo {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as PassMemo) : {};
  } catch {
    return {};
  }
}

/** The homepage to read: the profile's website (https), else its domain's root; null when it has neither. */
export function homepageOf(website: string | null, domain: string | null): string | null {
  for (const candidate of [website, domain ? `https://${domain}/` : null]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return `https://${url.host}${url.pathname === '' ? '/' : url.pathname}`;
    } catch {
      /* the next */
    }
  }
  return null;
}

/** The days to the next read after `failures` failures in a row (13 §7: 30, then 90, then 365 by default). */
export function retryDaysAfter(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, failures: number): number {
  const c = constantsOf(deps);
  const ladder = [Math.ceil(c.get('COMPANY_REFRESH_DAYS_OPEN') / 3), c.get('COMPANY_REFRESH_DAYS_OPEN'), c.get('COMPANY_REFRESH_DAYS_CLOSED')];
  return ladder[Math.min(Math.max(failures, 1), ladder.length) - 1]!;
}

/** The `company_site` step for one company (see the module's note). Outside any transaction. */
export async function runCompanySiteStep(deps: AppDeps, input: EnrichmentStepInput, options: CompanySiteOptions = {}): Promise<EnrichmentStepOutcome> {
  deps.db.assertNoTx('the company site step');
  const c = constantsOf(deps);
  const at = Date.parse(input.at);
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = await deps.db.one<CompanyRow>(
    `SELECT c.owner_user_id, c.merged_into_id, c.do_not_fetch, p.website, p.domain, p.confidence::text AS confidence,
       s.id AS site_id, s.fields::text AS site_fields, s.status AS site_status,
       EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.active /* held_since: counts (the refresh cadence only) */) AS open_jobs
     FROM companies c
     LEFT JOIN company_profiles p ON p.company_id = c.id
     LEFT JOIN company_sources s ON s.company_id = c.id AND s.kind = 'company_site' AND s.ref = ''
     WHERE c.id = ?`,
    [input.companyId],
  );
  if (!row) return stepDone('no such company');
  // An account's own row is never looked up anywhere (13 §5.6); a merged row's survivor is read instead; an opted-out
  // company is never read.
  if (row.owner_user_id !== null || row.merged_into_id !== null || row.do_not_fetch) return stepDone('not read: an own, merged or opted-out company');
  if (!c.get('SITE_READER_COMPANY_SITES')) return stepDone('off: SITE_READER_COMPANY_SITES is off');
  if (!newReadsAllowed(deps)) return stepDone('off: BOT_USER_AGENT is a placeholder');
  const home = homepageOf(row.website, row.domain);
  if (!home) return stepDone('no website to read');

  const reader = options.reader ?? siteReader;
  const budget = options.budget ?? processSiteBudget;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));
  const perMinute = c.get('COMPANY_SITE_FETCH_PER_MINUTE');
  const previous = parseObject(row.site_fields);
  const profileConfidence = parseObject(row.confidence) as Record<string, unknown>;
  const stated = [profileConfidence.website, profileConfidence.domain].find((value): value is number => typeof value === 'number');
  const matchConfidence = Math.max(0, Math.min(100, stated ?? DEFAULT_SITE_CONFIDENCE));
  const refreshDays = c.get(row.open_jobs ? 'COMPANY_REFRESH_DAYS_OPEN' : 'COMPANY_REFRESH_DAYS_CLOSED');

  /** Keeps the pass's row and recomputes the profile, in one transaction. */
  const save = async (
    fields: PassMemo,
    status: 'ok' | 'blocked' | 'robots_disallowed' | 'not_found' | 'error',
    nextAt: number,
    lei: string | null = null,
    careers: string | null = null,
  ) => {
    await deps.db.tx(
      async (t) => {
        const key = { kind: 'company_site', ref: '', licence: 'own_site' as const, matchConfidence, status, expiresAt: iso(nextAt) };
        const source = await upsertSource(t, input.companyId, key, fields, input.at);
        // An unchanged answer writes nothing: its next read moves all the same.
        if (!source.changed) {
          await t.run('UPDATE company_sources SET status = ?, retrieved_at = ?, expires_at = ? WHERE id = ?', [status, input.at, iso(nextAt), source.sourceId]);
        }
        if (lei) await addAlias(t, input.companyId, 'lei', lei, matchConfidence, input.at, { sourceId: source.sourceId });
        // v30 INT-4 (S2's edit C, 12 §4.1 signal 4): the homepage's Careers link is offered to discovery (its ATS board;
        // its career site only while SITE_READER_CAREER_PAGES is on). Nothing is read here.
        if (careers) await offerLink(deps, t, careers, 'company_site', input.at);
        const result = await recomputeProfile(t, input.companyId, input.at, minConfidenceOf(deps));
        await refreshCompanySearchIn(t, input.companyId, result);
      },
      { label: 'company site' },
    );
  };

  /**
   * A pass that read nothing: a refusal by the site marks the row (its values no longer used); a passing failure keeps
   * a good row's values. Either way the next read follows the failure ladder.
   */
  const failed = async (status: 'blocked' | 'robots_disallowed' | 'not_found' | 'error', passing: boolean, note: string) => {
    const failures = (typeof previous.failures === 'number' ? previous.failures : 0) + 1;
    const keep = passing && row.site_status === 'ok';
    await save({ ...previous, failures }, keep ? 'ok' : status, at + retryDaysAfter(deps, failures) * DAY_MS);
    return stepDone(note);
  };

  /** One read within the pass's pages and the minute's budget (a wait for the budget inside a pass). */
  let pages = 0;
  const read = async (request: Parameters<SiteReader['read']>[1]): Promise<SiteReadResult | null> => {
    if (pages >= c.get('COMPANY_SITE_PAGES_PER_PASS')) return null;
    for (let wait = budget.take(perMinute); wait > 0; wait = budget.take(perMinute)) await sleep(wait);
    pages += 1;
    return reader.read(deps, request);
  };

  // 1. The homepage (the minute's budget first: a spent budget puts the whole pass off).
  const wait = budget.take(perMinute);
  if (wait > 0) return stepRetry(iso(at + wait), "the minute's site reads are spent");
  pages = 1;
  const homepage = await reader.read(deps, {
    url: home,
    purpose: 'company_site',
    accept: 'html',
    etag: typeof previous.etag === 'string' && previous.siteUrl === home ? previous.etag : null,
    lastModified: typeof previous.lastModified === 'string' && previous.siteUrl === home ? previous.lastModified : null,
  });
  if (!homepage.ok) {
    switch (homepage.refusal) {
      case 'switch_off':
      case 'identity_placeholder':
        return stepDone(`off: ${homepage.refusal}`);
      case 'opted_out':
        return stepDone('not read: the domain is opted out');
      case 'robots':
        return homepage.retryAt ? stepRetry(homepage.retryAt, 'robots.txt cannot be read now') : failed('robots_disallowed', false, 'robots.txt disallows the homepage');
      case 'held':
        return homepage.retryAt ? stepRetry(homepage.retryAt, 'the host is held') : failed('error', true, 'the site is not at a public https address');
      case 'blocked':
        return failed('blocked', false, `the site refused TailorIT (HTTP ${homepage.status ?? '?'})`);
      default:
        return homepage.status === 404 || homepage.status === 410
          ? failed('not_found', false, `the homepage is gone (HTTP ${homepage.status})`)
          : failed('error', true, `the homepage could not be read${homepage.status ? ` (HTTP ${homepage.status})` : ''}`);
    }
  }

  let fields: PassMemo;
  let candidates: LogoCandidate[];
  let lei: string | null = null;
  let careers: string | null = null;
  if (homepage.notModified) {
    // Unchanged since the last pass: its values stand; only the logo may be due again (its address as kept).
    fields = { ...previous };
    candidates = typeof previous.logoSourceUrl === 'string' ? [{ url: previous.logoSourceUrl, from: 'organization', declared: null, vector: false }] : [];
    lei = typeof previous.lei === 'string' ? previous.lei : null;
  } else {
    const page = parseSitePage(homepage.body.toString('utf8'), homepage.finalUrl);
    careers = page.careersUrl;
    let aboutDescription: string | null = null;
    // 2. An about page, only when the homepage has no description (and has not asked not to be quoted).
    if (!page.description && !page.nosnippet && page.aboutUrl) {
      const about = await read({ url: page.aboutUrl, purpose: 'company_site', accept: 'html' });
      if (about?.ok && !about.notModified) {
        const aboutPage = parseSitePage(about.body.toString('utf8'), about.finalUrl);
        aboutDescription = aboutPage.nosnippet ? null : aboutPage.description;
      } else if (about && !about.ok && about.refusal === 'blocked') {
        return failed('blocked', false, `the site refused TailorIT on its about page (HTTP ${about.status ?? '?'})`);
      }
    }
    const day = new Date(at).toISOString().slice(0, 10);
    lei = leiOf(page.organization?.leiCode ?? null);
    const robots = await storedRobots(deps.db, new URL(homepage.finalUrl).host).catch(() => null);
    fields = {
      ...siteFields(page, { finalUrl: homepage.finalUrl, day, aboutDescription }),
      siteUrl: home,
      etag: homepage.etag,
      lastModified: homepage.lastModified,
      // The site's text as AI input (E3): never under nosnippet, nor when its robots.txt says ai-input=no (12 §1 test 5).
      aiInput: !page.nosnippet && robots?.aiInput !== false,
      nosnippet: page.nosnippet,
      ...(lei ? { lei } : {}),
      ...(page.organization?.parentName ? { parentName: page.organization.parentName } : {}),
      ...(page.organization?.parentUrl ? { parentUrl: page.organization.parentUrl } : {}),
    };
    // The last logo, kept until this pass finds a better one.
    for (const key of ['logoUrl', 'logoFiles', 'logoSourceUrl', 'logoSha256', 'logoReadAt'] as const) {
      if (previous[key] !== undefined) fields[key] = previous[key];
    }
    // A JobPosting's hiringOrganization.logo (S5's hand-off, kept by E0-API as the posting row's logoSourceUrl) is the
    // company's own word too: after the homepage's own logo and icons, before its og:image.
    const stated = await deps.db.all<{ url: string }>(
      `SELECT DISTINCT fields->>'logoSourceUrl' AS url FROM company_sources
       WHERE company_id = ? AND kind = 'job_posting' AND status = 'ok' AND fields->>'logoSourceUrl' IS NOT NULL LIMIT 3`,
      [input.companyId],
    );
    const fromPostings: LogoCandidate[] = stated.map(({ url }) => ({ url, from: 'organization', declared: null, vector: /\.svg(?:$|[?#])/i.test(url) }));
    const seen = new Set<string>();
    candidates = [...page.logos.filter((logo) => logo.from !== 'og_image'), ...fromPostings, ...page.logos.filter((logo) => logo.from === 'og_image')].filter(
      (logo) => !seen.has(logo.url) && Boolean(seen.add(logo.url)),
    );
  }

  // 3. The logo.
  const logoDueAt = typeof previous.logoReadAt === 'string' ? Date.parse(previous.logoReadAt) + 2 * c.get('COMPANY_REFRESH_DAYS_OPEN') * DAY_MS : 0;
  for (const candidate of candidates) {
    // The same address, read lately: the copy stands.
    if (candidate.url === previous.logoSourceUrl && typeof previous.logoUrl === 'string' && at < logoDueAt) break;
    const image = await read({ url: candidate.url, purpose: 'company_site', accept: 'image' });
    if (!image) break;
    if (!image.ok || image.notModified) continue;
    const sha = createHash('sha256').update(image.body).digest('hex');
    if (sha === previous.logoSha256 && typeof previous.logoUrl === 'string') {
      Object.assign(fields, { logoSourceUrl: candidate.url, logoReadAt: input.at });
      break;
    }
    let copied;
    try {
      copied = await copyLogo(deps, image.body, {
        rasterizer: options.rasterizer,
        squareOnly: candidate.from === 'og_image',
        wordmark: candidate.from === 'organization',
      });
    } catch (error) {
      // No browser to draw it: the address is kept for the next pass.
      deps.log.warn(`[companies] a logo of company ${input.companyId} could not be drawn: ${(error as Error).message}`);
      break;
    }
    if ('refused' in copied) continue;
    Object.assign(fields, {
      logoUrl: copied.path,
      logoFiles: copied.files,
      logoSourceUrl: candidate.url,
      logoSha256: copied.sourceSha256,
      logoReadAt: input.at,
    });
    break;
  }

  fields.failures = 0;
  await save(fields, 'ok', at + refreshDays * DAY_MS, lei, careers);
  return stepDone(homepage.notModified ? 'read: the homepage is unchanged' : `read: ${pages} page${pages === 1 ? '' : 's'}`);
}
