import type { WorkArrangement } from '@tailorit/shared';
import { ukgPostingOf, ukgPostingUrl, boardUrlOf } from '@tailorit/shared/sourcing';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { OutboundRefusedError } from '../../../core/http/outbound';
import { placeOfParts } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { IngestError, type RawPosting, type RawSalary } from '../types';
import { isRecord, num, records, str, type Json } from './common'; // v38 FIX-APP: no nameFromSlug (D1)
import { defineAdapter } from './define';

// v38 ATS-D (SP v38 PLAN "Final coverage" #20; EVIDENCE.md §20): UKG Recruiting's postings. A posting's page,
// GET https://<sub>.rec.pro.ukg.net/<tenant>/JobBoard/<board>/OpportunityDetail?opportunityId=<uuid> (robots.txt allows
// */JobBoard/), is server-drawn around an inline `var opportunity = new US.Opportunity.CandidateOpportunityDetail({...});`
// whose object is JSON: Id (the opportunity), Title, RequisitionNumber, Description (HTML), PostedDate, UpdatedDate,
// FullTime, JobCategoryName, Locations[{ LocalizedName, Address { City, State { Name, Code }, Country { Name, Code } } }],
// Compensation*, PayRange (shown only when PayRangeVisible), JobBoardMemberships[{ JobBoardId, ExternalPostedDate }],
// OpportunityIsClosed. An unknown opportunity answers 200 with no such object and the marker
// `Opportunity.OpportunityError.NotFoundErrorMessage`: gone, as an OpportunityIsClosed posting is. TailorIT keeps the
// posting's text, places, pay and dates; never SupervisorName (a person), the EEO statement or the apply criteria. The
// page names no company (its <title> is drawn by script): the source's companyName (v38 FIX-APP, D1: else none, never
// the tenant's host label).
//
// A board's whole list is a POST to …/JobBoardView/LoadSearchResults, which robots.txt disallows: a UKG source never runs
// (its kind's row: runs false); its postings are read one at a time (a link's read, the re-checks). A new kind of read
// ('feed_read': only once BOT_USER_AGENT names TailorIT's bot), on UKG's lane.

/** The most of one posting's page read (about 120 KB; a not-found page about 20 KB): 2 MB. */
export const UKG_PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** A page read's Accept header. */
const UKG_PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
/** The posting's object, inline in its page. */
const DETAIL_MARKER = 'new US.Opportunity.CandidateOpportunityDetail(';
/** An unknown opportunity's page names this message key (and no object). */
const NOT_FOUND_MARKER = 'Opportunity.OpportunityError.NotFoundErrorMessage';

/** The JSON object text starting at `from` (a '{'), balanced outside strings; null when it never closes. */
function objectTextAt(text: string, from: number): string | null {
  if (text[from] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, index + 1);
    }
  }
  return null;
}

/** What a posting's page holds: its record, the not-found marker, or neither (a page TailorIT does not know). */
export type UkgPage = { kind: 'posting'; detail: Json } | { kind: 'not_found' } | { kind: 'unknown' };

/** Reads a posting's page (see the top). */
export function ukgPageOf(html: string): UkgPage {
  const at = html.indexOf(DETAIL_MARKER);
  if (at >= 0) {
    const text = objectTextAt(html, at + DETAIL_MARKER.length);
    if (text) {
      try {
        const detail = JSON.parse(text) as unknown;
        if (isRecord(detail)) return { kind: 'posting', detail };
      } catch {
        // Not JSON: a page TailorIT does not know.
      }
    }
    return { kind: 'unknown' };
  }
  return html.includes(NOT_FOUND_MARKER) ? { kind: 'not_found' } : { kind: 'unknown' };
}

/** A posting's places (its location's words for a remote one, else its address), and whether one is remote. */
function placesOf(detail: Json): { locations: string[]; remote: boolean } {
  const locations: string[] = [];
  let remote = false;
  for (const location of records(detail.Locations)) {
    const name = str(location.LocalizedName);
    if (name && /\bremote\b/i.test(name)) {
      remote = true;
      locations.push(name);
      continue;
    }
    const address = isRecord(location.Address) && location.DisplayAddress !== false ? location.Address : null;
    const state = isRecord(address?.State) ? address.State : null;
    const country = isRecord(address?.Country) ? address.Country : null;
    const place = address ? placeOfParts(str(address.City), str(state?.Name) ?? str(state?.Code), str(country?.Name) ?? str(country?.Code)) : null;
    const line = place ?? name;
    if (line && !locations.includes(line)) locations.push(line);
  }
  return { locations, remote };
}

/** A positive amount, else null (UKG writes 0 or null for none). */
const amount = (value: unknown): number | null => {
  const found = num(value);
  return found !== null && found > 0 ? found : null;
};

/** The pay the posting shows: its annual or hourly compensation, else its pay range when it is shown; else none. */
export function ukgSalary(detail: Json): RawSalary | null {
  const currency = str(detail.CompensationCurrencyCode) ?? str(detail.PayRangeCurrencyCode);
  const annual = [amount(detail.CompensationAnnualMinimum), amount(detail.CompensationAnnualMaximum)] as const;
  if (annual[0] !== null || annual[1] !== null) return { min: annual[0], max: annual[1], currency, period: 'year' };
  const hourly = [amount(detail.CompensationHourlyMinimum), amount(detail.CompensationHourlyMaximum)] as const;
  if (hourly[0] !== null || hourly[1] !== null) return { min: hourly[0], max: hourly[1], currency, period: 'hour' };
  // A pay range the employer hides (PayRangeVisible false) is never shown.
  const range = detail.PayRangeVisible === true && isRecord(detail.PayRange) ? detail.PayRange : null;
  const min = amount(range?.PayRangeMinimum);
  const max = amount(range?.PayRangeMaximum);
  if (min === null && max === null) return null;
  return { min, max, currency: str(detail.PayRangeCurrencyCode) ?? currency, period: detail.Salaried === false ? 'hour' : 'year' };
}

/** When the posting went up on this board (its membership's external date), else its own posted date. */
function postedAtOf(detail: Json, board: string): string | null {
  const membership = records(detail.JobBoardMemberships).find((item) => str(item.JobBoardId)?.toLowerCase() === board.toLowerCase());
  return str(membership?.ExternalPostedDate) ?? str(detail.PostedDate);
}

/** A UKG posting's page, as its read names it. */
export interface UkgPostingRef {
  /** The posting's page (its clean link, or any of its addresses). */
  page: string;
  /** The opportunity (lower case). */
  id: string;
}

/** The posting's host, tenant and board (as written), from its page; null when the page names none or another. */
function postingOfPage(ref: UkgPostingRef): { host: string; tenant: string; board: string; id: string } | null {
  const url = boardUrlOf(ref.page);
  const posting = url ? ukgPostingOf(url) : null;
  return url && posting && posting.id.toLowerCase() === ref.id.toLowerCase() ? { host: url.hostname.toLowerCase(), ...posting } : null;
}

// v38 FIX-APP (SP v38 FIXES-38 D1; REVIEW38-ux H1): no name from the tenant's host label ("Netspi"): the page names no
// company, so a posting read without a source's (or an import row's) Company name names none, and Add job takes the
// person's typed company or asks for it (jobs/add/board-link.ts).

/** One posting's record as a RawPosting (see the top); null without a title. Throws for another opportunity's record. */
export function ukgRawPosting(detail: Json, posting: { host: string; tenant: string; board: string; id: string }, companyName: string): RawPosting | null {
  const id = str(detail.Id)?.toLowerCase();
  if (id !== posting.id.toLowerCase()) throw new IngestError('UKG answered with another opportunity.');
  const title = str(detail.Title);
  if (!title) return null;
  const { locations, remote } = placesOf(detail);
  const arrangement: WorkArrangement | null = remote ? 'remote' : null;
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    url: ukgPostingUrl(posting.host, posting),
    descriptionHtml: str(detail.Description),
    locations,
    workArrangement: arrangement,
    employmentText: detail.FullTime === true ? 'Full-time' : detail.FullTime === false ? 'Part-time' : null,
    department: str(detail.JobCategoryName),
    salary: ukgSalary(detail),
    postedAt: postedAtOf(detail, posting.board),
    updatedAt: str(detail.UpdatedDate),
  };
}

/** What one posting's read came to: open, gone, or a page TailorIT cannot read. */
export type UkgRead = { found: true; raw: RawPosting } | { found: false; unreadable?: 'no_posting' };

/**
 * One posting read from its page (at most UKG_PAGE_MAX_BYTES, on its own host only): open, gone (404, 410, the not-found
 * marker, OpportunityIsClosed), or a page with neither (`no_posting`: can't read). Throws IngestHttpError when UKG
 * fails, RobotsRefusal when robots.txt refuses it, and IngestError for a page that is no posting of UKG's.
 */
export async function readUkgPosting(http: IngestHttp, ref: UkgPostingRef, companyName: string | null, signal?: AbortSignal): Promise<UkgRead> {
  const posting = postingOfPage(ref);
  if (!posting) throw new IngestError('TailorIT does not know this UKG posting.');
  let away = false;
  let answer;
  try {
    answer = await http.getJson(ukgPostingUrl(posting.host, posting), {
      signal,
      text: true,
      accept: UKG_PAGE_ACCEPT,
      allow: [404, 410],
      maxBytes: UKG_PAGE_MAX_BYTES,
      allowRedirectHost: (to) => {
        if (to === posting.host) return true;
        away = true;
        return false;
      },
    });
  } catch (error) {
    // A redirect off the tenant's host (a page TailorIT does not know): nothing read there.
    if (error instanceof OutboundRefusedError && away) return { found: false, unreadable: 'no_posting' };
    throw error;
  }
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const page = ukgPageOf(typeof answer.data === 'string' ? answer.data : '');
  if (page.kind === 'not_found') return { found: false };
  if (page.kind === 'unknown') return { found: false, unreadable: 'no_posting' };
  if (page.detail.OpportunityIsClosed === true) return { found: false };
  const raw = ukgRawPosting(page.detail, posting, companyName ?? ''); // v38 FIX-APP (D1)
  if (!raw) throw new IngestError("UKG's posting has no title.");
  return { found: true, raw };
}

export const ukgAdapter = defineAdapter({
  kind: 'ukg',
  label: 'UKG Recruiting postings',
  access: 'page',
  hosts: ['*.rec.pro.ukg.net', 'recruiting.ultipro.com', 'recruiting2.ultipro.com', 'recruiting.ultipro.ca'],
  fetch(_source, ctx) {
    // A new kind of read: the identity guard first (as every such adapter's), then the refusal in words.
    try {
      assertNewReadAllowed(ctx.deps, 'feed_read');
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.reject(
      new IngestError(
        "TailorIT reads UKG Recruiting postings one at a time (the ones added by their link), never a whole board: the board's " +
          "list is a request its robots.txt asks robots not to make. This source cannot be run.",
      ),
    );
  },
});
