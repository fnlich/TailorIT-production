import { DAY_MS } from '@tailorit/shared';
import { boardUrlOf, isZohoRecruitHost, ZOHO_JOB_ID, ZOHO_RECRUIT_PORTAL, zohoRecruitHostOf, zohoRecruitJobOf, zohoRecruitJobUrl } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import type { DbQueries } from '../../../core/db/types';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { OutboundRefusedError } from '../../../core/http/outbound';
import { placeOfParts } from '../career/jsonld';
import { withCompanyFacts } from '../boards/company';
import type { CompanyFacts } from '../boards/types';
import type { IngestHttp } from '../http';
import { storedSourceJobId } from '../normalize';
import { IngestError, SourceNotFoundError, type FetchFailure, type RawPosting } from '../types';
import { isRecord, str, type Json } from './common';
import { defineAdapter } from './define';
import { runListedReads } from './listed-reads';
import { inputValueById, jsonParseArgumentAfter, metaContentOf, PAGE_ACCEPT } from './page-data';

// v38 ATS-B (SP v38 REQUEST.md 12, EVIDENCE.md §12, PLAN "Final coverage" 12): a company's Zoho Recruit careers site, read
// from its own pages' embedded data (robots.txt allows /jobs; every other path is disallowed and never read):
//   - the list, GET https://{host}/jobs/Careers: a hidden `<input value="[...]" id="jobs">` (its value before its id, the
//     JSON array HTML-entity encoded: &#34;), one record per job with the job page's keys (id, Posting_Title, City, State,
//     Country, Remote_Job, Job_Type, Industry, Date_Opened, Salary, Job_Description, Is_Locked, Publish), and beside it
//     `<input value="{...}" id="meta">` whose org_info names the company (company_name, website, description when
//     public_description; hide_company_name keeps the name out). No #jobs input: no such careers site (or a legacy
//     portal); an empty array: no openings;
//   - a job's page, GET https://{host}/jobs/{portal}/{id}/{slug}: its record as `var jobs = JSON.parse('[{\x22...}]')`
//     (a JavaScript string literal: its \xNN escapes read first, then the JSON); a job no longer open answers 200 with
//     "This job posting is no longer available." and no record (EVIDENCE: no 404). A record locked (Is_Locked) or not
//     published (Publish false: "Position filled") is closed.
// Pages run to about 2 MB (the careers app is inline): each is read to ZOHO_RECRUIT_PAGE_MAX_BYTES, the list once a run.
// A run stores the list's records whole; a record that came without its description has its job's page read (as
// BambooHR's openings are, adapters/listed-reads.ts), at most ZOHO_RECRUIT_READS_PER_RUN a run. The careers site's
// mailbox (register_info) is never read.
// A source: config `{ site: <its host>, companyName? }`. A new kind of read: the identity guard first ('feed_read').
// v38 FIX-A (SP v38 FIXES-38 items 3, 7 and 12; D5; REVIEW38-beh M5, M10, L5):
//   - closed only on the job's own words ("This job posting is no longer available"), a locked or unpublished record or
//     a 404/410: Zoho's generic error template (div.sorry-block with any other message) is can't read;
//   - a run lists the source's own portal (/jobs/Careers) and closes by absence only the jobs whose link names that
//     portal on its host: a job a person added from another portal of the site (/jobs/<other>/...) is never closed for
//     missing from this list (its own page's read still closes it);
//   - the site is "not found" only when its list page answers 404/410 or Zoho sends it to Zoho's own site; a 200 page
//     without the list (a challenge, an error, a changed template) is try later.

const NEW_READ: NewReadKind = 'feed_read';

/** The most of one careers page read: 8 MB (they run to about 2 MB). */
export const ZOHO_RECRUIT_PAGE_MAX_BYTES = 8 * 1024 * 1024;
/** The words of a job that is no longer open (its page answers 200). v38 FIX-A (M5): these words alone. */
const NO_LONGER_AVAILABLE = /This job posting is no longer available/i;
/** v38 FIX-A (L5): Zoho's own hosts, where a careers site Zoho no longer has sends its visitors. */
const ZOHO_OWN_HOST = /(?:^|\.)zoho(?:recruit)?\.(?:com|eu|in|com\.au)$/;

/** A source's careers host, or the plain refusal for a config that names none. */
export function zohoRecruitHostOfSource(config: Record<string, unknown>): string {
  const host = zohoRecruitHostOf(str(config.site) ?? '');
  if (!host) throw new IngestError('This source names no Zoho Recruit careers site (<name>.zohorecruit.com). Edit the source and add it.');
  return host;
}

/** The careers site's list page. */
export const zohoRecruitListUrl = (host: string) => `https://${host}/jobs/${ZOHO_RECRUIT_PORTAL}`;

/** A job title as its address's slug ("IT Infrastructure Engineer" -> "IT-Infrastructure-Engineer"). */
export function zohoRecruitSlug(title: string): string | null {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return slug || null;
}

/** Whether a record is one the careers site shows (not locked, published). */
export const zohoRecruitListed = (record: Json) => record.Is_Locked !== true && record.Publish !== false;

/** The company the list's #meta names (its org_info), as facts; null when it names none. */
export function zohoRecruitCompanyOf(meta: Json | null): CompanyFacts | null {
  const org = meta && isRecord(meta.org_info) ? meta.org_info : null;
  if (!org) return null;
  const name = org.hide_company_name === true ? null : str(org.company_name);
  const about = org.public_description === false ? null : str(org.description);
  const site = str(org.website);
  const website = site ? (/^https?:\/\//i.test(site) ? site : `https://${site}`) : null;
  return name || about || website ? { name: name?.slice(0, 200) ?? null, about, website } : null;
}

/**
 * One record as a RawPosting of the careers site (null without an id or a title): its job page its link, its text when
 * the record has it, its place, type, industry, date and pay's words.
 */
export function zohoRecruitPosting(record: Json, host: string, companyName: string, url?: string): RawPosting | null {
  const id = str(record.id);
  const title = str(record.Posting_Title) ?? str(record.Job_Opening_Name);
  if (!id || !ZOHO_JOB_ID.test(id) || !title) return null;
  const remote = record.Remote_Job === true;
  const place = placeOfParts(str(record.City), str(record.State), str(record.Country));
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: str(record.Job_Description),
    url: url ?? zohoRecruitJobUrl(host, ZOHO_RECRUIT_PORTAL, id, zohoRecruitSlug(title)),
    locations: place ? [place] : remote ? ['Remote'] : [],
    workArrangement: remote ? 'remote' : null,
    employmentText: str(record.Job_Type),
    industry: str(record.Industry),
    salaryText: str(record.Salary),
    postedAt: str(record.Date_Opened),
  };
}

/** The company facts applied to a posting (its about text, website and logo: the company record takes them). */
function withFacts(raw: RawPosting, facts: CompanyFacts | null, logo: string | null): RawPosting {
  return withCompanyFacts(raw, { name: null, about: facts?.about ?? null, website: facts?.website ?? null, logoUrl: logo }, undefined);
}

/**
 * A page of the careers site (on its host only): its HTML, gone (404 or 410), or sent off the host (`away`; v38 FIX-A:
 * `zoho` when to Zoho's own site).
 */
type ZohoPage = { html: string } | { gone: true } | { away: true; zoho: boolean };

async function readPage(http: IngestHttp, url: string, host: string, signal?: AbortSignal): Promise<ZohoPage> {
  let away: string | null = null;
  try {
    const answer = await http.getJson(url, {
      signal,
      text: true,
      accept: PAGE_ACCEPT,
      allow: [404, 410],
      maxBytes: ZOHO_RECRUIT_PAGE_MAX_BYTES,
      allowRedirectHost: (to) => {
        if (to === host) return true;
        away = to;
        return false;
      },
    });
    if (answer.status === 404 || answer.status === 410) return { gone: true };
    return { html: typeof answer.data === 'string' ? answer.data : '' };
  } catch (error) {
    // A careers site Zoho no longer has sends its visitors to Zoho's own site.
    if (error instanceof OutboundRefusedError && away !== null && !signal?.aborted) return { away: true, zoho: ZOHO_OWN_HOST.test(away) };
    throw error;
  }
}

/** The list page's records and its company, read (see the top); null when the page holds no list. */
export function zohoRecruitListOf(html: string): { records: Json[]; meta: Json | null } | null {
  const value = inputValueById(html, 'jobs');
  if (value === null) return null;
  let records: unknown;
  try {
    records = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(records)) return null;
  let meta: Json | null = null;
  const metaValue = inputValueById(html, 'meta');
  if (metaValue) {
    try {
      const parsed: unknown = JSON.parse(metaValue);
      meta = isRecord(parsed) ? parsed : null;
    } catch {
      meta = null;
    }
  }
  return { records: records.filter(isRecord), meta };
}

/** A job page's record (`var jobs = JSON.parse('…')`), or null when the page has none. */
export function zohoRecruitRecordsOf(html: string): Json[] | null {
  const text = jsonParseArgumentAfter(html, 'var jobs = ');
  if (text === null) return null;
  try {
    const records: unknown = JSON.parse(text);
    return Array.isArray(records) ? records.filter(isRecord) : null;
  } catch {
    return null;
  }
}

/** One job's read: found (its posting and its company's facts), or gone. */
export type ZohoRecruitRead = { found: true; raw: RawPosting; company: CompanyFacts } | { found: false };

/**
 * One job read from its page (at most ZOHO_RECRUIT_PAGE_MAX_BYTES, on the careers host only): its posting, named by
 * `companyName`, else the page's site name; or gone (404, the "no longer available" page, a locked or unpublished
 * record). Throws IngestHttpError when Zoho fails, RobotsRefusal when robots.txt refuses the read, and IngestError when
 * the page holds no record of the job.
 */
export async function readZohoRecruitPosting(
  http: IngestHttp,
  host: string,
  id: string,
  options: { url: string; companyName: string | null; signal?: AbortSignal },
): Promise<ZohoRecruitRead> {
  if (!isZohoRecruitHost(host) || !ZOHO_JOB_ID.test(id)) throw new IngestError('TailorIT does not know this Zoho Recruit job.');
  const page = await readPage(http, options.url, host, options.signal);
  if ('gone' in page) return { found: false };
  if ('away' in page) throw new IngestError("Zoho Recruit sent the job's page elsewhere.");
  const html = page.html;
  const records = zohoRecruitRecordsOf(html);
  if (!records) {
    // v38 FIX-A (M5): the job's own words close it; Zoho's error template with any other message is can't read.
    if (NO_LONGER_AVAILABLE.test(html)) return { found: false };
    throw new IngestError("The job's page holds no record of it.");
  }
  const record = records.find((item) => str(item.id) === id);
  if (!record) throw new IngestError("Zoho Recruit's page holds another job.");
  if (!zohoRecruitListed(record)) return { found: false };
  const metaValue = inputValueById(html, 'meta');
  let meta: Json | null = null;
  try {
    const parsed: unknown = metaValue ? JSON.parse(metaValue) : null;
    meta = isRecord(parsed) ? parsed : null;
  } catch {
    meta = null;
  }
  const facts = zohoRecruitCompanyOf(meta);
  const name = options.companyName ?? facts?.name ?? metaContentOf(html, 'og:site_name');
  const raw = zohoRecruitPosting(record, host, name ?? host.split('.')[0]!, options.url);
  if (!raw) throw new IngestError("Zoho Recruit's job has no title.");
  const logo = metaContentOf(html, 'og:image');
  return { found: true, raw, company: { name: facts?.name ?? metaContentOf(html, 'og:site_name'), about: facts?.about ?? null, website: facts?.website ?? null, logoUrl: logo } };
}

export const zohoRecruitAdapter = defineAdapter({
  kind: 'zoho_recruit',
  label: 'Zoho Recruit careers site',
  access: 'page',
  hosts: ['*.zohorecruit.com', '*.zohorecruit.eu', '*.zohorecruit.in', '*.zohorecruit.com.au'],
  robotsPaths(source) {
    try {
      zohoRecruitHostOfSource(source.config);
      return [`/jobs/${ZOHO_RECRUIT_PORTAL}`, `/jobs/${ZOHO_RECRUIT_PORTAL}/`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const host = zohoRecruitHostOfSource(source.config);
    const page = await readPage(ctx.http, zohoRecruitListUrl(host), host, ctx.signal);
    // v38 FIX-A (L5): "not found" only on the list page's 404/410 or Zoho sending it to its own site.
    if ('gone' in page || ('away' in page && page.zoho)) {
      throw new SourceNotFoundError(`Zoho Recruit has no careers site at ${host} (or it is an older portal TailorIT can't read). Check the address.`);
    }
    if ('away' in page) throw new IngestError(`Zoho Recruit sent the careers page of ${host} to another site.`);
    const html = page.html;
    const list = zohoRecruitListOf(html);
    if (!list) throw new IngestError(`Zoho Recruit answered without the job list of ${host}.`);
    const facts = zohoRecruitCompanyOf(list.meta);
    const companyName = str(source.config.companyName) ?? facts?.name ?? metaContentOf(html, 'og:site_name') ?? host.split('.')[0]!;
    const logo = metaContentOf(html, 'og:image');
    const failures: FetchFailure[] = [];
    const listed = new Map<string, RawPosting>();
    let hidden = 0;
    for (const record of list.records) {
      if (!zohoRecruitListed(record)) {
        hidden += 1;
        continue;
      }
      const posting = zohoRecruitPosting(record, host, companyName);
      if (!posting) failures.push({ sourceJobId: str(record.id) ?? undefined, message: 'A job has no id or title.' });
      else if (!listed.has(posting.sourceJobId)) listed.set(posting.sourceJobId, withFacts(posting, facts, logo));
    }
    ctx.log(`Zoho Recruit ${host}: ${listed.size} jobs${hidden ? ` (${hidden} locked or not published, left out)` : ''}.`);
    const constants = constantsOf(ctx.deps);
    const runs = !ctx.listingOnly && source.id > 0;
    const result = await runListedReads(source, ctx, {
      label: `Zoho Recruit ${host}`,
      host,
      listed,
      whole: true,
      failures,
      isWhole: (posting) => Boolean(posting.descriptionHtml),
      read: async (id, posting) => {
        const read = await readZohoRecruitPosting(ctx.http, host, id, { url: posting.url, companyName, signal: ctx.signal });
        return read.found ? withFacts(read.raw, facts, logo) : null;
      },
      budget: runs ? constants.get('ZOHO_RECRUIT_READS_PER_RUN') : 0,
      recheckMs: runs ? constants.get('LISTED_POSTINGS_RECHECK_DAYS') * DAY_MS : 0,
    });
    if (!runs) return result;
    // v38 FIX-A (M10): the source's open links on another portal (or whose job's link names none of this host's) are
    // seen: this list is the Careers portal's alone, so their absence from it says nothing.
    const elsewhere = await linksOffThePortal(ctx.deps.db, source.id, host, new Set([...listed.keys()].map(storedSourceJobId)));
    if (elsewhere.length > 0) ctx.log(`Zoho Recruit ${host}: ${elsewhere.length} open jobs of other portals, left as they are (their own pages decide).`);
    return { ...result, skippedIds: [...(result.skippedIds ?? []), ...elsewhere] };
  },
});

/** Whether a job's link names the run's portal (ZOHO_RECRUIT_PORTAL, in any case) on `host`. */
export function zohoRecruitLinkOnPortal(link: string | null, host: string): boolean {
  const url = link ? boardUrlOf(link) : null;
  const job = url ? zohoRecruitJobOf(url) : null;
  return job !== null && job.host === host && job.portal.toLowerCase() === ZOHO_RECRUIT_PORTAL.toLowerCase();
}

/**
 * v38 FIX-A (M10): the source's open links (stored ids) the list does not name whose job's own link is on another portal
 * of the site (or names none on its host): never closed by this list's absence.
 */
async function linksOffThePortal(db: DbQueries, sourceId: number, host: string, listed: ReadonlySet<string>): Promise<string[]> {
  const rows = await db.all<{ source_job_id: string; apply_url: string | null }>(
    `SELECT l.source_job_id, j.apply_url FROM job_source_links l JOIN jobs j ON j.id = l.job_id
     WHERE l.source_id = ? AND l.missing_since IS NULL ORDER BY l.source_job_id`,
    [sourceId],
  );
  return rows.filter((row) => !listed.has(row.source_job_id) && !zohoRecruitLinkOnPortal(row.apply_url, host)).map((row) => row.source_job_id);
}
