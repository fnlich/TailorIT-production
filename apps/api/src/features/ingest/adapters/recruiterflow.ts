import { DAY_MS } from '@tailorit/shared';
import { RECRUITERFLOW_HOST, RECRUITERFLOW_JOB_ID, recruiterflowCompanyOf, recruiterflowJobUrl } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { withCompanyFacts } from '../boards/company';
import type { CompanyFacts } from '../boards/types';
import { jobPostingOf, jsonLdBlocksOf } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { IngestError, SourceNotFoundError, type FetchFailure, type RawPosting } from '../types';
import { arrangementOf, isRecord, num, records, str, type Json } from './common';
import { defineAdapter } from './define';
import { runListedReads } from './listed-reads';
import { jsonLiteralAfter, PAGE_ACCEPT } from './page-data';

// v38 ATS-B (SP v38 REQUEST.md 14, EVIDENCE.md §14, PLAN "Final coverage" 14): a company's (most often a recruiting
// agency's) Recruiterflow job board. Its pages are a JavaScript app ("Loading..."), but their raw HTML carries the data
// (robots.txt allows everything; no headless browser):
//   - the board, GET https://recruiterflow.com/{company}/jobs (about 1 MB): `window.jobsList = { "<grouping>": [
//     ["<group>", [{ apply_link "<company>/jobs/<id>" (relative, no leading slash), details (its place's words),
//     employment_type, job_id, job_name, last_opened, remote_type }]], ...], ... }`: one job may sit in several groupings
//     (read once, by job_id);
//   - a job's page, GET https://recruiterflow.com/{company}/jobs/{id}: one JSON-LD JobPosting (title, description, its
//     identifier, datePosted, employmentType, hiringOrganization { name, logo }, jobLocation's address, whose parts start
//     with ", ": trimmed) and `var convertedToJSON = {...}` (window.applyJobData: job_id, job_name, job_location
//     "Remote|United States", job_visibility_id, JOB_VISIBILITY_CLOSED 6, company_name). A job whose visibility is the
//     closed one is gone, as is a 404. Its apply form (application_form) and tracking code are never read or kept.
// A run reads the board, then each job's page as BambooHR's openings are read (adapters/listed-reads.ts), at most
// RECRUITERFLOW_READS_PER_RUN a run.
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The most of one page read: 4 MB (a board's runs to about 1 MB, a job's to about 120 kB). */
export const RECRUITERFLOW_PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The visibility of a closed job, when its page does not say (EVIDENCE: JOB_VISIBILITY_CLOSED 6). */
const VISIBILITY_CLOSED = 6;

/** A source's company on Recruiterflow, or the plain refusal for a config that names none. */
export function recruiterflowCompanyOfSource(config: Record<string, unknown>): string {
  const company = recruiterflowCompanyOf(str(config.company) ?? '');
  if (!company) throw new IngestError('This source names no Recruiterflow board (recruiterflow.com/<name>/jobs). Edit the source and add it.');
  return company;
}

/** The company's board page. */
export const recruiterflowBoardUrl = (company: string) => `https://${RECRUITERFLOW_HOST}/${company}/jobs`;

/** A Recruiterflow page (on its host only): its HTML, or null for a 404 or 410 (gone). */
async function readPage(http: IngestHttp, url: string, signal?: AbortSignal): Promise<string | null> {
  const answer = await http.getJson(url, {
    signal,
    text: true,
    accept: PAGE_ACCEPT,
    allow: [404, 410],
    maxBytes: RECRUITERFLOW_PAGE_MAX_BYTES,
    allowRedirectHost: (to) => to === RECRUITERFLOW_HOST || to === `www.${RECRUITERFLOW_HOST}`,
  });
  if (answer.status === 404 || answer.status === 410) return null;
  return typeof answer.data === 'string' ? answer.data : '';
}

/** A place's words as Recruiterflow writes them (", San Francisco", "Remote|United States"): its separators trimmed. */
export function recruiterflowPlace(value: unknown): string | null {
  const text = str(value)
    ?.split('|')
    .map((part) => part.replace(/^[\s,]+|[\s,]+$/g, ''))
    .filter(Boolean)
    .join(', ');
  return text || null;
}

/** The board's jobs, each once (by job_id), in the order the board first names them; null when the page has no list. */
export function recruiterflowJobsOf(html: string): Json[] | null {
  const list = jsonLiteralAfter(html, 'window.jobsList = ');
  if (!isRecord(list)) return null;
  const jobs = new Map<string, Json>();
  for (const groups of Object.values(list)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const items = Array.isArray(group) ? group[1] : null;
      for (const item of records(items)) {
        const id = str(item.job_id);
        if (id && RECRUITERFLOW_JOB_ID.test(id) && !jobs.has(id)) jobs.set(id, item);
      }
    }
  }
  return [...jobs.values()];
}

/** A board's job as a listing's posting (title, place, type, date, link); null without an id or a name. */
export function recruiterflowListedPosting(item: Json, company: string, companyName: string): RawPosting | null {
  const id = str(item.job_id);
  const title = str(item.job_name);
  if (!id || !RECRUITERFLOW_JOB_ID.test(id) || !title) return null;
  const place = recruiterflowPlace(item.details);
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    // Its apply_link is relative ("<company>/jobs/<id>"): the clean link is built from the board and the id.
    url: recruiterflowJobUrl(company, id),
    locations: place ? [place] : [],
    workArrangement: arrangementOf(item.remote_type) ?? arrangementOf(item.details),
    employmentText: str(item.employment_type),
    postedAt: str(item.last_opened),
  };
}

/** A job's page data: its applyJobData (convertedToJSON) without its apply form, or null. */
function applyDataOf(html: string): Json | null {
  const data = jsonLiteralAfter(html, 'var convertedToJSON = ');
  if (!isRecord(data)) return null;
  // Never kept: the apply form and the tracking code (only what a posting needs is read below).
  const rest: Json = { ...data };
  for (const key of ['application_form', 'tracking_code', 'tracking_code_body']) delete rest[key];
  return rest;
}

/** A JSON-LD JobPosting with its places' parts trimmed (Recruiterflow writes ", San Francisco", ", CA"). */
function trimmedPlaces(node: Json): Json {
  const trim = (address: unknown) => {
    if (!isRecord(address)) return address;
    const out: Json = { ...address };
    for (const key of ['addressLocality', 'addressRegion', 'addressCountry', 'postalCode']) {
      if (typeof out[key] === 'string') out[key] = (out[key] as string).replace(/^[\s,]+|[\s,]+$/g, '');
    }
    return out;
  };
  const place = (value: unknown) => (isRecord(value) ? { ...value, address: trim(value.address) } : value);
  return { ...node, jobLocation: Array.isArray(node.jobLocation) ? node.jobLocation.map(place) : place(node.jobLocation) };
}

/** One job's read: found (its posting and its company's facts), or gone. */
export type RecruiterflowRead = { found: true; raw: RawPosting; company: CompanyFacts } | { found: false };

/**
 * One job read from its page (at most RECRUITERFLOW_PAGE_MAX_BYTES, on recruiterflow.com only): its posting (the
 * JSON-LD's text, the page data's place and visibility), named by `companyName`, else the hiring organisation; or gone
 * (404, 410, the closed visibility). Throws IngestHttpError when Recruiterflow fails, RobotsRefusal when robots.txt
 * refuses the read, and IngestError when the page holds no posting, or another one.
 */
export async function readRecruiterflowPosting(
  http: IngestHttp,
  company: string,
  id: string,
  options: { companyName: string | null; signal?: AbortSignal },
): Promise<RecruiterflowRead> {
  if (!RECRUITERFLOW_JOB_ID.test(id)) throw new IngestError('TailorIT does not know this Recruiterflow job.');
  const url = recruiterflowJobUrl(company, id);
  const html = await readPage(http, url, options.signal);
  if (html === null) return { found: false };
  const data = applyDataOf(html);
  if (data && str(data.job_id) !== null && str(data.job_id) !== id) throw new IngestError("Recruiterflow's page holds another job.");
  const closed = num(data?.JOB_VISIBILITY_CLOSED) ?? VISIBILITY_CLOSED;
  if (data && num(data.job_visibility_id) === closed) return { found: false };
  const node = jsonLdBlocksOf(html).find((block) => isRecord(block) && block['@type'] === 'JobPosting');
  const posting = isRecord(node) ? jobPostingOf(trimmedPlaces(node)) : null;
  const title = posting?.title ?? str(data?.job_name);
  const descriptionHtml = posting?.descriptionHtml ?? str(data?.about_position);
  if (!title || !descriptionHtml) throw new IngestError("The job's page holds no posting.");
  const org = posting?.hiringOrganization ?? null;
  const name = options.companyName ?? org?.name ?? str(data?.company_name) ?? company;
  // Its places: the JSON-LD's address (each part's leading ", " trimmed), else the page data's words.
  const places = (posting?.locations ?? []).map(recruiterflowPlace).filter((place): place is string => Boolean(place));
  const fallback = recruiterflowPlace(data?.job_location);
  const locations = places.length > 0 ? places : fallback ? [fallback] : [];
  const remote = /\bremote\b/i.test(str(data?.job_location) ?? '') || posting?.remote === true;
  return {
    found: true,
    raw: {
      sourceJobId: id,
      title,
      company: { name },
      descriptionHtml,
      url,
      locations,
      workArrangement: remote ? 'remote' : arrangementOf(data?.remote_type),
      employmentText: posting?.employmentText ?? str(data?.employment_type),
      salary: posting?.salary ?? null,
      postedAt: posting?.datePosted ?? null,
    },
    company: { name: org?.name ?? str(data?.company_name), logoUrl: org?.logo ?? null, website: org?.sameAs[0] ?? org?.url ?? null },
  };
}

/** The company facts applied to a posting (its logo and website: the company record takes them). */
function withLogo(raw: RawPosting, facts: CompanyFacts | null): RawPosting {
  return facts ? withCompanyFacts(raw, { ...facts, name: null }, undefined) : raw;
}

export const recruiterflowAdapter = defineAdapter({
  kind: 'recruiterflow',
  label: 'Recruiterflow job board',
  access: 'page',
  hosts: [RECRUITERFLOW_HOST, `www.${RECRUITERFLOW_HOST}`],
  robotsPaths(source) {
    try {
      const company = recruiterflowCompanyOfSource(source.config);
      return [`/${company}/jobs`, `/${company}/jobs/`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const company = recruiterflowCompanyOfSource(source.config);
    const html = await readPage(ctx.http, recruiterflowBoardUrl(company), ctx.signal);
    if (html === null) throw new SourceNotFoundError(`Recruiterflow has no board "${company}". Check the board's address.`);
    const jobs = recruiterflowJobsOf(html);
    if (!jobs) throw new IngestError(`Recruiterflow answered without the jobs of "${company}".`);
    const companyName = str(source.config.companyName) ?? null;
    const failures: FetchFailure[] = [];
    const listed = new Map<string, RawPosting>();
    for (const item of jobs) {
      const posting = recruiterflowListedPosting(item, company, companyName ?? company);
      if (!posting) failures.push({ sourceJobId: str(item.job_id) ?? undefined, message: 'A job has no id or name.' });
      else listed.set(posting.sourceJobId, posting);
    }
    ctx.log(`Recruiterflow ${company}: ${listed.size} jobs.`);
    const constants = constantsOf(ctx.deps);
    const runs = !ctx.listingOnly && source.id > 0;
    return runListedReads(source, ctx, {
      label: `Recruiterflow ${company}`,
      host: RECRUITERFLOW_HOST,
      listed,
      whole: true,
      failures,
      read: async (id) => {
        const read = await readRecruiterflowPosting(ctx.http, company, id, { companyName, signal: ctx.signal });
        return read.found ? withLogo(read.raw, read.company) : null;
      },
      budget: runs ? constants.get('RECRUITERFLOW_READS_PER_RUN') : 0,
      recheckMs: runs ? constants.get('LISTED_POSTINGS_RECHECK_DAYS') * DAY_MS : 0,
    });
  },
});
