import { boardUrlOf, JOBVITE_HOST, jobviteCompany, jobviteLinkOf } from '@tailorit/shared/sourcing';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { pageJobPosting } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { storedSourceJobId } from '../normalize';
import { IngestError, SourceNotFoundError, type RawPosting } from '../types';
import { nameFromSlug, str } from './common';
import { defineAdapter } from './define';
import { addressOn, anyTagsOf, elementsWithClass, inlineText, innerHtmlOf, metaContent, readListedPages, readPage, REDIRECT_STATUSES, titleOf } from './page-boards';

// v38 ATS-C (SP v38 PLAN "Final coverage" row 8; SP v38 EVIDENCE.md §8): a company's Jobvite board as a source,
// jobs.jobvite.com/<company> (config `{ company, companyName? }`; robots.txt: none on the host).
//   - Its list, /<company>/jobs: HTML tables (table.jv-job-list) grouped under <h3 class="h2"><category>, each row a link
//     /<company>/job/<id> (td.jv-job-list-name) and its place (td.jv-job-list-location); no paging. A page that holds no
//     table (or a pager) is not taken as the whole list: nothing closes by its absence.
//   - A posting's page, /<company>/job/<id>: one schema.org JobPosting (title, description HTML, datePosted, employmentType,
//     industry = its category, identifier = its id, jobLocation, baseSalary); <title> "<Company> Careers - <Title>",
//     og:image the company's logo, .jv-job-detail-meta "<category> | <place>".
//   - A gone posting: its page answers 303 to /careers/<company>/jobs?error=404, never followed (the error page says "The
//     job listing no longer exists."); a 404 or 410 too. Any other redirect is no posting read (a failure).
// A run reads the list, then each job's page (adapters/page-boards.ts readListedPages, BOARD_PAGE_READS_PER_RUN); a link
// (Add job and its kin) and the re-checks read one page the same way (boards/jobvite.ts). A new kind of read: the identity
// guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** A posting's own page. */
export const jobviteJobUrl = (company: string, id: string) => `https://${JOBVITE_HOST}/${company}/job/${id}`;
/** A company's list. */
export const jobviteListUrl = (company: string) => `https://${JOBVITE_HOST}/${company}/jobs`;

/**
 * A redirect to Jobvite's error page for `company`'s posting: the posting is gone. v38 FIX-C (REVIEW38-beh M6; SP v38
 * EVIDENCE.md §8): only Jobvite's own "not found" answer, jobs.jobvite.com/careers/<company>/jobs?error=404 (or
 * /<company>/jobs?error=404), the company as the link writes it in any case; any other redirect (another error, a
 * sign-in page, another path) is no sign the posting is gone.
 */
function isErrorPage(location: string | null, company: string): boolean {
  const url = location ? boardUrlOf(location) : null;
  if (!url || url.hostname.toLowerCase() !== JOBVITE_HOST) return false;
  const path = /^\/(?:careers\/)?([^/]+)\/jobs\/?$/i.exec(url.pathname);
  const errors = [...url.searchParams].filter(([name]) => name === 'error').map(([, value]) => value);
  return Boolean(path && path[1]!.toLowerCase() === company.toLowerCase() && errors.length === 1 && errors[0] === '404');
}

/** The company a source's config names (lower case), or IngestError. */
export function jobviteCompanyOf(config: Record<string, unknown>): string {
  const company = jobviteCompany(str(config.company) ?? '');
  if (!company) throw new IngestError('This source has no Jobvite company (jobs.jobvite.com/<company>). Edit the source and add it.');
  return company;
}

/** The place a posting's page states in its .jv-job-detail-meta ("<category> | <place>"), or null. */
function metaPlaceOf(html: string): string | null {
  const meta = elementsWithClass(html, 'p', 'jv-job-detail-meta')[0];
  if (!meta) return null;
  const parts = meta.split(/<span\b[^>]*jv-inline-separator[^>]*>\s*<\/span>/i);
  const place = parts.length > 1 ? inlineText(parts.slice(1).join(' ')).replace(/\s*,\s*$/, '').replace(/\s+,/g, ',') : '';
  return place || null;
}

/** What a Jobvite posting's page says: its posting, and its company's facts. */
export interface JobvitePage {
  raw: RawPosting;
  company: { name: string | null; logoUrl: string | null };
}

/** A posting's page (its JobPosting) as a RawPosting for the posting `id` of `company`; null when it holds none. */
export function jobvitePosting(html: string, company: string, id: string, companyName: string | null): JobvitePage | null {
  const page = jobviteJobUrl(company, id);
  const posting = pageJobPosting(html, page);
  if (!posting) return null;
  if (posting.identifier && posting.identifier !== id) throw new IngestError('Jobvite answered with another posting.');
  const ownName = posting.hiringOrganization?.name ?? /^(.+?) Careers - /.exec(titleOf(html) ?? '')?.[1]?.trim() ?? null;
  const place = metaPlaceOf(html);
  const locations = posting.locations.length > 1 || !place ? posting.locations : [place];
  return {
    raw: {
      sourceJobId: id,
      title: posting.title,
      company: { name: companyName ?? ownName ?? nameFromSlug(company) },
      descriptionHtml: posting.descriptionHtml,
      url: page,
      locations: posting.remote && locations.length === 0 ? ['Remote'] : locations,
      employmentText: posting.employmentText,
      salary: posting.salary,
      // Jobvite writes the posting's category (its list's heading) as the JobPosting's industry.
      department: posting.industry,
      postedAt: posting.datePosted,
    },
    company: { name: ownName, logoUrl: addressOn(metaContent(html, 'og:image'), page, () => true) },
  };
}

/** One posting's read: found (its posting and its company's facts), or gone. */
export type JobviteRead = ({ found: true } & JobvitePage) | { found: false };

/**
 * One posting read from its page (on jobs.jobvite.com; a redirect is never followed): gone on a 303 to the error page, a
 * 404 or a 410, or the error page's words. Throws IngestHttpError when Jobvite fails, RobotsRefusal when robots.txt refuses
 * the read, and IngestError when the page holds no posting (or another one), or sends the read elsewhere.
 */
export async function readJobvitePosting(
  http: IngestHttp,
  company: string,
  id: string,
  options: { companyName?: string | null; signal?: AbortSignal } = {},
): Promise<JobviteRead> {
  if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new IngestError('TailorIT does not know this Jobvite posting.');
  const answer = await readPage(http, jobviteJobUrl(company, id), { signal: options.signal, allow: [404, 410], followRedirects: false });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  if (REDIRECT_STATUSES.includes(answer.status)) {
    if (isErrorPage(answer.location, company)) return { found: false }; // v38 FIX-C (beh-M6): its own error=404 only
    throw new IngestError("Jobvite sent the posting's page elsewhere.");
  }
  if (/jv-page-error[\s\S]{0,400}no longer exists/i.test(answer.html)) return { found: false };
  const read = jobvitePosting(answer.html, company, id, options.companyName ?? null);
  if (!read) throw new IngestError("The posting's page holds no JobPosting.");
  return { found: true, ...read };
}

/** A company's list: its jobs by id (in the list's order, no full text) and whether it is the whole list. */
export function jobviteListOf(html: string, company: string, companyName: string): { listed: Map<string, RawPosting>; whole: boolean } {
  const listed = new Map<string, RawPosting>();
  const headings = anyTagsOf(html).filter((tag) => tag.name === 'h3');
  const cells = anyTagsOf(html).filter((tag) => tag.name === 'td');
  cells.forEach((cell, index) => {
    if (!(cell.attributes.class ?? '').split(/\s+/).includes('jv-job-list-name')) return;
    const inner = innerHtmlOf(html, cell, 'td') ?? '';
    const anchor = anyTagsOf(inner).find((tag) => tag.name === 'a');
    const href = boardUrlOf(addressOn(anchor?.attributes.href, jobviteListUrl(company), (host) => host === JOBVITE_HOST) ?? '');
    const posting = href ? jobviteLinkOf(href) : null;
    if (!posting || posting.company.toLowerCase() !== company || listed.has(storedSourceJobId(posting.id))) return;
    const title = inlineText(innerHtmlOf(inner, anchor!, 'a') ?? '');
    if (!title) return;
    const next = cells[index + 1];
    const place = next && (next.attributes.class ?? '').split(/\s+/).includes('jv-job-list-location') ? inlineText(innerHtmlOf(html, next, 'td') ?? '') : '';
    const heading = headings.filter((tag) => tag.at < cell.at).at(-1);
    const category = heading ? inlineText(innerHtmlOf(html, heading, 'h3') ?? '') : '';
    listed.set(storedSourceJobId(posting.id), {
      sourceJobId: posting.id,
      title,
      company: { name: companyName },
      url: posting.clean,
      locations: place ? [place.replace(/\s+,/g, ',').replace(/\s*,\s*$/, '')] : [],
      department: category || null,
    });
  });
  const tables = anyTagsOf(html).some((tag) => tag.name === 'table' && (tag.attributes.class ?? '').split(/\s+/).includes('jv-job-list'));
  const paged = /class\s*=\s*["'][^"']*\bjv-pagination/i.test(html);
  return { listed, whole: tables && !paged };
}

export const jobviteAdapter = defineAdapter({
  kind: 'jobvite',
  label: 'Jobvite company',
  access: 'page',
  hosts: [JOBVITE_HOST],
  robotsPaths(source) {
    try {
      const company = jobviteCompanyOf(source.config);
      return [`/${company}/jobs`, `/${company}/job/`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const company = jobviteCompanyOf(source.config);
    const signal = ctx.signal;
    const answer = await readPage(ctx.http, jobviteListUrl(company), { signal, allow: [404, 410], followRedirects: false });
    // v38 FIX-C (REVIEW38-beh L5, its Jobvite part): "no such company" only on a 404 or 410, or Jobvite's own error page; a
    // redirect elsewhere (a sign-in or check page) is a failed run, never a source "not found".
    if (answer.status === 404 || answer.status === 410 || (REDIRECT_STATUSES.includes(answer.status) && isErrorPage(answer.location, company))) {
      throw new SourceNotFoundError(`Jobvite has no company "${company}" (jobs.jobvite.com/${company}). Check the company name.`);
    }
    if (REDIRECT_STATUSES.includes(answer.status)) throw new IngestError("Jobvite sent the company's list elsewhere: TailorIT tries again later.");
    const named = str(source.config.companyName);
    const companyName = named ?? /^(.+?) Careers\b/.exec(titleOf(answer.html) ?? '')?.[1]?.trim() ?? nameFromSlug(company);
    const { listed, whole } = jobviteListOf(answer.html, company, companyName);
    ctx.log(`Jobvite ${company}: ${listed.size} jobs${whole ? '' : ' (not taken as the whole list: nothing closes by its absence)'}.`);
    return readListedPages(source, ctx, {
      label: `Jobvite company ${company}`,
      host: JOBVITE_HOST,
      listed,
      whole,
      read: async (_id, item, readSignal) => {
        const read = await readJobvitePosting(ctx.http, company, item.sourceJobId, { companyName: named ?? null, signal: readSignal });
        if (!read.found) return null;
        const raw = read.raw;
        return {
          ...raw,
          company: { ...raw.company, ...(named ? { name: named } : {}), ...(read.company.logoUrl ? { logoSourceUrl: read.company.logoUrl } : {}) },
          locations: raw.locations && raw.locations.length > 0 ? raw.locations : item.locations,
          department: raw.department ?? item.department ?? null,
        };
      },
    });
  },
});
