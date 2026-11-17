import { z } from 'zod';
import { decodeHtmlEntities, parseLocations, DAY_MS, type ExperienceLevel } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { IngestError, type FetchFailure, type RawPosting } from '../types';
import { isRecord, num, records, str, type Json } from './common';
import { defineAdapter, type OutsideKey } from './define';

// v30 S4: Himalayas, remote jobs (docs/design/part2/12-job-sourcing.md §3.7, §8.1, §11 phase 4; SP DECISIONS P1, owner
// questions 7, 9 and 10). One source reads the remote-jobs API page by page:
//
//   GET https://himalayas.app/jobs/api?limit=20&offset=<n>
//
// with TailorIT's one identity (BOT_USER_AGENT, sent by the service's client for new kinds of read) and the key the
// owner signed up for (HIMALAYAS_API_KEY, deps.config.outside.himalayasApiKey) as `Authorization: Bearer <key>`, kept
// out of the address so no run log or error repeats it. Two switches keep it off: BOT_USER_AGENT's placeholder
// (assertNewReadAllowed 'remote_api': the run and this adapter both ask) and an empty key (`outsideKey`: the worker
// never takes the source, Run now refuses). Its host's robots.txt is read like any keyless read's (`/jobs/api`
// allowed, `ai-input=yes` on 2026-11-14).
//
// Terms (read 2026-11-14, design [A11]): use in commercial integrations, "your own job board, website or app"; caching
// allowed, expired jobs removed; a visible credit with a link (job_source_kinds' attribution "Himalayas", shown on the
// job's card); every Apply uses the API's `applicationLink` (the posting's url); no passing jobs on to aggregators.
// Limits: 60 requests a minute (the host's one-a-second pace, INGEST_HOST_MIN_INTERVAL_MS), HIMALAYAS_REQUESTS_PER_DAY
// a day (the constant, under Himalayas' 10,000: the day's runs of every Himalayas source share it), 20 jobs a request.
// A run that meets the day's budget stops there, not complete (nothing closes).
//
// For US users (owner question 9): a source keeps the jobs open to its `country` (by default the US): those with no
// location restriction (anywhere) or one naming it; `country: "any"` keeps every job. A job past its `expiryDate` is
// left out (it closes after two listings miss it, 12 §8.1-8.2).

export const HIMALAYAS_API = 'https://himalayas.app/jobs/api';
/** The API's host: its redirects stay on it (v30 FIX-A). */
export const HIMALAYAS_HOST = new URL(HIMALAYAS_API).hostname;
/** The most jobs one request answers (Himalayas' own cap). */
export const HIMALAYAS_PAGE_SIZE = 20;
/** The window HIMALAYAS_REQUESTS_PER_DAY counts. */

/** A Himalayas source's settings: the country its jobs must be open to (a name or an ISO code; "any" for every job). */
export const HimalayasConfigSchema = z.object({
  country: z.string().trim().min(2).max(60).optional(),
});

/** HIMALAYAS_API_KEY (DECISIONS P1, owner question 10): the source stays off while it is empty. */
export const HIMALAYAS_KEY: OutsideKey = {
  setting: 'HIMALAYAS_API_KEY',
  of: (deps) => deps.config.outside.himalayasApiKey,
};

export function himalayasPageUrl(offset: number): string {
  return `${HIMALAYAS_API}?limit=${HIMALAYAS_PAGE_SIZE}&offset=${offset}`;
}

/** A country name or ISO code as its code ("United States", "USA", "us": "US"); null when it names no country. */
export function countryCodeOf(text: string): string | null {
  const value = text.trim();
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return parseLocations([value])[0]?.countryCode ?? null;
}

/** The country a source keeps jobs for: its config's, by default the US; null keeps every job ("any"). */
export function himalayasCountry(config: Record<string, unknown>): string | null {
  const given = str(config.country) ?? 'US';
  if (given.toLowerCase() === 'any') return null;
  const code = countryCodeOf(given);
  if (!code) throw new IngestError(`"${given}" is not a country: give the Himalayas source a country name or code, or "any".`);
  return code;
}

/** A Himalayas time: Unix seconds (or milliseconds), or an ISO text; null when unreadable. */
export function himalayasTime(value: unknown): number | null {
  const n = num(value);
  if (n !== null) return n > 1e12 ? n : n * 1000;
  const text = str(value);
  const parsed = text ? Date.parse(text) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/** Seniority words as experience levels (the rest is left to the posting's own reading). */
export function levelsOf(words: string[]): ExperienceLevel[] {
  const levels = new Set<ExperienceLevel>();
  for (const word of words.map((item) => item.toLowerCase())) {
    if (/entry|intern|graduate/.test(word)) levels.add('entry');
    else if (/junior/.test(word)) levels.add('junior');
    else if (/mid/.test(word)) levels.add('mid');
    else if (/senior/.test(word)) levels.add('senior');
    else if (/director|executive|principal|staff|lead|head/.test(word)) levels.add('expert');
  }
  return [...levels];
}

function words(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((item) => (isRecord(item) ? str(item.name) : str(item))).filter((item): item is string => Boolean(item));
}

function httpsAddress(value: unknown): string | null {
  const text = str(value);
  return text && /^https:\/\/\S+$/i.test(text) ? text : null;
}

/**
 * One job as a RawPosting; null when it lacks an id, a title or its application link (the terms' Apply), or names no
 * company.
 */
export function himalayasPosting(job: Json): RawPosting | null {
  const id = str(job.guid) ?? str(job.id);
  const title = str(job.title);
  const url = httpsAddress(job.applicationLink);
  const company = str(job.companyName);
  if (!id || !title || !url || !company) return null;
  const restrictions = words(job.locationRestrictions);
  const min = num(job.minSalary);
  const max = num(job.maxSalary);
  const posted = himalayasTime(job.pubDate);
  return {
    sourceJobId: id,
    title: decodeHtmlEntities(title),
    company: { name: decodeHtmlEntities(company) },
    descriptionHtml: typeof job.description === 'string' && job.description.trim() ? job.description : null,
    descriptionText: str(job.excerpt),
    url,
    locations: restrictions.length ? restrictions.map((country) => `Remote, ${country}`) : ['Remote'],
    workArrangement: 'remote',
    employmentText: str(job.employmentType),
    experienceLevels: levelsOf(words(job.seniority)),
    department: words(job.categories)[0] ?? null,
    salary:
      min !== null || max !== null
        ? { min, max, currency: str(job.currency) ?? str(job.salaryCurrency) ?? 'USD', period: 'year' }
        : null,
    postedAt: posted !== null ? new Date(posted).toISOString() : null,
  };
}

/** Whether a job is open to `country` (null: any job): no location restriction, or one naming it. */
export function openTo(job: Json, country: string | null): boolean {
  if (!country) return true;
  const restrictions = words(job.locationRestrictions);
  return restrictions.length === 0 || restrictions.some((place) => countryCodeOf(place) === country);
}

/** Requests the day's Himalayas runs made (job_source_runs.requests, the last 24 hours), shared by every source. */
async function requestsToday(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  const row = await deps.db.one<{ n: number | string }>(
    `SELECT COALESCE(SUM(r.requests), 0) AS n FROM job_source_runs r JOIN job_sources s ON s.id = r.source_id
     WHERE s.kind = 'himalayas' AND r.started_at > CAST(? AS timestamptz)`,
    [new Date(deps.now().getTime() - DAY_MS).toISOString()],
  );
  return Number(row?.n ?? 0);
}

export const himalayasAdapter = defineAdapter({
  kind: 'himalayas',
  label: 'Himalayas remote jobs',
  access: 'api',
  hosts: [HIMALAYAS_HOST],
  robotsPaths: () => [`/jobs/api?limit=${HIMALAYAS_PAGE_SIZE}&offset=0`],
  outsideKey: HIMALAYAS_KEY,
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, 'remote_api');
    const key = HIMALAYAS_KEY.of(ctx.deps);
    if (!key) throw new IngestError('TailorIT reads no Himalayas source while HIMALAYAS_API_KEY is empty: set it in .env, then restart.');
    const country = himalayasCountry(source.config);
    const budget = Math.max(0, constantsOf(ctx.deps).get('HIMALAYAS_REQUESTS_PER_DAY') - (await requestsToday(ctx.deps)));
    const now = ctx.deps.now().getTime();
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    let complete = true;
    let expired = 0;
    let elsewhere = 0;
    let total: number | null = null;
    let offset = 0;
    for (let page = 0; ; page += 1) {
      if (page >= budget) {
        complete = false;
        ctx.log(`The day's Himalayas requests (HIMALAYAS_REQUESTS_PER_DAY) are spent: the rest is read on a later run, and nothing is marked missing this run.`);
        break;
      }
      let answer;
      try {
        answer = await ctx.http.getJson(himalayasPageUrl(offset), {
          signal: ctx.signal,
          allow: [401],
          headers: { Authorization: `Bearer ${key}` },
          // v30 FIX-A (REV-SEC SEC-1): never a redirect off the API's host (the key stays there).
          allowRedirectHost: (host) => host === HIMALAYAS_HOST,
        });
      } catch (error) {
        if (page === 0 || ctx.signal.aborted) throw error;
        complete = false;
        failures.push({ message: `Page ${page + 1} of the listing could not be read: ${(error as Error).message}` });
        break;
      }
      if (answer.status === 401) throw new IngestError('Himalayas did not accept the key (HTTP 401): check HIMALAYAS_API_KEY.');
      if (!isRecord(answer.data) || !Array.isArray(answer.data.jobs)) throw new IngestError('Himalayas answered without a job list.');
      total ??= num(answer.data.totalCount);
      const jobs = records(answer.data.jobs);
      for (const job of jobs) {
        const expiry = himalayasTime(job.expiryDate);
        if (expiry !== null && expiry < now) {
          expired += 1;
          continue;
        }
        if (!openTo(job, country)) {
          elsewhere += 1;
          continue;
        }
        const posting = himalayasPosting(job);
        if (posting) postings.push(posting);
        else failures.push({ sourceJobId: str(job.guid) ?? undefined, message: 'A listed job has no id, title, company or application link.' });
      }
      offset += jobs.length;
      if (jobs.length < HIMALAYAS_PAGE_SIZE || (total !== null && offset >= total)) break;
    }
    const left = [expired ? `${expired} past their expiry date` : '', elsewhere ? `${elsewhere} not open to ${country}` : '']
      .filter(Boolean)
      .join(', ');
    ctx.log(`Himalayas: ${postings.length} open jobs${left ? ` (${left} left out)` : ''}.`);
    return { postings, complete, failures };
  },
});
