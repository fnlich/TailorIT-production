import { nowIso, type AppDeps } from '../../../core/context';
import { assertNewReadAllowed } from '../../../core/http/identity';
import type { IngestHttp } from '../http';
import { requireIngest } from '../service';
import { boardOfUrl, type FoundBoard } from './boards';
import { offerToDiscovery } from './offer';
import { lockState, readState, writeState } from './state';

// v30 S2: Common Crawl, discovery's third signal (docs/design/part2/12-job-sourcing.md §3.9, §4.1 signal 3): the
// newest monthly crawl's URL index is asked, host by host, for the addresses it saw on the board kinds' hosts, and each
// address's board (boards.ts boardOfUrl) is offered as a `common_crawl` candidate. Only that a URL exists is learned:
// no page text is read or kept (12 §3.9's terms). A board found here is only a candidate; validation reads it from
// its own ATS (validate.ts).
//
// The index is read through its CDX API (index.commoncrawl.org: `?url=<host>/&matchType=prefix|domain&output=json
// &fl=url`, `showNumPages=true` first, then `page=0..n-1`). The design names the columnar index (Athena or DuckDB) for
// bulk use; neither is a dependency of TailorIT, so the CDX API is read instead, gently: a few pages a pass
// (COMMON_CRAWL_PAGES_PER_PASS), a pass at most every COMMON_CRAWL_PASS_EVERY_MS, one request at a time at the host's
// pace, robots.txt first (the ingest client), a new crawl looked for once a week. Its progress (the crawl, the query, the
// page) is kept in discovery_state 'common_crawl', so a pass goes on where the last stopped, across restarts.
//
// A NEW kind of outside read: it runs only once BOT_USER_AGENT is set (assertNewReadAllowed 'common_crawl') and reads
// with that identity (the ingest service's botHttp), and only while INGEST_ENABLED.

/** Common Crawl's index server. */
export const COMMON_CRAWL_INDEX = 'https://index.commoncrawl.org';
/** Its host: the only one a crawl's CDX address may name. */
const COMMON_CRAWL_HOST = 'index.commoncrawl.org';
/** discovery_state's key. */
export const COMMON_CRAWL_STATE = 'common_crawl';
/** Index pages one pass reads. */
export const COMMON_CRAWL_PAGES_PER_PASS = 3;
/** The least time between two passes. */
export const COMMON_CRAWL_PASS_EVERY_MS = 5 * 60_000;
/** How often a finished crawl's index list is read again for a newer crawl. */
export const COMMON_CRAWL_RECHECK_MS = 7 * 86_400_000;
/** The largest index page read (a page of the CDX API holds some thousands of lines). */
const PAGE_MAX_BYTES = 32 * 1024 * 1024;

/** One question to the index: a host's addresses (prefix) or every subdomain of a domain (domain). */
export interface CrawlQuery {
  url: string;
  match: 'prefix' | 'domain';
}

/** The board kinds' hosts, asked in this order (boards.ts reads the boards from their addresses). */
export const COMMON_CRAWL_QUERIES: readonly CrawlQuery[] = [
  { url: 'boards.greenhouse.io/', match: 'prefix' },
  { url: 'job-boards.greenhouse.io/', match: 'prefix' },
  { url: 'boards.eu.greenhouse.io/', match: 'prefix' },
  { url: 'job-boards.eu.greenhouse.io/', match: 'prefix' },
  { url: 'jobs.lever.co/', match: 'prefix' },
  { url: 'jobs.eu.lever.co/', match: 'prefix' },
  { url: 'jobs.ashbyhq.com/', match: 'prefix' },
  { url: 'apply.workable.com/', match: 'prefix' },
  { url: 'myworkdayjobs.com', match: 'domain' },
  { url: 'myworkdaysite.com', match: 'domain' },
  { url: 'jobs.personio.de', match: 'domain' },
  { url: 'jobs.personio.com', match: 'domain' },
  { url: 'recruitee.com', match: 'domain' },
  { url: 'breezy.hr', match: 'domain' },
  { url: 'bamboohr.com', match: 'domain' },
  // v37 BOARDS (SP v37 PLAN I5): employers' iCIMS sites (boards.ts reads their boards; iCIMS's own hosts are none). Last,
  // so a crawl's progress through the earlier queries keeps its place.
  { url: 'icims.com', match: 'domain' },
];

/** The progress through the newest crawl. */
export interface CrawlState {
  /** The crawl's id (CC-MAIN-2026-43), its CDX address; null before the first look. */
  crawl: string | null;
  cdx: string | null;
  /** The query (COMMON_CRAWL_QUERIES' index) and page read next; its page count once asked. */
  query: number;
  page: number;
  pages: number | null;
  /** Every query of the crawl read. */
  done: boolean;
  /** When the index list was last read; when the last pass ran; when the crawl was finished. */
  listedAt: string | null;
  passAt: string | null;
  finishedAt: string | null;
}

export const NO_CRAWL: CrawlState = { crawl: null, cdx: null, query: 0, page: 0, pages: null, done: true, listedAt: null, passAt: null, finishedAt: null };

/** What a pass did. */
export interface CrawlPass {
  requests: number;
  pages: number;
  /** Addresses read and boards offered (each once per page), new candidates among them. */
  urls: number;
  offered: number;
  added: number;
  /** Why it read nothing: too soon after the last pass, nothing new to read. */
  idle?: 'too_soon' | 'up_to_date';
}

const sameStep = (a: CrawlState, b: CrawlState) => a.crawl === b.crawl && a.query === b.query && a.page === b.page && a.done === b.done;

/** A crawl's CDX address from the index list's entry, when it is on Common Crawl's index host. */
function cdxOf(entry: unknown): { id: string; cdx: string } | null {
  if (!entry || typeof entry !== 'object') return null;
  const { id, 'cdx-api': cdx } = entry as Record<string, unknown>;
  if (typeof id !== 'string' || !/^CC-MAIN-\d{4}-\d{2}$/.test(id) || typeof cdx !== 'string') return null;
  try {
    const url = new URL(cdx);
    return url.protocol === 'https:' && url.hostname === COMMON_CRAWL_HOST ? { id, cdx: url.toString() } : null;
  } catch {
    return null;
  }
}

/** The address of one question to a crawl's index: its page count (`pages`) or one page. */
export function crawlQueryUrl(cdx: string, query: CrawlQuery, page: number | 'count'): string {
  const params = new URLSearchParams({ url: query.url, matchType: query.match, output: 'json', fl: 'url' });
  if (page === 'count') params.set('showNumPages', 'true');
  else params.set('page', String(page));
  return `${cdx}?${params.toString()}`;
}

/** The boards an index page's lines name ({"url": ...} per line), each once. */
export function boardsOfIndexPage(text: string): { urls: number; boards: FoundBoard[] } {
  const boards = new Map<string, FoundBoard>();
  let urls = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let url: unknown;
    try {
      url = (JSON.parse(trimmed) as { url?: unknown }).url;
    } catch {
      continue;
    }
    if (typeof url !== 'string') continue;
    urls += 1;
    const board = boardOfUrl(url);
    if (board) boards.set(`${board.kind}:${board.name}`, board);
  }
  return { urls, boards: [...boards.values()] };
}

/** One Common Crawl pass (see the top). Throws NewReadRefusedError (nothing sent) while BOT_USER_AGENT is a placeholder. */
export async function commonCrawlPass(deps: AppDeps, options: { http?: IngestHttp; signal?: AbortSignal; force?: boolean } = {}): Promise<CrawlPass> {
  const pass: CrawlPass = { requests: 0, pages: 0, urls: 0, offered: 0, added: 0 };
  assertNewReadAllowed(deps, 'common_crawl');
  if (!deps.config.ingest.enabled) return pass;
  const http = options.http ?? requireIngest(deps).botHttp;
  const nowMs = () => deps.now().getTime();
  let state: CrawlState = { ...NO_CRAWL, ...((await readState<Partial<CrawlState>>(deps.db, COMMON_CRAWL_STATE)) ?? {}) };
  if (!options.force && state.passAt && nowMs() - Date.parse(state.passAt) < COMMON_CRAWL_PASS_EVERY_MS) return { ...pass, idle: 'too_soon' };

  /** Moves the progress from `from` to `to` (with this page's offers), unless another pass moved it meanwhile. */
  const advance = async (from: CrawlState, to: CrawlState, boards: readonly FoundBoard[]): Promise<boolean> =>
    deps.db.tx(
      async (t) => {
        const at = nowIso(deps);
        const current = await lockState<CrawlState>(t, COMMON_CRAWL_STATE, NO_CRAWL, at);
        if (!sameStep(current, from)) return false;
        for (const board of boards) {
          const offered = await offerToDiscovery(deps, t, { kind: board.kind, name: board.name, via: 'common_crawl', at });
          pass.offered += 1;
          if (offered.outcome === 'added') pass.added += 1;
        }
        await writeState(t, COMMON_CRAWL_STATE, { ...to, passAt: at }, at);
        return true;
      },
      { label: 'discovery common crawl' },
    );

  if (state.done) {
    if (!options.force && state.listedAt && nowMs() - Date.parse(state.listedAt) < COMMON_CRAWL_RECHECK_MS) {
      await writeState(deps.db, COMMON_CRAWL_STATE, { ...state, passAt: nowIso(deps) }, nowIso(deps));
      return { ...pass, idle: 'up_to_date' };
    }
    pass.requests += 1;
    const list = await http.getJson(`${COMMON_CRAWL_INDEX}/collinfo.json`, { signal: options.signal });
    const newest = Array.isArray(list.data) ? cdxOf(list.data[0]) : null;
    const at = nowIso(deps);
    const next: CrawlState =
      newest && newest.id !== state.crawl
        ? { ...NO_CRAWL, crawl: newest.id, cdx: newest.cdx, done: false, listedAt: at }
        : { ...state, listedAt: at };
    if (!(await advance(state, next, []))) return pass;
    if (next.done) return { ...pass, idle: 'up_to_date' };
    deps.log.info(`[discovery] Common Crawl: reading ${next.crawl}'s index for boards`);
    state = next;
  }

  for (let read = 0; read < COMMON_CRAWL_PAGES_PER_PASS && !state.done && !options.signal?.aborted; read += 1) {
    const query = COMMON_CRAWL_QUERIES[state.query];
    if (!query || !state.cdx) {
      const finished: CrawlState = { ...state, done: true, finishedAt: nowIso(deps) };
      if (!(await advance(state, finished, []))) break;
      state = finished;
      break;
    }
    if (state.pages === null) {
      pass.requests += 1;
      const answer = await http.getJson(crawlQueryUrl(state.cdx, query, 'count'), { signal: options.signal, allow: [404] });
      const pages = answer.status === 404 ? 0 : Number((answer.data as { pages?: unknown } | null)?.pages);
      const next: CrawlState = Number.isInteger(pages) && pages > 0 ? { ...state, pages } : { ...state, query: state.query + 1, page: 0, pages: null };
      if (!(await advance(state, next, []))) break;
      state = next;
      continue;
    }
    pass.requests += 1;
    const answer = await http.getJson(crawlQueryUrl(state.cdx, query, state.page), {
      signal: options.signal,
      allow: [404],
      text: true,
      maxBytes: PAGE_MAX_BYTES,
    });
    const found = answer.status === 404 ? { urls: 0, boards: [] } : boardsOfIndexPage(String(answer.data ?? ''));
    pass.pages += 1;
    pass.urls += found.urls;
    const last = state.page + 1 >= state.pages;
    const next: CrawlState = last ? { ...state, query: state.query + 1, page: 0, pages: null } : { ...state, page: state.page + 1 };
    if (!(await advance(state, next, found.boards))) break;
    state = next;
    if (state.query >= COMMON_CRAWL_QUERIES.length) {
      const finished: CrawlState = { ...state, done: true, finishedAt: nowIso(deps) };
      if (await advance(state, finished, [])) {
        state = finished;
        deps.log.info(`[discovery] Common Crawl: ${state.crawl}'s index read through`);
      }
    }
  }
  if (pass.offered > 0) deps.log.info(`[discovery] Common Crawl: ${pass.pages} index pages, ${pass.urls} addresses, ${pass.offered} boards offered, ${pass.added} new`);
  return pass;
}
