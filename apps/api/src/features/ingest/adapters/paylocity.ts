import { boardUrlOf, PAYLOCITY_HOST, paylocityBoard, paylocityBoardUrl, paylocityDetailsUrl } from '@tailorit/shared/sourcing';
import { escapeHtml } from '@tailorit/shared';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { isoOf, placeOfParts } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { storedSourceJobId } from '../normalize';
import { IngestError, SourceNotFoundError, type RawPosting } from '../types';
import { isRecord, num, records, str, type Json } from './common';
import { defineAdapter } from './define';
import { addressOn, anyTagsOf, hasClass, inlineText, innerHtmlOf, metaContent, readListedPages, readPage, REDIRECT_STATUSES, scriptObjectAfter, tagsOf } from './page-boards';

// v38 ATS-C (SP v38 PLAN "Final coverage" row 15; SP v38 EVIDENCE.md §15): a company's Paylocity job board as a source,
// recruiting.paylocity.com/Recruiting/Jobs/All/<boardGuid> (config `{ board: "<guid>", companyName? }`; robots.txt: none).
//   - The board's page carries its list as JSON, `window.pageData = {"Jobs": [{JobId, JobTitle, LocationName,
//     PublishedDate (the posted date), IsInternal, HiringDepartment, JobLocation {City, State, Country, ...}, IsRemote}],
//     "ModuleTitle" (the company), "LogoUrl", ...}`: no paging, no full text (a short preview). An internal job is passed
//     over; a street address is never kept.
//   - A posting's page, /Recruiting/Jobs/Details/<id>: <title> and og:title "<Company> - <Title>", .job-preview-title,
//     .preview-location, its text after the .job-listing-header "Description", `window.pageData = {"jobTitle", "moduleName"
//     (the company)}` and a "View All Jobs" link to its board (/Recruiting/Jobs/All/<guid>): a link names no board, so its
//     read takes the board from there. No posted date on it.
//   - A gone posting answers 302 to /Recruiting/Jobs/JobNotFound (never followed); a 404 or 410 too.
// A run reads the board's page, then each job's page (adapters/page-boards.ts readListedPages); a link and the re-checks
// read one page the same way (boards/paylocity.ts). A new kind of read: the identity guard first ('feed_read').
// v38 INT-2 (SP v38 FIXES-38 D1): no fallback name (never the platform's): a run is named by its source's Company name,
// else by the board's page (ModuleTitle), else refused in words; a link's read names none then (Add job asks for it).

/** A run's refusal of a Paylocity board whose page names no company and whose source names none. */
export const PAYLOCITY_NEEDS_COMPANY =
  "This Paylocity job board's page doesn't name its company, and its source names none. Edit the source and type its Company name.";

const NEW_READ: NewReadKind = 'feed_read';

/** The board a source's config names (its guid, lower case); IngestError for none. */
export function paylocityBoardOf(config: Record<string, unknown>): string {
  const board = paylocityBoard(str(config.board) ?? '');
  if (!board) throw new IngestError("This source has no Paylocity board (its All Jobs page's address). Edit the source and add it.");
  return board;
}

/**
 * Whether a redirect leads to Paylocity's "Job Not Found" page. v38 FIX-C (REVIEW38-beh L1): on recruiting.paylocity.com
 * only (a sign-in or identity provider's JobNotFound elsewhere says nothing of the posting).
 */
function isNotFound(location: string | null): boolean {
  const url = location ? boardUrlOf(location) : null;
  return Boolean(url && url.hostname.toLowerCase() === PAYLOCITY_HOST && /\/Recruiting\/Jobs\/JobNotFound\/?$/i.test(url.pathname));
}

/** The text after each .job-listing-header ("Description", ...): the element that follows it, as headed HTML. */
function descriptionOf(html: string): string | null {
  const headers = tagsOf(html, 'div').filter((tag) => hasClass(tag, 'job-listing-header'));
  const parts: string[] = [];
  for (const header of headers) {
    const heading = inlineText(innerHtmlOf(html, header, 'div') ?? '');
    const next = anyTagsOf(html.slice(header.end)).find((tag) => tag.name === 'div' && !hasClass(tag, 'job-listing-header'));
    if (!next) continue;
    const at = header.end;
    const inner = innerHtmlOf(html, { ...next, at: next.at + at, end: next.end + at }, 'div');
    if (inner && inlineText(inner)) parts.push(`${heading && headers.length > 1 ? `<h3>${escapeHtml(heading)}</h3>\n` : ''}${inner.trim()}`);
  }
  return parts.join('\n') || null;
}

/** A Paylocity location's name as a place ("Remote Worker - N/A": Remote). */
function placeOfName(name: string | null): { place: string | null; remote: boolean } {
  const text = (name ?? '').replace(/\s*-\s*N\/A\s*$/i, '').trim();
  if (!text) return { place: null, remote: false };
  return /^remote\b/i.test(text) ? { place: 'Remote', remote: true } : { place: text, remote: false };
}

/** What a Paylocity posting's page says: its posting, its board and its company's name. */
export interface PaylocityPage {
  raw: RawPosting;
  /** The board its page links to (its guid, lower case), or null. */
  board: string | null;
  company: { name: string | null };
}

/** A posting's Details page as a RawPosting for the posting `id`; null when it names no title. */
export function paylocityPosting(html: string, id: string, companyName: string | null): PaylocityPage | null {
  const data = scriptObjectAfter(html, 'window.pageData');
  const pageData: Json = isRecord(data) ? data : {};
  const og = metaContent(html, 'og:title');
  const ownName = str(pageData.moduleName) ?? (og && og.includes(' - ') ? og.slice(0, og.indexOf(' - ')).trim() : null);
  const heading = tagsOf(html, 'span').find((tag) => hasClass(tag, 'job-preview-title'));
  const title =
    (heading ? inlineText(innerHtmlOf(html, heading, 'span') ?? '') : '') ||
    str(pageData.jobTitle) ||
    (og && ownName && og.startsWith(`${ownName} - `) ? og.slice(ownName.length + 3).trim() : null);
  if (!title) return null;
  const ogUrl = boardUrlOf(metaContent(html, 'og:url') ?? '');
  const ogId = ogUrl ? /\/Recruiting\/Jobs\/Details\/(\d+)/i.exec(ogUrl.pathname)?.[1] : undefined;
  if (ogId && ogId !== id) throw new IngestError('Paylocity answered with another posting.');
  const location = tagsOf(html, 'div').find((tag) => hasClass(tag, 'preview-location'));
  const { place, remote } = placeOfName(location ? inlineText(innerHtmlOf(html, location, 'div') ?? '') : null);
  const board = anyTagsOf(html)
    .filter((tag) => tag.name === 'a' && tag.attributes.href)
    .map((tag) => paylocityBoard(addressOn(tag.attributes.href, paylocityDetailsUrl(id), (host) => host === PAYLOCITY_HOST) ?? ''))
    .find(Boolean);
  return {
    raw: {
      sourceJobId: id,
      title,
      company: { name: companyName ?? ownName ?? '' }, // v38 INT-2 (D1): none rather than a made-up name
      descriptionHtml: descriptionOf(html),
      url: paylocityDetailsUrl(id),
      locations: place ? [place] : [],
      workArrangement: remote ? 'remote' : null,
    },
    board: board || null,
    company: { name: ownName },
  };
}

/** One posting's read: found (its posting, its board, its company's name), or gone. */
export type PaylocityRead = ({ found: true } & PaylocityPage) | { found: false };

/**
 * One posting read from its Details page (on recruiting.paylocity.com; a redirect is never followed): gone on a redirect to
 * "Job Not Found", a 404 or a 410. Throws IngestHttpError when Paylocity fails, RobotsRefusal when robots.txt refuses the
 * read, and IngestError when the page holds no posting (or another one), or sends the read elsewhere.
 */
export async function readPaylocityPosting(
  http: IngestHttp,
  id: string,
  options: { companyName?: string | null; signal?: AbortSignal } = {},
): Promise<PaylocityRead> {
  if (!/^\d{1,15}$/.test(id)) throw new IngestError('TailorIT does not know this Paylocity posting.');
  const answer = await readPage(http, paylocityDetailsUrl(id), { signal: options.signal, allow: [404, 410], followRedirects: false });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  if (REDIRECT_STATUSES.includes(answer.status)) {
    if (isNotFound(answer.location)) return { found: false };
    throw new IngestError("Paylocity sent the posting's page elsewhere.");
  }
  const read = paylocityPosting(answer.html, id, options.companyName ?? null);
  if (!read) throw new IngestError("The posting's page holds no Paylocity posting.");
  return { found: true, ...read };
}

/** A board's list (its page's pageData): its jobs by id (no full text), the company's name and logo; null with no list. */
export function paylocityListOf(html: string): { listed: Map<string, RawPosting>; company: string | null; logoUrl: string | null } | null {
  const data = scriptObjectAfter(html, 'window.pageData');
  if (!isRecord(data) || !Array.isArray(data.Jobs)) return null;
  const company = str(data.ModuleTitle);
  const listed = new Map<string, RawPosting>();
  for (const job of records(data.Jobs)) {
    const id = num(job.JobId);
    const title = str(job.JobTitle);
    if (id === null || !Number.isInteger(id) || id <= 0 || !title || job.IsInternal === true) continue;
    const key = storedSourceJobId(String(id));
    if (listed.has(key)) continue;
    const where = isRecord(job.JobLocation) ? job.JobLocation : {};
    const named = placeOfName(str(job.LocationName));
    const remote = job.IsRemote === true || named.remote;
    const place = placeOfParts(str(where.City), str(where.State), str(where.Country)) ?? named.place;
    listed.set(key, {
      sourceJobId: String(id),
      title,
      company: { name: company ?? '' }, // v38 INT-2 (D1): a run names it (see the top) or is refused
      url: paylocityDetailsUrl(String(id)),
      locations: place ? [place] : remote ? ['Remote'] : [],
      workArrangement: remote ? 'remote' : null,
      department: str(job.HiringDepartment),
      postedAt: isoOf(job.PublishedDate),
    });
  }
  return { listed, company, logoUrl: addressOn(str(data.LogoUrl), paylocityBoardUrl('x'), () => true) };
}

export const paylocityAdapter = defineAdapter({
  kind: 'paylocity',
  label: 'Paylocity job board',
  access: 'page',
  hosts: [PAYLOCITY_HOST],
  robotsPaths(source) {
    try {
      return [`/Recruiting/Jobs/All/${paylocityBoardOf(source.config)}`, '/Recruiting/Jobs/Details/'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const board = paylocityBoardOf(source.config);
    const answer = await readPage(ctx.http, paylocityBoardUrl(board), { signal: ctx.signal, allow: [404, 410], followRedirects: false });
    // v38 FIX-C (REVIEW38-beh L5, its Paylocity part): "no such board" only on a 404 or 410, or Paylocity's own not-found
    // page; a redirect elsewhere (a sign-in or check page) is a failed run, never a source "not found".
    if (answer.status === 404 || answer.status === 410 || (REDIRECT_STATUSES.includes(answer.status) && isNotFound(answer.location))) {
      throw new SourceNotFoundError(`Paylocity has no job board ${board}. Check the board's All Jobs address.`);
    }
    if (REDIRECT_STATUSES.includes(answer.status)) throw new IngestError("Paylocity sent the board's page elsewhere: TailorIT tries again later.");
    const list = paylocityListOf(answer.html);
    if (!list) throw new IngestError("The board's page holds no job list (window.pageData.Jobs).");
    const named = str(source.config.companyName);
    // v38 INT-2 (D1): a listing-only read (a discovery check) stores nothing; a run with no name is refused.
    const companyName = named ?? list.company ?? (ctx.listingOnly ? '' : null);
    if (companyName === null) throw new IngestError(PAYLOCITY_NEEDS_COMPANY);
    const listed = new Map([...list.listed].map(([id, job]) => [id, { ...job, company: { name: companyName } }]));
    ctx.log(`Paylocity board ${board}: ${listed.size} jobs.`);
    return readListedPages(source, ctx, {
      label: `Paylocity board ${board}`,
      host: PAYLOCITY_HOST,
      listed,
      whole: true,
      read: async (_id, item, readSignal) => {
        const read = await readPaylocityPosting(ctx.http, item.sourceJobId, { companyName, signal: readSignal });
        if (!read.found) return null;
        // The list's place (city, state, country) and posted date are its page's better.
        return {
          ...read.raw,
          company: { ...read.raw.company, name: companyName, ...(list.logoUrl ? { logoSourceUrl: list.logoUrl } : {}) },
          locations: item.locations && item.locations.length > 0 ? item.locations : read.raw.locations,
          workArrangement: item.workArrangement ?? read.raw.workArrangement ?? null,
          department: item.department ?? null,
          postedAt: item.postedAt ?? null,
        };
      },
    });
  },
});
