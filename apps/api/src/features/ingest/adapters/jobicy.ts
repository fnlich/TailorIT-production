import { z } from 'zod';
import { decodeHtmlEntities } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { IngestError, type FetchFailure, type RawPosting } from '../types';
import { isRecord, num, records, str, type Json } from './common';
import { defineAdapter } from './define';
import { levelsOf } from './himalayas';

// v30 S4: Jobicy, remote jobs of the last days (docs/design/part2/12-job-sourcing.md §3.7, §8.1, §11 phase 4; SP
// DECISIONS P1, owner questions 7 and 9). One source is one filtered listing of the free jobs API:
//
//   GET https://jobicy.com/api/v2/remote-jobs?count=50[&geo=<region>][&industry=<slug>][&tag=<word>]
//
// keyless, so its host's robots.txt is read first like any keyless read's (`/api/jobs` allowed on 2026-11-14), and,
// like every new kind of read, only once BOT_USER_AGENT names TailorIT's bot page and mailbox (assertNewReadAllowed
// 'remote_api': the run and this adapter both ask; the service's client sends BOT_USER_AGENT).
//
// Terms (read 2026-11-14, design [A12]): "Our free Jobs API can be used in commercial projects"; "You may store, cache,
// process, and retain Jobicy API data without a fixed retention period"; credit Jobicy (job_source_kinds' attribution
// "Jobicy", shown on the job's card); apply links stay Jobicy's (the posting's url is the job's Jobicy page); one sync
// an hour (JOBICY_READ_GAP_MINUTES across every Jobicy source: a run sooner reads nothing).
//
// For US users (owner question 9) a source's `geo` is `usa` unless its settings name another region (or "any"). The
// API answers the newest JOBICY_COUNT jobs at most: a full answer may have left older ones out, so it is not complete
// (nothing closes); a shorter one is the whole listing, and a job it no longer lists closes after two such listings
// (12 §8.1-8.2).

export const JOBICY_API = 'https://jobicy.com/api/v2/remote-jobs';
/** The API's host: its redirects stay on it (v30 FIX-A). */
export const JOBICY_HOST = new URL(JOBICY_API).hostname;
/** The most jobs one listing asks for (within Jobicy's own cap). */
export const JOBICY_COUNT = 50;

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A Jobicy source's settings: its region (`geo`, default usa; "any" for every region), industry and tag. */
export const JobicyConfigSchema = z.object({
  geo: z.string().trim().toLowerCase().regex(SLUG, 'Give the region as Jobicy writes it, such as usa or canada.').optional(),
  industry: z.string().trim().toLowerCase().regex(SLUG, 'Give the industry as Jobicy writes it, such as dev or marketing.').optional(),
  tag: z.string().trim().max(40).optional(),
});

/** The listing's address for a source's settings: count, then geo (usa unless "any"), industry and tag. */
export function jobicyUrl(config: Record<string, unknown>): string {
  const parsed = JobicyConfigSchema.safeParse(config);
  if (!parsed.success) throw new IngestError(`This Jobicy source's settings are not valid: ${parsed.error.issues[0]?.message ?? ''}`);
  const query = new URLSearchParams({ count: String(JOBICY_COUNT) });
  const geo = parsed.data.geo ?? 'usa';
  if (geo !== 'any') query.set('geo', geo);
  if (parsed.data.industry) query.set('industry', parsed.data.industry);
  if (parsed.data.tag) query.set('tag', parsed.data.tag);
  return `${JOBICY_API}?${query.toString()}`;
}

/** A Jobicy time ("2026-11-13 08:00:00", UTC) as ISO; null when unreadable. */
export function jobicyTime(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function words(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((item) => str(item)).filter((item): item is string => Boolean(item)).map((item) => decodeHtmlEntities(item));
}

/** A job's region ("USA", "USA, Canada", "Anywhere") as remote places. */
export function jobicyPlaces(geo: string | null): string[] {
  if (!geo || /anywhere|worldwide|global/i.test(geo)) return ['Remote'];
  return geo
    .split(/\s*[,/;]\s*|\s+(?:and|&)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `Remote, ${part}`);
}

/** One job as a RawPosting; null when it lacks an id, a title, a company or its Jobicy link. */
export function jobicyPosting(job: Json): RawPosting | null {
  const id = str(job.id);
  const title = str(job.jobTitle);
  const company = str(job.companyName);
  const url = str(job.url);
  if (!id || !title || !company || !url || !/^https:\/\/\S+$/i.test(url)) return null;
  const min = num(job.annualSalaryMin);
  const max = num(job.annualSalaryMax);
  return {
    sourceJobId: id,
    title: decodeHtmlEntities(title),
    company: { name: decodeHtmlEntities(company) },
    descriptionHtml: typeof job.jobDescription === 'string' && job.jobDescription.trim() ? job.jobDescription : null,
    descriptionText: str(job.jobExcerpt),
    url,
    locations: jobicyPlaces(str(job.jobGeo)),
    workArrangement: 'remote',
    employmentText: words(job.jobType).join(', ') || null,
    experienceLevels: levelsOf(words(job.jobLevel)),
    department: words(job.jobIndustry)[0] ?? null,
    salary: min !== null || max !== null ? { min, max, currency: str(job.salaryCurrency) ?? 'USD', period: 'year' } : null,
    postedAt: jobicyTime(job.pubDate),
  };
}

/** When a Jobicy source last read the API (a run that made a request), as ms; null when none ever did. */
async function lastRead(deps: Pick<AppDeps, 'db'>): Promise<number | null> {
  const row = await deps.db.one<{ at: string | Date | null }>(
    `SELECT MAX(r.started_at) AS at FROM job_source_runs r JOIN job_sources s ON s.id = r.source_id
     WHERE s.kind = 'jobicy' AND r.requests > 0`,
  );
  if (!row?.at) return null;
  const at = row.at instanceof Date ? row.at.getTime() : Date.parse(row.at);
  return Number.isNaN(at) ? null : at;
}

export const jobicyAdapter = defineAdapter({
  kind: 'jobicy',
  label: 'Jobicy remote jobs',
  access: 'api',
  hosts: [JOBICY_HOST],
  robotsPaths: (source) => {
    const url = new URL(jobicyUrl(source.config));
    return [`${url.pathname}${url.search}`];
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, 'remote_api');
    const url = jobicyUrl(source.config);
    const last = await lastRead(ctx.deps);
    // v30 FIX-WEB (REQ-7): Jobicy's "one sync an hour", the constant JOBICY_READ_GAP_MINUTES (by any Jobicy source).
    const gap = constantsOf(ctx.deps).get('JOBICY_READ_GAP_MINUTES');
    if (last !== null && ctx.deps.now().getTime() - last < gap * 60_000) {
      ctx.log(`Jobicy was read less than ${gap} minutes ago (its terms ask for one read an hour): nothing was read this run.`);
      return { postings: [], complete: false, failures: [] };
    }
    // v30 FIX-A (REV-SEC SEC-1): never a redirect off the API's host.
    const answer = await ctx.http.getJson(url, { signal: ctx.signal, allowRedirectHost: (host) => host === JOBICY_HOST });
    if (!isRecord(answer.data) || !Array.isArray(answer.data.jobs)) throw new IngestError('Jobicy answered without a job list.');
    const jobs = records(answer.data.jobs);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    for (const job of jobs) {
      const posting = jobicyPosting(job);
      if (posting) postings.push(posting);
      else failures.push({ sourceJobId: str(job.id) ?? undefined, message: 'A listed job has no id, title, company or link.' });
    }
    const complete = jobs.length < JOBICY_COUNT;
    if (!complete) ctx.log(`Jobicy answered its most (${JOBICY_COUNT} jobs): older ones may be left out, so nothing is marked missing this run.`);
    ctx.log(`Jobicy: ${postings.length} jobs.`);
    return { postings, complete, failures };
  },
});
