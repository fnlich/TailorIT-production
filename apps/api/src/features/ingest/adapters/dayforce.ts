import { DAYFORCE_HOST, DAYFORCE_POSTING_ID } from '@tailorit/shared/sourcing';
import { assertNewReadAllowed } from '../../../core/http/identity';
import type { CompanyFacts } from '../boards/types';
import { placeOfParts } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { IngestError, type RawPosting, type RawSalary } from '../types';
import { isRecord, num, records, str, type Json } from './common';
import { defineAdapter } from './define';
import { nextDataOf, PAGE_ACCEPT, pathOf } from './page-data';

// v38 ATS-B (SP v38 REQUEST.md 17, EVIDENCE.md §17, PLAN "Final coverage" 17): a Dayforce posting, read from its own page's
// Next.js data (robots.txt has no rules; no headless browser): GET https://jobs.dayforcehcm.com/[<locale>/]<namespace>/
// <portal>/jobs/<id>, `<script id="__NEXT_DATA__">` props.pageProps.jobData { jobPostingId (the link's id; jobReqId is
// the page's "Req #"), jobTitle, postingStartTimestampUTC, postingExpiryTimestampUTC, jobPostingContent {
// jobDescriptionHeader (its "About" part), jobDescription, jobDescriptionFooter } (HTML), postingLocations [{ cityName,
// stateCode, isoCountryCode }], hasVirtualLocation, jobPostingAttributes [{ name PayType|HiringMinRate|HiringMaxRate,
// value }], isoCurrencyRegion }, and its site's info (dehydratedState's "site-info" query: candidateCorrespondenceClientName,
// the employer's name; largeLogo). A posting that is gone answers 404 ("Page Not Found", no jobData), as does a past
// expiry. The client's correspondence mailbox is never read.
// A portal's job list needs a browser (its raw HTML holds no jobs): the kind never runs (SP v38 PLAN "Final coverage");
// its links are read one at a time (Add job, imports, the extension, MCP, re-checks).

/** The most of one posting's page read: 4 MB (they run to about 450 kB, mostly their words in every language). */
export const DAYFORCE_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Pay types as salary periods (Dayforce's PayType: Salary, Hourly). */
const PAY_PERIODS: Readonly<Record<string, RawSalary['period']>> = { salary: 'year', salaried: 'year', hourly: 'hour', hour: 'hour' };

/** A posting's pay from its attributes (HiringMinRate, HiringMaxRate, PayType) and its currency; null for none. */
export function dayforceSalaryOf(job: Json): RawSalary | null {
  const attributes = new Map(records(job.jobPostingAttributes).map((item) => [str(item.name)?.toLowerCase() ?? '', item.value]));
  const min = num(attributes.get('hiringminrate'));
  const max = num(attributes.get('hiringmaxrate'));
  if (min === null && max === null) return null;
  const currency = str(job.isoCurrencyRegion)?.toUpperCase() ?? null;
  return {
    min: min ?? max,
    max: max ?? min,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    period: PAY_PERIODS[str(attributes.get('paytype'))?.toLowerCase() ?? ''] ?? null,
  };
}

/** A posting's places (city, state, country), each once. */
function placesOf(job: Json): string[] {
  const places: string[] = [];
  for (const location of records(job.postingLocations)) {
    const place = placeOfParts(str(location.cityName), str(location.stateCode), str(location.isoCountryCode));
    if (place && !places.includes(place)) places.push(place);
  }
  return places;
}

/** The site's info a page's data holds (its "site-info" query's data), or null. */
function siteInfoOf(pageProps: Json): Json | null {
  const queries = isRecord(pageProps.dehydratedState) ? records(pageProps.dehydratedState.queries) : [];
  for (const query of queries) {
    const key = Array.isArray(query.queryKey) ? query.queryKey[0] : null;
    const data = isRecord(query.state) ? query.state.data : null;
    if (key === 'site-info' && isRecord(data)) return data;
  }
  return null;
}

/** The employer a posting's site names (its correspondence name, its logo); null for none. */
export function dayforceCompanyOf(pageProps: Json): CompanyFacts | null {
  const info = siteInfoOf(pageProps);
  if (!info) return null;
  const name = str(info.candidateCorrespondenceClientName)?.slice(0, 200) ?? null;
  const logo = isRecord(info.largeLogo) ? str(info.largeLogo.url) : isRecord(info.smallLogo) ? str(info.smallLogo.url) : null;
  return name || logo ? { name, logoUrl: logo } : null;
}

/** A posting's jobData as the RawPosting at `url` (null without a title): its text in its three parts, places, pay, dates. */
export function dayforcePosting(job: Json, id: string, url: string, companyName: string): RawPosting | null {
  const title = str(job.jobTitle);
  if (!title) return null;
  const content = isRecord(job.jobPostingContent) ? job.jobPostingContent : {};
  const parts = [str(content.jobDescriptionHeader), str(content.jobDescription), str(content.jobDescriptionFooter)].filter((part): part is string => Boolean(part));
  const places = placesOf(job);
  const virtual = job.hasVirtualLocation === true;
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: parts.length > 0 ? parts.join('\n') : null,
    url,
    locations: places.length > 0 ? places : virtual ? ['Remote'] : [],
    workArrangement: virtual && places.length === 0 ? 'remote' : null,
    salary: dayforceSalaryOf(job),
    postedAt: str(job.postingStartTimestampUTC),
  };
}

/** One posting's read: found (its posting and its employer's facts), or gone. */
export type DayforceRead = { found: true; raw: RawPosting; company: CompanyFacts | null } | { found: false };

/**
 * One posting read from its page (at most DAYFORCE_PAGE_MAX_BYTES, on jobs.dayforcehcm.com only): found, named by
 * `companyName`, else its site's correspondence name (v38 FIX-APP, D1: else none, never the client's namespace); or gone (404, 410, Dayforce's own "not
 * found" page, a past expiry). Throws IngestHttpError when Dayforce fails, RobotsRefusal when robots.txt refuses the
 * read, and IngestError when the page holds no posting data, or another posting's.
 */
export async function readDayforcePosting(
  http: IngestHttp,
  url: string,
  id: string,
  options: { namespace: string; companyName: string | null; signal?: AbortSignal; now: Date },
): Promise<DayforceRead> {
  if (!DAYFORCE_POSTING_ID.test(id)) throw new IngestError('TailorIT does not know this Dayforce posting.');
  const answer = await http.getJson(url, {
    signal: options.signal,
    text: true,
    accept: PAGE_ACCEPT,
    allow: [404, 410],
    maxBytes: DAYFORCE_PAGE_MAX_BYTES,
    allowRedirectHost: (to) => to === DAYFORCE_HOST,
  });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const data = nextDataOf(typeof answer.data === 'string' ? answer.data : '');
  if (data && data.page === '/404') return { found: false };
  const pageProps = pathOf(data, 'props.pageProps');
  const job = isRecord(pageProps) ? pageProps.jobData : null;
  if (!isRecord(pageProps) || !isRecord(job)) throw new IngestError("The posting's page holds no posting data.");
  if (str(job.jobPostingId) !== id) throw new IngestError("Dayforce's page holds another posting.");
  const expiry = str(job.postingExpiryTimestampUTC);
  if (expiry && Date.parse(expiry) < options.now.getTime()) return { found: false };
  const company = dayforceCompanyOf(pageProps);
  const raw = dayforcePosting(job, id, url, options.companyName ?? company?.name ?? ''); // v38 FIX-APP (D1)
  if (!raw) throw new IngestError("Dayforce's posting has no title.");
  return { found: true, raw, company };
}

export const dayforceAdapter = defineAdapter({
  kind: 'dayforce',
  label: 'Dayforce postings',
  access: 'page',
  hosts: [DAYFORCE_HOST],
  // A new kind of read: the identity guard first ('feed_read'), as every new kind's run refuses before anything.
  async fetch(_source, ctx) {
    assertNewReadAllowed(ctx.deps, 'feed_read');
    throw new IngestError(
      "TailorIT reads Dayforce postings one at a time (the ones added by their links), never a whole Dayforce portal: its job list needs a browser. This source can't be run; the daily check keeps its postings up to date.",
    );
  },
});
