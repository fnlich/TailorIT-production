import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { RIPPLING_API_HOST, RIPPLING_ATS_HOST, ripplingBoard, ripplingPostingLink } from '@tailorit/shared/sourcing';
import { withCompanyFacts } from '../boards/company';
import type { CompanyFacts } from '../boards/types';
import type { IngestHttp } from '../http';
import { storedSourceJobId } from '../normalize';
import { IngestError, SourceNotFoundError, type FetchFailure, type RawPosting } from '../types';
import { arrangementOf, isRecord, nameFromSlug, num, records, str, type Json } from './common';
import { defineAdapter } from './define';
import { readListedDetails, recheckSpanOf } from './detail-reads';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 7; REQUEST.md 7; EVIDENCE.md 7, read 2026-11-25): a Rippling job board.
//   - The list: GET https://ats.rippling.com/api/v2/board/{board}/jobs?page={n}&pageSize=100, pages from 0:
//     { items: [{ id (uuid), name, url, department { name }, locations [{ name, country, countryCode, state, city,
//     workplaceType }] }], page, pageSize, totalItems, totalPages } (no text).
//   - A posting: GET https://api.rippling.com/platform/api/ats/v1/board/{board}/jobs/{uuid}: { uuid, name, description
//     { company (HTML: the company's blurb), role (HTML) }, workLocations [text], department { name }, employmentType
//     { label "SALARIED_FT", id "Salaried, full-time" } (the two look swapped: the words are in `id`), createdOn, url,
//     companyName, board { title, logo { url }, companyName }, payRangeDetails [] }. Its apply form
//     (activeJobApplication) and the board's look are never read or kept. An unknown uuid answers 404.
//   robots.txt: ats.rippling.com disallows /internal/ only; api.rippling.com has none (404).
// A run reads the list, then each planned posting's record (adapters/detail-reads.ts: new ones first, at most
// RIPPLING_READS_PER_RUN, a listed one again after RIPPLING_RECHECK_DAYS), one request at a time on the Rippling lane.
// Add job, an import's link and the re-checks read one posting the same way (readRipplingPosting).
//
// A source: config `{ board, companyName? }` (a board's name is case-sensitive). A new kind of read: the identity guard
// first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The list's page size (Rippling's own largest is not documented; 100 answered). */
export const RIPPLING_PAGE_SIZE = 100;
/** The most list pages a run reads (5,000 postings); a board with more is read in part (nothing closes by absence). */
export const RIPPLING_MAX_PAGES = 50;
/** The most of one answer read (a posting's record runs to some tens of kilobytes; a list page to less). */
export const RIPPLING_ANSWER_MAX_BYTES = 4 * 1024 * 1024;
/** A run stops after this many failed record reads in a row. */
export const RIPPLING_FAILURES_IN_A_ROW = 5;

/** A posting's id: a UUID, in lower case. */
const RIPPLING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Rippling source's board (its name as written); throws IngestError for none. */
export function ripplingBoardOf(config: Record<string, unknown>): string {
  const board = ripplingBoard(str(config.board) ?? '');
  if (!board) throw new IngestError('This source has no Rippling board (ats.rippling.com/<board>/jobs). Edit the source and add it.');
  return board;
}

/** A list page's address. */
export const ripplingListUrl = (board: string, page: number) =>
  `https://${RIPPLING_ATS_HOST}/api/v2/board/${encodeURIComponent(board)}/jobs?page=${page}&pageSize=${RIPPLING_PAGE_SIZE}`;

/** A posting's record's address. */
export const ripplingPostingUrl = (board: string, id: string) =>
  `https://${RIPPLING_API_HOST}/platform/api/ats/v1/board/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`;

/** An https address on the posting's own host, else its clean link. */
function postingUrlOf(given: unknown, board: string, id: string): string {
  try {
    const url = str(given) ? new URL(str(given)!) : null;
    if (url && url.protocol === 'https:' && url.hostname === RIPPLING_ATS_HOST) return `https://${RIPPLING_ATS_HOST}${url.pathname}`;
  } catch {
    /* the built address */
  }
  return ripplingPostingLink(board, id);
}

/** A list item's places, as the places reader reads them ("Tampa, Florida, US"; "Remote" for a remote one with none). */
function listPlacesOf(item: Json): { places: string[]; remote: boolean; country: string | null } {
  const locations = records(item.locations);
  const places = locations
    .map((place) => [str(place.city), str(place.state), str(place.countryCode) ?? str(place.country)].filter(Boolean).join(', ') || str(place.name))
    .filter((place): place is string => Boolean(place));
  const remote = locations.some((place) => str(place.workplaceType)?.toUpperCase() === 'REMOTE');
  const country = locations.map((place) => str(place.countryCode)).find((code) => code && /^[A-Za-z]{2}$/.test(code)) ?? null;
  return { places: [...new Set(places)], remote, country: country ? country.toUpperCase() : null };
}

/** A list item as a posting (its title and places alone: the admin's Test, discovery's validation); null without an id. */
export function ripplingListPosting(item: Json, board: string, companyName: string): RawPosting | null {
  const id = str(item.id)?.toLowerCase() ?? null;
  const title = str(item.name);
  if (!id || !RIPPLING_ID.test(id) || !title) return null;
  const { places, remote, country } = listPlacesOf(item);
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    url: postingUrlOf(item.url, board, id),
    locations: places,
    countryHint: country,
    workArrangement: remote ? 'remote' : null,
    department: isRecord(item.department) ? (str(item.department.displayName) ?? str(item.department.name)) : null,
  };
}

/** The words of a posting's employment type: Rippling's `id` holds them (`label` is the code: the two look swapped). */
function employmentWordsOf(value: unknown): string | null {
  if (!isRecord(value)) return str(value);
  const id = str(value.id);
  const label = str(value.label);
  // The one with a space or a comma is the words ("Salaried, full-time"), the other the code ("SALARIED_FT").
  if (id && /[\s,]/.test(id)) return id;
  if (label && /[\s,]/.test(label)) return label;
  return id ?? label;
}

/** What a posting's record says about its company (A6): its name, its blurb, its board's logo. */
export function ripplingCompanyFacts(data: Json): CompanyFacts {
  const board = isRecord(data.board) ? data.board : {};
  const description = isRecord(data.description) ? data.description : {};
  const logo = isRecord(board.logo) ? str(board.logo.url) : null;
  return { name: str(data.companyName) ?? str(board.companyName), about: str(description.company), logoUrl: logo };
}

/** A posting's record as a RawPosting (never its apply form); null without an id, a title or a text. */
export function ripplingPosting(data: Json, board: string, companyName: string): RawPosting | null {
  const id = (str(data.uuid) ?? str(data.id))?.toLowerCase() ?? null;
  const title = str(data.name);
  if (!id || !RIPPLING_ID.test(id) || !title) return null;
  const description = isRecord(data.description) ? data.description : {};
  const role = str(description.role);
  const places = (Array.isArray(data.workLocations) ? data.workLocations : []).map(str).filter((place): place is string => Boolean(place));
  const remote = places.length > 0 && places.every((place) => /^remote\b/i.test(place));
  const department = isRecord(data.department) ? str(data.department.name) : str(data.department);
  const pay = records(data.payRangeDetails)[0];
  const min = pay ? (num(pay.rangeStart) ?? num(pay.min)) : null;
  const max = pay ? (num(pay.rangeEnd) ?? num(pay.max)) : null;
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: role,
    url: postingUrlOf(data.url, board, id),
    locations: places,
    workArrangement: remote ? 'remote' : arrangementOf(places.join(' ')),
    employmentText: employmentWordsOf(data.employmentType),
    department,
    salary: min !== null || max !== null ? { min, max, currency: pay ? str(pay.currency) : null, period: null } : null,
    postedAt: str(data.createdOn),
  };
}

/**
 * One posting read from its record (at most RIPPLING_ANSWER_MAX_BYTES): the posting and what it says about its company,
 * or null when it is gone (404). The company is the source's companyName, else the record's, else the board's name made
 * readable. Throws IngestHttpError when Rippling fails, IngestError for an answer that is no posting or another one.
 */
export async function readRipplingPosting(
  http: IngestHttp,
  board: string,
  id: string,
  named: string | null,
  signal?: AbortSignal,
): Promise<{ raw: RawPosting; company: CompanyFacts } | null> {
  const answer = await http.getJson(ripplingPostingUrl(board, id), {
    signal,
    allow: [404],
    maxBytes: RIPPLING_ANSWER_MAX_BYTES,
    allowRedirectHost: (host) => host === RIPPLING_API_HOST,
  });
  if (answer.status === 404) return null;
  if (!isRecord(answer.data)) throw new IngestError('Rippling answered without a posting.');
  const company = ripplingCompanyFacts(answer.data);
  const raw = ripplingPosting(answer.data, board, named ?? company.name ?? nameFromSlug(board));
  if (!raw) throw new IngestError("Rippling's posting has no id or title.");
  if (raw.sourceJobId !== id.toLowerCase()) throw new IngestError('Rippling answered with another posting.');
  return { raw, company };
}

/** The board's list, page by page (pages from 0), at most RIPPLING_MAX_PAGES: its items and whether it was read whole. */
async function readRipplingList(
  http: IngestHttp,
  board: string,
  signal: AbortSignal,
  failures: FetchFailure[],
): Promise<{ items: Json[]; whole: boolean }> {
  const items: Json[] = [];
  // v38 FIX-A (SP v38 FIXES-38 item 12, REVIEW38-beh L7): the list's postings counted once each (a page that repeats one
  // and leaves another out is not the whole list).
  const ids = new Set<string>();
  let whole = true;
  for (let page = 0; page < RIPPLING_MAX_PAGES; page += 1) {
    let answer;
    try {
      answer = await http.getJson(ripplingListUrl(board, page), {
        signal,
        allow: [404],
        maxBytes: RIPPLING_ANSWER_MAX_BYTES,
        allowRedirectHost: (host) => host === RIPPLING_ATS_HOST,
      });
    } catch (error) {
      // The first page failing is the run failing; a later page leaves the list incomplete.
      if (page === 0 || signal.aborted) throw error;
      failures.push({ message: `Page ${page + 1} of the list could not be read.` });
      return { items, whole: false };
    }
    if (answer.status === 404) {
      if (page === 0) throw new SourceNotFoundError(`Rippling has no job board "${board}". Check the board's name (ats.rippling.com/<board>/jobs).`);
      return { items, whole: false };
    }
    if (!isRecord(answer.data) || !Array.isArray(answer.data.items)) throw new IngestError(`Rippling answered without the jobs of "${board}".`);
    for (const item of records(answer.data.items)) {
      const id = str(item.id)?.toLowerCase();
      if (id && ids.has(id)) continue;
      if (id) ids.add(id);
      items.push(item);
    }
    const pages = num(answer.data.totalPages);
    const total = num(answer.data.totalItems);
    const last = pages !== null ? page >= pages - 1 : answer.data.items.length < RIPPLING_PAGE_SIZE;
    if (last) {
      // A list shorter than its own total is not the whole one (nothing closes by its absence).
      if (total !== null && ids.size < total) whole = false;
      return { items, whole };
    }
    if (page === RIPPLING_MAX_PAGES - 1) {
      failures.push({ message: `The board lists more than ${RIPPLING_MAX_PAGES * RIPPLING_PAGE_SIZE} postings; the rest were not read.` });
      whole = false;
    }
  }
  return { items, whole };
}

export const ripplingAdapter = defineAdapter({
  kind: 'rippling',
  label: 'Rippling job board',
  access: 'api',
  hosts: [RIPPLING_ATS_HOST, RIPPLING_API_HOST],
  robotsPaths(source) {
    try {
      const board = encodeURIComponent(ripplingBoardOf(source.config));
      return [`/api/v2/board/${board}/jobs`, `/${board}/jobs`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const board = ripplingBoardOf(source.config);
    const named = str(source.config.companyName);
    const failures: FetchFailure[] = [];
    const { items, whole } = await readRipplingList(ctx.http, board, ctx.signal, failures);
    const listed = new Map<string, RawPosting>();
    for (const item of items) {
      const posting = ripplingListPosting(item, board, named ?? nameFromSlug(board));
      if (!posting) failures.push({ sourceJobId: str(item.id) ?? undefined, message: 'A listed job has no id or name.' });
      else if (!listed.has(posting.sourceJobId)) listed.set(posting.sourceJobId, posting);
    }
    ctx.log(`Rippling ${board}: ${listed.size} jobs${whole ? '' : ' (the list is incomplete)'}.`);
    // The admin's Test and discovery's validation (they store nothing): the list alone, titles and places.
    if (ctx.listingOnly || source.id <= 0) return { postings: [...listed.values()], complete: whole, failures };
    const constants = constantsOf(ctx.deps);
    return readListedDetails(source, ctx, [...listed.keys()].map(storedSourceJobId), whole, failures, {
      label: 'Rippling',
      host: RIPPLING_API_HOST,
      budget: constants.get('RIPPLING_READS_PER_RUN'),
      recheckMs: recheckSpanOf(constants.get('RIPPLING_RECHECK_DAYS')),
      failuresInARow: RIPPLING_FAILURES_IN_A_ROW,
      read: async (id, signal) => {
        const read = await readRipplingPosting(ctx.http, board, id, named, signal);
        // The record's company facts (A6): its blurb and its board's logo, as a link's read applies them.
        return read ? withCompanyFacts(read.raw, read.company, source.config) : null;
      },
    });
  },
});
