import { z } from 'zod';
import { escapeHtml, type SalaryPeriod } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { IngestError, type AdapterContext, type FetchFailure, type RawPosting, type RawSalary } from '../types';
import { isRecord, num, records, str, type Json } from './common';
import { defineAdapter, type OutsideKey } from './define';

// v30 S4: USAJOBS, the US federal government's job announcements (docs/design/part2/12-job-sourcing.md §3.6, §8.1,
// §11 phase 4; SP DECISIONS P1, owner questions 7, 9 and 10: US users). One source is one search of the Search API:
//
//   GET https://data.usajobs.gov/api/search?ResultsPerPage=500&Page=<n>[&<the source's own search parameters>]
//
// with the key in `Authorization-Key` and TailorIT's one identity, BOT_USER_AGENT (it names the role mailbox USAJOBS
// asks for in the User-Agent), sent by the service's client for new kinds of read. Two switches keep it off:
//   - BOT_USER_AGENT's placeholder: a new kind of read (assertNewReadAllowed 'usajobs': the run and this adapter both
//     ask);
//   - USAJOBS_API_KEY empty (deps.config.outside.usajobsApiKey; `outsideKey` below): the worker never takes the source
//     and Run now refuses.
//
// Terms (read 2026-11-14, design [A1]): "Public Data may be copied, stored, reformatted, adapted, analyzed, published,
// redistributed ... for lawful commercial or noncommercial purposes"; "Prior OPM approval is not required"; a credit
// and a link are encouraged (job_source_kinds' attribution: "USAJOBS", shown on the job's card). data.usajobs.gov's
// robots.txt says `Disallow: /` to crawlers, but the API is keyed: its terms govern and robots.txt does not apply
// (12 §1: robots_status `not_applicable`), so its reads skip the client's robots.txt check (`robots: false`).
//
// A search answers at most USAJOBS_MAX_ROWS rows, USAJOBS_PAGE_SIZE a page (design [A2]): a search with more is read as
// far as it goes and is not complete, so nothing closes and the log asks for a narrower search (the source's
// `params`, e.g. a JobCategoryCode or an Organization per source). An announcement whose ApplicationCloseDate has
// passed is left out of the listing: it closes when two listings miss it (12 §8.1-8.2). The agencies' contact names,
// emails and phones are never read into the posting (12 §14: personal data kept out of fields).

export const USAJOBS_SEARCH = 'https://data.usajobs.gov/api/search';
/** The search API's host: its redirects stay on it (v30 FIX-A). */
export const USAJOBS_HOST = new URL(USAJOBS_SEARCH).hostname;
/** The most rows one page answers (ResultsPerPage). */
export const USAJOBS_PAGE_SIZE = 500;
/** The company of an announcement that names no agency. */
const NO_AGENCY = 'US federal government';

/** The parameters the adapter sets itself, which a source's own search never gives. */
const OWN_PARAMS = /^(?:resultsperpage|page)$/i;

/**
 * A USAJOBS source's settings: `params`, more parameters of the Search API (Keyword, LocationName, JobCategoryCode,
 * Organization, HiringPath, ...), so a search larger than USAJOBS_MAX_ROWS can be split into several sources.
 */
export const UsajobsConfigSchema = z.object({
  params: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/, 'A search parameter is a USAJOBS parameter name, such as JobCategoryCode.'),
      z.string().trim().min(1).max(200),
    )
    .refine((params) => Object.keys(params).length <= 12, 'Give at most 12 search parameters.')
    .refine((params) => !Object.keys(params).some((name) => OWN_PARAMS.test(name)), 'TailorIT sets ResultsPerPage and Page itself.')
    .optional(),
});
export type UsajobsConfig = z.infer<typeof UsajobsConfigSchema>;

/** The source's search parameters (none when its config holds none or holds them badly). */
export function usajobsParams(config: Record<string, unknown>): Record<string, string> {
  const parsed = UsajobsConfigSchema.safeParse(config);
  return parsed.success ? (parsed.data.params ?? {}) : {};
}

/** The address of one page of the source's search: TailorIT's paging first, then its parameters by name. */
export function usajobsSearchUrl(params: Record<string, string>, page: number): string {
  const query = new URLSearchParams({ ResultsPerPage: String(USAJOBS_PAGE_SIZE), Page: String(page) });
  for (const name of Object.keys(params).sort()) query.set(name, params[name]!);
  return `${USAJOBS_SEARCH}?${query.toString()}`;
}

/** USAJOBS_API_KEY (DECISIONS P1, owner question 10): the source stays off while it is empty. */
export const USAJOBS_KEY: OutsideKey = {
  setting: 'USAJOBS_API_KEY',
  of: (deps) => deps.config.outside.usajobsApiKey,
};

/** The key, or the refusal of a run without one (the worker never starts one; a test's or a race's run ends here). */
function keyOf(deps: Pick<AppDeps, 'config'>): string {
  const key = USAJOBS_KEY.of(deps);
  if (!key) throw new IngestError('TailorIT reads no USAJOBS source while USAJOBS_API_KEY is empty: set it in .env, then restart.');
  return key;
}

/** RateIntervalCode as a salary period: per annum, hour, day, week, month (bi-weekly and fee basis say none). */
const RATE_PERIODS: Readonly<Record<string, SalaryPeriod>> = { PA: 'year', PH: 'hour', PD: 'day', PW: 'week', PM: 'month' };

/** A USAJOBS time ("2026-11-01T00:00:00.0000", Eastern, no zone) as its day, YYYY-MM-DD; null when unreadable. */
export function usajobsDay(value: unknown): string | null {
  const text = str(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** Plain text of the announcement as paragraphs (its fields are plain text; line breaks start a paragraph). */
function paragraphs(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part)}</p>`)
    .join('');
}

function section(heading: string, body: string | null): string {
  return body ? `<h3>${escapeHtml(heading)}</h3>${paragraphs(body)}` : '';
}

function listSection(heading: string, items: string[]): string {
  return items.length ? `<h3>${escapeHtml(heading)}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter((item): item is string => Boolean(item)) : [];
}

/** An https address as stored (USAJOBS writes `https://www.usajobs.gov:443/...`); null for anything else. */
function httpsAddress(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * One search item as a RawPosting; null when it lacks an id, a title or a link. The text is the announcement's
 * summary, duties, qualifications, education, conditions of employment and who may apply, never its contacts.
 */
export function usajobsPosting(item: Json): RawPosting | null {
  const d = isRecord(item.MatchedObjectDescriptor) ? item.MatchedObjectDescriptor : null;
  if (!d) return null;
  const id = str(item.MatchedObjectId) ?? str(d.PositionID);
  const title = str(d.PositionTitle);
  const url = httpsAddress(d.PositionURI) ?? httpsAddress(texts(d.ApplyURI)[0]);
  if (!id || !title || !url) return null;
  const userArea = isRecord(d.UserArea) ? d.UserArea : {};
  const details = isRecord(userArea.Details) ? userArea.Details : {};
  const whoMayApply = isRecord(details.WhoMayApply) ? str(details.WhoMayApply.Name) : str(details.WhoMayApply);
  const html = [
    section('Summary', str(details.JobSummary)),
    listSection('Duties', texts(details.MajorDuties)),
    section('Qualifications', str(d.QualificationSummary) ?? str(details.Requirements)),
    section('Education', str(details.Education)),
    listSection('Conditions of employment', texts(details.KeyRequirements)),
    section('Who may apply', whoMayApply),
  ].join('');
  const places = records(d.PositionLocation);
  const locations = places.map((place) => str(place.LocationName)).filter((name): name is string => Boolean(name));
  const inUs = places.length > 0 && places.every((place) => /^(?:united states|us|usa)$/i.test(str(place.CountryCode) ?? ''));
  const pay = records(d.PositionRemuneration)[0];
  const salary: RawSalary | null = pay
    ? { min: num(pay.MinimumRange), max: num(pay.MaximumRange), currency: 'USD', period: RATE_PERIODS[str(pay.RateIntervalCode) ?? ''] ?? null }
    : null;
  const schedule = [...records(d.PositionSchedule), ...records(d.PositionOfferingType)]
    .map((entry) => str(entry.Name))
    .filter((name): name is string => Boolean(name));
  const clearance = str(details.SecurityClearance);
  const posted = usajobsDay(d.PublicationStartDate);
  return {
    sourceJobId: id,
    title,
    company: { name: str(d.OrganizationName) ?? str(d.DepartmentName) ?? NO_AGENCY },
    descriptionHtml: html,
    url,
    locations: locations.length ? locations : str(d.PositionLocationDisplay) ? [str(d.PositionLocationDisplay)!] : [],
    countryHint: inUs ? 'US' : null,
    workArrangement: details.RemoteIndicator === true ? 'remote' : null,
    employmentText: schedule.length ? schedule.join(', ') : null,
    department: str(d.DepartmentName),
    salary: salary && (salary.min !== null || salary.max !== null) ? salary : null,
    requiresClearance: clearance ? !/^(?:not required|not applicable|none)\b/i.test(clearance) : null,
    postedAt: posted,
    updatedAt: posted,
  };
}

/** Whether the announcement's application window closed before `today` (YYYY-MM-DD, UTC). */
export function usajobsClosed(item: Json, today: string): boolean {
  const d = isRecord(item.MatchedObjectDescriptor) ? item.MatchedObjectDescriptor : null;
  const close = d ? usajobsDay(d.ApplicationCloseDate) : null;
  return close !== null && close < today;
}

/** One page of the search: its items and the search's whole count. */
async function readPage(ctx: AdapterContext, key: string, params: Record<string, string>, page: number) {
  const answer = await ctx.http.getJson(usajobsSearchUrl(params, page), {
    signal: ctx.signal,
    // A refused key is the source's settings, not a bot check that holds data.usajobs.gov for a day.
    allow: [401],
    headers: { 'Authorization-Key': key },
    robots: false,
    // v30 FIX-A (REV-SEC SEC-1): the search never follows a redirect off its API's host (the key stays there).
    allowRedirectHost: (host) => host === USAJOBS_HOST,
  });
  if (answer.status === 401) {
    throw new IngestError(
      'USAJOBS did not accept the key (HTTP 401): check USAJOBS_API_KEY, and that BOT_USER_AGENT names the mailbox the key was given to.',
    );
  }
  const result = isRecord(answer.data) && isRecord(answer.data.SearchResult) ? answer.data.SearchResult : null;
  if (!result || !Array.isArray(result.SearchResultItems)) throw new IngestError('USAJOBS answered without a search result.');
  return { items: records(result.SearchResultItems), total: num(result.SearchResultCountAll) };
}

export const usajobsAdapter = defineAdapter({
  kind: 'usajobs',
  label: 'USAJOBS search',
  access: 'api',
  hosts: [USAJOBS_HOST],
  // No robotsPaths: a keyed API (robots_status `not_applicable`, never judged by the robots refresh).
  outsideKey: USAJOBS_KEY,
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, 'usajobs');
    const key = keyOf(ctx.deps);
    const params = usajobsParams(source.config);
    const today = ctx.deps.now().toISOString().slice(0, 10);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    let complete = true;
    let read = 0;
    let closed = 0;
    let total: number | null = null;
    const maxRows = constantsOf(ctx.deps).get('USAJOBS_MAX_ROWS');
    const maxPages = Math.ceil(maxRows / USAJOBS_PAGE_SIZE);
    for (let page = 1; page <= maxPages; page += 1) {
      let answer;
      try {
        answer = await readPage(ctx, key, params, page);
      } catch (error) {
        // The first page failing is the run failing; a later page leaves the listing incomplete.
        if (page === 1 || ctx.signal.aborted) throw error;
        complete = false;
        failures.push({ message: `Page ${page} of the search could not be read: ${(error as Error).message}` });
        break;
      }
      total ??= answer.total;
      read += answer.items.length;
      for (const item of answer.items) {
        if (usajobsClosed(item, today)) {
          closed += 1;
          continue;
        }
        const posting = usajobsPosting(item);
        if (posting) postings.push(posting);
        else failures.push({ sourceJobId: str(item.MatchedObjectId) ?? undefined, message: 'A listed announcement has no id, title or link.' });
      }
      if (answer.items.length < USAJOBS_PAGE_SIZE || (total !== null && read >= total)) break;
    }
    if (total === null || read < total) {
      complete = false;
      ctx.log(
        total !== null && total > maxRows
          ? `The search has ${total} announcements, more than the ${maxRows} USAJOBS answers for one search: split it into narrower sources (search parameters). Nothing is marked missing this run.`
          : 'The search did not answer every announcement it counted; nothing is marked missing this run.',
      );
    }
    ctx.log(`USAJOBS search: ${postings.length} open announcements${closed ? ` (${closed} past their closing date left out)` : ''}.`);
    return { postings, complete, failures };
  },
});
