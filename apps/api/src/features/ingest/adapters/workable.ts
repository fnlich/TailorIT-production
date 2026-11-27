import type { EmploymentType } from '@tailorit/shared';
import { workableAccount } from '@tailorit/shared/sourcing'; // v38 FRAME: the board registry's normaliser
import { IngestHttpError, type IngestHttp } from '../http';
import { IngestError, SourceNotFoundError, type FetchFailure, type ListingValidators, type RawPosting, type RawSalary } from '../types';
import { arrangementOf, configText, isRecord, nameFromSlug, num, periodOf, records, str, type Json } from './common';
import { conditionalOf, defineAdapter, notModifiedResult } from './define';

// Workable accounts (apply.workable.com/<account>, autofill API version 4): the account's list from Workable's widget
// API (GET /api/v1/widget/accounts/{account}?details=false: its name and every published posting, once per place,
// without its text), then each posting from the API its careers page reads (GET /api/v2/accounts/{account}/jobs/
// {shortcode}: the text, requirements and benefits, places, workplace and pay), one request a second as on every board.
// Add job and the daily liveness check read one posting the same way (ingest/postings.ts), so a posting is stored alike
// however it was read. The API wants the account in lower case (any other case is 404) and takes the shortcode in
// either. A posting's answer names no company: the source's companyName does (Add job stores Workable's own name
// there for a source it makes), else the name the account's list gives, else, last, the account's slug
// ("labella-associates" reads "Labella Associates").
//
// A run reads only what it must: the list, then the postings TailorIT has not read for this source (new), those whose
// link is missing (listed again: read to reopen) and those last read WORKABLE_FRESH_DAYS ago or more (stale, the
// oldest first), at most WORKABLE_READS_PER_RUN a run. The rest are seen, so never closed: the list says they are live,
// and a later run reads them when they go stale. Only the list closes a posting: one the list names but whose own
// address answers 404 (or no longer published) is seen too, and closes once the list drops it. After
// WORKABLE_FAILURES_IN_A_ROW failed reads in a row the run stops, its listing incomplete, so nothing closes.
//
// Add job beside a run: the run's reads go one at a time through the shared client, each taking the host's next turn,
// so an Add job's read waits at most about one turn (a second) behind it, never behind the whole run; the per-run cap
// keeps a run to a couple of minutes. Only when Workable throttles (429 with Retry-After, or 5xx retried) is the host
// held for every caller, and Add job then answers 503 within ADD_JOB_FETCH_TIMEOUT_MS ("try again in a minute").

export const WORKABLE_API = 'https://apply.workable.com/api';

/**
 * The most of one of Workable's answers read outside a run (a posting, or an account's list read for its name; a
 * posting's text runs to a few kilobytes): 2 MB. Past it the client stops reading (413, never retried).
 */
export const WORKABLE_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
/** A posting a run read this recently is left as it is (seen) until it goes stale. */
export const WORKABLE_FRESH_DAYS = 7;
/** The most postings one run reads (about one a second). */
export const WORKABLE_READS_PER_RUN = 100;
/** A run stops after this many failed reads in a row. */
export const WORKABLE_FAILURES_IN_A_ROW = 5;

const SHORTCODE = /^[0-9A-F]{10}$/;

/** v38 FRAME: the account as typed (the shared board registry's WORKABLE_BOARD normaliser). */
export { workableAccount };

/** The account's list of postings (no text). */
export const workableListUrl = (account: string) =>
  `${WORKABLE_API}/v1/widget/accounts/${encodeURIComponent(account)}?details=false`;

/** One posting's API address. */
export const workablePostingUrl = (account: string, shortcode: string) =>
  `${WORKABLE_API}/v2/accounts/${encodeURIComponent(account)}/jobs/${encodeURIComponent(shortcode)}`;

/** A posting's own page, as Workable writes its canonical link: Apply opens it. */
export const workableJobUrl = (account: string, shortcode: string) =>
  `https://apply.workable.com/${account}/j/${shortcode}/`;

const EMPLOYMENT: Record<string, EmploymentType> = {
  full: 'full_time',
  fulltime: 'full_time',
  part: 'part_time',
  parttime: 'part_time',
  contract: 'contract',
  contractor: 'contract',
  temporary: 'contract',
  temp: 'contract',
  intern: 'internship',
  internship: 'internship',
};

function employmentOf(value: unknown): EmploymentType | null {
  const key = str(value)?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return EMPLOYMENT[key] ?? null;
}

/** "Rochester, New York, United States": a place's parts as the posting names them. */
function placeOf(location: unknown): string | null {
  if (!isRecord(location)) return null;
  const parts = [str(location.city), str(location.region), str(location.country)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The posting's pay (salary_from, salary_to, their currency and frequency); null when it names none. */
export function workableSalary(job: Json): RawSalary | null {
  const positive = (value: unknown) => {
    const amount = num(value);
    return amount !== null && amount > 0 ? amount : null;
  };
  const min = positive(job.salary_from);
  const max = positive(job.salary_to);
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: str(job.salary_currency_iso_code)?.toUpperCase() ?? null,
    period: periodOf(job.salary_frequency) ?? 'year',
  };
}

/** Whether the answer is a posting Workable still publishes (an answer that does not say counts as one). */
export function isPublished(job: Json): boolean {
  const state = str(job.state);
  return state === null || state.toLowerCase() === 'published';
}

/**
 * One posting as a RawPosting (the v2 answer); null when it lacks a shortcode or a title. Its text is the description,
 * then the requirements and the benefits under their headings, as Workable's own widget joins them.
 */
export function workablePosting(job: Json, account: string, companyName: string): RawPosting | null {
  const shortcode = str(job.shortcode)?.toUpperCase() ?? null;
  const title = str(job.title);
  if (!shortcode || !SHORTCODE.test(shortcode) || !title) return null;
  const html = [
    str(job.description),
    str(job.requirements) && `<p><strong>Requirements</strong></p>${str(job.requirements)}`,
    str(job.benefits) && `<p><strong>Benefits</strong></p>${str(job.benefits)}`,
  ]
    .filter(Boolean)
    .join('');
  const arrangement = arrangementOf(job.workplace) ?? (job.remote === true ? 'remote' : null);
  const remote = arrangement === 'remote';
  // "United States" on a remote posting is "Remote - United States": where the remote work may happen.
  const place = (value: string | null) => (value && remote && !/remote/i.test(value) ? `Remote - ${value}` : value);
  const places = records(job.locations);
  const location = job.location;
  const main = isRecord(location) ? location : places[0];
  const locations = [...new Set((places.length > 0 ? places.map(placeOf) : [placeOf(location)]).map(place))].filter(
    (value): value is string => Boolean(value),
  );
  const departments: unknown[] = Array.isArray(job.department) ? job.department : [job.department];
  const department = departments.map(str).find((name): name is string => Boolean(name)) ?? null;
  return {
    sourceJobId: shortcode,
    title,
    company: { name: companyName },
    descriptionHtml: html || null,
    url: workableJobUrl(account, shortcode),
    locations,
    countryHint: main ? str(main.countryCode) : null,
    workArrangement: arrangement,
    employmentType: employmentOf(job.type),
    department,
    salary: workableSalary(job),
    postedAt: str(job.published),
  };
}

/**
 * One posting read from Workable's API (at most WORKABLE_ANSWER_MAX_BYTES of it): null when it is gone (404, or no
 * longer published). Throws IngestHttpError when Workable fails or the answer runs over the cap (413, never retried),
 * and IngestError when the answer is not that posting.
 */
export async function readWorkablePosting(
  http: IngestHttp,
  account: string,
  shortcode: string,
  companyName: string,
  signal?: AbortSignal,
): Promise<RawPosting | null> {
  const answer = await http.getJson(workablePostingUrl(account, shortcode), {
    signal,
    allow: [404],
    maxBytes: WORKABLE_ANSWER_MAX_BYTES,
  });
  if (answer.status === 404) return null;
  if (!isRecord(answer.data)) throw new IngestError('Workable answered without a posting.');
  if (!isPublished(answer.data)) return null;
  const raw = workablePosting(answer.data, account, companyName);
  if (!raw) throw new IngestError("Workable's posting has no shortcode or title.");
  if (raw.sourceJobId !== shortcode.toUpperCase()) throw new IngestError('Workable answered with another posting.');
  return raw;
}

/**
 * The company name Workable gives the account (its list's `name`), read once (at most WORKABLE_ANSWER_MAX_BYTES of the
 * list), or null when the list cannot be read or names none: best effort, never failing the caller. A stop (`signal`)
 * is passed on.
 */
export async function readWorkableAccountName(
  http: IngestHttp,
  account: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const options = { signal, allow: [404], maxBytes: WORKABLE_ANSWER_MAX_BYTES };
    const answer = await http.getJson(workableListUrl(account), options);
    return answer.status === 404 || !isRecord(answer.data) ? null : str(answer.data.name);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** A listed posting as its list writes it (title and places, no text): the source's test, which stores nothing. */
function listedPosting(job: Json, account: string, companyName: string): RawPosting | null {
  const shortcode = str(job.shortcode)?.toUpperCase() ?? null;
  const title = str(job.title);
  if (!shortcode || !SHORTCODE.test(shortcode) || !title) return null;
  const place = [str(job.city), str(job.state), str(job.country)].filter(Boolean).join(', ');
  const url = workableJobUrl(account, shortcode);
  return { sourceJobId: shortcode, title, company: { name: companyName }, url, locations: place ? [place] : [] };
}

interface StoredLink {
  source_job_id: string;
  last_seen_at: string;
  missing_since: string | null;
}

/**
 * The listed postings a run reads, in order: those TailorIT has not stored for this source (in the list's order),
 * those whose link is missing (listed again: read to reopen), then those last read WORKABLE_FRESH_DAYS ago or more,
 * the oldest first; at most WORKABLE_READS_PER_RUN. The rest are left as they are.
 */
function toRead(
  listed: readonly string[],
  stored: ReadonlyMap<string, StoredLink>,
  now: Date,
): { read: string[]; left: string[] } {
  const staleBefore = new Date(now.getTime() - WORKABLE_FRESH_DAYS * 86_400_000).toISOString();
  const fresh: string[] = [];
  const unread: string[] = [];
  const missing: string[] = [];
  const stale: StoredLink[] = [];
  for (const shortcode of listed) {
    const link = stored.get(shortcode);
    if (!link) unread.push(shortcode);
    else if (link.missing_since !== null) missing.push(shortcode);
    else if (link.last_seen_at < staleBefore) stale.push(link);
    else fresh.push(shortcode);
  }
  stale.sort((a, b) => a.last_seen_at.localeCompare(b.last_seen_at));
  const due = [...unread, ...missing, ...stale.map((link) => link.source_job_id)];
  return { read: due.slice(0, WORKABLE_READS_PER_RUN), left: [...fresh, ...due.slice(WORKABLE_READS_PER_RUN)] };
}

export const workableAdapter = defineAdapter({
  kind: 'workable',
  label: 'Workable account',
  access: 'api',
  hosts: ['apply.workable.com'],
  robotsPaths(source) {
    const account = encodeURIComponent(workableAccount(String(source.config.account ?? '')));
    return [`/api/v1/widget/accounts/${account}?details=false`, `/api/v2/accounts/${account}/jobs/`];
  },
  async fetch(source, ctx) {
    const account = workableAccount(configText(source.config, 'account', 'Workable account name'));
    if (!account) throw new IngestError('This source has no Workable account name. Edit the source and add it.');
    let validators: ListingValidators | null = null;
    const listing = await ctx.http.getJson(workableListUrl(account), {
      signal: ctx.signal,
      allow: [404],
      ...(ctx.listingOnly ? {} : conditionalOf(ctx)),
      meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
    });
    // v30 S1-API: the listing is unchanged since the last complete one: nothing is read or closed this run.
    if (listing.status === 304) return notModifiedResult();
    if (listing.status === 404) {
      const where = 'apply.workable.com/<account>';
      throw new SourceNotFoundError(`Workable has no account "${account}". Check the account name (${where}).`);
    }
    if (!isRecord(listing.data) || !Array.isArray(listing.data.jobs)) {
      throw new IngestError(`Workable account "${account}" answered without a job list.`);
    }
    const companyName = str(source.config.companyName) ?? str(listing.data.name) ?? nameFromSlug(account);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    // A posting in several places is listed once per place: one entry per shortcode, in the list's order.
    const listed = new Map<string, Json>();
    for (const job of records(listing.data.jobs)) {
      const shortcode = str(job.shortcode)?.toUpperCase();
      if (shortcode && SHORTCODE.test(shortcode)) {
        if (!listed.has(shortcode)) listed.set(shortcode, job);
      } else {
        failures.push({ message: 'A listed posting has no shortcode.' });
      }
    }
    if (ctx.listingOnly) {
      for (const job of listed.values()) {
        const posting = listedPosting(job, account, companyName);
        if (posting) postings.push(posting);
      }
      return { postings, complete: true, failures };
    }
    const stored = new Map(
      (
        await ctx.deps.db.all<StoredLink>('SELECT source_job_id, last_seen_at, missing_since FROM job_source_links WHERE source_id = ?', [
          source.id,
        ])
      ).map((link) => [link.source_job_id, link]),
    );
    const { read, left } = toRead([...listed.keys()], stored, ctx.deps.now());
    // Listed, so live: seen whatever their own addresses answer. Only the list, complete, closes a posting.
    const seen = [...left];
    let unanswered = 0;
    let failedInARow = 0;
    let complete = true;
    for (const shortcode of read) {
      try {
        const posting = await readWorkablePosting(ctx.http, account, shortcode, companyName, ctx.signal);
        failedInARow = 0;
        if (posting) {
          postings.push(posting);
        } else {
          unanswered += 1;
          seen.push(shortcode);
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        // Counted as seen, so it is never closed for a read that failed; asked for again next run.
        const status = error instanceof IngestHttpError ? ` (HTTP ${error.status})` : '';
        failures.push({ sourceJobId: shortcode, message: `Posting ${shortcode} could not be read${status}.` });
        failedInARow += 1;
        if (failedInARow >= WORKABLE_FAILURES_IN_A_ROW) {
          complete = false;
          failures.push({
            message:
              `Workable failed ${WORKABLE_FAILURES_IN_A_ROW} reads in a row: ` +
              'the run stopped, and nothing was closed.',
          });
          break;
        }
      }
    }
    const attempted = postings.length + unanswered + failures.filter((failure) => failure.sourceJobId).length;
    ctx.log(
      `Workable account ${account}: ${listed.size} listed postings, ${attempted} read (${postings.length} stored, ` +
        `${unanswered} listed but not answered: kept), ${left.length} left as they are.`,
    );
    return { postings, complete, failures, skippedIds: seen, validators: complete ? validators : null };
  },
});
