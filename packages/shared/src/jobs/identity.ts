// What makes two postings, or two company names, the same. Used by ingestion's dedupe and by the tracker when a job is
// saved. Pure string work; the API hashes `normalizeJobText` with SHA-256 for `jobs.content_hash`.
// v31 LINK: a link's noise (tracking marks, `source`/`src`, a job board's name as a value, the keep-only boards) is
// canonical.ts' one list (isLinkNoise), shared with canonicalJobUrl.
import { canonicalJobUrl, canonicalPath, keptLinkParameters, linkQueryOf } from './canonical';
import { hostHasCleanLinks } from '../sourcing/boards/index'; // v38 FRAME (A2)

interface UrlLike {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  hash: string;
  searchParams: Iterable<[string, string]>;
}

// URL exists in every browser and in Node; this package's lib types (ES only) do not declare it.
const runtime = globalThis as unknown as {
  URL?: new (input: string) => UrlLike;
};

/**
 * JobDiva's candidate portal (autofill API 7): www<n>.jobdiva.com/portal/?a=<agency>#/jobs/<id>, where the job lives
 * only in the fragment's route (its own query, or a later number, no part of the job), as the autofill contract's
 * parseAtsUrl reads it.
 */
const JOBDIVA_HOST = /^www\d{0,2}\.jobdiva\.com$/;
const JOBDIVA_ROUTE = /^#\/jobs\/(\d{1,12})(?:\/\d{1,12})?\/?(?:\?.*)?$/;

/** The job a JobDiva portal address names in its fragment, or null for any other address. */
function fragmentJob(url: UrlLike): string | null {
  if (!JOBDIVA_HOST.test(url.hostname) || (url.pathname !== '/portal/' && url.pathname !== '/portal')) return null;
  return JOBDIVA_ROUTE.exec(url.hash)?.[1] ?? null;
}

/**
 * A job link as an identity (free_tailor's `linkKey`): http and https folded together, the host lower-case, a default
 * port and the #fragment dropped, the link's noise (canonical.ts isLinkNoise: `utm_*`, `source`, `src`, `gclid`, `ref`,
 * a job board's name as a value, every parameter but its own on Indeed and Glassdoor, ...) removed and the rest sorted,
 * a session matrix parameter (;jsessionid=...) and one trailing slash dropped. The path keeps its case (boards put case-sensitive ids there). Null for anything that is
 * not an http(s) URL. One fragment counts (jr7, autofill API 7): a JobDiva portal's job route, #/jobs/<id>, which is the
 * only place its job is named; it is kept as the query's `id` (JobDiva's own older spelling of the same job, which it
 * replaces), so two jobs of one agency's portal never share a key. v31 LINK: linkKey(canonicalJobUrl(x)) === linkKey(x).
 */
export function linkKey(link: unknown): string | null {
  if (typeof link !== 'string' || !runtime.URL) return null;
  const trimmed = link.trim();
  if (!trimmed) return null;
  let url: UrlLike;
  try {
    url = new runtime.URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  let host = url.hostname.toLowerCase().replace(/\.+$/, '');
  // v38 FRAME (SP v38 PLAN A2): on a board platform that cleans its links, the key is its clean link's (canonicalJobUrl
  // applies its cleanLink), so two spellings of one posting are one key.
  if (hostHasCleanLinks(host)) {
    const clean = canonicalJobUrl(trimmed);
    if (clean && clean !== trimmed) {
      try {
        url = new runtime.URL(clean);
        host = url.hostname.toLowerCase().replace(/\.+$/, '');
      } catch {
        // The clean link is always an address; the link keeps its own key otherwise.
      }
    }
  }
  const job = fragmentJob(url);
  const params = [...url.searchParams].filter(([name]) => !(job !== null && name === 'id'));
  if (job !== null) params.push(['id', job]);
  const search = linkQueryOf(keptLinkParameters(params, host));

  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  return `https://${host}${port}${canonicalPath(url.pathname)}${search}`;
}

/** Legal suffixes dropped from the end of a company name, longest first so "pty ltd" goes before "ltd". */
const LEGAL_SUFFIXES = [
  'incorporated',
  'inc',
  'llc',
  'l l c',
  'llp',
  'lllp',
  'pllc',
  'lp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'pc',
  'plc',
  'gmbh',
  'gmbh co kg',
  'co kg',
  'kg',
  'ag',
  'se',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'sl',
  'bv',
  'nv',
  'oy',
  'oyj',
  'ab',
  'as',
  'asa',
  'aps',
  'kk',
  'pty',
  'pty ltd',
  'pte',
  'pte ltd',
  'sdn bhd',
  'bhd',
  'ulc',
  'co ltd',
].sort((a, b) => b.length - a.length);

/**
 * A company name as a key (`companies.name_key`): symbols (TM, (R)) dropped, Unicode NFKC, lower case, full stops and
 * apostrophes removed ("S.A." -> "sa", "Macy's" -> "macys"), other punctuation as spaces ("AT&T" -> "at t"), trailing
 * legal suffixes dropped repeatedly but never down to nothing ("Acme, Inc." -> "acme"), then every space removed
 * ("Open AI" -> "openai"). '' for a name with nothing left.
 */
export function normalizeCompanyName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const words = name
    .replace(/\p{S}/gu, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.'‘’]/g, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  let rest = words;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (rest.endsWith(` ${suffix}`)) {
        rest = rest.slice(0, rest.length - suffix.length - 1).trimEnd();
        stripped = true;
        break;
      }
    }
  }
  return rest.replace(/\s+/g, '');
}

/** A title for the cross-source dedupe: lower case, punctuation as spaces, whitespace collapsed. */
export function normalizeJobTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A description's text as hashed for `content_hash`: whitespace runs as one space, ends trimmed, nothing else. */
export function normalizeJobText(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}
