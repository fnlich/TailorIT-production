import { escapeHtml } from '@tailorit/shared';
import { listItemsOf, sectionsOfLists } from '../../job-analysis/sections';
import { IngestError, SourceNotFoundError, type AdapterContext, type FetchFailure, type ListingValidators, type RawPosting } from '../types';
import { arrangementOf, configText, isRecord, nameFromSlug, num, periodOf, records, str, type Json } from './common';
import { conditionalOf, defineAdapter, notModifiedResult } from './define';

// Lever postings: GET api.lever.co/v0/postings/{site}?mode=json&skip=N&limit=100 (EU sites: api.eu.lever.co), page by
// page until a short page; a listing of several pages has its earlier pages read again after the last, and is
// incomplete when one of them changed meanwhile (pagesHeld). An unknown site answers 404 {ok:false}. `lists[]` are the
// posting's own sections.

export const LEVER_PAGE_SIZE = 100;
const MAX_PAGES = 50;

export function leverHost(region: unknown): string {
  return str(region)?.toLowerCase() === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
}

/** The site as typed: a site name or a jobs.lever.co URL. */
export function leverSite(input: string): string {
  const text = input.trim();
  const fromUrl = /lever\.co\/(?:v0\/postings\/)?([A-Za-z0-9_.-]+)/i.exec(text);
  return (fromUrl?.[1] ?? text).replace(/[^A-Za-z0-9_.-]/g, '');
}

/** One posting as a RawPosting; null when it lacks an id, a title or a link. */
export function leverPosting(posting: Json, companyName: string): RawPosting | null {
  const id = str(posting.id);
  const title = str(posting.text);
  const url = str(posting.hostedUrl) ?? str(posting.applyUrl);
  if (!id || !title || !url) return null;
  const categories = isRecord(posting.categories) ? posting.categories : {};
  const lists = records(posting.lists).map((list) => ({
    heading: str(list.text) ?? '',
    content: typeof list.content === 'string' ? list.content : '',
  }));
  const html = [
    typeof posting.description === 'string' ? posting.description : '',
    ...lists.map((list) => `<h3>${escapeHtml(list.heading)}</h3><ul>${list.content}</ul>`),
    typeof posting.additional === 'string' ? posting.additional : '',
  ]
    .filter((part) => part.trim())
    .join('\n');
  const allLocations = Array.isArray(categories.allLocations)
    ? categories.allLocations.map(str).filter((place): place is string => Boolean(place))
    : [];
  const location = str(categories.location);
  const range = isRecord(posting.salaryRange) ? posting.salaryRange : null;
  const created = num(posting.createdAt);
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: html,
    descriptionText: html ? null : str(posting.descriptionPlain),
    sections: sectionsOfLists(lists.map((list) => ({ heading: list.heading, items: listItemsOf(list.content) }))),
    url,
    locations: allLocations.length ? allLocations : location ? [location] : [],
    countryHint: str(posting.country),
    workArrangement: arrangementOf(posting.workplaceType),
    employmentText: str(categories.commitment),
    department: str(categories.team) ?? str(categories.department),
    salary: range
      ? { min: num(range.min), max: num(range.max), currency: str(range.currency), period: periodOf(range.interval) }
      : null,
    postedAt: created !== null ? new Date(created).toISOString() : null,
  };
}

/** A page's posting ids, in order ('' for an item without one). */
function idsOf(data: unknown[]): string[] {
  return data.map((item) => (isRecord(item) ? (str(item.id) ?? '') : ''));
}

/**
 * Whether every page but the last still holds the postings it held when it was read. Lever pages by position (skip and
 * limit), so a posting removed from (or added to) an earlier page between two page reads moves a posting across the
 * boundary: it is on no page read, and a complete listing would mark it missing and close its job for a day. Read
 * again after the last page, an earlier page that shifted no longer matches. A page that cannot be read again counts
 * as changed.
 */
async function pagesHeld(
  ctx: AdapterContext,
  pageUrl: (page: number) => string,
  pageIds: readonly string[][],
): Promise<boolean> {
  for (let page = 0; page < pageIds.length - 1; page += 1) {
    try {
      const again = await ctx.http.getJson(pageUrl(page), { signal: ctx.signal });
      if (!Array.isArray(again.data) || idsOf(again.data).join('\n') !== pageIds[page]!.join('\n')) return false;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return false;
    }
  }
  return true;
}

export const leverAdapter = defineAdapter({
  kind: 'lever',
  label: 'Lever job site',
  access: 'api',
  hosts: ['api.lever.co', 'api.eu.lever.co'],
  robotsPaths(source) {
    const site = encodeURIComponent(leverSite(String(source.config.site ?? '')));
    return [`/v0/postings/${site}?mode=json&skip=0&limit=${LEVER_PAGE_SIZE}`];
  },
  async fetch(source, ctx) {
    const site = leverSite(configText(source.config, 'site', 'Lever site name'));
    const host = leverHost(source.config.region);
    const companyName = str(source.config.companyName) ?? nameFromSlug(site);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    let complete = true;
    const pageUrl = (page: number) =>
      `${host}/v0/postings/${encodeURIComponent(site)}?mode=json&skip=${page * LEVER_PAGE_SIZE}&limit=${LEVER_PAGE_SIZE}`;
    /** Each page's posting ids as first read, in order. */
    const pageIds: string[][] = [];
    // v30 S1-API: the first page goes as a conditional GET. Validators are kept only for a listing of one page (below),
    // so a 304 means the whole listing is unchanged.
    let validators: ListingValidators | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = pageUrl(page);
      let answer;
      try {
        answer =
          page === 0
            ? await ctx.http.getJson(url, {
                signal: ctx.signal,
                allow: [404],
                ...conditionalOf(ctx),
                meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
              })
            : await ctx.http.getJson(url, { signal: ctx.signal, allow: [404] });
      } catch (error) {
        // The first page failing is the run failing; a later page leaves the listing incomplete.
        if (page === 0 || ctx.signal.aborted) throw error;
        complete = false;
        failures.push({ message: `Page ${page + 1} of the listing could not be read: ${(error as Error).message}` });
        break;
      }
      if (page === 0 && answer.status === 304) return notModifiedResult();
      if (answer.status === 404) {
        throw new SourceNotFoundError(
          `Lever has no job site "${site}"${host.includes('.eu.') ? ' in the EU region' : ''}. Check the site name (jobs.lever.co/<site>).`,
        );
      }
      if (!Array.isArray(answer.data)) throw new IngestError(`Lever site "${site}" answered without a posting list.`);
      pageIds.push(idsOf(answer.data));
      for (const item of records(answer.data)) {
        const posting = leverPosting(item, companyName);
        if (posting) postings.push(posting);
        else failures.push({ sourceJobId: str(item.id) ?? undefined, message: 'A listed posting has no id, title or link.' });
      }
      if (answer.data.length < LEVER_PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) {
        complete = false;
        failures.push({ message: `The listing has more than ${MAX_PAGES * LEVER_PAGE_SIZE} postings; the rest were not read.` });
      }
    }
    if (complete && pageIds.length > 1 && !(await pagesHeld(ctx, pageUrl, pageIds))) {
      complete = false;
      ctx.log('The listing changed while it was read (a posting moved across its pages); nothing is marked missing this run.');
    }
    ctx.log(`Lever site ${site}: ${postings.length} postings.`);
    return { postings, complete, failures, validators: complete && pageIds.length === 1 ? validators : null };
  },
});
