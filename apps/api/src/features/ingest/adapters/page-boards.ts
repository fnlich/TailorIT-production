import { collapseWhitespace, DAY_MS, decodeHtmlEntities, htmlToText } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
// The one close function (core/seams re-exports it from here; a test's vi.mock of this path reaches this import too).
import { closeLink } from '../close';
import { HostHeldError, IngestHttpError, parseJsonLenient, type GetJsonOptions, type HttpAnswer, type IngestHttp } from '../http';
import { holdOf } from '../hosts';
import { RobotsRefusal } from '../robots';
import { IngestError, type AdapterContext, type FetchFailure, type FetchResult, type RawPosting, type SourceRecord } from '../types';
import { planBamboohrReads, type BamboohrStoredLink } from './bamboohr';
import { loadReadFailures, saveReadFailures } from './read-failures';

// v38 ATS-C (SP v38 PLAN "Final coverage" rows 2, 8, 11, 15, 16, 22): what the server-rendered boards share
// (SmartRecruiters, Jobvite, Taleo, Avature, Paylocity, Paycom): a page read as HTML through the ingest client (its bot
// user agent, robots.txt before every read, the platform's lane), a few readers of a page's tags (no DOM, no scripts run:
// a page's own data is read where it is written), and the run of a board whose list holds no full text (Jobvite's,
// Avature's, Paylocity's): the list, then each job's own page, as a BambooHR run reads each opening's detail
// (adapters/bamboohr.ts planBamboohrReads):
//   - new jobs first (in the list's order), then jobs whose link closed (listed again: read to reopen), then jobs last
//     read BOARD_PAGE_RECHECK_DAYS ago or more (the oldest first), at most BOARD_PAGE_READS_PER_RUN a run; a job whose
//     read failed lately waits and is read after the others (adapters/read-failures.ts); v38 FIX-C (REVIEW38-beh M9): so
//     does a listed job whose own page says gone that is not stored or is closed (as adapters/listed-reads.ts);
//   - the rest of the list is seen (skippedIds: never wiped, never closed while the list names it);
//   - a job whose own page says it is gone closes its link through the one close function (reason `gone`), and its job
//     once no live link is left; a whole list closes a job it no longer names after two misses (store.ts markMissing);
//   - a held host or lane, a 429 past the request's retries, or a robots.txt that cannot be read stops the reads (the run
//     keeps what it read, its list incomplete: nothing closes by absence); PAGE_FAILURES_IN_A_ROW failed reads in a row
//     stop them too.

/** A page asked for as HTML (a browser's Accept). */
export const PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
/** The most of one page read (a job page runs to tens of kilobytes; Paycom's to about 250 kB): 2 MB. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** A run stops after this many failed page reads in a row. */
export const PAGE_FAILURES_IN_A_ROW = 5;
/** The redirects a page may answer (read, never followed, where its platform's "gone" is one). */
export const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

/** A page read as HTML: its status, its text ('' for none) and, for a redirect not followed, where it leads. */
export interface PageAnswer {
  status: number;
  html: string;
  location: string | null;
}

/**
 * A page read as text from `url` (at most PAGE_MAX_BYTES unless `maxBytes`): `allow`ed statuses are answers; with
 * `followRedirects: false` a redirect is the answer (its Location), nothing more is sent.
 */
export async function readPage(
  http: IngestHttp,
  url: string,
  options: Pick<GetJsonOptions, 'signal' | 'allow' | 'followRedirects' | 'allowRedirectHost' | 'maxBytes'> = {},
): Promise<PageAnswer> {
  const answer: HttpAnswer = await http.getJson(url, {
    ...options,
    text: true,
    accept: PAGE_ACCEPT,
    maxBytes: options.maxBytes ?? PAGE_MAX_BYTES,
  });
  return { status: answer.status, html: typeof answer.data === 'string' ? answer.data : '', location: resolvedAgainst(answer.location ?? null, url) };
}

/** An address resolved against the page it was read on (a redirect's Location may be a path), or null. */
function resolvedAgainst(location: string | null, url: string): string | null {
  if (!location) return null;
  try {
    return new URL(location, url).href;
  } catch {
    return null;
  }
}

// --- a page's tags ------------------------------------------------------------------------------------------------

/** One opening tag: where it starts and ends, and its attributes (names in lower case, values entity-decoded). */
export interface OpeningTag {
  at: number;
  end: number;
  attributes: Record<string, string>;
}

/** An opening tag's attributes text ("a=\"1\" b='2' c=3 d") as a record. */
export function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!(name in attributes)) attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** Every opening tag named `name` (any case) in `html`, in order (a quoted attribute value may hold a '>'). */
export function tagsOf(html: string, name: string): OpeningTag[] {
  const tags: OpeningTag[] = [];
  const pattern = new RegExp(`<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi');
  for (const match of html.matchAll(pattern)) {
    tags.push({ at: match.index!, end: match.index! + match[0].length, attributes: attributesOf(match[1] ?? '') });
  }
  return tags;
}

/** An opening tag of any element, with its name in lower case. */
export interface NamedTag extends OpeningTag {
  name: string;
}

/** Every opening tag in `html`, in order. */
export function anyTagsOf(html: string): NamedTag[] {
  const tags: NamedTag[] = [];
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    tags.push({ name: match[1]!.toLowerCase(), at: match.index!, end: match.index! + match[0].length, attributes: attributesOf(match[2] ?? '') });
  }
  return tags;
}

/**
 * The elements of a schema.org microdata scope whose itemprop is `prop`, in order: a <meta>'s content, any other
 * element's inner HTML ('' for one that never closes).
 */
export function itemProps(html: string, prop: string): Array<{ tag: NamedTag; value: string }> {
  return anyTagsOf(html)
    .filter((tag) => (tag.attributes.itemprop ?? '').split(/\s+/).includes(prop))
    .map((tag) => ({ tag, value: tag.name === 'meta' ? (tag.attributes.content ?? '').trim() : (innerHtmlOf(html, tag, tag.name) ?? '') }));
}

/** The first itemprop `prop`'s value (a <meta>'s content, else its element's text), or null. */
export function itemText(html: string, prop: string): string | null {
  const item = itemProps(html, prop)[0];
  if (!item) return null;
  const text = item.tag.name === 'meta' ? item.value : inlineText(item.value);
  return text || null;
}

/** Whether a tag's class attribute holds `name` (a whole class). */
export const hasClass = (tag: OpeningTag, name: string): boolean => (tag.attributes.class ?? '').split(/\s+/).includes(name);

/**
 * The inner HTML of the `name` element whose opening tag is `tag`, its nested elements of that name balanced; null when it
 * never closes.
 */
export function innerHtmlOf(html: string, tag: OpeningTag, name: string): string | null {
  const pattern = new RegExp(`<(/?)${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*?(/?)>`, 'gi');
  pattern.lastIndex = tag.end;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[1]) depth -= 1;
    else if (!match[2]) depth += 1;
    if (depth === 0) return html.slice(tag.end, match.index);
  }
  return null;
}

/** The inner HTML of every `name` element whose class holds `className`, in order. */
export function elementsWithClass(html: string, name: string, className: string): string[] {
  return tagsOf(html, name)
    .filter((tag) => hasClass(tag, className))
    .map((tag) => innerHtmlOf(html, tag, name))
    .filter((inner): inner is string => inner !== null);
}

/** An HTML fragment's text on one line: tags dropped, entities decoded, spaces folded. */
export const inlineText = (html: string): string => collapseWhitespace(htmlToText(html));

/** The content of a page's <meta> whose property, name or itemprop is `key` (any case), or null. */
export function metaContent(html: string, key: string): string | null {
  const wanted = key.toLowerCase();
  for (const tag of tagsOf(html, 'meta')) {
    const { property, name, itemprop, content } = tag.attributes;
    if ([property, name, itemprop].some((value) => value?.toLowerCase() === wanted) && content !== undefined) {
      const text = content.trim();
      return text || null;
    }
  }
  return null;
}

/** A page's <link rel="canonical"> address, or null. */
export function canonicalLinkOf(html: string): string | null {
  const tag = tagsOf(html, 'link').find((link) => (link.attributes.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  return tag?.attributes.href?.trim() || null;
}

/** A page's <title> text, or null. */
export function titleOf(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const text = match ? inlineText(match[1]!) : '';
  return text || null;
}

/**
 * The JSON object a page's script writes after `marker` (`window.pageData = {...}`), braces balanced outside its strings,
 * parsed leniently; null when there is none or it is no JSON.
 */
export function scriptObjectAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  if (start < 0 || /[^\s=:]/.test(html.slice(at + marker.length, start))) return null;
  let depth = 0;
  let inString: string | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]!;
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") inString = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return parseJsonLenient(html.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** An https address on `host` (relative to `base`), or null. */
export function addressOn(value: string | null | undefined, base: string, host: (name: string) => boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'https:' && host(url.hostname.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

// --- a run that reads each listed job's page -------------------------------------------------------------------

/** The board a run reads: its list, whether it is whole, and each job's own read. */
export interface ListedPagesRun {
  /** The board in words for the run's log ("Jobvite company acme"). */
  label: string;
  /** The host its reads go to (a 429 with no hold of its own: the host's hold, if any). */
  host: string;
  /** The jobs the list names, by id (in the list's order), as the list gives them (no full text). */
  listed: ReadonlyMap<string, RawPosting>;
  /** Whether the list is the board's whole list (only then does absence close a job: store.ts markMissing). */
  whole: boolean;
  /** One job's read: its posting, or null when its page says it is gone; throws when it cannot be read. */
  read(id: string, listed: RawPosting, signal: AbortSignal): Promise<RawPosting | null>;
}

/** The source's links of the listed jobs (live or closed), with when each was last read. */
async function storedLinks(deps: Pick<AppDeps, 'db'>, sourceId: number, listed: readonly string[]): Promise<Map<string, BamboohrStoredLink>> {
  const db = deps.db;
  const rows = await db.all<{ source_job_id: string; job_id: number; live: boolean; read_at: string | Date }>(
    `SELECT l.source_job_id, l.job_id, l.missing_since IS NULL AS live,
       GREATEST(l.last_seen_at, l.liveness_checked_at) AS read_at
     FROM job_source_links l
     WHERE l.source_id = ? AND l.source_job_id IN (SELECT value FROM ${db.dialect.jsonEach('?')})`,
    [sourceId, JSON.stringify(listed)],
  );
  return new Map(rows.map((row) => [row.source_job_id, { ...row, live: row.live === true, read_at: new Date(row.read_at).toISOString() }]));
}

/** A read's failure as a sentence. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A run of a board whose list holds no full text (see the top): the list as it is for the admin's Test and discovery's
 * validation (`ctx.listingOnly`, or no stored source: nothing is stored), else each planned job's own page.
 */
export async function readListedPages(source: SourceRecord, ctx: AdapterContext, run: ListedPagesRun): Promise<FetchResult> {
  if (ctx.listingOnly || source.id <= 0) return { postings: [...run.listed.values()], complete: run.whole, failures: [] };
  const deps = ctx.deps;
  const signal = ctx.signal;
  const constants = constantsOf(deps);
  const ids = [...run.listed.keys()];
  const stored = await storedLinks(deps, source.id, ids);
  const readFailures = await loadReadFailures(deps.db, source.id);
  const { read, left, dueLeft } = planBamboohrReads(ids, stored, {
    now: deps.now().getTime(),
    budget: constants.get('BOARD_PAGE_READS_PER_RUN'),
    recheckMs: constants.get('BOARD_PAGE_RECHECK_DAYS') * DAY_MS,
    failures: readFailures,
  });
  const postings: RawPosting[] = [];
  const failures: FetchFailure[] = [];
  // Listed, so live: seen whatever their own pages answer, unless read gone (closed below).
  const seen = [...left];
  const checked: string[] = [];
  const gone: BamboohrStoredLink[] = [];
  const answered: string[] = [];
  const pageFailed: string[] = [];
  let attempted = 0;
  let goneUnstored = 0;
  let failedInARow = 0;
  let complete = run.whole;
  let stopped: string | null = null;
  let heldUntil: string | null = null;
  for (const [index, id] of read.entries()) {
    if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
    const link = stored.get(id) ?? null;
    attempted += 1;
    try {
      const posting = await run.read(id, run.listed.get(id)!, signal);
      failedInARow = 0;
      if (link) checked.push(id);
      if (posting) {
        postings.push(posting);
        answered.push(id);
      } else if (link?.live) {
        gone.push(link);
        answered.push(id);
      } else {
        // v38 FIX-C (REVIEW38-beh M9; SP v38 FIXES-38 D9, as adapters/listed-reads.ts does): listed, yet its own page says
        // gone, and never stored (or closed): new to every run, it was read before the stale ones each time. Backed off as
        // a failed read is (read after the others, less often: read-failures.ts), never counted a failure.
        goneUnstored += 1;
        pageFailed.push(id);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // A 429 past the request's retries (no hold of its own) stops the reads as a held host or lane does.
      const rateLimited = error instanceof IngestHttpError && !(error instanceof HostHeldError) && error.status === 429;
      if (error instanceof HostHeldError || rateLimited || (error instanceof RobotsRefusal && error.reason === 'unreadable')) {
        if (!rateLimited) attempted -= 1;
        stopped = messageOf(error);
        complete = false;
        seen.push(...read.slice(index));
        if (error instanceof HostHeldError) heldUntil = error.until;
        else if (rateLimited) heldUntil = (await holdOf(deps.db, run.host, nowIso(deps)))?.until ?? null;
        break;
      }
      // Counted as seen (a failure's id), so it is never closed for a read that failed; read again later.
      const status = error instanceof IngestHttpError ? ` (HTTP ${error.status})` : '';
      failures.push({ sourceJobId: id, message: `Job ${id} could not be read${status}: ${messageOf(error)}` });
      pageFailed.push(id);
      failedInARow += 1;
      if (failedInARow >= PAGE_FAILURES_IN_A_ROW) {
        complete = false;
        seen.push(...read.slice(index + 1));
        stopped = `${PAGE_FAILURES_IN_A_ROW} job pages in a row could not be read.`;
        break;
      }
    }
  }

  // The jobs read get their read time; the gone ones close (their jobs once no live link is left).
  if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
  const at = nowIso(deps);
  if (checked.length > 0) {
    await deps.db.run(
      `UPDATE job_source_links SET liveness_checked_at = CAST(? AS timestamptz)
       WHERE source_id = ? AND source_job_id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
      [at, source.id, JSON.stringify(checked)],
    );
  }
  let jobsClosed = 0;
  if (gone.length > 0) {
    await deps.db.tx(
      async (t) => {
        for (const link of gone) {
          const closed = await closeLink(deps, t, { jobId: link.job_id, link: { sourceId: source.id, sourceJobId: link.source_job_id }, reason: 'gone', at });
          if (closed.jobClosed) jobsClosed += 1;
        }
      },
      { label: `${source.kind}: jobs gone` },
    );
  }
  ctx.log(
    `Read ${attempted} of ${read.length} planned job pages: ${postings.length} stored, ${gone.length} gone (${jobsClosed} jobs closed)` +
      `${goneUnstored ? `, ${goneUnstored} more gone (none of them open here)` : ''}${failures.length ? `, ${failures.length} failed` : ''}; ` +
      `${left.length} left as they are.`,
  );
  if (stopped) ctx.log(`The reads stopped early, so nothing closes by its absence this run: ${stopped}`);
  if (dueLeft > 0) ctx.log(`${dueLeft} more jobs are due a read: later runs read them.`);
  const listedIds = new Set(ids);
  await saveReadFailures(deps.db, source.id, readFailures, { failed: pageFailed, answered, keep: (id) => listedIds.has(id), now: deps.now().getTime() });
  return {
    postings,
    complete,
    failures,
    skippedIds: seen,
    closedByRead: jobsClosed,
    ...(heldUntil ? { heldUntil } : {}),
  };
}
