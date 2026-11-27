import { DAY_MS } from '@tailorit/shared';
import { boardUrlOf, JOIN_HOST, joinCompanyOf, joinJobOf, joinJobUrl } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { withCompanyFacts } from '../boards/company';
import type { CompanyFacts } from '../boards/types';
import { pageJobPosting, placeOfParts } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { IngestError, SourceNotFoundError, type FetchFailure, type RawPosting, type RawSalary } from '../types';
import { arrangementOf, isRecord, num, periodOf, records, str, type Json } from './common';
import { defineAdapter } from './define';
import { runListedReads } from './listed-reads';
import { canonicalLinkOf } from './page-boards';
import { nextDataOf, PAGE_ACCEPT, pathOf } from './page-data';

// v38 ATS-B (SP v38 REQUEST.md 13, EVIDENCE.md §13, PLAN "Final coverage" 13): a company on Join.com, read from its own
// pages' Next.js data (robots.txt disallows only /*/lp/, never read):
//   - the company's page, GET https://join.com/companies/{company}: __NEXT_DATA__ props.pageProps.pageData { jobs: {
//     items: [{ id, idParam "<id>-<slug>", title, createdAt, workplaceType, remoteType, city { cityName, countryName },
//     country { iso3166 }, employmentType { name }, category { name } }], pagination { page, pageCount, perPage, total } },
//     company { name, domain, url (its website) } }. The page lists 5 jobs; how its further pages are asked for was not
//     confirmed (EVIDENCE), so a run reads this page alone: a list of more than one page is not whole (nothing closes by
//     absence; each stored job's own read still closes it);
//   - a job's page, GET https://join.com/companies/{company}/{id}-{slug}: __NEXT_DATA__ pageData.job { id, title, status
//     ("ONLINE" while open), description (HTML), createdAt, city, country, workplaceType, remoteType, employmentType {
//     googleType }, category, salaryAmountFrom/To { amount in cents, currency }, salaryFrequency, company { name, url },
//     companyDesc }, else its JSON-LD JobPosting; 404 = the job is gone, and so is a job whose status is no longer ONLINE.
//     Its contact person (contactName, contactTitle) is never read.
// A run reads the company's page, then each job's page as BambooHR's openings are read (adapters/listed-reads.ts), at
// most JOIN_READS_PER_RUN a run.
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The most of one page read (a job's runs to some hundreds of kilobytes with its Next.js data): 4 MB. */
export const JOIN_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/** A source's company on Join.com, or the plain refusal for a config that names none. */
export function joinCompanyOfSource(config: Record<string, unknown>): string {
  const company = joinCompanyOf(str(config.company) ?? '');
  if (!company) throw new IngestError('This source names no Join.com company (join.com/companies/<name>). Edit the source and add it.');
  return company;
}

/** The company's page on Join.com. */
export const joinCompanyUrl = (company: string) => `https://${JOIN_HOST}/companies/${company}`;

/** A Join.com page (on join.com only): its HTML, or null for a 404 or 410 (gone). */
async function readJoinPage(http: IngestHttp, url: string, signal?: AbortSignal): Promise<string | null> {
  const answer = await http.getJson(url, {
    signal,
    text: true,
    accept: PAGE_ACCEPT,
    allow: [404, 410],
    maxBytes: JOIN_PAGE_MAX_BYTES,
    allowRedirectHost: (to) => to === JOIN_HOST || to === `www.${JOIN_HOST}`,
  });
  if (answer.status === 404 || answer.status === 410) return null;
  return typeof answer.data === 'string' ? answer.data : '';
}

/** A Join.com amount (cents) in its currency's units. */
const units = (value: unknown) => {
  const cents = isRecord(value) ? num(value.amount) : null;
  return cents === null ? null : Math.round(cents) / 100;
};

/** A job's pay: salaryAmountFrom/To in cents, their currency, salaryFrequency (PER_YEAR...); null for none. */
export function joinSalaryOf(job: Json): RawSalary | null {
  const min = units(job.salaryAmountFrom);
  const max = units(job.salaryAmountTo);
  if (min === null && max === null) return null;
  const currency = str(isRecord(job.salaryAmountFrom) ? job.salaryAmountFrom.currency : null) ?? str(isRecord(job.salaryAmountTo) ? job.salaryAmountTo.currency : null);
  return {
    min: min ?? max,
    max: max ?? min,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    period: periodOf(job.salaryFrequency),
  };
}

/** A job's places: remote ("Remote, <country>" for a country's remote job), else its city, region and country. */
function placesOf(job: Json): string[] {
  const city = isRecord(job.city) ? job.city : null;
  const country = isRecord(job.country) ? job.country : null;
  const countryName = str(country?.name) ?? str(city?.countryName) ?? str(country?.iso3166);
  if (str(job.workplaceType)?.toUpperCase() === 'REMOTE') {
    return [countryName && str(job.remoteType)?.toUpperCase() !== 'WORLDWIDE' ? `Remote, ${countryName}` : 'Remote'];
  }
  const place = placeOfParts(str(city?.cityName), str(city?.regionName), countryName);
  return place ? [place] : [];
}

/** A job of the company's list (or its page) as a listing's posting; null without a numeric id or a title. */
export function joinListedPosting(item: Json, company: string, companyName: string): RawPosting | null {
  const id = str(item.id);
  const title = str(item.title);
  if (!id || !/^\d{1,15}$/.test(id) || !title) return null;
  const segment = str(item.idParam);
  const employment = isRecord(item.employmentType) ? item.employmentType : null;
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    url: joinJobUrl(company, segment && segment.startsWith(`${id}-`) ? segment : id),
    locations: placesOf(item),
    workArrangement: arrangementOf(item.workplaceType),
    employmentText: str(employment?.googleType)?.replace(/_/g, ' ') ?? str(employment?.name),
    department: isRecord(item.category) ? str(item.category.name) : null,
    postedAt: str(item.createdAt),
  };
}

/** The company's facts a page names (pageData.company, or a job's company): its name and website. */
export function joinCompanyFactsOf(company: unknown, about: unknown = null): CompanyFacts | null {
  if (!isRecord(company)) return null;
  const name = str(company.name)?.slice(0, 200) ?? null;
  const website = str(company.url);
  const text = str(about) ?? str(company.desc);
  return name || website || text ? { name, website, about: text } : null;
}

/** The company's page read: its jobs, whether they are its whole list, its facts. */
export interface JoinList {
  items: Json[];
  whole: boolean;
  total: number | null;
  company: CompanyFacts | null;
}

/**
 * The company's list from its page's Next.js data, or null when the page has none. v38 FIX-A (SP v38 FIXES-38 item 12,
 * REVIEW38-beh L6): whole only when the page says how many pages it has (its pagination) and that is one, and it holds
 * as many jobs as its total: a page with no pagination may have more pages (nothing closes by their absence).
 */
export function joinListOf(html: string): JoinList | null {
  const data = pathOf(nextDataOf(html), 'props.pageProps.pageData');
  if (!isRecord(data) || !isRecord(data.jobs)) return null;
  const items = records(data.jobs.items).filter((item) => /^\d{1,15}$/.test(str(item.id) ?? ''));
  const pagination = isRecord(data.jobs.pagination) ? data.jobs.pagination : null;
  const pages = num(pagination?.pageCount);
  const total = num(pagination?.total);
  return { items, whole: pages !== null && pages <= 1 && (total === null || items.length >= total), total, company: joinCompanyFactsOf(data.company) };
}

/**
 * One job's read: found (its posting, its company's facts, and v38 FIX-A: `board`, the company the job's own page names,
 * for a short link that names none), or gone.
 */
export type JoinRead = { found: true; raw: RawPosting; company: CompanyFacts | null; board: string | null } | { found: false };

/** v38 FIX-A (M3): the job's long link a page's <link rel="canonical"> names (this job's), or null. */
function canonicalJobOf(html: string, id: string): { company: string; segment: string } | null {
  const canonical = canonicalLinkOf(html);
  const url = canonical ? boardUrlOf(canonical) : null;
  const job = url ? joinJobOf(url) : null;
  return job && job.company && job.id === id ? { company: job.company, segment: job.segment } : null;
}

/**
 * One job read from its page (at most JOIN_PAGE_MAX_BYTES, on join.com only): its posting (its Next.js data, else its
 * JSON-LD), named by `companyName`, else the page's company; or gone (404, 410, a status no longer ONLINE). Throws
 * IngestHttpError when Join fails, RobotsRefusal when robots.txt refuses the read, and IngestError when the page holds
 * no job, or another one.
 * v38 FIX-A (SP v38 FIXES-38 items 4 and 11; REVIEW38-beh M7, M13, REVIEW38-ux M3):
 *   - closed only on a 404/410 or a status the page gives that is not ONLINE: a job with no status (null, or the field
 *     gone) is can't read;
 *   - `url` may be the short link, https://join.com/jobs/<id> (Join's own page, which names no company in its address):
 *     its Next.js data (company.domain) or its canonical link (the long form) names the company; the posting is the long
 *     form's (its link, its company as the read's `board`); a page that names none is can't read.
 */
export async function readJoinPosting(
  http: IngestHttp,
  url: string,
  id: string,
  options: { companyName: string | null; signal?: AbortSignal },
): Promise<JoinRead> {
  const html = await readJoinPage(http, url, options.signal);
  if (html === null) return { found: false };
  const page = boardUrlOf(url);
  const fromUrl = page ? (joinJobOf(page)?.company ?? null) : null;
  const canonical = canonicalJobOf(html, id);
  const job = pathOf(nextDataOf(html), 'props.pageProps.pageData.job');
  if (isRecord(job)) {
    if (str(job.id) !== id) throw new IngestError("Join.com's page holds another job.");
    // v38 FIX-A (M7): only a status the page gives closes the job.
    const status = str(job.status)?.toUpperCase() ?? null;
    if (status === null) throw new IngestError("Join.com's job has no status.");
    if (status !== 'ONLINE') return { found: false };
    const company = joinCompanyFactsOf(job.company, job.companyDesc);
    const slug = joinCompanyOf(str(isRecord(job.company) ? job.company.domain : null) ?? '') || fromUrl || canonical?.company || '';
    if (!slug) throw new IngestError("Join.com's page names no company.");
    const listed = joinListedPosting(job, slug, options.companyName ?? company?.name ?? slug);
    if (!listed) throw new IngestError("Join.com's job has no title.");
    return {
      found: true,
      raw: { ...listed, descriptionHtml: str(job.description), salary: joinSalaryOf(job) },
      company,
      board: slug,
    };
  }
  // No Next.js data: the page's JobPosting (EVIDENCE: Join's job pages carry one).
  const posting = pageJobPosting(html, url);
  if (!posting) throw new IngestError("The job's page holds no job.");
  const board = fromUrl ?? canonical?.company ?? null;
  // v38 FIX-A (M3): a short link's posting is its long form's (the page's canonical link).
  const link = fromUrl ? url : canonical ? joinJobUrl(canonical.company, canonical.segment) : null;
  if (!board || !link) throw new IngestError("Join.com's page names no company.");
  const name = options.companyName ?? posting.hiringOrganization?.name ?? board;
  return {
    found: true,
    raw: {
      sourceJobId: id,
      title: posting.title,
      company: { name },
      descriptionHtml: posting.descriptionHtml,
      url: link,
      locations: [...posting.locations, ...(posting.remote ? ['Remote'] : [])],
      employmentText: posting.employmentText,
      salary: posting.salary,
      postedAt: posting.datePosted,
    },
    // Its organisation's own site is its sameAs (its url is the company's Join.com page).
    company: posting.hiringOrganization ? { name: posting.hiringOrganization.name, website: posting.hiringOrganization.sameAs[0] ?? null } : null,
    board,
  };
}

/** The company facts applied to a posting (its website and about text: the company record takes them). */
function withFacts(raw: RawPosting, facts: CompanyFacts | null): RawPosting {
  return facts ? withCompanyFacts(raw, { ...facts, name: null }, undefined) : raw;
}

export const joinAdapter = defineAdapter({
  kind: 'join',
  label: 'Join.com company',
  access: 'page',
  hosts: [JOIN_HOST, `www.${JOIN_HOST}`],
  robotsPaths(source) {
    try {
      const company = joinCompanyOfSource(source.config);
      return [`/companies/${company}`, `/companies/${company}/`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const company = joinCompanyOfSource(source.config);
    const html = await readJoinPage(ctx.http, joinCompanyUrl(company), ctx.signal);
    if (html === null) throw new SourceNotFoundError(`Join.com has no company "${company}". Check the company's address.`);
    const list = joinListOf(html);
    if (!list) throw new IngestError(`Join.com answered without the jobs of "${company}".`);
    const companyName = str(source.config.companyName) ?? list.company?.name ?? company;
    const failures: FetchFailure[] = [];
    const listed = new Map<string, RawPosting>();
    for (const item of list.items) {
      const posting = joinListedPosting(item, company, companyName);
      if (!posting) failures.push({ sourceJobId: str(item.id) ?? undefined, message: 'A job has no id or title.' });
      else if (!listed.has(posting.sourceJobId)) listed.set(posting.sourceJobId, withFacts(posting, list.company));
    }
    ctx.log(`Join.com ${company}: ${listed.size} jobs${list.whole ? '' : ` of ${list.total ?? 'more'} (only the page's first ones: its next pages are not read)`}.`);
    const constants = constantsOf(ctx.deps);
    const runs = !ctx.listingOnly && source.id > 0;
    return runListedReads(source, ctx, {
      label: `Join.com ${company}`,
      host: JOIN_HOST,
      listed,
      whole: list.whole,
      failures,
      read: async (id, posting) => {
        const read = await readJoinPosting(ctx.http, posting.url, id, { companyName, signal: ctx.signal });
        return read.found ? withFacts(read.raw, read.company ?? list.company) : null;
      },
      budget: runs ? constants.get('JOIN_READS_PER_RUN') : 0,
      recheckMs: runs ? constants.get('LISTED_POSTINGS_RECHECK_DAYS') * DAY_MS : 0,
    });
  },
});
