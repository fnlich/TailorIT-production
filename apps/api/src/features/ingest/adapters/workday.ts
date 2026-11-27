import { COUNTRIES, parseLocations, type ParsedLocation, type WorkArrangement } from '@tailorit/shared';
import { unsafeWorkdaySegment, WORKDAY_PATH_MAX, type AddablePosting, type WorkdayPostingRef } from '@tailorit/shared/autofill';
import { isWorkdayHost, workdayTenant } from '@tailorit/shared/sourcing'; // v38 FRAME: the board registry's rules
import type { IngestHttp } from '../http';
import { assertRobotsAllow } from '../robots';
import { IngestError, type RawPosting } from '../types';
import { arrangementOf, isRecord, nameFromSlug, str, type Json } from './common';
import { defineAdapter } from './define';

// Workday postings (autofill API version 5), read one at a time: never a whole career site. Add job reads the posting
// a page shows, and the daily liveness check asks again for the postings only an Add job source lists, both through
// GET https://<host>/wday/cxs/<tenant>/<site>/job/<location>/<slug>_<reqId>, the JSON read the posting's own page
// makes (its candidate site is a single-page application over it). Before it, the host's robots.txt must allow both
// that read's path and the posting page's (robots.ts: a tenant that disallows one of its career sites keeps its
// postings out). The answer is capped (WORKDAY_ANSWER_MAX_BYTES) and its fields checked, as every board's are. A
// Workday source is never run: its config names the tenant alone (`tenant`, and `companyName` once Workday named the
// company), and each posting's site and name come from its job's own link.

/**
 * The most of one Workday answer read: 2 MB (a posting's answer, with its description and a few similar postings,
 * runs to tens of kilobytes). Past it the client stops reading (413, never retried).
 */
export const WORKDAY_ANSWER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * v38 FRAME: the tenant as a source's config names it, and a Workday host (the shared board registry's WORKDAY_BOARD
 * rules, moved there unchanged).
 */
export { isWorkdayHost, workdayTenant };

/** A posting the read names: the tenant (lower case), its requisition id and its address parts. */
export interface WorkdayRef extends WorkdayPostingRef {
  tenant: string;
  reqId: string;
}

/** On myworkdaysite.com the tenant sits in the path, before the site. */
const onSharedHost = (host: string) => host.endsWith('.myworkdaysite.com');

// v37 CLOSED (SP v37 PLAN.md C4): a posting's link may name no location (`location` ''): Workday's own
// /<site>/details/<slug>_<reqId> (its search pages' links) or /<site>/job/<slug>_<reqId>. Its read is the posting's JSON
// without the location, /wday/cxs/<tenant>/<site>/job/<slug>_<reqId> (Workday answers it as the located one; a
// /details/ path in the JSON read answers 406), and its page the /details/ one (workdayLinkPosting below; the shared
// lookup's addablePosting, hash-pinned by the extension's contract, reads located links only).

/** The posting's own page: https://<host>[/recruiting/<tenant>]/<site>/job/<location>/<slug>_<reqId> (no location: /details/). */
function pagePath(ref: WorkdayRef): string {
  const prefix = onSharedHost(ref.host) ? `/recruiting/${ref.tenant}` : '';
  if (!ref.location) return `${prefix}/${ref.site}/details/${ref.posting}`; // v37 CLOSED (C4)
  return `${prefix}/${ref.site}/job/${ref.location}/${ref.posting}`;
}

/** The read's path: /wday/cxs/<tenant>/<site>/job/[<location>/]<slug>_<reqId> (location and name as the page writes them). */
function cxsPath(ref: WorkdayRef): string {
  const located = ref.location ? `${ref.location}/` : ''; // v37 CLOSED (C4): no location, none in the read
  return `/wday/cxs/${encodeURIComponent(ref.tenant)}/${encodeURIComponent(ref.site)}/job/${located}${ref.posting}`;
}

/** The posting's JSON address. */
export const workdayPostingUrl = (ref: WorkdayRef) => `https://${ref.host}${cxsPath(ref)}`;

/** The posting's page, for its job's link: Workday's own externalUrl when it is on the posting's host, else built. */
function postingPage(info: Json, ref: WorkdayRef): string {
  const external = str(info.externalUrl);
  try {
    const url = external ? new URL(external) : null;
    if (url && url.protocol === 'https:' && url.hostname === ref.host && url.port === '') return url.href;
  } catch {
    /* not an address: built below */
  }
  return `https://${ref.host}${pagePath(ref)}`;
}

/** The posting's country as an ISO code, from its requisition's location (`alpha2Code`); null when not given. */
function countryOf(info: Json): string | null {
  const location = isRecord(info.jobRequisitionLocation) ? info.jobRequisitionLocation : null;
  const country = location && isRecord(location.country) ? str(location.country.alpha2Code) : null;
  return country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
}

/** "2026-11-02" as a date the store reads; anything else is no date. */
function dateOf(value: unknown): string | null {
  const text = str(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** ISO 3166-1: every alpha-3 code (and Kosovo's XKX) with its alpha-2 code. */
const ALPHA3: ReadonlyMap<string, string> = new Map(
  (
    'AFG AF ALA AX ALB AL DZA DZ ASM AS AND AD AGO AO AIA AI ATA AQ ATG AG ARG AR ARM AM ABW AW AUS AU AUT AT AZE AZ ' +
    'BHS BS BHR BH BGD BD BRB BB BLR BY BEL BE BLZ BZ BEN BJ BMU BM BTN BT BOL BO BES BQ BIH BA BWA BW BVT BV BRA BR ' +
    'IOT IO BRN BN BGR BG BFA BF BDI BI CPV CV KHM KH CMR CM CAN CA CYM KY CAF CF TCD TD CHL CL CHN CN CXR CX CCK CC ' +
    'COL CO COM KM COG CG COD CD COK CK CRI CR CIV CI HRV HR CUB CU CUW CW CYP CY CZE CZ DNK DK DJI DJ DMA DM DOM DO ' +
    'ECU EC EGY EG SLV SV GNQ GQ ERI ER EST EE SWZ SZ ETH ET FLK FK FRO FO FJI FJ FIN FI FRA FR GUF GF PYF PF ATF TF ' +
    'GAB GA GMB GM GEO GE DEU DE GHA GH GIB GI GRC GR GRL GL GRD GD GLP GP GUM GU GTM GT GGY GG GIN GN GNB GW GUY GY ' +
    'HTI HT HMD HM VAT VA HND HN HKG HK HUN HU ISL IS IND IN IDN ID IRN IR IRQ IQ IRL IE IMN IM ISR IL ITA IT JAM JM ' +
    'JPN JP JEY JE JOR JO KAZ KZ KEN KE KIR KI PRK KP KOR KR KWT KW KGZ KG LAO LA LVA LV LBN LB LSO LS LBR LR LBY LY ' +
    'LIE LI LTU LT LUX LU MAC MO MDG MG MWI MW MYS MY MDV MV MLI ML MLT MT MHL MH MTQ MQ MRT MR MUS MU MYT YT MEX MX ' +
    'FSM FM MDA MD MCO MC MNG MN MNE ME MSR MS MAR MA MOZ MZ MMR MM NAM NA NRU NR NPL NP NLD NL NCL NC NZL NZ NIC NI ' +
    'NER NE NGA NG NIU NU NFK NF MKD MK MNP MP NOR NO OMN OM PAK PK PLW PW PSE PS PAN PA PNG PG PRY PY PER PE PHL PH ' +
    'PCN PN POL PL PRT PT PRI PR QAT QA REU RE ROU RO RUS RU RWA RW BLM BL SHN SH KNA KN LCA LC MAF MF SPM PM VCT VC ' +
    'WSM WS SMR SM STP ST SAU SA SEN SN SRB RS SYC SC SLE SL SGP SG SXM SX SVK SK SVN SI SLB SB SOM SO ZAF ZA SGS GS ' +
    'SSD SS ESP ES LKA LK SDN SD SUR SR SJM SJ SWE SE CHE CH SYR SY TWN TW TJK TJ TZA TZ THA TH TLS TL TGO TG TKL TK ' +
    'TON TO TTO TT TUN TN TUR TR TKM TM TCA TC TUV TV UGA UG UKR UA ARE AE GBR GB USA US UMI UM URY UY UZB UZ VUT VU ' +
    'VEN VE VNM VN VGB VG VIR VI WLF WF ESH EH YEM YE ZMB ZM ZWE ZW XKX XK'
  )
    .match(/[A-Z]{3} [A-Z]{2}/g)!
    .map((pair) => pair.split(' ') as [string, string]),
);
const ALPHA2: ReadonlySet<string> = new Set(ALPHA3.values());

/** A Workday place written country first ("USA, CA, Santa Clara"): its country's alpha-2 code (null: none known). */
interface WorkdayPlace {
  country: string | null;
  region: string;
  city: string;
}

function workdayPlace(value: string): WorkdayPlace | null {
  const match = /^([A-Z]{2,3}),\s*([A-Z0-9]{1,3}),\s*(.+)$/.exec(value);
  if (!match) return null;
  const [, written, region, city] = match;
  const country = written!.length === 3 ? (ALPHA3.get(written!) ?? null) : ALPHA2.has(written!) ? written! : null;
  return { country, region: region!, city: city!.trim() };
}

/**
 * A place as Workday's tenants often write it, country and region first ("USA, CA, Santa Clara"), turned the way the
 * places reader reads it: a US or Canadian place with its region and country ("Santa Clara, CA, USA", "Toronto, ON,
 * Canada"); any other in a country the reader knows as its city and its country's name ("IND, TN, Chennai" as
 * "Chennai, India", "DEU, BE, Berlin" as "Berlin, Germany"), since the reader would take a region code after the city
 * for a US state or a country of its own (TN, GA, BE); in any other country, or one no ISO code names, as the city
 * alone, its country set by workdayPlaces (never the requisition's, unless it is that one); any other text as it is.
 */
function placeOf(value: string | null): string | null {
  const place = value ? workdayPlace(value) : null;
  if (!place) return value;
  const { country, region, city } = place;
  if (country === 'US') return `${city}, ${region}, ${value!.split(',')[0]}`;
  if (country === 'CA') return `${city}, ${region}, Canada`;
  const name = country && Object.hasOwn(COUNTRIES, country) ? COUNTRIES[country]!.name : null;
  return name ? `${city}, ${name}` : city;
}

/** Whether a Workday place is in a country placeOf cannot write for the reader (or no country at all). */
function unwritableCountry(value: string): boolean {
  const place = workdayPlace(value);
  if (!place) return false;
  const { country } = place;
  return country !== 'US' && country !== 'CA' && !(country && Object.hasOwn(COUNTRIES, country));
}

/**
 * The posting's places when one of them is in a country placeOf cannot write for the reader (Jordan, a code no ISO
 * table holds): each read on its own, that one with its own country (or none, never the requisition's), every other
 * with the requisition's country where it names none, as the reader would give it. Null when every place can be
 * written, and the places go to the reader as text with the requisition's country as its hint.
 */
function workdayPlaces(values: readonly string[], hint: string | null): ParsedLocation[] | null {
  if (!values.some(unwritableCountry)) return null;
  return values.flatMap((value) => {
    const place = workdayPlace(value);
    if (place && unwritableCountry(value)) {
      return parseLocations([place.city]).map((read) => ({ ...read, region: null, countryCode: place.country }));
    }
    return parseLocations([placeOf(value)!]).map((read) =>
      read.countryCode || (!read.city && !read.region && !read.isRemote) || !hint ? read : { ...read, countryCode: hint },
    );
  });
}

/**
 * Workday's `remoteType` as an arrangement: Workday's own words are "Flex" (the recorded answer of 2026-11-05) and
 * "Flexible" for a role worked partly from home, "Hybrid", "Remote" (and "Fully Remote", "Virtual"), and "On Site",
 * "Onsite", "In Office" or "Office" (or "Not Remote", "Non-Remote", "No Remote"); anything else says nothing.
 */
export function workdayArrangement(value: unknown): WorkArrangement | null {
  const text = str(value)?.toLowerCase().replace(/[\s_-]+/g, '') ?? '';
  if (!text) return null;
  if (text === 'notremote' || text === 'nonremote' || text === 'noremote') return 'onsite';
  if (text.startsWith('flex')) return 'hybrid';
  if (text === 'virtual') return 'remote';
  return arrangementOf(value);
}

/**
 * One posting as a RawPosting (the answer's `jobPostingInfo`); null when it lacks a title. Its company is the source's
 * companyName, else the hiring organisation Workday names, else the tenant's slug.
 */
export function workdayPosting(answer: Json, ref: WorkdayRef, companyName: string | null): RawPosting | null {
  const info = isRecord(answer.jobPostingInfo) ? answer.jobPostingInfo : null;
  const title = info ? str(info.title) : null;
  if (!info || !title) return null;
  const hiring = isRecord(answer.hiringOrganization) ? str(answer.hiringOrganization.name) : null;
  const more = Array.isArray(info.additionalLocations) ? info.additionalLocations.map(str) : [];
  // Workday's count of a posting's places ("2 Locations") is no place: the places it counts are listed beside it.
  const main = str(info.location);
  const places = [main && /^\d+\s+locations?$/i.test(main) ? null : main, ...more];
  const written = [...new Set(places)].filter((value): value is string => Boolean(value));
  const locations = [...new Set(written.map(placeOf))].filter((value): value is string => Boolean(value));
  const hint = countryOf(info);
  // A place in a country the reader cannot be told by name: the places read here, each with its own country.
  const read = workdayPlaces(written, hint);
  return {
    sourceJobId: ref.reqId,
    title,
    company: { name: companyName ?? hiring ?? nameFromSlug(ref.tenant) },
    descriptionHtml: str(info.jobDescription),
    url: postingPage(info, ref),
    ...(read ? { locations: [], places: read } : { locations }),
    workArrangement: workdayArrangement(info.remoteType),
    arrangementText: str(info.remoteType),
    employmentText: str(info.timeType),
    postedAt: dateOf(info.startDate),
    countryHint: read ? null : hint,
  };
}

/** A posting read: found (with the company Workday names, when the source names none), or gone. */
export type WorkdayAnswer = { found: true; raw: RawPosting; listedCompany?: string } | { found: false };

/** A tenant's own Workday host (its first label the tenant; never www or a bare wd<n>). */
const WORKDAY_TENANT_HOST = /^(?!(?:www|wd\d{1,3})\.)([a-z0-9-]+)\.(?:wd\d{1,3}\.)?myworkdayjobs\.com$/;
/** A locale segment, read as one only where a site follows it (as the shared lookup reads Workday's addresses). */
const WORKDAY_LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,4})?$/i;
/** A tenant or a career site as Workday's addresses write them. */
const WORKDAY_NAME = /^[A-Za-z0-9_-]+$/;
/** What may follow a location-less posting: nothing (the posting) or its Apply choice. */
const WORKDAY_LINK_PAGES: ReadonlySet<string> = new Set(['', 'apply', 'apply/applyManually', 'apply/autofillWithResume', 'apply/useMyLastApplication']);

/** A path segment decoded once and encoded again one way (a ',' and its '%2C' are one), or null. */
function foldedSegment(segment: string): string | null {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * v37 CLOSED (C4): the posting a Workday link names WITHOUT a location, as Add job reads it: <host>/[<locale>/]<site>/
 * details/<slug>_<reqId> or <host>/[<locale>/]<site>/job/<slug>_<reqId> (and /recruiting/<tenant>/<site>/... on
 * wd<n>.myworkdaysite.com), then nothing or the posting's Apply pages. Null for any other address (a located posting is
 * the shared lookup's: addablePosting), a segment that would change the read's path, or a path over WORKDAY_PATH_MAX.
 */
export function workdayLinkPosting(address: string): AddablePosting | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '') return null;
  const host = url.hostname.toLowerCase();
  const own = WORKDAY_TENANT_HOST.exec(host);
  const shared = /^wd\d{1,3}\.myworkdaysite\.com$/.test(host);
  if (!own && !shared) return null;
  let parts = url.pathname.split('/').filter((part) => part !== '');
  const siteAt = own ? 0 : 2;
  // A first segment shaped like a locale is one only where the posting's shape follows it.
  const shaped = (rest: string[]) => (own ? rest[siteAt + 1] === 'details' || rest[siteAt + 1] === 'job' : rest[0] === 'recruiting');
  if (parts[0] !== undefined && WORKDAY_LOCALE.test(parts[0]) && shaped(parts.slice(1))) parts = parts.slice(1);
  let tenant: string;
  if (own) {
    tenant = own[1]!;
  } else {
    const [recruiting, named, ...rest] = parts;
    if (recruiting !== 'recruiting' || named === undefined || !WORKDAY_NAME.test(named)) return null;
    tenant = named.toLowerCase();
    parts = rest;
  }
  const [site, kind, posting, ...rest] = parts;
  if (site === undefined || !WORKDAY_NAME.test(site) || (kind !== 'details' && kind !== 'job') || posting === undefined) return null;
  if (!WORKDAY_LINK_PAGES.has(rest.join('/'))) return null;
  const folded = foldedSegment(posting);
  const match = folded === null ? null : /^(.+)_([^_]+)$/.exec(folded);
  if (!folded || !match || unsafeWorkdaySegment(folded)) return null;
  const ref = { host, site, location: '', posting: folded };
  if (pagePath({ ...ref, tenant, reqId: match[2]! }).length > WORKDAY_PATH_MAX) return null;
  return { kind: 'workday', board: tenant, externalId: match[2]!, region: 'global', workday: ref };
}


/**
 * Whether the answer is the posting the read named. Its posting id (<slug>_<reqId>) decides when it has one: its id
 * part (after the last '_') is the address's (the slug may be spelt otherwise; R1-3 is never R1-2), or, for an address
 * without the suffix, the requisition's posting (…_JR123-2 for …_JR123, its jobReqId JR123). Without one, its
 * requisition id is the address's id or that id's start (a requisition's postings are R0047453-1, R0047453-2, … in
 * their addresses). An answer naming neither is taken as the one asked for.
 */
function isPostingOf(info: Json, ref: WorkdayRef): boolean {
  const postingId = str(info.jobPostingId)?.toLowerCase();
  const reqId = str(info.jobReqId)?.toLowerCase();
  const wanted = ref.reqId.toLowerCase();
  if (postingId) {
    const named = postingId.slice(postingId.lastIndexOf('_') + 1);
    if (named === wanted) return true;
    // An address without its posting's suffix (…_JR123 for the requisition's posting …_JR123-2): the requisition decides.
    return reqId === wanted && named.startsWith(`${wanted}-`) && /^\d+$/.test(named.slice(wanted.length + 1));
  }
  if (reqId) return reqId === wanted || wanted.startsWith(`${reqId}-`);
  return true;
}

/**
 * One posting read from Workday (at most WORKDAY_ANSWER_MAX_BYTES), its host's robots.txt asked first, both reads kept
 * on Workday's hosts: gone when Workday answers 404 or 410, an error code instead of a posting, or a posting no longer
 * posted. Throws RobotsRefusal when the robots.txt keeps the read out or cannot be read, IngestHttpError when Workday
 * fails or the answer runs over the cap, and IngestError when the address is not one TailorIT reads (a segment that
 * would change the read's path, a path over WORKDAY_PATH_MAX) or the answer is not that posting.
 */
export async function readWorkdayPosting(
  http: IngestHttp,
  ref: WorkdayRef,
  companyName: string | null,
  signal?: AbortSignal,
): Promise<WorkdayAnswer> {
  // v37 CLOSED (C4): a posting with no location ('') has none to check.
  if ((ref.location !== '' && unsafeWorkdaySegment(ref.location)) || unsafeWorkdaySegment(ref.posting) || pagePath(ref).length > WORKDAY_PATH_MAX) {
    throw new IngestError('TailorIT does not read a Workday posting from this address.');
  }
  // Workday reads its career sites' names in any case, so a rule written in one case keeps the others out too.
  await assertRobotsAllow(http, ref.host, [cxsPath(ref), pagePath(ref)], {
    signal,
    ignoreCase: true,
    allowRedirectHost: isWorkdayHost,
  });
  const answer = await http.getJson(workdayPostingUrl(ref), {
    signal,
    allow: [404, 410],
    maxBytes: WORKDAY_ANSWER_MAX_BYTES,
    allowRedirectHost: isWorkdayHost,
  });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  if (!isRecord(answer.data)) throw new IngestError('Workday answered without a posting.');
  const info = answer.data.jobPostingInfo;
  if (!isRecord(info)) {
    if (str(answer.data.errorCode)) return { found: false };
    throw new IngestError('Workday answered without a posting.');
  }
  if (info.posted === false) return { found: false };
  if (!isPostingOf(info, ref)) throw new IngestError('Workday answered with another posting.');
  const raw = workdayPosting(answer.data, ref, companyName);
  if (!raw) throw new IngestError("Workday's posting has no title.");
  const hiring = isRecord(answer.data.hiringOrganization) ? str(answer.data.hiringOrganization.name) : null;
  return companyName === null && hiring ? { found: true, raw, listedCompany: hiring } : { found: true, raw };
}

/**
 * A Workday source is never run: its postings are read one at a time, by Add job and the daily check
 * (readWorkdayPosting, on Workday's own hosts: isWorkdayHost, which `hosts` names).
 */
export const workdayAdapter = defineAdapter({
  kind: 'workday',
  label: 'Workday postings',
  access: 'api',
  hosts: ['*.myworkdayjobs.com', '*.myworkdaysite.com'],
  fetch() {
    return Promise.reject(
      new IngestError(
        'TailorIT reads Workday postings one at a time (the ones added from the extension), never a whole Workday ' +
          'site: this source cannot be run. The daily check keeps its postings up to date.',
      ),
    );
  },
});
