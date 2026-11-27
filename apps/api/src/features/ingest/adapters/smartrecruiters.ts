import { boardUrlOf, SMARTRECRUITERS_HOST, smartRecruitersLinkOf } from '@tailorit/shared/sourcing';
import { escapeHtml, type WorkArrangement } from '@tailorit/shared';
import { placeOfParts } from '../career/jsonld';
import { assertNewReadAllowed } from '../../../core/http/identity';
import type { IngestHttp } from '../http';
import { IngestError, type RawPosting, type RawSalary } from '../types';
import { arrangementOf, nameFromSlug, num, periodOf } from './common';
import { defineAdapter } from './define';
import { addressOn, anyTagsOf, canonicalLinkOf, elementsWithClass, inlineText, innerHtmlOf, itemProps, itemText, metaContent, readPage } from './page-boards';

// v38 ATS-C (SP v38 PLAN "Final coverage" row 2; SP v38 EVIDENCE.md §2): SmartRecruiters, links only.
//   - A numeric link's page (jobs.smartrecruiters.com/<Company>/<postingId>-<slug>) is server-rendered with schema.org
//     microdata on <main itemscope itemtype="http://schema.org/JobPosting">: itemprop title; jobLocation > address >
//     meta addressLocality / addressRegion / addressCountry; employmentType; hiringOrganization > meta name, logo;
//     meta datePosted, industry; baseSalary > meta currency, value > minValue, maxValue, unitText; description holding
//     the sections #st-companyDescription (the company's blurb), #st-jobDescription, #st-qualifications and
//     #st-additionalInformation, each a heading and a div.wysiwyg. Its <link rel="canonical"> is the clean link. It is
//     read through the ingest client (its bot user agent, robots.txt: jobs.smartrecruiters.com has none), on the
//     SmartRecruiters lane. A 404 or 410 is gone; a page with no JobPosting is no posting (can't read).
//   - api.smartrecruiters.com is NEVER asked: its robots.txt disallows every path for `*` (the adapter declares no such host,
//     so the recorded-answer harness fails a read of it).
//   - A one-click link (/oneclick-ui/company/<Company>/publication/<uuid>) is never read: the page answers a DataDome bot
//     check (403). Its read answers can't read at once, nothing sent (boards/smartrecruiters.ts).
// No board list in v3.8: the source kind never runs (its adapter refuses), as Workday's one-posting kind.

/** A posting of a company: its number, and the page to read (the link's own clean page when it has one). */
export interface SmartRecruitersRef {
  company: string;
  id: string;
  page?: string | null;
}

/**
 * The page a posting is read from: its own clean link (it names this posting, its company in any case), else null. v38
 * FIX-C (REVIEW38-beh L11): never an address built from the company and the number alone (whether SmartRecruiters
 * answers a slug-less /<Company>/<id>, or how, is unknown), so a re-check of a job whose link is not the posting's page is
 * can't read.
 */
export function smartRecruitersPageOf(ref: SmartRecruitersRef): string | null {
  const own = ref.page ? boardUrlOf(ref.page) : null;
  const read = own ? smartRecruitersLinkOf(own) : null;
  if (read && !read.oneClick && read.id === ref.id && read.company.toLowerCase() === ref.company.toLowerCase()) return read.clean;
  return null;
}

/** v38 FIX-C (beh-L11): the host a posting of `company` is read on (the re-check's hold check), its page or not. */
export const smartRecruitersCompanyUrl = (company: string) => `https://${SMARTRECRUITERS_HOST}/${encodeURIComponent(company)}`;

/** The posting's sections in the page's order: [id, default heading]. */
const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['st-companyDescription', 'Company Description'],
  ['st-jobDescription', 'Job Description'],
  ['st-qualifications', 'Qualifications'],
  ['st-additionalInformation', 'Additional Information'],
];

/** A section of the description by its id: its heading's text and its wysiwyg HTML, or null. */
function sectionOf(scope: string, id: string): { heading: string | null; html: string } | null {
  const tag = anyTagsOf(scope).find((item) => item.name === 'section' && item.attributes.id === id);
  const inner = tag ? innerHtmlOf(scope, tag, 'section') : null;
  if (!inner) return null;
  const heading = elementsWithClass(inner, 'h2', 'title')[0];
  const body = elementsWithClass(inner, 'div', 'wysiwyg')[0] ?? '';
  return inlineText(body) ? { heading: heading ? inlineText(heading) || null : null, html: body.trim() } : null;
}

/** baseSalary's microdata as a salary, or null. */
function salaryOf(scope: string): RawSalary | null {
  const item = itemProps(scope, 'baseSalary')[0];
  if (!item) return null;
  const min = num(itemText(item.value, 'minValue'));
  const max = num(itemText(item.value, 'maxValue'));
  if (min === null && max === null) return null;
  const currency = itemText(item.value, 'currency')?.toUpperCase() ?? null;
  return { min, max, currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null, period: periodOf(itemText(item.value, 'unitText')) };
}

/** The work arrangement the page's location says (its spl-job-location workplaceType: remote, hybrid, onsite). */
function arrangementOfPage(scope: string): WorkArrangement | null {
  const tag = anyTagsOf(scope).find((item) => item.name === 'spl-job-location');
  return arrangementOf(tag?.attributes.workplacetype ?? null);
}

/** What a SmartRecruiters page says: its posting, and its company's facts. */
export interface SmartRecruitersPage {
  raw: RawPosting;
  company: { name: string | null; about: string | null; logoUrl: string | null; website: string | null };
  /** v38 FIX-C (REVIEW38-beh L10): the JobPosting's own validThrough (its microdata scope's, never another one's on the page). */
  validThrough: string | null;
}

/**
 * A posting's page as a RawPosting (null when the page holds no JobPosting microdata or no title). `pageUrl` is the page
 * read; the posting's link is its canonical link when that names this posting, else the page read.
 */
export function smartRecruitersPosting(html: string, ref: SmartRecruitersRef, pageUrl: string, companyName: string | null): SmartRecruitersPage | null {
  const main = anyTagsOf(html).find((tag) => /^https?:\/\/schema\.org\/JobPosting$/i.test(tag.attributes.itemtype ?? '') && tag.attributes.itemscope !== undefined);
  const scope = main ? innerHtmlOf(html, main, main.name) : null;
  if (!scope) return null;
  const title = itemText(scope, 'title');
  if (!title) return null;
  const canonical = boardUrlOf(canonicalLinkOf(html) ?? '');
  const named = canonical ? smartRecruitersLinkOf(canonical) : null;
  if (named && !named.oneClick && named.id !== ref.id) throw new IngestError('SmartRecruiters answered with another posting.');
  const places = itemProps(scope, 'jobLocation')
    .map((item) => placeOfParts(itemText(item.value, 'addressLocality'), itemText(item.value, 'addressRegion'), itemText(item.value, 'addressCountry')))
    .filter((place): place is string => Boolean(place));
  const sections = SECTIONS.map(([id, heading]) => ({ id, section: sectionOf(scope, id), heading })).filter((item) => item.section);
  const descriptionHtml = sections.map(({ section, heading }) => `<h3>${escapeHtml(section!.heading ?? heading)}</h3>\n${section!.html}`).join('\n') || null;
  const organization = itemProps(scope, 'hiringOrganization')[0]?.value ?? '';
  const organizationName = itemText(organization, 'name') ?? metaContent(html, 'og:site_name');
  const department = anyTagsOf(scope)
    .filter((tag) => tag.name === 'li' && (tag.attributes.class ?? '').split(/\s+/).includes('job-detail'))
    .map((tag) => inlineText(innerHtmlOf(scope, tag, 'li') ?? ''))
    .find((text) => /^department:/i.test(text))
    ?.replace(/^department:\s*/i, '');
  const website = elementsWithClass(html, 'span', 'header-logo')
    .flatMap((inner) => anyTagsOf(inner).filter((tag) => tag.name === 'a'))
    .map((tag) => tag.attributes.href ?? null)[0];
  const raw: RawPosting = {
    sourceJobId: ref.id,
    title,
    company: { name: companyName ?? organizationName ?? nameFromSlug(ref.company.replace(/\d+$/, '') || ref.company) },
    descriptionHtml,
    url: named && !named.oneClick ? named.clean : pageUrl,
    locations: places,
    workArrangement: arrangementOfPage(scope),
    employmentText: itemText(scope, 'employmentType'),
    salary: salaryOf(scope),
    industry: itemText(scope, 'industry'),
    department: department || null,
    postedAt: itemText(scope, 'datePosted'),
  };
  const about = sections.find((item) => item.id === 'st-companyDescription')?.section?.html ?? null;
  return {
    raw,
    company: {
      name: organizationName,
      about,
      logoUrl: addressOn(itemText(organization, 'logo'), pageUrl, () => true),
      website: addressOn(website ?? null, pageUrl, () => true),
    },
    validThrough: itemText(scope, 'validThrough'), // v38 FIX-C (beh-L10)
  };
}

/** One posting's read: found (its posting and its company's facts), or gone (404, 410, a past validThrough). */
export type SmartRecruitersRead = ({ found: true } & SmartRecruitersPage) | { found: false };

/**
 * One posting read from its page (on jobs.smartrecruiters.com only; its redirects stay there). Throws IngestHttpError
 * when SmartRecruiters fails (a 403 bot check holds the lane: the ingest client), RobotsRefusal when robots.txt refuses
 * it, and IngestError when the page holds no posting or another one.
 */
export async function readSmartRecruitersPosting(
  http: IngestHttp,
  ref: SmartRecruitersRef,
  options: { companyName?: string | null; signal?: AbortSignal; now?: Date } = {},
): Promise<SmartRecruitersRead> {
  if (!/^\d{6,20}$/.test(ref.id)) throw new IngestError('TailorIT reads a SmartRecruiters posting by its number only.');
  const page = smartRecruitersPageOf(ref);
  // v38 FIX-C (beh-L11): read from the posting's own link only.
  if (!page) throw new IngestError("TailorIT reads a SmartRecruiters posting from its own link only, and this job's link is not that posting's page.");
  const answer = await readPage(http, page, {
    signal: options.signal,
    allow: [404, 410],
    allowRedirectHost: (host) => host === SMARTRECRUITERS_HOST,
  });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const read = smartRecruitersPosting(answer.html, ref, page, options.companyName ?? null);
  if (!read) throw new IngestError("The posting's page holds no SmartRecruiters posting.");
  const validThrough = Date.parse(read.validThrough ?? ''); // v38 FIX-C (beh-L10): the JobPosting's own
  if (Number.isFinite(validThrough) && validThrough < (options.now ?? new Date()).getTime()) return { found: false };
  return { found: true, ...read };
}

export const smartRecruitersAdapter = defineAdapter({
  kind: 'smartrecruiters',
  label: 'SmartRecruiters postings',
  access: 'page',
  hosts: [SMARTRECRUITERS_HOST],
  robotsPaths: () => ['/'],
  // Never run (links only); the identity guard first, as every new kind of read's (v30-switches.test.ts).
  async fetch(_source, ctx) {
    assertNewReadAllowed(ctx.deps, 'feed_read');
    throw new IngestError(
      "TailorIT reads SmartRecruiters postings one at a time (the links people add), never a company's whole list: " +
        'this source cannot be run. The daily check keeps its postings up to date.',
    );
  },
});
