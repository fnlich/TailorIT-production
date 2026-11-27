import { DAY_MS } from '@tailorit/shared';
import { ADP_DEFAULT_CC_ID, ADP_HOST, ADP_JOB_ID, adpCenterOfConfig, adpPostingUrl, type AdpCenter } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { placeOfParts } from '../career/jsonld';
import type { IngestHttp } from '../http';
import { IngestError, PostingUnreadableError, SourceNotFoundError, type FetchFailure, type RawPosting } from '../types';
import { isRecord, num, records, str, type Json } from './common';
import { defineAdapter } from './define';
import { runListedReads } from './listed-reads';

// v38 ATS-B (SP v38 REQUEST.md 21, EVIDENCE.md §21, PLAN "Final coverage" 21): an ADP Workforce Now career center, read
// through the career center's own public JSON (keyless; its careers page loads it):
//   - the list, GET https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions
//     ?cid={cid}&ccId={ccId}&lang=en_US&locale=en_US&$top={n}[&$skip={k}]: `{ jobRequisitions: [{ itemID,
//     requisitionTitle, postDate, requisitionLocations: [{ address { cityName, countrySubdivisionLevel1 { codeValue } },
//     nameCode { shortName " Boca Raton, FL, US" } }], customFieldGroup { stringFields: [{ nameCode { codeValue
//     "ExternalJobID" }, stringValue }] } }], meta: { totalNumber } }`. Pages follow one another by $skip (each asks from
//     the count read so far: ADP's $skip is 1-based, so the page before's last row comes again and is read once), until
//     the total is read, at most ADP_LIST_MAX rows a run. `meta.links` (filter lists that hold what look like people's
//     names) is never read;
//   - each posting's own record, GET .../job-requisitions/{itemID}?cid=...: the same fields with requisitionDescription
//     (HTML) and workLevelCode { shortName }. An unknown itemID answers 200 with empty lists: that answer (and only
//     it: v38 FIX-A, isAdpGoneAnswer) is a posting that is gone.
// A posting is the one its link names: its jobId is the record's ExternalJobID (the custom field), not the API's itemID,
// so a link's read finds the itemID in the list first (the list read once and reused a short time: boards/feed-cache).
// Neither answer names the employer: a source's companyName names it (v38 FIX-APP: never the client's id).
// A source: config `{ tenant: "<cid>[/<ccId>]", companyName? }` (its board's name: the career center, when not ADP's usual one). A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The most of one list page read (its rows and the filter lists beside them): 4 MB. */
export const ADP_LIST_MAX_BYTES = 4 * 1024 * 1024;
/** The most of one posting's record read: 2 MB. */
export const ADP_DETAIL_MAX_BYTES = 2 * 1024 * 1024;
/** The rows one list page asks for. */
export const ADP_LIST_PAGE_SIZE = 50;
/** The most rows a link's read of the list reads (a run reads at most ADP_LIST_MAX). */
export const ADP_LINK_LIST_MAX = 2000;

const BASE = `https://${ADP_HOST}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions`;

/** A source's career center, or the plain refusal for a config that names none. */
export function adpCenterOfSource(config: Record<string, unknown>): AdpCenter {
  const center = adpCenterOfConfig(config);
  if (!center) throw new IngestError("This source names no ADP career center (its careers page's cid). Edit the source and add it.");
  return center;
}

/** The query every read of a career center carries. */
const queryOf = (center: AdpCenter) => `cid=${center.cid}&ccId=${center.ccId ?? ADP_DEFAULT_CC_ID}&lang=en_US&locale=en_US`;

/** One page of the list, from `skip` (none for the first page). */
export const adpListUrl = (center: AdpCenter, skip: number, top = ADP_LIST_PAGE_SIZE) => `${BASE}?${queryOf(center)}&$top=${top}${skip > 0 ? `&$skip=${skip}` : ''}`;

/** One posting's record. */
export const adpDetailUrl = (center: AdpCenter, itemId: string) => `${BASE}/${encodeURIComponent(itemId)}?${queryOf(center)}`;

// v38 FIX-APP (SP v38 FIXES-38 D1; REVIEW38-ux H1): no fallback name. ADP names no employer anywhere, and TailorIT never
// makes one up from the client's id or the platform's name: a run needs its source's Company name (refused in words
// without one), a link read takes the source's, an import row's or the person's company (jobs/add/board-link.ts).
/** A run's refusal of an ADP source with no Company name (Add source asks for it). */
export const ADP_NEEDS_COMPANY =
  "This ADP Workforce Now source names no company, and ADP's careers page doesn't name it. Edit the source and type its Company name.";

/** A row's ExternalJobID (its link's jobId), or null. */
export function adpExternalJobId(row: Json): string | null {
  const group = isRecord(row.customFieldGroup) ? row.customFieldGroup : null;
  for (const field of records(group?.stringFields)) {
    const code = isRecord(field.nameCode) ? str(field.nameCode.codeValue) : null;
    if (code === 'ExternalJobID') {
      const value = str(field.stringValue);
      return value && ADP_JOB_ID.test(value) ? value : null;
    }
  }
  return null;
}

/** A row's places: each location's short name, trimmed (" Boca Raton, FL, US"), else its address's parts. */
function placesOf(row: Json): string[] {
  const places: string[] = [];
  for (const location of records(row.requisitionLocations)) {
    const short = isRecord(location.nameCode) ? str(location.nameCode.shortName)?.replace(/^[\s,]+|[\s,]+$/g, '') : null;
    const address = isRecord(location.address) ? location.address : null;
    const region = address && isRecord(address.countrySubdivisionLevel1) ? str(address.countrySubdivisionLevel1.codeValue) : null;
    const place = short || (address ? placeOfParts(str(address.cityName), region, str(address.countryCode)) : null);
    if (place && !places.includes(place)) places.push(place);
  }
  return places;
}

/** One list row (or a record) as a listing's posting; null without its ExternalJobID or a title. */
export function adpListedPosting(row: Json, center: AdpCenter, companyName: string): RawPosting | null {
  const id = adpExternalJobId(row);
  const title = str(row.requisitionTitle);
  if (!id || !title) return null;
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    url: adpPostingUrl(center, id),
    locations: placesOf(row),
    postedAt: str(row.postDate),
  };
}

/**
 * v38 FIX-A (SP v38 FIXES-38 item 2, REVIEW38-beh M4): ADP's own answer for an itemID it no longer has (EVIDENCE §21):
 * an object of empty lists alone (postingInstructions, links, organizationalUnits, requisitionLocations, ...), with no
 * requisitionTitle. Any other answer without a title (`{}`, an error's confirmMessage) is no such word: can't read.
 */
export function isAdpGoneAnswer(record: Json): boolean {
  const keys = Object.keys(record);
  return (
    keys.length > 0 &&
    keys.includes('requisitionLocations') &&
    !keys.includes('requisitionTitle') &&
    keys.every((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length === 0)
  );
}

/**
 * A record (`requisitionDescription` and all) as the RawPosting of jobId `id`; null when it is ADP's answer for a posting
 * it no longer has (isAdpGoneAnswer). v38 FIX-A (M4): any other record without a title throws IngestError (can't read).
 */
export function adpDetailPosting(record: Json, center: AdpCenter, id: string, companyName: string): RawPosting | null {
  const title = str(record.requisitionTitle);
  if (!title) {
    if (isAdpGoneAnswer(record)) return null;
    throw new IngestError("ADP answered without the posting's title.");
  }
  const named = adpExternalJobId(record);
  if (named && named !== id) throw new IngestError('ADP answered with another posting.');
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: str(record.requisitionDescription),
    url: adpPostingUrl(center, id),
    locations: placesOf(record),
    employmentText: isRecord(record.workLevelCode) ? str(record.workLevelCode.shortName) : null,
    postedAt: str(record.postDate),
  };
}

/** The career center's list: its rows in order, by ExternalJobID, with their itemIDs; whether it was read whole. */
export interface AdpList {
  rows: Json[];
  /** ExternalJobID -> itemID. */
  items: Map<string, string>;
  whole: boolean;
  total: number | null;
}

/**
 * The career center's list (see the top), at most `max` rows. Throws SourceNotFoundError when the first page answers
 * 404 or 410 (no such career center), IngestError for any other answer that is no list (v38 FIX-A, SP v38 FIXES-38 items
 * 1 and 12, REVIEW38-beh M3/L5: a later page's 404, a sign-in or error page, is no word on the career center: try
 * later, and nothing closes), IngestHttpError when it fails.
 */
export async function readAdpList(
  http: IngestHttp,
  center: AdpCenter,
  options: { max: number; signal?: AbortSignal; pageSize?: number },
): Promise<AdpList> {
  const rows = new Map<string, Json>();
  let total: number | null = null;
  let read = 0;
  let complete = false;
  let pages = 0;
  while (rows.size < options.max) {
    const answer = await http.getJson(adpListUrl(center, read, options.pageSize ?? ADP_LIST_PAGE_SIZE), {
      signal: options.signal,
      allow: [404, 410],
      maxBytes: ADP_LIST_MAX_BYTES,
      allowRedirectHost: (to) => to === ADP_HOST,
    });
    pages += 1;
    if ((answer.status === 404 || answer.status === 410) && pages === 1) {
      throw new SourceNotFoundError(`ADP has no career center for the client ${center.cid}. Check the careers page's address.`);
    }
    if (answer.status !== 200 || !isRecord(answer.data) || !Array.isArray(answer.data.jobRequisitions)) {
      throw new IngestError(`ADP answered without the job list of the client ${center.cid} (page ${pages}).`);
    }
    // meta.totalNumber only (meta.links is never read: see the top).
    total = isRecord(answer.data.meta) ? (num(answer.data.meta.totalNumber) ?? total) : total;
    const page = records(answer.data.jobRequisitions);
    const before = rows.size;
    for (const row of page) {
      const itemId = str(row.itemID);
      if (itemId && !rows.has(itemId)) rows.set(itemId, row);
    }
    read += page.length;
    if (page.length === 0 || (total !== null && rows.size >= total)) {
      complete = true;
      break;
    }
    if (rows.size === before) break; // nothing new: the list stops here, not whole
  }
  const kept = [...rows.values()].slice(0, options.max);
  const items = new Map<string, string>();
  for (const row of kept) {
    const id = adpExternalJobId(row);
    const itemId = str(row.itemID);
    if (id && itemId && !items.has(id)) items.set(id, itemId);
  }
  return { rows: kept, items, whole: complete && (total === null || rows.size >= total), total };
}

/**
 * One posting read by its itemID (at most ADP_DETAIL_MAX_BYTES): its RawPosting, or null when it is gone (ADP's own
 * answer for it: isAdpGoneAnswer). Throws IngestHttpError when ADP fails, IngestError when the answer is not that
 * posting's record. v38 FIX-A (M3, M4): a 404 or 410 of the record's address is no word on the posting (a wrong
 * address or career center): PostingUnreadableError `unavailable` (try later), never gone.
 */
export async function readAdpPosting(
  http: IngestHttp,
  center: AdpCenter,
  id: string,
  itemId: string,
  options: { companyName: string; signal?: AbortSignal },
): Promise<RawPosting | null> {
  const answer = await http.getJson(adpDetailUrl(center, itemId), {
    signal: options.signal,
    allow: [404, 410],
    maxBytes: ADP_DETAIL_MAX_BYTES,
    allowRedirectHost: (to) => to === ADP_HOST,
  });
  if (answer.status === 404 || answer.status === 410) throw new PostingUnreadableError('unavailable');
  if (!isRecord(answer.data)) throw new IngestError('ADP answered without the posting.');
  return adpDetailPosting(answer.data, center, id, options.companyName);
}

export const adpAdapter = defineAdapter({
  kind: 'adp',
  label: 'ADP Workforce Now career center',
  access: 'api',
  hosts: [ADP_HOST],
  robotsPaths(source) {
    try {
      adpCenterOfSource(source.config);
      return ['/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const center = adpCenterOfSource(source.config);
    const constants = constantsOf(ctx.deps);
    const runs = !ctx.listingOnly && source.id > 0;
    // v38 FIX-APP (D1): a run needs the source's Company name (nothing is sent without one); a listing-only read (a
    // discovery check) stores nothing, so it names none.
    const companyName = str(source.config.companyName) ?? (ctx.listingOnly ? '' : null);
    if (companyName === null) throw new IngestError(ADP_NEEDS_COMPANY);
    const list = await readAdpList(ctx.http, center, { max: runs ? constants.get('ADP_LIST_MAX') : ADP_LIST_PAGE_SIZE, signal: ctx.signal });
    const failures: FetchFailure[] = [];
    const listed = new Map<string, RawPosting>();
    for (const row of list.rows) {
      const posting = adpListedPosting(row, center, companyName);
      if (!posting) failures.push({ message: 'A requisition has no ExternalJobID or title.' });
      else if (!listed.has(posting.sourceJobId)) listed.set(posting.sourceJobId, posting);
    }
    ctx.log(`ADP client ${center.cid}: ${listed.size} postings${list.whole ? '' : ` of ${list.total ?? 'an unknown number'} (the list was not read whole)`}.`);
    return runListedReads(source, ctx, {
      label: `ADP client ${center.cid}`,
      host: ADP_HOST,
      listed,
      whole: list.whole,
      failures,
      read: (id) => readAdpPosting(ctx.http, center, id, list.items.get(id)!, { companyName, signal: ctx.signal }),
      budget: runs ? constants.get('ADP_READS_PER_RUN') : 0,
      recheckMs: runs ? constants.get('LISTED_POSTINGS_RECHECK_DAYS') * DAY_MS : 0,
    });
  },
});
