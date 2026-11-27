import { avatureHostOf, avatureLinkOf, avatureSite, boardUrlOf } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { isoOf } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { storedSourceJobId } from '../normalize';
import { IngestError, SourceNotFoundError, type RawPosting } from '../types';
import { nameFromSlug, str } from './common';
import { defineAdapter } from './define';
import { addressOn, anyTagsOf, elementsWithClass, hasClass, inlineText, innerHtmlOf, metaContent, readListedPages, readPage, REDIRECT_STATUSES, tagsOf } from './page-boards';

// v38 ATS-C (SP v38 PLAN "Final coverage" row 22; SP v38 EVIDENCE.md §22): a company's Avature careers site as a source,
// <tenant>.avature.net/<locale>/<portal> (config `{ site: "<host>/<locale>/<portal>", companyName? }`).
//   - robots.txt (`*`) disallows everything but the portals' pages (Allow /*/careers ...) and disallows any address with
//     qtvc= in it: TailorIT never adds qtvc (and never follows a "next" link that holds it).
//   - Its list, /<locale>/<portal>/SearchJobs: 6 jobs a page, each an article whose heading links
//     /<locale>/<portal>/JobDetail/<slug>/<id> with its "Location:" field; the next page is the a.paginationNextLink's
//     address (…/SearchJobs/?jobRecordsPerPage=6&jobOffset=6); no total: the pages are read while a next link is there,
//     at most AVATURE_LIST_PAGES_PER_RUN a run (a list cut short is not the whole list: nothing closes by its absence).
//     v38 FIX-C (REVIEW38-beh H1): the list is whole only on a positive end sign: its last page lists jobs and shows its
//     pager (div.list-controls__pagination) with no next link, or the jobs listed reach the exact results count a page's
//     heading gives; a first page with no job is the empty list only with Avature's own "no results" sign (else can't read).
//   - A posting's page is server-rendered: its title (h2.banner__text__title, og:title), its fields as
//     .article__content__view__field with __label / __value ("Location(s)" "A | B", "Company" (the hiring company),
//     "Eligible for remote", "Career Field", "Job Number"), and its description, the field with no label. No posted date.
//   - A gone posting answers 302 to /<locale>/<portal>/Error (never followed; v38 FIX-C L1: on the site's own host only);
//     a 404 or 410 too. v38 FIX-C (L11): a posting is read from its own link only, never an address built from its id.
// A run reads the list, then each job's page (adapters/page-boards.ts readListedPages); a link and the re-checks read one
// page the same way (boards/avature.ts). A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** A site's job search (its list's first page). */
export const avatureSearchUrl = (site: string) => `https://${site}/SearchJobs`;

/** The site a source's config names, its host and its path; IngestError for none. */
export function avatureSiteOf(config: Record<string, unknown>): { site: string; host: string; path: string } {
  const site = avatureSite(str(config.site) ?? '');
  const host = site ? avatureHostOf(site) : null;
  if (!site || !host) throw new IngestError('This source has no Avature careers site (<tenant>.avature.net/<locale>/<portal>). Edit the source and add it.');
  return { site, host, path: site.slice(host.length) };
}

/**
 * Whether a redirect leads to Avature's error page (…/Error): the posting is gone. v38 FIX-C (REVIEW38-beh L1): only the
 * site's own error page, on its own host (a sign-in or identity provider's /Error elsewhere says nothing of the posting).
 */
function isErrorPage(location: string | null, host: string): boolean {
  const url = location ? boardUrlOf(location) : null;
  return Boolean(url && url.hostname.toLowerCase() === host.toLowerCase() && /\/Error\/?$/i.test(url.pathname));
}

/** A posting's fields, by label in lower case without its colon; the field with no label (its description) as ''. */
export function avatureFieldsOf(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const field of elementsWithClass(html, 'div', 'article__content__view__field')) {
    const label = inlineText(elementsWithClass(field, 'div', 'article__content__view__field__label')[0] ?? '')
      .replace(/:$/, '')
      .toLowerCase();
    const value = (elementsWithClass(field, 'div', 'article__content__view__field__value')[0] ?? '').trim();
    if (!value) continue;
    // The description: the longest field with no label.
    if (!label) {
      if (inlineText(value).length > inlineText(fields.get('') ?? '').length) fields.set('', value);
    } else if (!fields.has(label)) fields.set(label, value);
  }
  return fields;
}

/** The first of these fields' text, or null. */
function fieldText(fields: ReadonlyMap<string, string>, ...labels: string[]): string | null {
  for (const label of labels) {
    const text = inlineText(fields.get(label) ?? '');
    if (text) return text;
  }
  return null;
}

/** What an Avature posting's page says: its posting, and its company's name. */
export interface AvaturePage {
  raw: RawPosting;
  company: { name: string | null };
}

/** A posting's page as a RawPosting (`page` its link); null when it names no title. */
export function avaturePosting(html: string, site: string, id: string, page: string, companyName: string | null): AvaturePage | null {
  const fields = avatureFieldsOf(html);
  const heading = tagsOf(html, 'h2').find((tag) => hasClass(tag, 'banner__text__title'));
  const title = (heading ? inlineText(innerHtmlOf(html, heading, 'h2') ?? '') : '') || metaContent(html, 'og:title');
  if (!title) return null;
  const number = fieldText(fields, 'job number', 'job id', 'requisition id', 'requisition number');
  if (number && number !== id) throw new IngestError('Avature answered with another posting.');
  const places = (fieldText(fields, 'location(s)', 'locations', 'location') ?? '')
    .split(/\s*[|;]\s*/)
    .map((place) => place.trim())
    .filter(Boolean);
  const remote = /^yes\b/i.test(fieldText(fields, 'eligible for remote', 'remote') ?? '');
  const ownName = fieldText(fields, 'company', 'business', 'hiring company') ?? metaContent(html, 'og:site_name');
  const tenant = site.split('.')[0] ?? site;
  return {
    raw: {
      sourceJobId: id,
      title,
      company: { name: companyName ?? ownName ?? nameFromSlug(tenant) },
      descriptionHtml: fields.get('') ?? null,
      url: page,
      locations: places.length > 0 ? places : remote ? ['Remote'] : [],
      workArrangement: remote ? 'remote' : null,
      employmentText: fieldText(fields, 'employment type', 'job type', 'schedule', 'work type'),
      department: fieldText(fields, 'career field', 'job category', 'category', 'department', 'job family'),
      postedAt: isoOf(fieldText(fields, 'posted date', 'date posted', 'posting date')),
    },
    company: { name: ownName },
  };
}

/** One posting's read: found (its posting and its company's name), or gone. */
export type AvatureRead = ({ found: true } & AvaturePage) | { found: false };

/**
 * The page a posting is read from: `page` when it is this posting's on this site, else null. v38 FIX-C (REVIEW38-beh
 * L11): never an address built from the id alone (/JobDetail/<id> with no slug: whether Avature answers it, or answers its
 * error page for it, is unknown), so a re-check of a job whose link is not the posting's page is can't read.
 */
export function avaturePageOf(site: string, id: string, page?: string | null): string | null {
  const own = page ? boardUrlOf(page) : null;
  const read = own ? avatureLinkOf(own) : null;
  return read && read.id === id && read.site.toLowerCase() === site.toLowerCase() ? read.clean : null;
}

/**
 * One posting read from its page (redirects are never followed but one to the same posting's own page, read once): gone
 * on a redirect to the site's error page, a 404 or a 410. Throws IngestHttpError when Avature fails, RobotsRefusal when
 * robots.txt refuses the read, and IngestError when the page holds no posting (or another one), or sends it elsewhere.
 */
export async function readAvaturePosting(
  http: IngestHttp,
  site: string,
  id: string,
  options: { page?: string | null; companyName?: string | null; signal?: AbortSignal } = {},
): Promise<AvatureRead> {
  if (!/^\d{1,12}$/.test(id)) throw new IngestError('TailorIT does not know this Avature posting.');
  const own = avaturePageOf(site, id, options.page);
  // v38 FIX-C (beh-L11): read from the posting's own link only.
  if (!own) throw new IngestError("TailorIT reads an Avature posting from its own link only, and this job's link is not that posting's page.");
  const host = avatureHostOf(site) ?? '';
  let page = own;
  let answer = await readPage(http, page, { signal: options.signal, allow: [404, 410], followRedirects: false });
  for (let hop = 0; REDIRECT_STATUSES.includes(answer.status); hop += 1) {
    if (isErrorPage(answer.location, host)) return { found: false }; // v38 FIX-C (beh-L1): the site's own error page
    const next = answer.location ? boardUrlOf(answer.location) : null;
    const same = next ? avatureLinkOf(next) : null;
    if (hop > 0 || !same || same.id !== id || same.site.toLowerCase() !== site.toLowerCase() || same.clean === page) {
      throw new IngestError("Avature sent the posting's page elsewhere.");
    }
    page = same.clean;
    answer = await readPage(http, page, { signal: options.signal, allow: [404, 410], followRedirects: false });
  }
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const read = avaturePosting(answer.html, site, id, page, options.companyName ?? null);
  if (!read) throw new IngestError("The posting's page holds no Avature posting.");
  return { found: true, ...read };
}

/**
 * One page of a site's job search: its jobs (id, title, link, place), its next page's address (on the site), if any, and
 * (v38 FIX-C, REVIEW38-beh H1) the page's own signs of where the list ends: whether its pager is there
 * (div.list-controls__pagination: present on a page of the list, with or without a next link), the results count its
 * heading gives ("12 results"; "999+ results" is no exact count), whether it carries the list's markup at all
 * (div.section__content__results or an article--result) and whether it says the search found nothing (a count of 0,
 * or "no results" / "no jobs" words in the list's place). SP v38 EVIDENCE.md §22: the pager and the count; an empty
 * search was not seen live (its words are read in the list's place only).
 */
export interface AvatureSearchPage {
  jobs: RawPosting[];
  next: string | null;
  nextRefused: boolean;
  pager: boolean;
  count: { total: number; exact: boolean } | null;
  listMarkup: boolean;
  noResults: boolean;
}

/** The classes of an opening tag, as a set. */
const classesOf = (tag: { attributes: Record<string, string> }) => new Set((tag.attributes.class ?? '').split(/\s+/).filter(Boolean));

/** The results count a job search's heading gives ("1,204 results", "999+ results"), or null. */
function resultsCountOf(html: string): AvatureSearchPage['count'] {
  const header = elementsWithClass(html, 'div', 'section__header--main')[0];
  const match = header ? /^\s*(\d{1,3}(?:[,.\s]\d{3})*|\d+)\s*(\+)?\s+\p{L}/u.exec(inlineText(header)) : null;
  if (!match) return null;
  const total = Number(match[1]!.replace(/[,.\s]/g, ''));
  return Number.isSafeInteger(total) ? { total, exact: !match[2] } : null;
}

export function avatureSearchPageOf(html: string, site: string): AvatureSearchPage {
  const jobs: RawPosting[] = [];
  for (const article of tagsOf(html, 'article')) {
    const inner = innerHtmlOf(html, article, 'article') ?? '';
    const anchor = anyTagsOf(inner).find((tag) => tag.name === 'a' && /\/JobDetail\//i.test(tag.attributes.href ?? ''));
    const url = boardUrlOf(addressOn(anchor?.attributes.href, avatureSearchUrl(site), () => true) ?? '');
    const posting = url ? avatureLinkOf(url) : null;
    if (!posting || posting.site.toLowerCase() !== site.toLowerCase()) continue;
    const title = inlineText(innerHtmlOf(inner, anchor!, 'a') ?? '');
    if (!title) continue;
    const place = elementsWithClass(inner, 'div', 'article__content__field')
      .map((field) => ({
        label: inlineText(elementsWithClass(field, 'div', 'article__content__field__label')[0] ?? '').replace(/:$/, '').toLowerCase(),
        value: inlineText(elementsWithClass(field, 'div', 'article__content__field__value')[0] ?? ''),
      }))
      .find((field) => field.label.startsWith('location'))?.value;
    jobs.push({ sourceJobId: posting.id, title, company: { name: '' }, url: posting.clean, locations: place ? [place] : [] });
  }
  const link = tagsOf(html, 'a').find((tag) => hasClass(tag, 'paginationNextLink'))?.attributes.href ?? null;
  let next: string | null = null;
  let nextRefused = false;
  if (link) {
    try {
      const url = new URL(link, avatureSearchUrl(site));
      const host = avatureHostOf(site)!;
      const path = site.slice(host.length);
      // On the site's own job search, never an address robots.txt disallows (qtvc).
      if (url.protocol === 'https:' && url.hostname.toLowerCase() === host && url.pathname.startsWith(`${path}/SearchJobs`) && !/qtvc/i.test(url.search)) {
        next = url.toString();
      } else nextRefused = true;
    } catch {
      nextRefused = true;
    }
  }
  // v38 FIX-C (beh-H1): the page's own signs of the list's end (see AvatureSearchPage).
  const tags = anyTagsOf(html);
  const pager = tags.some((tag) => classesOf(tag).has('list-controls__pagination'));
  const results = tags.filter((tag) => tag.name === 'div' && classesOf(tag).has('section__content__results'));
  const listMarkup = results.length > 0 || tags.some((tag) => tag.name === 'article' && classesOf(tag).has('article--result'));
  const count = resultsCountOf(html);
  const resultsText = results.map((tag) => inlineText(innerHtmlOf(html, tag, 'div') ?? '')).join(' ');
  const noResults =
    jobs.length === 0 &&
    ((count?.exact === true && count.total === 0) ||
      (listMarkup && /\bno (?:job |matching )?(?:results|jobs|positions|openings|vacancies|matches)\b/i.test(resultsText)));
  return { jobs, next, nextRefused, pager, count, listMarkup, noResults };
}

export const avatureAdapter = defineAdapter({
  kind: 'avature',
  label: 'Avature careers site',
  access: 'page',
  hosts: ['*.avature.net'],
  robotsPaths(source) {
    try {
      const { path } = avatureSiteOf(source.config);
      return [`${path}/SearchJobs`, `${path}/JobDetail/`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const { site, host } = avatureSiteOf(source.config);
    const signal = ctx.signal;
    // The admin's Test and discovery's validation read the list's first page only.
    const listingOnly = ctx.listingOnly || source.id <= 0;
    const cap = listingOnly ? 1 : constantsOf(ctx.deps).get('AVATURE_LIST_PAGES_PER_RUN');
    const named = str(source.config.companyName);
    const listed = new Map<string, RawPosting>();
    let address: string | null = avatureSearchUrl(site);
    let pages = 0;
    let whole = false;
    // v38 FIX-C (REVIEW38-beh H1): the list is whole only on a positive sign of its end: its last page read lists jobs and
    // shows its pager with no next link, or the jobs listed reach the results count a page gave (an exact one). A page with
    // no next link and no such sign (a check page answering 200, a maintenance page, a template with another pager) is no
    // end: nothing closes by absence that run. A first page with no job and no "no results" sign of Avature's is can't read.
    let refused = false;
    let exactCount: number | null = null;
    let last: { jobs: number; pager: boolean; next: boolean } | null = null;
    while (address && pages < cap) {
      if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
      const answer = await readPage(ctx.http, address, { signal, allow: [404, 410], followRedirects: false });
      pages += 1;
      if (answer.status === 404 || answer.status === 410 || (REDIRECT_STATUSES.includes(answer.status) && isErrorPage(answer.location, host))) {
        if (pages === 1) throw new SourceNotFoundError(`Avature has no careers site at ${site}. Check its job search address.`);
        last = null; // a later page gone: no end sign
        break;
      }
      if (REDIRECT_STATUSES.includes(answer.status)) throw new IngestError("Avature sent the site's job search elsewhere.");
      const page = avatureSearchPageOf(answer.html, site);
      if (page.count?.exact) exactCount = page.count.total;
      if (pages === 1 && page.jobs.length === 0) {
        if (page.noResults) {
          whole = true; // Avature's own "no results": the site lists no job now
          last = null;
          break;
        }
        throw new IngestError(
          "Avature's job search answered a page with no jobs and no sign that the search found none (a check page, or a " +
            'changed page): nothing is read or closed now; the next run tries again.',
        );
      }
      let added = 0;
      for (const job of page.jobs) {
        const key = storedSourceJobId(job.sourceJobId);
        if (listed.has(key)) continue;
        listed.set(key, { ...job, company: { name: named ?? nameFromSlug(host.split('.')[0]!) } });
        added += 1;
      }
      if (page.nextRefused) {
        refused = true;
        ctx.log('Its next page is no address TailorIT reads (another site, or one robots.txt disallows): the list stops there.');
      }
      last = { jobs: page.jobs.length, pager: page.pager, next: page.next !== null };
      // A page that adds nothing stops the reads.
      address = page.next && added > 0 ? page.next : null;
    }
    const endShown = last !== null && last.jobs > 0 && last.pager && !last.next;
    const countReached = exactCount !== null && listed.size >= exactCount;
    whole = whole || (!refused && (endShown || countReached));
    ctx.log(`Avature ${site}: ${listed.size} jobs on ${pages} pages${whole ? '' : ' (not the whole list: nothing closes by its absence)'}.`);
    return readListedPages(source, ctx, {
      label: `Avature site ${site}`,
      host,
      listed,
      whole,
      read: async (_id, item, readSignal) => {
        const read = await readAvaturePosting(ctx.http, site, item.sourceJobId, { page: item.url, companyName: named, signal: readSignal });
        if (!read.found) return null;
        return { ...read.raw, locations: read.raw.locations && read.raw.locations.length > 0 ? read.raw.locations : item.locations };
      },
    });
  },
});
