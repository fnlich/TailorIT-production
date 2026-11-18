import { canonicalJobUrl, normalizeCompanyName, normalizeJobTitle, parseLocations, type JobAddDetails, type JobVerifyReason } from '@tailorit/shared';
import {
  addablePosting,
  isLinkedInHost,
  type AtsKind,
  type AutofillFromPageRequest,
} from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/dialect';
import type { DbQueries } from '../../core/db/types';
import { AppError } from '../../core/http/errors';
import { ADDED_BY_AUTOFILL } from '../ingest/liveness';
import { MAX_SOURCE_JOB_ID, compactId, sha256, sourceHashOf, storedSourceJobId } from '../ingest/normalize';
import { RobotsRefusal } from '../ingest/robots';
import { requireIngest } from '../ingest/service';
import { IngestError, type RawPosting, type SourceRecord } from '../ingest/types';
import { sightPublishedPageJob } from '../job-reviews/new-jobs'; // v30 X1-API
import { noteUnverified } from '../jobs/add/verification'; // v31 LINK
import { noticeVerification } from '../jobs/add/notify'; // v31 LINK
import { readPageToSharedJob, type PageJobRead } from '../jobs/add/page'; // v31 LINK
import { isRefusedPageHost } from '../job-reviews/hosts'; // v31 LINK
import { aliasValueHash } from './alias-key';
import { jobPlaces, placeKey, placesMeet, type Place } from './places';
import {
  isGonePosting,
  isOwnPageJob,
  linkHandAddedEntry,
  ownsResume,
  readShared,
  saveToTracker,
  upgradeOwnPageJob,
  upgradeOwnPageJobsFor,
  type AddedJob,
  type InFlight,
} from './jobs';
import {
  identityKeys,
  lookupPosting,
  pageJobCandidates,
  pageKeys,
  postingIdentityOf,
  readPage,
  storedPageAddress,
  type JobMatch,
  type PageReading,
} from './lookup';
import { firstSourceOfKind, insertSourceIfNameFree } from './sources';

// Adding the job a page shows from the text the person sees on it (POST /api/autofill/jobs/from-page, autofill API
// version 5, scope jobs:add): a LinkedIn job, a posting on a platform with no public posting API (iCIMS, Taleo,
// SuccessFactors, Oracle Recruiting Cloud), or a company's careers page. It reverses Add job's rule ("never from the
// page") for these pages only:
// - A job TailorIT has is found as the lookup finds it for the person (a LinkedIn job's alias, the employer's posting,
//   the page) and saved as it is: never a second job for one posting. A job found only by a page's link or an alias
//   (not by a posting's identity: an ATS posting's, a LinkedIn job's) counts only when its title and company agree
//   with the page's, and no alias is added to it; otherwise the page gets a job of its own.
// - A posting an ATS API reads (the employer's posting first, then the page's own address: addablePosting) is read
//   from it as POST /api/autofill/jobs reads it, and the page's text is not used; a closed job of it is read again,
//   as Add job reads it. Only on the ATS's lasting word is the page's text used instead (pageMayStandIn): it will not
//   give the posting (`unsupported`: an Ashby posting off its public list), its site's robots.txt disallows the read,
//   or its answer is no posting TailorIT can read; any other failure (401, 403, 429, 5xx, a timeout, a robots.txt that
//   cannot be read now, a closed posting) is answered as Add job answers it. The person's own job made from the page's
//   text for such a posting is read again from its ATS at each add, and gives way to the posting once it is read.
// - Otherwise the job is made from the page's text, under the one source of kind 'page' ("Job pages", disabled and
//   never run, checked or closed). It is the person's own (jobs.owner_user_id): listed, searched, matched and answered
//   for them alone, never merged with another job and keeping no link key, so another account (or another page) never
//   meets its text: its text is hashed under its account (its analyses, AI facts and AI attempts are its own), and
//   its company is the shared row of the name, read as it is, or the account's own row (ingest/store.ts pageCompany).
//   A second, different job the same address shows gets a link of its own (linkIdFor). Normalised as any posting,
//   its description kept as text (escaped wherever it is shown), its title, company and place stripped of markup.
//   Its link (Apply) is the employer's link when the page showed one, else the page's canonical address (a LinkedIn
//   job's https://www.linkedin.com/jobs/view/<id>/), each as storedPageAddress
//   keeps an address: no user name, password or tracking, every query parameter but a secret's (a sign-in code, a
//   token, a session, a signature, an email address, SuccessFactors' _s.crb), no matrix parameter (a jsessionid).
//   Claude's analysis reads its text as untrusted (job-analysis/prompt.ts). Nothing the page names is fetched or
//   followed: TailorIT's server never requests LinkedIn, and reads an employer's link only through its ATS's API.
// Then the page's addresses become the person's aliases of the job (job_link_aliases: the LinkedIn job's canonical
// address, or the page's; the employer's posting, when parseAtsUrl reads one from its link), so the lookup finds it
// from either page later, and the person's tracker holds it at Saved, as Add job saves it. The text, the addresses
// and the job are never logged. A tracker entry the person added by hand joins the job when its link names the
// posting, or, found only by the page's own address or alias, when it has no job and its title and company agree.

/** The source the job pages' jobs are kept under (one; made disabled and never run). */
export const PAGE_SOURCE_NAME = 'Job pages';

/** How the job came: found in TailorIT, read from its ATS, or made from the page's text. */
export type FromPageVia = 'existing' | 'ats' | 'page';

export interface AddedFromPage extends AddedJob {
  via: FromPageVia;
}

/** The criteria labels the page's facts are read from (LinkedIn's job criteria), in lower case. */
const CRITERIA = {
  employment: ['employment type', 'job type'],
  industry: ['industries', 'industry'],
  arrangement: ['workplace type', 'work arrangement', 'location type'],
} as const;

/** Invisible and bidi characters, and control characters but line breaks and tabs. */
const INVISIBLE = /[\p{Cf}\u{34F}\u{17B4}\u{17B5}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const CONTROL = /(?![\n\t])\p{Cc}/gu;
/** Markup in a one-line field: a tag (with its attributes), never in a title, company or place. */
const TAG = /<\/?[A-Za-z][^<>]{0,500}>/g;

/** A one-line page text as kept: invisible and control characters and markup removed, spaces collapsed, capped. */
export function pageLine(text: string, max: number): string {
  return [...text.normalize('NFC').replace(INVISIBLE, '').replace(CONTROL, ' ').replace(TAG, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, max)
    .join('')
    .trim();
}

/** The description as kept: invisible and control characters removed, its lines and paragraphs kept, capped. */
export function pageText(text: string, max: number): string {
  const lines = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());
  return [...lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()].slice(0, max).join('');
}

/** A criterion's value by any of its labels, as the page wrote it; null when the page lists none. */
function criterion(request: AutofillFromPageRequest, labels: readonly string[]): string | null {
  const found = request.criteria?.find((item) => labels.includes(pageLine(item.label, 100).toLowerCase()));
  return found ? pageLine(found.value, 300) || null : null;
}

/**
 * The page's own address as the person's alias of it: a LinkedIn job's canonical address, else the page's (its ATS
 * posting's own address when parseAtsUrl reads one), as storedPageAddress keeps it.
 */
function pageAlias(page: PageReading): { alias: string; kind: 'linkedin' | 'page' } | null {
  const alias = page.aliasKeys[0];
  if (!alias) return null;
  return { alias, kind: page.linkedIn ? 'linkedin' : 'page' };
}

/** The longest alias kept (migration 0809's CHECK). */
const ALIAS_MAX = 2100;

/**
 * Keeps the page's addresses as the person's aliases of the job: the LinkedIn job's (or the page's), and the employer's
 * posting when parseAtsUrl reads one from its link (any other employer link is the Apply link alone). An alias the
 * person already keeps names one job: for a job made or read now it names this one from now on (the person's latest
 * add from the page); for a job found by its posting it stays as it was.
 */
async function keepAliases(
  t: DbQueries,
  now: string,
  userId: string,
  jobId: number,
  page: PageReading,
  replace: boolean,
): Promise<void> {
  const own = pageAlias(page);
  const employer = page.employer?.ats ? page.employer.aliasKeys[0] : undefined;
  const rows: Array<[string, 'linkedin' | 'page' | 'employer']> = [];
  if (own) rows.push([own.alias, own.kind]);
  if (employer && employer !== own?.alias) rows.push([employer, 'employer']);
  const insert = `INSERT INTO job_link_aliases(user_id, alias, job_id, kind, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, alias) DO ${replace ? 'UPDATE SET job_id = excluded.job_id, kind = excluded.kind' : 'NOTHING'}`;
  for (const [alias, kind] of rows) {
    if (alias.length <= ALIAS_MAX && alias.startsWith('https://')) await t.run(insert, [userId, alias, jobId, kind, now]);
  }
}

/**
 * The job pages' source: the one there is (found by its kind, whatever its name), else a new one, disabled and closing
 * nothing. v3.0 D2-B (the concurrency audit): made with the unique key job_sources(kind, name) and ON CONFLICT DO
 * NOTHING (sources.ts), so the first two page jobs at once make one source: the one that finds the name taken reads
 * the source the other made.
 */
async function pageSource(t: DbQueries, now: string): Promise<SourceRecord> {
  const found = await firstSourceOfKind(t, 'page');
  if (found) return found;
  const made = await insertSourceIfNameFree(
    t,
    { kind: 'page', name: PAGE_SOURCE_NAME, config: { addedBy: ADDED_BY_AUTOFILL }, enabled: false, deactivateMissing: false },
    now,
  );
  const source = made ?? (await firstSourceOfKind(t, 'page'));
  if (!source) throw new AppError('internal', 'TailorIT could not save this job. Please try again.');
  return source;
}

/**
 * The most of a page's alias a link id holds: an alias past it is kept as its start and its hash (compactId), so the
 * link id (an account's 36-character id, "|", the alias, a space, its posting's 16-character mark and a "-<n>" of up to
 * six) stays within the stored cap (MAX_SOURCE_JOB_ID) and is found again as it was stored. An alias within it is kept
 * whole, as before.
 */
const PAGE_ALIAS_IN_LINK_ID = MAX_SOURCE_JOB_ID - 36 - 1 - 1 - 16 - 6;

/**
 * A page job's link id under the job pages' source: the account, then the page's alias ("<user id>|<alias>"), and,
 * for a second job on one page (`posting`: a hash of its title, company and places), a space and that hash (no stored
 * address holds a space). A long alias is cut and hashed (PAGE_ALIAS_IN_LINK_ID).
 */
export const pageLinkId = (userId: string, alias: string, posting?: string) => {
  const own = `${userId}|${compactId(alias, PAGE_ALIAS_IN_LINK_ID)}`;
  return posting ? `${own} ${posting}` : own;
};

/** The page's alias from a page job's link id; the id itself when it names no account (a link made before). */
export const aliasOfPageLink = (sourceJobId: string) => sourceJobId.slice(sourceJobId.indexOf('|') + 1).split(' ')[0]!;

/** A page job's title, company and places as one posting's mark: their normalised forms, hashed (16 hex characters). */
function postingMark(request: AutofillFromPageRequest): string {
  const title = normalizeJobTitle(pageLine(request.title, 300));
  const company = normalizeCompanyName(pageLine(request.company, 200));
  const places = pagePlaces(request).map(placeKey).sort().join('|');
  return sha256(`${title}\n${company}\n${places}`).slice(0, 16);
}

/** The page's places, read by the places reader as a posting's are ("Austin, Texas" and "Austin, TX" are one place). */
function pagePlaces(request: AutofillFromPageRequest): Place[] {
  const location = request.location ? pageLine(request.location, 300) : '';
  return (location ? parseLocations([location]) : []).map((place) => ({
    city: place.city,
    region: place.region,
    country: place.countryCode,
    remote: place.isRemote,
  }));
}


/**
 * The link id the page's job is stored under: the link of this address whose job is the page's (agrees: the address's
 * own, "<user id>|<alias>", or one marked beside it); else the address's own while it is free; else a new one marked
 * with the posting (a second job a page shows, as a careers site showing every job at one address does), so a job of
 * its own that never rewrites another. A link an upgrade retired (" superseded:") is never one of them.
 */
/**
 * linkIdFor's statement (the source, the person's own id, then the range '<own> ' up to '<own>!'): the page source's
 * links with that id or a marked one, in the order they were made. v3.0 PG-B: the order through the dialect (SQLite's
 * rowid, job_source_links.seq on PostgreSQL), and the range compared in byte order whatever the database's collation;
 * v3.0 INT-2: the column is COLLATE "C" (migrations-pg/0009), so the primary key serves the range.
 */
export function pageLinksSql(d: Dialect): string {
  return `SELECT source_job_id, job_id FROM job_source_links
     WHERE source_id = ? AND (source_job_id = ? OR (${d.collateC('source_job_id')} >= ? AND ${d.collateC('source_job_id')} < ?))
     ORDER BY ${d.seq()}`;
}

async function linkIdFor(
  deps: Pick<AppDeps, 'db'>,
  source: SourceRecord,
  userId: string,
  alias: string,
  request: AutofillFromPageRequest,
): Promise<string> {
  const own = pageLinkId(userId, alias);
  const links = await deps.db.all<{ source_job_id: string; job_id: number }>(pageLinksSql(deps.db.dialect), [
    source.id,
    own,
    `${own} `,
    `${own}!`,
  ]);
  const live = links.filter((link) => !link.source_job_id.includes(' superseded:'));
  let mine: (typeof live)[number] | undefined;
  for (const link of live) {
    if (await agrees(deps, link.job_id, request)) {
      mine = link;
      break;
    }
  }
  if (mine) return mine.source_job_id;
  if (!live.some((link) => link.source_job_id === own) && !links.some((link) => link.source_job_id === own)) return own;
  const marked = pageLinkId(userId, alias, postingMark(request));
  let id = marked;
  for (let n = 2; links.some((link) => link.source_job_id === id); n += 1) id = `${marked}-${n}`;
  return id;
}

/**
 * The job's link (Apply): the employer's link when the page showed one, else the page's canonical address, each kept
 * as storedPageAddress keeps an address; null when neither is one.
 */
function applyLinkOf(page: PageReading): string | null {
  if (page.employer) {
    const read = page.employer.ats;
    return storedPageAddress(read?.canonical[0] ?? page.employer.url);
  }
  return page.linkedIn?.canonical ?? storedPageAddress(page.ats?.canonical[0] ?? page.url);
}

/** The job as the page shows it, for the ingest pipeline, the person's own, under link id `linkId`. */
function postingOf(page: PageReading, request: AutofillFromPageRequest, userId: string, alias: string, linkId: string): RawPosting {
  const location = request.location ? pageLine(request.location, 300) : '';
  const industry = criterion(request, CRITERIA.industry);
  return {
    sourceJobId: linkId,
    title: pageLine(request.title, 300),
    company: { name: pageLine(request.company, 200) },
    descriptionText: pageText(request.description, 20_000),
    // Apply opens the employer's own link when the page showed one, else the page itself (never fetched by TailorIT).
    url: applyLinkOf(page) ?? alias,
    locations: location ? [location] : [],
    employmentText: criterion(request, CRITERIA.employment),
    arrangementText: criterion(request, CRITERIA.arrangement),
    industry: industry ? industry.slice(0, 120) : null,
    // TailorIT did not read the posting itself: it is not "confirmed live".
    verified: false,
    ownerUserId: userId,
  };
}

/**
 * Stores the job from the page's text under the job pages' source, the person's own: always a new job (a page job is
 * never merged with another). Nothing is fetched. v3.0 D2-B (the concurrency audit): the page job's link id is the
 * person's own ("<user id>|<alias>", linkIdFor), chosen by looking at the links there are, so the choice and the store
 * hold the person's lock: two adds from one page at once choose as one after the other would (the second finds the
 * first's link), and the link's key (job_source_links' (source_id, source_job_id)) refuses a second row for one id.
 */
async function storeFromPage(
  deps: AppDeps,
  userId: string,
  page: PageReading,
  request: AutofillFromPageRequest,
  madeFrom: string | null,
  // v31 LINK: a job the person typed (the Add job dialog's details) may come without a description.
  options: { allowEmptyText?: boolean } = {},
): Promise<{ jobId: number; created: boolean }> {
  const ingest = requireIngest(deps);
  const own = pageAlias(page);
  if (!own) throw new AppError('unsupported', "TailorIT cannot read this page's address. Save the job from the Tracker instead.");
  const checked = postingOf(page, request, userId, own.alias, pageLinkId(userId, own.alias));
  if (!checked.title || !checked.company.name || (!checked.descriptionText && !options.allowEmptyText)) {
    throw new AppError('validation_failed', 'The page shows no title, company or description TailorIT can keep.');
  }
  return deps.db.tx(async (t) => {
    await t.lockPerson(userId);
    const now = nowIso(deps);
    const source = await pageSource(t, now);
    const raw = { ...checked, sourceJobId: await linkIdFor(deps, source, userId, own.alias, request) };
    // The ingest pipeline's store (ingest/store.ts) writes on the raw handle inside this transaction.
    const outcome = await ingest.store.upsertBatch(source, [{ raw, sourceHash: sourceHashOf(raw) }], now);
    const link = await t.one<{ job_id: number }>('SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ?', [
      source.id,
      storedSourceJobId(raw.sourceJobId),
    ]);
    if (outcome.failures.length > 0 || !link) {
      throw new AppError('internal', 'TailorIT could not save this job. Please try again.');
    }
    // The ATS posting the job was made with (the employer's link's, even a dead one; else the page's own), kept for
    // the upgrade alone: no lookup, alias or Apply link reads it.
    if (madeFrom) {
      await t.run('UPDATE jobs SET made_from = COALESCE(made_from, ?) WHERE id = ? AND owner_user_id = ?', [
        madeFrom,
        link.job_id,
        userId,
      ]);
    }
    return { jobId: link.job_id, created: outcome.counts.created > 0 };
  }, { label: 'autofill add from page' });
}

/** Why a page is not one TailorIT adds a job from, or null when it is. */
function pageProblem(page: PageReading): string | null {
  let url: URL;
  try {
    url = new URL(page.url.trim());
  } catch {
    return "TailorIT cannot read this page's address.";
  }
  if (url.protocol !== 'https:') return 'TailorIT adds a job from an https page only.';
  // As an employer's link: an address carrying a user name, a password or a port is no page TailorIT keeps.
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return 'TailorIT adds a job from a page with no user name, password or port in its address.';
  }
  if (isLinkedInHost(url.hostname) && !page.linkedIn) return 'This LinkedIn page shows no job. Open the job, then add it.';
  return null;
}

/**
 * Whether a job found only by a page's link or an alias is the page's posting: its title and company, normalised as
 * the dedupe normalises them, are the page's. A shared job (found by its link, or an alias an upgrade moved to it) is
 * decided by those two alone; a page job by its places too, which tell two page jobs at one address apart only when
 * both have places and none meet (placesMeet). Never by the text: the same job added again with its description edited
 * (a "posted 2 days ago" line) is still the same job.
 */
async function agrees(deps: Pick<AppDeps, 'db'>, jobId: number, request: AutofillFromPageRequest): Promise<boolean> {
  const job = await deps.db.one<{ title: string; company: string; owner_user_id: string | null }>(
    'SELECT j.title, c.name AS company, j.owner_user_id FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?',
    [jobId],
  );
  if (!job) return false;
  const named =
    normalizeJobTitle(job.title) === normalizeJobTitle(pageLine(request.title, 300)) &&
    normalizeCompanyName(job.company) === normalizeCompanyName(pageLine(request.company, 200));
  if (!named || job.owner_user_id === null) return named;
  return placesMeet(await jobPlaces(deps, jobId), pagePlaces(request));
}

/** A job's Apply link. */
/**
 * The ATS posting a page job is: the one it was made from (jobs.made_from: the employer's link it was made with, even
 * one that was gone and is no Apply link), else the one its Apply link names; null when it names none.
 */
async function ownPostingOf(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<string | null> {
  const row = await deps.db.one<{ made_from: string | null; apply_url: string }>('SELECT made_from, apply_url FROM jobs WHERE id = ?', [
    jobId,
  ]);
  return row?.made_from ?? postingIdentityOf(row?.apply_url);
}

/** Whether TailorIT has closed the job (no live link: its board no longer lists it). */
async function isClosed(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<boolean> {
  const row = await deps.db.one<{ active: unknown }>('SELECT active FROM jobs WHERE id = ?', [jobId]);
  return row !== undefined && !deps.db.dialect.isTrue(row.active);
}

/**
 * Whether the page's text may stand in for an ATS read that failed, on the ATS's lasting word only: it will never give
 * the posting (`unsupported`: an Ashby posting off its public list), the site's robots.txt disallows the read, or its
 * answer is no posting TailorIT can read (an IngestError: another posting, no posting). Never for a refusal that may
 * pass (401, 403, 429), a failing or unreachable ATS (5xx, a timeout), a robots.txt that cannot be read now, a redirect
 * TailorIT does not follow, an unknown error or a closed posting (404): those are answered as Add job answers them, so
 * the page's text never takes the place of a posting TailorIT could read later.
 */
function pageMayStandIn(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.cause instanceof RobotsRefusal) return error.cause.reason === 'disallowed';
  if (error.code === 'unsupported') return true;
  return error.code === 'ats_failed' && error.cause instanceof IngestError;
}

/**
 * v30 X1-API (14 §4.2, §5.3 step 4): the person's own page job is noted for Admin › Review (v31 LINK: as "Couldn't
 * verify", jobs/add/verification.ts, with the reason TailorIT could not read its link; never a page review whose
 * approval would publish the page's text), and a job found that an admin published from pages before v3.1 (`ext_page`)
 * counts as seen now. Neither ever fails the add: a failure is logged without the job or the page.
 */
async function reviewPageJob(
  deps: AppDeps,
  userId: string,
  jobId: number,
  page: PageReading,
  via: FromPageVia,
  unread: JobVerifyReason | null,
): Promise<void> {
  try {
    if (via === 'page' || (await isOwnPageJob(deps, userId, jobId))) {
      // v31 LINK (D2): the person's own job is "Couldn't verify" (Admin › Review lists it: Retry read, Reject), never
      // a page review whose approval would publish the browser's text (publishPageJob is gone).
      const reason = unread ?? 'unreadable_host';
      await noteUnverified(deps.db, { jobId, userId, url: page.employer?.url ?? page.url, origin: 'extension_page', reason }, nowIso(deps));
      // The person added it in their browser: TailorIT says why it is theirs alone (once per job: NOTIFY dedupes).
      if (via === 'page') await noticeVerification(deps, { userId, jobId, state: 'private_unverified', reason });
    } else if (via === 'existing') {
      await sightPublishedPageJob(deps, jobId);
    }
  } catch (error) {
    deps.log.warn('[autofill] add job from page: the review step failed; the job is saved', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * v31 LINK: TailorIT's own read of the page a job is added from (the employer's link when the page showed one, else the
 * page): a shared job when its schema.org JobPosting is read (jobs/add/page.ts), else why not. Never LinkedIn or a
 * refused job board (`unreadable_host`), nothing sent.
 */
async function readOwnPage(deps: AppDeps, page: PageReading): Promise<PageJobRead> {
  const address = canonicalJobUrl(page.employer?.url ?? page.url);
  if (!address || page.linkedIn) return { kind: 'unreadable', reason: 'unreadable_host' };
  const url = new URL(address);
  if (isRefusedPageHost(url.hostname)) return { kind: 'unreadable', reason: 'unreadable_host' };
  return readPageToSharedJob(deps, address);
}

/**
 * v31 LINK (D2): the person's own job made from what they typed for a link TailorIT cannot read (the web's Add job
 * dialog, its details step): as a page job from the page's text is made (storeFromPage), the person's alone, its
 * description optional, the link kept as their alias of it so a later add or lookup finds it.
 */
export async function storeOwnJobFromDetails(
  deps: AppDeps,
  userId: string,
  url: string,
  details: JobAddDetails,
): Promise<{ jobId: number; created: boolean }> {
  const page = readPage(url, undefined, aliasValueHash(deps));
  const request: AutofillFromPageRequest = {
    url,
    title: details.title,
    company: details.company,
    description: details.description ?? '',
    ...(details.location ? { location: details.location } : {}),
  };
  const made = await storeFromPage(deps, userId, page, request, postingIdentityOf(page.ats?.canonical[0]), { allowEmptyText: true });
  const now = nowIso(deps);
  await deps.db.tx((t) => keepAliases(t, now, userId, made.jobId, page, true), { label: 'own job aliases' });
  return made;
}

/**
 * POST /jobs/from-page: the job the page shows (see above), in TailorIT and in the person's tracker at Saved, answered
 * as Add job answers: `created` when the job is new to TailorIT, and the lookup's answer for the page (with the same
 * employer link and resume).
 */
export async function addFromPage(
  deps: AppDeps,
  userId: string,
  request: AutofillFromPageRequest,
  inFlight: InFlight,
): Promise<AddedFromPage> {
  const page = readPage(request.url, request.employerUrl, aliasValueHash(deps));
  const problem = pageProblem(page);
  if (problem) throw new AppError('unsupported', problem);
  const kind: AtsKind | null = page.employer?.ats?.kind ?? page.ats?.kind ?? null;
  const fromEmployer = addablePosting(page.employer?.ats ?? null);
  const posting = fromEmployer ?? addablePosting(page.ats);
  // The ATS posting read for the page, as postingIdentityOf names it.
  const postingId = postingIdentityOf((fromEmployer ? page.employer?.ats : page.ats)?.canonical[0]);
  // The ATS posting a page job made now is made with: the employer's link's (read or not, alive or not), else the page's.
  const madeFrom = postingIdentityOf((page.employer?.ats ?? page.ats)?.canonical[0]);
  let stored: PageReading = page;

  // The first job found by a posting's identity, or by a link or an alias whose job's title and company are the page's.
  let found: JobMatch | null = null;
  for (const match of await pageJobCandidates(deps, userId, page)) {
    if (match.posting || (await agrees(deps, match.id, request))) {
      found = match;
      break;
    }
  }
  let jobId: number | null = found?.id ?? null;
  let created = false;
  let via: FromPageVia = 'existing';
  const ownPage = found !== null && (await isOwnPageJob(deps, userId, found.id));
  // The person's own page job is read again for its own posting only (its Apply link names the posting read, or names
  // none): never upgraded into another posting the page's employer link names now.
  const ownPosting = found !== null && ownPage ? await ownPostingOf(deps, found.id) : null;
  if (
    found?.posting &&
    posting &&
    ((await isClosed(deps, found.id)) || ownPage) &&
    (ownPosting === null || ownPosting === postingId)
  ) {
    // A closed job of a posting its ATS reads is read again, as Add job reads it: a posting listed again reopens. So is
    // the person's own job made from the page's text while the ATS would not give the posting: read now, the posting
    // takes its place (upgradeOwnPageJob: aliases, tracker entry and queue moved, the page job closed and retired).
    try {
      const read = await readShared(deps, posting, inFlight);
      if (!ownPage || (await upgradeOwnPageJob(deps, userId, found.id, read.jobId))) {
        if (ownPage) via = 'ats';
        jobId = read.jobId;
        created = read.created;
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  } else if (jobId === null && posting) {
    try {
      const read = await readShared(deps, posting, inFlight);
      jobId = read.jobId;
      created = read.created;
      via = 'ats';
    } catch (error) {
      if (fromEmployer && !page.ats && isGonePosting(error)) {
        // The employer's posting is gone (closed, or off its board's list) while the page still shows the job (U11): the
        // page's text stands in, and the dead link is no identity, alias or Apply link: the page's own address is.
        stored = { ...page, employer: null };
      } else if (!pageMayStandIn(error)) {
        throw error;
      }
    }
  }
  // v31 LINK (D1-D3): before the page's text stands in, TailorIT reads the page itself (its schema.org JobPosting,
  // jobs/add/page.ts): a posting read is a shared job, and the text the browser sent is not used. LinkedIn and the
  // refused boards are never read; their jobs stay the person's own.
  let unread: JobVerifyReason | null = null;
  if (jobId === null) {
    const read = await readOwnPage(deps, stored);
    if (read.kind === 'shared') {
      jobId = read.jobId;
      created = read.created;
      via = 'ats';
    } else {
      unread = read.kind === 'closed' ? 'closed' : read.reason;
    }
  }
  if (jobId === null) {
    const made = await storeFromPage(deps, userId, stored, request, madeFrom);
    jobId = made.jobId;
    created = made.created;
    via = 'page';
  }
  // The posting's shared job takes the place of the person's own page jobs of it (U1).
  if (via !== 'page') await upgradeOwnPageJobsFor(deps, userId, jobId);
  const target = jobId;
  // Aliases go on a job made or read now, or found by its ATS posting; never on one a link or an alias alone found.
  if (via !== 'existing' || found?.posting) {
    const replace = via !== 'existing';
    const now = nowIso(deps);
    await deps.db.tx((t) => keepAliases(t, now, userId, target, stored, replace), { label: 'autofill page aliases' });
  }
  // The person's entry added by hand for the posting joins the job: one whose link names the posting (an ATS posting, a
  // LinkedIn job) always; one whose link is only the page's own address (a careers page two jobs may share) or its
  // alias only when its title and company are the page's.
  await linkHandAddedEntry(deps, userId, target, identityKeys(stored), stored, { identity: true });
  await linkHandAddedEntry(deps, userId, target, pageKeys(stored), stored, {
    agreeing: { title: pageLine(request.title, 300), company: pageLine(request.company, 200) },
  });
  // The resume the person chose in the extension, when it is theirs, is the entry's as it is made or brought back.
  const own = request.resumeId !== undefined && (await ownsResume(deps, userId, request.resumeId));
  await saveToTracker(deps, userId, target, own ? request.resumeId : undefined);
  await reviewPageJob(deps, userId, target, page, via, unread);
  const asked = {
    url: request.url,
    includePostingText: false,
    ...(request.employerUrl !== undefined ? { employerUrl: request.employerUrl } : {}),
    ...(request.resumeId !== undefined ? { resumeId: request.resumeId } : {}),
  };
  let lookup = await lookupPosting(deps, userId, asked);
  if (lookup.job?.id !== target) {
    // The page's lookup finds another job first (one this page's link or alias also names): answer the job saved now,
    // as the lookup answers a job, found the way it was found.
    lookup = await lookupPosting(deps, userId, { ...asked, jobId: target });
    const matchedBy = via === 'page' ? 'alias' : via === 'ats' ? 'source_link' : (found?.matchedBy ?? 'link_key');
    if (lookup.job) lookup = { ...lookup, job: { ...lookup.job, matchedBy } };
  }
  return { answer: { created, lookup }, kind, via };
}
