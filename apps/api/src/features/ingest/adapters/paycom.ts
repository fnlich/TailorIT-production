import { boardUrlOf, PAYCOM_HOST, paycomJobUrl, paycomLinkOf } from '@tailorit/shared/sourcing';
import { decodeHtmlEntities } from '@tailorit/shared';
import { expiredAt, pageJobPosting } from '../career/jsonld';
import { textToHtml } from '../html';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { wallOf } from '../../../core/http/reader/detect'; // v38 FIX-C (D2)
import type { IngestHttp } from '../http';
import { IngestError, type RawPosting } from '../types';
import { defineAdapter } from './define';
import { addressOn, readPage } from './page-boards';

// v38 ATS-C (SP v38 PLAN "Final coverage" row 16; SP v38 EVIDENCE.md §16): Paycom, links only. A posting's page,
// www.paycomonline.net/v4/ats/web.php/portal/<clientKey>/jobs/<jobId> (robots.txt allows /v4/ats/web.php/portal/), is a
// script app whose raw HTML (about 250 kB) already carries one schema.org JobPosting: title, identifier, url (the clean
// link), baseSalary, datePosted, validThrough, description (PLAIN TEXT: read as paragraphs and lists),
// employmentType ("OTHER" says nothing), hiringOrganization {name, logo}. It names no place anywhere: the posting keeps
// none (never guessed). A gone posting answers 200 with no JobPosting ("Loading..."): v38 INT (closed only on a positive
// sign: a challenge page answering 200 has no JobPosting either) that is can't read (no_posting), never closed; a 404 or
// 410, or a past validThrough, closes it. v38 FIX-C (D2): the portal's own empty page (isPaycomEmptyPortal, every sign of
// it together) is that positive sign: a new link's read closes at once, a stored job once two reads a day apart see it. No board list in v3.8 (the careers page needs a browser): the kind never runs (its adapter refuses).

/** A JobPosting's description as HTML: plain text as paragraphs and lists (its entities decoded), HTML as it is. */
export function paycomDescriptionHtml(text: string | null): string | null {
  if (!text) return null;
  if (/<[a-z!/][^>]*>/i.test(text)) return text;
  const html = textToHtml(decodeHtmlEntities(text));
  return html || null;
}

/** What a Paycom posting's page says: its posting, and its company's facts. */
export interface PaycomPage {
  raw: RawPosting;
  company: { name: string | null; logoUrl: string | null };
}

/**
 * One posting's read: found (its posting and its company's facts), or gone. v38 FIX-C (D2): `emptyPortal`, gone by the
 * portal's own empty page (isPaycomEmptyPortal), which closes a stored job only when seen twice a day apart.
 */
export type PaycomRead = ({ found: true } & PaycomPage) | { found: false; emptyPortal?: true };

/**
 * v38 FIX-C (SP v38 FIXES-38 D2; REVIEW38-beh M1; SP v38 EVIDENCE.md §16): Paycom's page for an id the portal does not
 * have. The portal's server writes a job's facts into the page's head only when it has the job (its <title>, og:title,
 * og:url, its JobPosting); for an unknown id it answers 200 with the portal's own shell and nothing of a job: ALL of
 *   - the portal's logo preload, /v4/ats/web.php/portal-customization/logo?clientkey=<the link's client key> (any case);
 *   - <title>Loading...</title>;
 *   - no og:url and no ld+json anywhere;
 *   - no wall (core/http/reader/detect.ts wallOf: no challenge title or script) — a challenge or WAF page carries none of
 *     the client key's preload, and one with a challenge header never reaches here (the ingest client holds the host).
 * Anything else with no JobPosting stays can't read.
 */
export function isPaycomEmptyPortal(html: string, key: string): boolean {
  const page = html.toLowerCase();
  return (
    page.includes(`/v4/ats/web.php/portal-customization/logo?clientkey=${key.toLowerCase()}`) &&
    /<title\b[^>]*>\s*loading\.\.\.\s*<\/title\s*>/.test(page) &&
    !/property\s*=\s*["']?og:url\b/.test(page) &&
    !page.includes('ld+json') &&
    wallOf(html) === null
  );
}

/**
 * One posting read from its page (on www.paycomonline.net only; its redirects stay there): gone on a 404, a 410 or a past
 * validThrough, or (v38 FIX-C, D2) the portal's empty page (`emptyPortal`). Throws IngestHttpError when Paycom fails,
 * RobotsRefusal when robots.txt refuses the read, and IngestError when the page holds another posting or none (v38 INT:
 * no JobPosting alone is no sign the job is gone: can't read).
 */
export async function readPaycomPosting(
  http: IngestHttp,
  key: string,
  id: string,
  options: { companyName?: string | null; signal?: AbortSignal; now?: Date } = {},
): Promise<PaycomRead> {
  if (!/^[A-Fa-f0-9]{32}$/.test(key) || !/^\d{1,15}$/.test(id)) throw new IngestError('TailorIT does not know this Paycom posting.');
  const page = paycomJobUrl(key, id);
  const answer = await readPage(http, page, { signal: options.signal, allow: [404, 410], allowRedirectHost: (host) => host === PAYCOM_HOST });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const posting = pageJobPosting(answer.html, page);
  if (!posting) {
    // v38 FIX-C (D2): the portal's own empty page is Paycom's sign that it has no such job (see isPaycomEmptyPortal).
    if (answer.status === 200 && isPaycomEmptyPortal(answer.html, key)) return { found: false, emptyPortal: true };
    throw new IngestError("The posting's page holds no JobPosting."); // v38 INT: can't read, never closed
  }
  const own = posting.url ? boardUrlOf(posting.url) : null;
  const named = own ? paycomLinkOf(own) : null;
  if (named && named.id !== id) throw new IngestError('Paycom answered with another posting.');
  if (expiredAt(posting, options.now ?? new Date())) return { found: false };
  const ownName = posting.hiringOrganization?.name ?? null;
  const employment = posting.employmentText && !/^other$/i.test(posting.employmentText.trim()) ? posting.employmentText : null;
  return {
    found: true,
    raw: {
      sourceJobId: id,
      title: posting.title,
      // v38 INT-2 (SP v38 FIXES-38 D1): never the platform's name; with no source Company name and no hiring
      // organisation the posting names none (Add job asks for it: jobs/add/board-link.ts).
      company: { name: options.companyName ?? ownName ?? '' },
      descriptionHtml: paycomDescriptionHtml(posting.descriptionHtml),
      url: page,
      // Paycom's page names no place: none is guessed.
      locations: [],
      employmentText: employment,
      salary: posting.salary,
      industry: posting.industry,
      postedAt: posting.datePosted,
    },
    company: { name: ownName, logoUrl: addressOn(posting.hiringOrganization?.logo, page, () => true) },
  };
}

export const paycomAdapter = defineAdapter({
  kind: 'paycom',
  label: 'Paycom postings',
  access: 'page',
  hosts: [PAYCOM_HOST],
  robotsPaths: () => ['/v4/ats/web.php/portal/'],
  // Never run (links only); the identity guard first, as every new kind of read's (v30-switches.test.ts).
  async fetch(_source, ctx) {
    assertNewReadAllowed(ctx.deps, 'feed_read');
    throw new IngestError(
      "TailorIT reads Paycom postings one at a time (the links people add), never a portal's whole list: this source " +
        'cannot be run. The daily check keeps its postings up to date.',
    );
  },
});
