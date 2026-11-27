import { DAY_MS } from '@tailorit/shared';
import { oraclePostingUrl, oracleSiteOfConfig, ORACLE_POSTING_ID, type OracleSite } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { withCompanyFacts } from '../boards/company';
import type { IngestHttp } from '../http';
import { IngestError, PostingUnreadableError, SourceNotFoundError, type FetchFailure, type RawPosting } from '../types';
import { arrangementOf, isRecord, num, records, str, type Json } from './common'; // v38 FIX-APP: no nameFromSlug (D1)
import { defineAdapter } from './define';
import { runListedReads } from './listed-reads';

// v38 ATS-B (SP v38 REQUEST.md 19, EVIDENCE.md §19, PLAN "Final coverage" 19): an Oracle Recruiting Cloud career site,
// read through the Candidate Experience's own REST resources (keyless JSON: the career site's pages load them):
//   - the list, GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true
//     &expand=requisitionList&finder=findReqs;siteNumber={site},limit={n},offset={o},sortBy=POSTING_DATES_DESC:
//     `{ items: [{ TotalJobsCount, requisitionList: [{ Id, Title, PostedDate, PrimaryLocation, PrimaryLocationCountry,
//     WorkplaceTypeCode, ... }], organizationsFacet: [{ Name }] }] }`, paged by offset (the next page starts after the
//     rows this one gave), at most ORACLE_LIST_MAX rows a run;
//   - each posting's details, GET .../recruitingCEJobRequisitionDetails?onlyData=true&finder=ById;Id=%22{id}%22,
//     siteNumber={site}: `{ items: [{ Id, Title, ExternalDescriptionStr (HTML), ExternalResponsibilitiesStr,
//     ExternalQualificationsStr, CorporateDescriptionStr, OrganizationDescriptionStr, ExternalPostedStartDate,
//     ExternalPostedEndDate, PrimaryLocation, PrimaryLocationCountry, WorkplaceType(Code), JobSchedule, JobFunction,
//     Category }] }`; `items: []` is a posting that is gone (EVIDENCE: an unknown id answers so, 200), as is a past
//     ExternalPostedEndDate. Its contact's name and email (ExternalContactName, ExternalContactEmail) and its hiring
//     manager are never read.
// A run reads the list, then each posting's details as BambooHR's run reads its openings (adapters/listed-reads.ts), at
// most ORACLE_READS_PER_RUN a run. Neither answer names the employer: a source's companyName names it, else the list's
// one organisation (its organizationsFacet, when it names exactly one); v38 FIX-APP (D1): else none (a run is refused in
// words, a link's read asks the person: never the tenant's host label).
// A source: config `{ site: "<host>/<SITE>", companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The most of one details answer read (its HTML runs to some tens of kilobytes): 2 MB. */
export const ORACLE_DETAIL_MAX_BYTES = 2 * 1024 * 1024;
/** The most of one list page read (100 rows and the search's facets): 4 MB. */
export const ORACLE_LIST_MAX_BYTES = 4 * 1024 * 1024;
/** The rows one list page asks for (the list answers what it holds; the next page starts after them). */
export const ORACLE_LIST_PAGE_SIZE = 100;

const RESOURCES = '/hcmRestApi/resources/latest';

/** A source's career site, or the plain refusal for a config that names none. */
export function oracleSiteOfSource(config: Record<string, unknown>): OracleSite {
  const site = oracleSiteOfConfig(config);
  if (!site) throw new IngestError('This source names no Oracle career site (its host and site, such as acme.fa.us2.oraclecloud.com/CX_1). Edit the source and add them.');
  return site;
}

/** One posting's details resource (the read the posting's page makes). */
export function oracleDetailUrl(site: OracleSite, id: string): string {
  return `https://${site.host}${RESOURCES}/recruitingCEJobRequisitionDetails?onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site.siteNumber}`;
}

/** One page of the site's list, from `offset`. */
export function oracleListUrl(site: OracleSite, offset: number, limit = ORACLE_LIST_PAGE_SIZE): string {
  return (
    `https://${site.host}${RESOURCES}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList` +
    `&finder=findReqs;siteNumber=${site.siteNumber},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`
  );
}

/** A posting's link (the site's own posting page, in English: its run's; a link read keeps the link's language). */
export const oracleJobUrl = (site: OracleSite, id: string, language = 'en') => oraclePostingUrl(site.host, language, site.siteNumber, id);

/** The employer the list names: its organisations' facet, when it names exactly one. */
export function oracleListCompany(search: Json): string | null {
  const orgs = records(search.organizationsFacet)
    .map((org) => str(org.Name))
    .filter((name): name is string => Boolean(name));
  return orgs.length === 1 ? orgs[0]!.slice(0, 200) : null;
}

// v38 FIX-APP (SP v38 FIXES-38 D1; REVIEW38-ux H1): no last resort from the tenant's host label ("Fa Evxo Saasfaprod1"):
// a run is named by its source's Company name, else by the list's single organisation, else refused in words.
/** A run's refusal of an Oracle site whose list names no single organisation and whose source names no company. */
export const ORACLE_NEEDS_COMPANY =
  "This Oracle Recruiting Cloud site's job list doesn't name one company, and its source names none. Edit the source and type its Company name.";

/** One list row as a listing's posting (title, place, date, link); null without an id or a title. */
export function oracleListedPosting(row: Json, site: OracleSite, companyName: string): RawPosting | null {
  const id = str(row.Id);
  const title = str(row.Title);
  if (!id || !ORACLE_POSTING_ID.test(id) || !title) return null;
  const place = str(row.PrimaryLocation);
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    url: oracleJobUrl(site, id),
    locations: place ? [place] : [],
    countryHint: str(row.PrimaryLocationCountry),
    workArrangement: arrangementOf(row.WorkplaceTypeCode) ?? arrangementOf(row.WorkplaceType),
    postedAt: str(row.PostedDate),
  };
}

/** A details field's HTML, or null when it is empty. */
const html = (value: unknown) => {
  const text = str(value);
  return text && text.replace(/<[^>]*>|&nbsp;|\s/g, '') ? text : null;
};

/**
 * One posting's details (`items[0]`) as a RawPosting of `id` (null without a title): its text (the description, then its
 * responsibilities and qualifications when the site gives them apart), place, date, schedule and function; the
 * company's own words (CorporateDescriptionStr, else OrganizationDescriptionStr) as its about text.
 */
export function oracleDetailPosting(item: Json, site: OracleSite, id: string, companyName: string, url = oracleJobUrl(site, id)): RawPosting | null {
  const title = str(item.Title);
  if (!title) return null;
  const parts = [
    html(item.ExternalDescriptionStr),
    html(item.ExternalResponsibilitiesStr) ? `<h3>Responsibilities</h3>${html(item.ExternalResponsibilitiesStr)}` : null,
    html(item.ExternalQualificationsStr) ? `<h3>Qualifications</h3>${html(item.ExternalQualificationsStr)}` : null,
  ].filter((part): part is string => Boolean(part));
  const about = html(item.CorporateDescriptionStr) ?? html(item.OrganizationDescriptionStr);
  const place = str(item.PrimaryLocation);
  const raw: RawPosting = {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: parts.length > 0 ? parts.join('\n') : null,
    url,
    locations: place ? [place] : [],
    countryHint: str(item.PrimaryLocationCountry),
    workArrangement: arrangementOf(item.WorkplaceTypeCode) ?? arrangementOf(item.WorkplaceType),
    employmentText: str(item.JobSchedule),
    department: str(item.JobFunction) ?? str(item.Category),
    postedAt: str(item.ExternalPostedStartDate),
  };
  // The company's own words feed its record (as plain text), never the posting's name.
  return about ? withCompanyFacts(raw, { name: null, about }, undefined) : raw;
}

/** Whether a posting's end date is past at `now` (its site no longer shows it). */
function endedAt(item: Json, now: Date): boolean {
  const end = str(item.ExternalPostedEndDate);
  const at = end ? Date.parse(end) : Number.NaN;
  return Number.isFinite(at) && at < now.getTime();
}

/**
 * One posting read from its details (at most ORACLE_DETAIL_MAX_BYTES): its RawPosting, or null when it is gone (no item,
 * or its end date past). Throws IngestHttpError when Oracle fails, RobotsRefusal when robots.txt refuses the read, and
 * IngestError when the answer is no posting or another one. v38 FIX-A (SP v38 FIXES-38 item 1, REVIEW38-beh M3): a 404
 * or 410 of the details resource is no word on the posting (Oracle answers an unknown id 200 `items: []`; a 404 is a
 * wrong pod, site or a retired resource): PostingUnreadableError `unavailable` (try later), never gone.
 */
export async function readOraclePosting(
  http: IngestHttp,
  site: OracleSite,
  id: string,
  options: { companyName: string; signal?: AbortSignal; now: Date; url?: string },
): Promise<RawPosting | null> {
  if (!ORACLE_POSTING_ID.test(id)) throw new IngestError('TailorIT does not know this Oracle posting.');
  const answer = await http.getJson(oracleDetailUrl(site, id), {
    signal: options.signal,
    allow: [404, 410],
    maxBytes: ORACLE_DETAIL_MAX_BYTES,
    allowRedirectHost: (to) => to === site.host,
  });
  if (answer.status === 404 || answer.status === 410) throw new PostingUnreadableError('unavailable');
  if (!isRecord(answer.data) || !Array.isArray(answer.data.items)) throw new IngestError('Oracle answered without the posting.');
  const item = records(answer.data.items)[0];
  if (!item) return null;
  if (str(item.Id) !== id) throw new IngestError('Oracle answered with another posting.');
  if (endedAt(item, options.now)) return null;
  const raw = oracleDetailPosting(item, site, id, options.companyName, options.url);
  if (!raw) throw new IngestError("Oracle's posting has no title.");
  return raw;
}

/** The site's list as a run reads it: its rows in order, whether it is whole, and its employer's name. */
export interface OracleList {
  rows: Json[];
  whole: boolean;
  company: string | null;
  total: number | null;
}

/**
 * The site's list (see the top), at most `max` rows; the pages follow one another until the total is read, a page is
 * empty, or `max` is reached. Throws SourceNotFoundError when the first page answers 404 or 410 (an unknown site),
 * IngestError for any other answer that holds no search (v38 FIX-A, SP v38 FIXES-38 item 12, REVIEW38-beh L5: a later
 * page, a sign-in or error page is no word on the site: try later, and nothing closes).
 */
export async function readOracleList(http: IngestHttp, site: OracleSite, options: { max: number; signal?: AbortSignal; pageSize?: number }): Promise<OracleList> {
  const rows = new Map<string, Json>();
  let total: number | null = null;
  let company: string | null = null;
  let offset = 0;
  let complete = false;
  let pages = 0;
  while (rows.size < options.max) {
    const limit = Math.min(options.pageSize ?? ORACLE_LIST_PAGE_SIZE, Math.max(1, options.max - rows.size));
    const answer = await http.getJson(oracleListUrl(site, offset, limit), {
      signal: options.signal,
      allow: [404, 410],
      maxBytes: ORACLE_LIST_MAX_BYTES,
      allowRedirectHost: (to) => to === site.host,
    });
    pages += 1;
    if ((answer.status === 404 || answer.status === 410) && pages === 1) {
      throw new SourceNotFoundError(`Oracle has no career site "${site.siteNumber}" on ${site.host}. Check the site's address.`);
    }
    const search = answer.status === 200 && isRecord(answer.data) ? records(answer.data.items)[0] : undefined;
    if (!search) throw new IngestError(`Oracle answered without the job list of site "${site.siteNumber}" on ${site.host} (page ${pages}).`);
    if (offset === 0) company = oracleListCompany(search);
    total = num(search.TotalJobsCount) ?? total;
    const page = records(search.requisitionList);
    const before = rows.size;
    for (const row of page) {
      const id = str(row.Id);
      if (id && !rows.has(id)) rows.set(id, row);
    }
    offset += page.length;
    if (page.length === 0 || (total !== null && offset >= total)) {
      complete = true;
      break;
    }
    // A page that names nothing new (the site ignored the offset): the list stops here, not whole.
    if (rows.size === before) break;
  }
  const whole = complete && total !== null && rows.size >= total;
  return { rows: [...rows.values()].slice(0, options.max), whole, company, total };
}

/**
 * The employer a site's list names (one row asked for: its organisations' facet comes with it), for a link's read of a
 * posting whose source names none; null when the list names none or cannot be read now (best effort).
 */
export async function readOracleCompanyName(http: IngestHttp, site: OracleSite, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await readOracleList(http, site, { max: 1, pageSize: 1, signal })).company;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export const oracleAdapter = defineAdapter({
  kind: 'oracle',
  label: 'Oracle Recruiting Cloud site',
  access: 'api',
  hosts: ['*.oraclecloud.com', '*.oraclegovcloud.com'],
  robotsPaths(source) {
    try {
      oracleSiteOfSource(source.config);
      return [`${RESOURCES}/recruitingCEJobRequisitions`, `${RESOURCES}/recruitingCEJobRequisitionDetails`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const site = oracleSiteOfSource(source.config);
    const constants = constantsOf(ctx.deps);
    const runs = !ctx.listingOnly && source.id > 0;
    const list = await readOracleList(ctx.http, site, { max: runs ? constants.get('ORACLE_LIST_MAX') : ORACLE_LIST_PAGE_SIZE, signal: ctx.signal });
    // v38 FIX-APP (D1): never a name made up from the host; a listing-only read (a discovery check) stores nothing.
    const companyName = str(source.config.companyName) ?? list.company ?? (ctx.listingOnly ? '' : null);
    if (companyName === null) throw new IngestError(ORACLE_NEEDS_COMPANY);
    const failures: FetchFailure[] = [];
    const listed = new Map<string, RawPosting>();
    for (const row of list.rows) {
      const posting = oracleListedPosting(row, site, companyName);
      if (!posting) failures.push({ sourceJobId: str(row.Id) ?? undefined, message: 'A requisition has no id or title.' });
      else listed.set(posting.sourceJobId, posting);
    }
    ctx.log(`Oracle site ${site.siteNumber} on ${site.host}: ${listed.size} postings${list.whole ? '' : ` of ${list.total ?? 'an unknown number'} (the list was not read whole)`}.`);
    return runListedReads(source, ctx, {
      label: `Oracle site ${site.siteNumber}`,
      host: site.host,
      listed,
      whole: list.whole,
      failures,
      read: (id) => readOraclePosting(ctx.http, site, id, { companyName, signal: ctx.signal, now: ctx.deps.now() }),
      budget: runs ? constants.get('ORACLE_READS_PER_RUN') : 0,
      recheckMs: runs ? constants.get('LISTED_POSTINGS_RECHECK_DAYS') * DAY_MS : 0,
    });
  },
});
