import { DAY_MS, decodeHtmlEntities, parseSalary, type ExperienceLevel, type WorkArrangement } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types'; // v37 FIX-37A
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { OutboundRefusedError } from '../../../core/http/outbound'; // v37 FIX-37A (F12)
// The one close function (core/seams re-exports it from here; a test's vi.mock of this path reaches this import too).
import { closeLink } from '../close';
import { placeOfParts } from '../career/jsonld'; // v37 FIX-37A
import { plainTextOf } from '../../jobs/text';
import { sanitizeDescription } from '../html';
import { HostHeldError, IngestHttpError, type GetJsonOptions, type HttpAnswer, type IngestHttp } from '../http'; // v37 FIX-37A: GetJsonOptions, HttpAnswer
import { holdOf } from '../hosts'; // v37 INT-B
import { salaryFromText, storedSourceJobId } from '../normalize';
import { RobotsRefusal } from '../robots';
import { BAMBOOHR_BOARD, BAMBOOHR_OWN_LABELS, bamboohrCompany } from '@tailorit/shared/sourcing'; // v38 FRAME: the board registry's rules
import { IngestError, SourceNotFoundError, type FetchFailure, type ListingValidators, type RawPosting, type RawSalary } from '../types';
import { isRecord, nameFromSlug, num, records, str, type Json } from './common';
import { conditionalOf, defineAdapter, notModifiedResult } from './define';
import { loadReadFailures, orderByFailures, saveReadFailures, type ReadFailures } from './read-failures'; // v37 FIX-37A (F8)

// v30 S3: BambooHR's careers list (docs/design/part2/12-job-sourcing.md §3.3): GET
// https://{company}.bamboohr.com/careers/list, `{ meta: { totalCount }, result: [{ id, jobOpeningName, departmentLabel,
// employmentStatusLabel, location { city, state }, atsLocation { city, state, province, country }, isRemote,
// locationType }] }`, the list the company's careers page reads; each opening's page is /careers/{id}. Its tests use
// answers written by hand in that shape (tools/ats-fixtures).
//
// v37 BOARDS (SP v37 PLAN B1, B2): the owner decided on 2026-11-24 that TailorIT reads BambooHR (sources.ts KIND_TERMS:
// a new source starts "allowed with conditions" with the dated note; migration 0063 writes it on the older ones). A run
// reads the list, then each opening's own detail, GET https://{company}.bamboohr.com/careers/{id}/detail,
// `{ result: { jobOpening: { jobOpeningShareUrl, jobOpeningName, jobOpeningStatus, departmentLabel, employmentStatusLabel,
// location { city, state, postalCode, addressCountry }, atsLocation { country, state, city }, description (HTML),
// compensation (free text), datePosted (YYYY-MM-DD), minimumExperience, locationType }, formFields: {...} } }` (the same
// JSON the careers page loads; `formFields`, the apply form, is never read or kept). A missing id answers 404.
//
// A run reads only what it must, as a Workable account's does: the list, then the openings TailorIT has not stored
// for this source (new, in the list's order), those whose link is closed (listed again: read to reopen), then those not
// read for BAMBOOHR_RECHECK_DAYS (the oldest first), at most BAMBOOHR_READS_PER_RUN a run. The rest of the list is seen
// (skippedIds): never wiped, since a posting sent without its text would lose its stored text (store.ts rewriteJob
// always rewrites it), and never closed while the list names it. An opening whose detail answers 404 (or whose status is
// no longer Open) closes its link through the one close function (closeLink, reason `gone`), and its job once no live
// link is left; the list, complete, still closes an opening it no longer names after two misses (store.ts markMissing).
// A held host stops the reads (the run keeps what it read, its listing incomplete: nothing closes by absence); after
// BAMBOOHR_FAILURES_IN_A_ROW failed reads in a row the run stops the same way.
// v37 INT-B (as LANE's W4 stops a Workday run): a 429 the request's own retries could not get past stops the reads at
// once too (each company is its own host, at its own pace), never grinding through the rest of the plan; the run keeps
// what it read and answers the host's hold, if any (FetchResult.heldUntil), so its next run is due after it.
//
// Add job and the re-checks read one opening the same way (readBamboohrPosting; ingest/postings.ts), so an opening is
// stored alike however it was read.
//
// v37 FIX-37A (SP v37 FIXES-37):
//   - E6: BambooHR's JSON names no employer. A run names its openings by the source's companyName, else by the name
//     the company's careers page gives (GET /careers, its <meta property="og:site_name">: one request, only when the
//     source has no name and the run stores an opening, kept as the source's companyName), else by the company's
//     name in its address made readable. Add job (jobs/add/board-link.ts) puts an admin import row's company first.
//   - F3: the list's validators are kept only when nothing due was left unread (past the cap, waiting after a failed
//     read, or stopped), and the list is asked for without them while a stored opening is due a re-read: a 304 never
//     hides openings a run still has to read.
//   - F8: an opening whose detail read failed is read after the others and backed off (adapters/read-failures.ts).
//   - F12: an unknown company (its list answers a redirect to BambooHR's own site) is a missing board, not a refused one.
//     v38 FIX-C (REVIEW38-beh L2): only a redirect to BambooHR's home page (www.bamboohr.com or bamboohr.com at "/") is;
//     any other redirect (a sign-in page, no address) fails the read and closes nothing.
//   - REVIEW37-ux L1: BambooHR's own hosts (www, app, ...) are never a company.
//
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The most of one detail answer read (its text and the apply form's fields run to some tens of kilobytes): 2 MB. */
export const BAMBOOHR_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
/** A run stops after this many failed detail reads in a row. */
export const BAMBOOHR_FAILURES_IN_A_ROW = 5;

/** An opening's id as BambooHR writes it. */
const OPENING_ID = /^[0-9]{1,20}$/;

/**
 * v37 FIX-37A (REVIEW37-ux L1): the labels of BambooHR's own hosts, never a company's. v37 INT-2b: the one API list
 * (FIX-37B's Add source list joined in; the web's sources.ts BAMBOOHR_OWN_LABELS says the same under the field).
 */
export { BAMBOOHR_OWN_LABELS };

/**
 * The company's name on BambooHR as typed: a name or an address on bamboohr.com ('' for none, or BambooHR's own host).
 * v38 FRAME: the shared board registry's BAMBOOHR_BOARD normaliser (moved there unchanged).
 */
export { bamboohrCompany };

/** v37 FIX-37A (F12): the redirects an unknown company's addresses answer (to BambooHR's own site). */
const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
const isBamboohrHost = (host: string) => host === 'bamboohr.com' || host.endsWith('.bamboohr.com');
/** v38 FIX-C (beh-L2): the redirects of one request on the company's own host followed, at most. */
const SAME_HOST_HOPS = 3;

/**
 * v38 FIX-C (REVIEW38-beh L2; SP v38 EVIDENCE.md §6): BambooHR's own home page, www.bamboohr.com (or bamboohr.com) at
 * "/", where it sends an unknown company. No other redirect is that sign (a sign-in page, another company's host).
 */
function isBamboohrHome(location: string | null | undefined): boolean {
  let url: URL;
  try {
    url = new URL(location ?? '');
  } catch {
    return false;
  }
  return url.protocol === 'https:' && ['www.bamboohr.com', 'bamboohr.com'].includes(url.hostname.toLowerCase()) && (url.pathname === '/' || url.pathname === '');
}

/**
 * v37 FIX-37A (F12): a request that stays on the company's host, and says whether it was sent away to BambooHR's own
 * site (an unknown company: its list, detail and careers page answer a redirect to bamboohr.com).
 * v38 FIX-C (REVIEW38-beh L2): an unknown company is ONLY its redirect to BambooHR's home page (isBamboohrHome): the
 * client answers each redirect (never following it), a hop on the company's own host is followed here (at most
 * SAME_HOST_HOPS), a redirect with no address or to another BambooHR page (app.bamboohr.com's sign-in, another company's
 * host) fails the read (can't read: IngestError), and one to any other host is refused as before (OutboundRefusedError).
 */
async function onTenant(
  http: IngestHttp,
  url: string,
  host: string,
  options: Omit<GetJsonOptions, 'allowRedirectHost'>,
): Promise<{ answer: HttpAnswer | null; unknownCompany: boolean }> {
  let address = url;
  for (let hop = 0; ; hop += 1) {
    const answer = await http.getJson(address, { ...options, followRedirects: false, allowRedirectHost: (to) => to === host });
    // v38 INT (closed only on a positive sign): a page answered on the company's own host where JSON was asked for (a
    // challenge page) says nothing of the opening: it fails the read (ATS-D read it as an unknown company).
    if (!(REDIRECT_STATUSES as readonly number[]).includes(answer.status)) return { answer, unknownCompany: false };
    if (isBamboohrHome(answer.location)) return { answer: null, unknownCompany: true };
    let next: URL | null = null;
    try {
      next = answer.location ? new URL(answer.location) : null;
    } catch {
      next = null;
    }
    const nextHost = next?.hostname.toLowerCase() ?? '';
    if (next && next.protocol === 'https:' && nextHost === host && hop < SAME_HOST_HOPS) {
      address = next.href;
      continue;
    }
    if (!next || isBamboohrHost(nextHost)) throw new IngestError('BambooHR answered with a redirect that is no answer about the company: TailorIT reads it again later.');
    throw new OutboundRefusedError('TailorIT follows no redirect away from the service it asked.');
  }
}

/** A BambooHR source's listing: its host and address. */
export function bamboohrFeedOf(config: Record<string, unknown>): { company: string; host: string; url: string } {
  const company = bamboohrCompany(str(config.company) ?? '');
  const host = company ? BAMBOOHR_BOARD.hostOf({ company }) : null;
  if (!host) throw new IngestError('This source has no BambooHR company name ({company}.bamboohr.com). Edit the source and add it.');
  return { company, host, url: `https://${host}/careers/list` };
}

/** v37 BOARDS: an opening's own detail (its text, date, pay): the JSON its careers page loads. */
export const bamboohrDetailUrl = (host: string, id: string) => `https://${host}/careers/${encodeURIComponent(id)}/detail`;

/** An opening's own page, as its list and its share link write it: Apply opens it. */
export const bamboohrJobUrl = (host: string, id: string) => `https://${host}/careers/${id}`;

/** locationType ("0" on site, "1" remote, "2" hybrid) or isRemote. */
function arrangementOf(opening: Json): WorkArrangement | null {
  const type = str(opening.locationType);
  if (type === '1' || opening.isRemote === true) return 'remote';
  if (type === '2') return 'hybrid';
  if (type === '0') return 'onsite';
  return null;
}

/**
 * An opening's place as the places reader reads it: its ATS place (city, state or province, country), else its address
 * (city, state, and v37 BOARDS: the detail's country).
 */
function placeOf(opening: Json): string | null {
  const ats = isRecord(opening.atsLocation) ? opening.atsLocation : null;
  const plain = isRecord(opening.location) ? opening.location : null;
  // v37 FIX-37A (E5): cleaned as a JSON-LD place is (placeholders dropped, a country code as its name).
  const fromAts = ats ? placeOfParts(str(ats.city), str(ats.state) ?? str(ats.province), str(ats.country)) : null;
  return fromAts ?? placeOfParts(str(plain?.city), str(plain?.state), str(plain?.addressCountry));
}

/** One opening as a RawPosting; null when it lacks an id or a name. */
export function bamboohrPosting(opening: Json, host: string, companyName: string): RawPosting | null {
  const id = str(opening.id);
  const title = str(opening.jobOpeningName);
  if (!id || !OPENING_ID.test(id) || !title) return null;
  const place = placeOf(opening);
  const arrangement = arrangementOf(opening);
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    url: bamboohrJobUrl(host, id),
    locations: place ? [place] : arrangement === 'remote' ? ['Remote'] : [],
    workArrangement: arrangement,
    employmentText: str(opening.employmentStatusLabel),
    department: str(opening.departmentLabel),
  };
}

/** v37 BOARDS: BambooHR's minimum experience ("Entry-level", "Mid-level", "Experienced", ...) as TailorIT's levels. */
const EXPERIENCE: ReadonlyArray<readonly [RegExp, ExperienceLevel[]]> = [
  [/\b(?:entry|student|intern)/i, ['entry']],
  [/\bmid/i, ['mid']],
  [/\bexecutive/i, ['expert']],
  [/\b(?:experienced|senior|manager|supervisor)/i, ['senior']],
];

/** The levels a minimum experience names (none for words it does not know). */
export function bamboohrExperience(value: unknown): ExperienceLevel[] {
  const text = str(value);
  if (!text) return [];
  return EXPERIENCE.find(([pattern]) => pattern.test(text))?.[1] ?? [];
}

/**
 * v37 BOARDS: the opening's free-text pay ("$19.00 per hour"): a salary when it reads as one (its words kept); else, when
 * the description names no pay of its own, its words alone (the job keeps them as its pay's text); else none, so the
 * description's pay is read (ingest/normalize.ts).
 */
export function bamboohrSalary(compensation: string | null, descriptionHtml: string | null): RawSalary | null {
  const text = compensation?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return null;
  const parsed = parseSalary(text);
  if (parsed) return { ...parsed, raw: text };
  if (descriptionHtml && salaryFromText(plainTextOf(sanitizeDescription(descriptionHtml)))) return null;
  return { min: null, max: null, currency: null, period: null, raw: text };
}

/**
 * v37 BOARDS: an opening's detail (`result.jobOpening`) as a RawPosting, for the opening `id` (its answer names no id: its
 * share link, when it gives one, must be this opening's); null when it lacks a name. Its text, date, place with its
 * country, employment status, minimum experience and pay are the detail's; the apply form is never read.
 */
export function bamboohrDetailPosting(opening: Json, host: string, id: string, companyName: string): RawPosting | null {
  const base = bamboohrPosting({ ...opening, id }, host, companyName);
  if (!base) return null;
  const share = str(opening.jobOpeningShareUrl);
  if (share && !new RegExp(`/careers/${id}(?:[/?#]|$)`).test(share)) throw new IngestError('BambooHR answered with another opening.');
  const descriptionHtml = str(opening.description);
  const levels = bamboohrExperience(opening.minimumExperience);
  return {
    ...base,
    descriptionHtml,
    employmentText: str(opening.employmentStatusLabel) ?? str(opening.employmentType),
    ...(levels.length > 0 ? { experienceLevels: levels } : {}),
    salary: bamboohrSalary(str(opening.compensation), descriptionHtml),
    postedAt: str(opening.datePosted),
  };
}

/** Whether a detail's opening is one BambooHR still shows (no status counts as one). */
function isOpen(opening: Json): boolean {
  const status = str(opening.jobOpeningStatus);
  return status === null || status.toLowerCase() === 'open';
}

/**
 * v37 BOARDS: one opening read from its detail (at most BAMBOOHR_ANSWER_MAX_BYTES), on the company's host only: null
 * when it is gone (404, or its status is no longer Open). Throws IngestHttpError when BambooHR fails, RobotsRefusal when
 * robots.txt refuses it, and IngestError when the answer is not that opening.
 */
export async function readBamboohrPosting(
  http: IngestHttp,
  company: string,
  id: string,
  companyName: string,
  signal?: AbortSignal,
): Promise<RawPosting | null> {
  const host = BAMBOOHR_BOARD.hostOf({ company });
  if (!host || !OPENING_ID.test(id)) throw new IngestError('TailorIT does not know this BambooHR opening.');
  // v37 FIX-37A (F12): an unknown company's detail is no opening (gone, as a 404).
  const { answer, unknownCompany } = await onTenant(http, bamboohrDetailUrl(host, id), host, {
    signal,
    allow: [404],
    maxBytes: BAMBOOHR_ANSWER_MAX_BYTES,
  });
  if (!answer || unknownCompany || answer.status === 404) return null;
  const result = isRecord(answer.data) && isRecord(answer.data.result) ? answer.data.result : null;
  const opening = result && isRecord(result.jobOpening) ? result.jobOpening : null;
  if (!opening) throw new IngestError('BambooHR answered without an opening.');
  if (!isOpen(opening)) return null;
  const raw = bamboohrDetailPosting(opening, host, id, companyName);
  if (!raw) throw new IngestError("BambooHR's opening has no name.");
  return raw;
}

/** v37 FIX-37A (E6): the company's careers page (its name is there, and nowhere in the JSON). */
export const bamboohrCareersUrl = (host: string) => `https://${host}/careers`;
/** v37 FIX-37A (E6): the most of the careers page read (it runs to about 100 kB): 1 MB. */
export const BAMBOOHR_CAREERS_PAGE_MAX_BYTES = 1024 * 1024;
const OG_SITE_NAME = /<meta\b[^>]*\bproperty\s*=\s*["']og:site_name["'][^>]*>/i;
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** v37 FIX-37A (E6): the company's name a careers page gives (its og:site_name), or null (none, or "BambooHR" itself). */
export function bamboohrNameOfPage(html: string): string | null {
  const tag = OG_SITE_NAME.exec(html)?.[0];
  const content = tag ? CONTENT_ATTRIBUTE.exec(tag) : null;
  const name = decodeHtmlEntities(content?.[1] ?? content?.[2] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return name && !/^bamboo\s*hr$/i.test(name) ? name : null;
}

/**
 * v37 FIX-37A (E6): the company's name from its careers page (one request, on the company's host only), or null when
 * the page names none or cannot be read now (best effort: a failure never fails the read it serves).
 */
export async function readBamboohrCompanyName(http: IngestHttp, company: string, signal?: AbortSignal): Promise<string | null> {
  const host = BAMBOOHR_BOARD.hostOf({ company });
  if (!host) return null;
  try {
    const { answer } = await onTenant(http, bamboohrCareersUrl(host), host, {
      signal,
      text: true,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      allow: [404],
      maxBytes: BAMBOOHR_CAREERS_PAGE_MAX_BYTES,
    });
    return answer?.status === 200 && typeof answer.data === 'string' ? bamboohrNameOfPage(answer.data) : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** v37 FIX-37A (E6): keeps a name the careers page gave as the source's companyName, unless one was set meanwhile. */
export async function keepBamboohrCompanyName(db: DbQueries, sourceId: number, name: string): Promise<void> {
  await db.run(
    `UPDATE job_sources SET config = jsonb_set(config, '{companyName}', to_jsonb(CAST(? AS text)))
     WHERE id = ? AND COALESCE(config->>'companyName', '') = ''`,
    [name, sourceId],
  );
}

/** One of the source's links as the plan reads it. */
export interface BamboohrStoredLink {
  source_job_id: string;
  job_id: number;
  live: boolean;
  /** When it was last read: its last sighting or its last read of its own (the later), ISO. */
  read_at: string;
}

/**
 * v37 BOARDS: the listed openings a run reads, in order (see the top): new ones in the list's order, those whose link is
 * closed (listed again: read to reopen), then those last read `recheckMs` ago or more, the oldest first; at most
 * `budget`. The rest are left as they are (seen).
 * v37 FIX-37A (F8, F3): an opening whose detail read failed lately (`failures`) is read after every other due one once
 * its wait is over, and left while it waits; `dueLeft`: the due openings this run does not read (past the budget, or
 * waiting).
 */
export function planBamboohrReads(
  listed: readonly string[],
  stored: ReadonlyMap<string, BamboohrStoredLink>,
  options: { now: number; budget: number; recheckMs: number; failures?: ReadFailures },
): { read: string[]; left: string[]; dueLeft: number } {
  const fresh: string[] = [];
  const unread: string[] = [];
  const closed: string[] = [];
  const stale: BamboohrStoredLink[] = [];
  for (const id of listed) {
    const link = stored.get(id);
    if (!link) unread.push(id);
    else if (!link.live) closed.push(id);
    else if (options.now - Date.parse(link.read_at) >= options.recheckMs) stale.push(link);
    else fresh.push(id);
  }
  stale.sort((a, b) => a.read_at.localeCompare(b.read_at) || a.source_job_id.localeCompare(b.source_job_id));
  const due = [...unread, ...closed, ...stale.map((link) => link.source_job_id)];
  const { ordered } = orderByFailures(due, (id) => id, options.failures ?? new Map(), options.now);
  const read = ordered.slice(0, Math.max(0, options.budget));
  const reading = new Set(read);
  return { read, left: [...fresh, ...due.filter((id) => !reading.has(id))], dueLeft: due.length - read.length };
}

/** v37 FIX-37A (F3): whether a live opening of the source was last read `recheckMs` ago or more (due a re-read). */
async function staleOpeningDue(deps: Pick<AppDeps, 'db'>, sourceId: number, before: string): Promise<boolean> {
  const row = await deps.db.one<{ due: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM job_source_links l WHERE l.source_id = ? AND l.missing_since IS NULL
       AND GREATEST(l.last_seen_at, l.liveness_checked_at) <= CAST(? AS timestamptz)) AS due`,
    [sourceId, before],
  );
  return row?.due === true;
}

/** The source's links of the listed openings (live or closed), with when each was last read. */
async function storedLinks(deps: Pick<AppDeps, 'db'>, sourceId: number, listed: readonly string[]): Promise<Map<string, BamboohrStoredLink>> {
  const db = deps.db;
  const rows = await db.all<{ source_job_id: string; job_id: number; live: boolean; read_at: string | Date }>(
    `SELECT l.source_job_id, l.job_id, l.missing_since IS NULL AS live,
       GREATEST(l.last_seen_at, l.liveness_checked_at) AS read_at
     FROM job_source_links l
     WHERE l.source_id = ? AND l.source_job_id IN (SELECT value FROM ${db.dialect.jsonEach('?')})`,
    [sourceId, JSON.stringify(listed)],
  );
  return new Map(
    rows.map((row) => [row.source_job_id, { ...row, live: row.live === true, read_at: new Date(row.read_at).toISOString() }]),
  );
}

/** A read's failure as a sentence. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const bamboohrAdapter = defineAdapter({
  kind: 'bamboohr',
  label: 'BambooHR careers list',
  access: 'api',
  hosts: ['*.bamboohr.com'],
  robotsPaths(source) {
    try {
      bamboohrFeedOf(source.config);
      return ['/careers/list', '/careers/', '/careers']; // v37 FIX-37A (E6): the careers page, for the company's name
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const feed = bamboohrFeedOf(source.config);
    const signal = ctx.signal;
    let validators: ListingValidators | null = null;
    const runs = !ctx.listingOnly && source.id > 0;
    const recheckMs = runs ? constantsOf(ctx.deps).get('BAMBOOHR_RECHECK_DAYS') * DAY_MS : 0;
    // v37 FIX-37A (F3): a stored opening due a re-read is read even when the list has not changed (no conditional GET).
    const conditional =
      runs && !(await staleOpeningDue(ctx.deps, source.id, new Date(ctx.deps.now().getTime() - recheckMs).toISOString())) ? conditionalOf(ctx) : {};
    // v37 FIX-37A (F12): an unknown company's list answers a redirect to BambooHR's own site: a missing board.
    const { answer, unknownCompany } = await onTenant(ctx.http, feed.url, feed.host, {
      signal,
      allow: [404],
      ...conditional,
      meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
    });
    if (answer?.status === 304) return notModifiedResult();
    if (!answer || unknownCompany || answer.status === 404) {
      throw new SourceNotFoundError(`BambooHR has no company "${feed.company}" (${feed.host}). Check the company name.`);
    }
    if (!isRecord(answer.data) || !Array.isArray(answer.data.result)) {
      throw new IngestError(`BambooHR answered without the openings of "${feed.company}".`);
    }
    const named = str(source.config.companyName);
    let companyName = named ?? nameFromSlug(feed.company);
    const failures: FetchFailure[] = [];
    const openings = records(answer.data.result);
    // One entry per opening, in the list's order.
    const listed = new Map<string, RawPosting>();
    for (const opening of openings) {
      const posting = bamboohrPosting(opening, feed.host, companyName);
      if (!posting) failures.push({ sourceJobId: str(opening.id) ?? undefined, message: 'An opening has no id or name.' });
      else if (!listed.has(posting.sourceJobId)) listed.set(posting.sourceJobId, posting);
    }
    // The list says how many openings there are: a shorter list is not the whole one (nothing closes by its absence).
    const total = isRecord(answer.data.meta) ? num(answer.data.meta.totalCount) : null;
    const whole = total === null || total <= openings.length;
    ctx.log(`BambooHR ${feed.company}: ${listed.size} openings${whole ? '' : ` of ${total} (the list is incomplete)`}.`);

    // The admin's Test and discovery's validation (they store nothing): the list alone, titles and places.
    if (!runs) {
      return { postings: [...listed.values()], complete: whole, failures, validators: whole ? validators : null };
    }

    // v37 BOARDS (B1): each planned opening's detail, read on its own.
    const deps = ctx.deps;
    const constants = constantsOf(deps);
    const ids = [...listed.keys()].map(storedSourceJobId);
    const stored = await storedLinks(deps, source.id, ids);
    const readFailures = await loadReadFailures(deps.db, source.id); // v37 FIX-37A (F8)
    const { read, left, dueLeft } = planBamboohrReads(ids, stored, {
      now: deps.now().getTime(),
      budget: constants.get('BAMBOOHR_READS_PER_RUN'),
      recheckMs,
      failures: readFailures,
    });
    // v37 FIX-37A (E6): no name on the source: its careers page names the company (once; kept on the source).
    if (!named && read.length > 0) {
      const fromPage = await readBamboohrCompanyName(ctx.http, feed.company, signal);
      if (fromPage) {
        companyName = fromPage;
        await keepBamboohrCompanyName(deps.db, source.id, fromPage);
        ctx.log(`BambooHR ${feed.company}: its careers page names the company "${fromPage}" (kept as the source's company name).`);
      }
    }
    const postings: RawPosting[] = [];
    // Listed, so live: seen whatever their own details answer, unless read gone (closed below).
    const seen = [...left];
    const checked: string[] = [];
    const gone: BamboohrStoredLink[] = [];
    const answered: string[] = []; // v37 FIX-37A (F8): read, found or gone
    const detailFailed: string[] = []; // v37 FIX-37A (F8): the details whose read failed
    let attempted = 0;
    let goneUnstored = 0;
    let failedInARow = 0;
    let complete = whole;
    let stopped: string | null = null;
    let heldUntil: string | null = null; // v37 INT-B
    for (const [index, id] of read.entries()) {
      if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
      const link = stored.get(id) ?? null;
      attempted += 1;
      try {
        const posting = await readBamboohrPosting(ctx.http, feed.company, id, companyName, signal);
        failedInARow = 0;
        if (link) checked.push(id);
        if (posting) {
          postings.push(posting);
          answered.push(id);
        } else if (link?.live) {
          gone.push(link);
          answered.push(id);
        } else {
          // v38 INT (ATS-B's rule, adapters/listed-reads.ts): listed, yet its own read says gone, and never stored (or
          // closed): new to every run, it was read before the stale ones each time. Backed off as a failed read is (read
          // after the others, less often: read-failures.ts), never counted a failure.
          goneUnstored += 1;
          detailFailed.push(id);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        // v37 INT-B: a 429 past the request's retries (no hold of its own) stops the reads as a held host does.
        const rateLimited = error instanceof IngestHttpError && !(error instanceof HostHeldError) && error.status === 429;
        if (error instanceof HostHeldError || rateLimited || (error instanceof RobotsRefusal && error.reason === 'unreadable')) {
          // The host is held (or its robots.txt cannot be read): the rest wait for the next run, seen; nothing closes.
          if (!rateLimited) attempted -= 1;
          stopped = messageOf(error);
          complete = false;
          seen.push(...read.slice(index));
          // v37 INT-B: the hold's end, for the next run (a 429 with no hold of its own: the host's hold, if any).
          if (error instanceof HostHeldError) heldUntil = error.until;
          else if (rateLimited) heldUntil = (await holdOf(deps.db, feed.host, nowIso(deps)))?.until ?? null;
          break;
        }
        // Counted as seen (a failure's id), so it is never closed for a read that failed; read again next run.
        const status = error instanceof IngestHttpError ? ` (HTTP ${error.status})` : '';
        failures.push({ sourceJobId: id, message: `Opening ${id} could not be read${status}.` });
        detailFailed.push(id);
        failedInARow += 1;
        if (failedInARow >= BAMBOOHR_FAILURES_IN_A_ROW) {
          complete = false;
          seen.push(...read.slice(index + 1));
          stopped = `BambooHR failed ${BAMBOOHR_FAILURES_IN_A_ROW} reads in a row.`;
          break;
        }
      }
    }

    // The openings read get their read time; the gone ones close (their jobs once no live link is left).
    if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
    const at = nowIso(deps);
    if (checked.length > 0) {
      await deps.db.run(
        `UPDATE job_source_links SET liveness_checked_at = CAST(? AS timestamptz)
         WHERE source_id = ? AND source_job_id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
        [at, source.id, JSON.stringify(checked)],
      );
    }
    let jobsClosed = 0;
    if (gone.length > 0) {
      await deps.db.tx(
        async (t) => {
          for (const link of gone) {
            const closed = await closeLink(deps, t, {
              jobId: link.job_id,
              link: { sourceId: source.id, sourceJobId: link.source_job_id },
              reason: 'gone',
              at,
            });
            if (closed.jobClosed) jobsClosed += 1;
          }
        },
        { label: 'bamboohr: openings gone' },
      );
    }
    ctx.log(
      `Read ${attempted} of ${read.length} planned openings: ${postings.length} stored, ${gone.length} gone ` +
        `(${jobsClosed} jobs closed)${goneUnstored ? `, ${goneUnstored} more gone (none of them open here)` : ''}` +
        `${failures.length ? `, ${failures.length} failed` : ''}; ${left.length} left as they are.`,
    );
    if (stopped) ctx.log(`The reads stopped early, so nothing closes by its absence this run: ${stopped}`);
    // v37 FIX-37A (F8): the failed reads back off; a read that answered, or an opening no longer listed, forgets them.
    const listedIds = new Set(ids);
    await saveReadFailures(deps.db, source.id, readFailures, {
      failed: detailFailed,
      answered,
      keep: (id) => listedIds.has(id),
      now: deps.now().getTime(),
    });
    // v37 FIX-37A (F3): the validators only when every due opening was read: else a 304 would hide the rest.
    const nothingDueLeft = dueLeft === 0 && detailFailed.length === 0 && !stopped;
    if (complete && !nothingDueLeft) ctx.log('Openings are still due a read, so the next run reads the whole list again.');
    return {
      postings,
      complete,
      failures,
      skippedIds: seen,
      validators: complete && nothingDueLeft ? validators : null,
      closedByRead: jobsClosed,
      ...(heldUntil ? { heldUntil } : {}), // v37 INT-B
    };
  },
});
