import { canonicalJobUrl } from '@tailorit/shared';
import { addablePosting, parseAtsUrl, type AddablePosting } from '@tailorit/shared/autofill';
import { boardOfAddress } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import { isOptedOut } from '../../../core/http/reader/read';
import { OutboundRefusedError } from '../../../core/http/outbound';
import { ADD_JOB_FETCH_TIMEOUT_MS, boardSourceOfPosting, storeReadPosting } from '../../autofill/jobs';
import { registrableDomain } from '../../companies/domain';
import { parseSitePage } from '../../companies/site/page';
import { GREENHOUSE_API } from '../../ingest/adapters/greenhouse';
import { isRecord, nameFromSlug } from '../../ingest/adapters/common';
import { ashbyBoardListing } from '../../ingest/boards/ashby'; // v381 INT-2
import { linkFeedCache, untilAborted } from '../../ingest/boards/feed-cache';
import { pageJobPosting } from '../../ingest/career/jsonld';
import {
  embeddedBoardOfSource,
  embeddedBoardsOf,
  embeddedLinkSiteOf,
  lockSites,
  noteEmbeddedMisses,
  rememberEmbeddedBoard,
  type EmbeddedKind,
  type EmbeddedVia,
} from '../../ingest/embedded-boards';
import { HostHeldError, IngestHttpError, type HttpAnswer } from '../../ingest/http';
import { ghjidKeyOf, keysOfAddress, tidyKeys } from '../../ingest/keys';
import { fetchPosting, type AshbyBoardReads, type PostingAnswer } from '../../ingest/postings';
import { RobotsRefusal } from '../../ingest/robots';
import { requireIngest } from '../../ingest/service';
import { termsRefusalOfPosting } from '../../ingest/terms';
import { IngestError, PostingUnreadableError, type RawPosting } from '../../ingest/types';
import { sharedAddress } from './address';
import { boardLinkFailure } from './board-link';
import type { JobPageFetch, PageJobRead, PageReadOptions } from './page';

// v3.8.1 EMBED (SP v381 REQUEST, PLAN E1-E6): a job link on a company's own site that shows a Greenhouse or Ashby job
// board inside its page (https://<site>/jobs/<id>?gh_jid=<id>, https://<site>/careers?ashby_jid=<uuid>) is read from
// that board, never as a page alone. Every path that reads a job's link comes here through jobs/add/page.ts
// readPageToSharedJob (Add job, Add by link, imports and the link queue, the MCP tool, the extension's add and From page,
// Retry read, the re-checks, an admin's approval), after the terms gate and the board kinds' own links.
//   E1 The link: a host that is no platform's (a company's own site), naming a posting in ?gh_jid=<digits> or
//      ?ashby_jid=<uuid> (any case, any other parameters; its canonical form keeps only those, as today). v381 FIX
//      (SP v381 FIXES-381 G4): a site on crawl_opt_outs is never read this way either: the opt-out's answer, no request.
//   E3 The board: the site's remembered boards first (ingest/embedded-boards.ts, the most recently confirmed first, at
//      most EMBEDDED_BOARD_CONFIRMS - 1 of them: one confirmation is kept for the page's board); one that holds the
//      posting answers with no read of the page. Else ONE read of the link's page through the shared reader
//      (jobs/add/page.ts fetchJobPage: ADD_JOB_PAGE_READ, the identity, opt-outs, holds, robots.txt, pace, redirects on
//      the same site), its raw HTML scanned (never run) for the boards it shows or links to (scanEmbeddedBoardRefs), and
//      the boards not asked yet asked (the page's, then remembered ones step 1 did not reach), up to
//      EMBEDDED_BOARD_CONFIRMS in all. The page read is handed back, so a page that
//      names no board TailorIT can confirm is read for its JobPosting as today with no second request.
//   E4 Confirming: the board's own posting address (job-boards.greenhouse.io/<b>/jobs/<id>, jobs.ashbyhq.com/<b>/<uuid>)
//      through parseAtsUrl and addablePosting (a board name of the platform's shape), its terms gate, then the board's
//      public API (ingest/postings.ts fetchPosting, the ingest client: pace, robots.txt, holds; v381 FIX (REVIEW381-beh
//      M1): an Ashby board's whole list through the process's feed cache, read again fresh once before a posting it lacks
//      counts as absent). Found: the board is confirmed (remembered beside the site's others, its misses back to 0) and
//      the posting stored under the board's source (made off: today's flow; autofill/jobs.ts storeReadPosting), its keys
//      the company link's and the board's posting's (`link`, `ats`, Greenhouse's `ghjid`), so the board's own link, a
//      later run of the board and the company's link are one job. v381 FIX (G2): its Apply link is always the board's
//      own address of the posting (Greenhouse's absolute_url, which the board may place on the company's site; Ashby's
//      jobUrl); the person's link is a key only. Try later or can't read: that verdict, nothing written.
//   v381 FIX (SP v381 FIXES-381 G1; REVIEW381-beh H1, REVIEW381-ux HIGH-1): Greenhouse and Ashby ids are global, so a
//      board that answers "not here" says only that the posting is not its own: a posting is closed only when the link's
//      page (read then) shows a board (its embed, or an address of the posting itself), every board the page names was
//      asked, and the board it shows answers the posting gone while it answers itself (Greenhouse's board resource; an
//      Ashby board's list). A page that shows no board it could confirm gives today's answer from that page (never
//      closed). A remembered board misses a link only when the page no longer names it (noteEmbeddedMisses).
//   v381 FIX (G7): a posting whose board names no company (Ashby's: the board's slug), read after the page was, is named
//      by the page's own organisation name (its JSON-LD Organization or hiringOrganization, else og:site_name) when that
//      name spells the board's own name (pageCompanyName: never another company's name a page claims), and the board's
//      source keeps it; a known site's link (no page read) keeps the source's company; the slug is the last resort.
//   v381 FIX (G3): a board found from a person's link (Add job, the extension, MCP, a person's import, the queue) is a
//      source found on "A company's website" (discovered_via `company_site`): off, waiting for an admin.
// Nothing here turns a source on (v3.6's fence: only enableSources does); an admin turns the board's source on and its
// run brings the company's other jobs.

/** A job link on a company's own site naming an embedded board's posting (E1). */
export interface EmbeddedLink {
  kind: EmbeddedKind;
  /** Greenhouse's job id (digits), or Ashby's posting id (a UUID, lower case). */
  externalId: string;
  /** The site (embedded-boards.ts embeddedSiteOf: the registrable domain, or a shared hosting suffix's whole host). */
  site: string;
  /** The link's canonical shared form (no secret parameter): one of the job's keys (v381 FIX G2: never its Apply link). */
  link: string;
}

/** The embedded board's posting a company page's link names (E1), or null for any other link. */
export function embeddedLinkOf(url: string): EmbeddedLink | null {
  const found = embeddedLinkSiteOf(url);
  if (!found) return null;
  let href: string;
  try {
    href = new URL(url.trim()).href;
  } catch {
    return null;
  }
  const canonical = canonicalJobUrl(href);
  const link = canonical ? sharedAddress(canonical) : null;
  return link ? { ...found, link } : null;
}

/** The board's own address of the posting (E4), read by parseAtsUrl as the extension reads it. */
export function boardPostingUrl(kind: EmbeddedKind, board: string, externalId: string): string {
  return kind === 'greenhouse'
    ? `https://job-boards.greenhouse.io/${encodeURIComponent(board)}/jobs/${externalId}`
    : `https://jobs.ashbyhq.com/${encodeURIComponent(board)}/${externalId}`;
}

/** The posting on `board` TailorIT may read (a board name of the platform's shape), or null. */
export function embeddedPostingOf(link: Pick<EmbeddedLink, 'kind' | 'externalId'>, board: string): AddablePosting | null {
  const posting = addablePosting(parseAtsUrl(boardPostingUrl(link.kind, board, link.externalId)));
  return posting && posting.kind === link.kind && posting.externalId.toLowerCase() === link.externalId.toLowerCase() ? posting : null;
}

// ------------------------------------------------------------------------------------------------ E3: the page's boards

/** The platforms' addresses in a page (the iframe, the embed script, a link), after its escapes are read. */
const PLATFORM_ADDRESS = /(?:https?:)?\/\/((?:job-)?boards(?:\.eu)?\.greenhouse\.io|jobs\.ashbyhq\.com)(\/[^\s"'<>`\\()[\]{}|^]*)?/gi;

/** The page's text with the escapes an address is written in read (HTML entities, a script string's \/ and /). */
function unescapedForScan(html: string): string {
  return html
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:#x0*2f|#0*47|sol);/gi, '/')
    .replace(/&(?:#x0*26|#0*38);/gi, '&')
    .replace(/&(?:#x0*3d|#0*61|equals);/gi, '=')
    .replace(/&(?:#x0*3f|#0*63|quest);/gi, '?');
}

/** One board a page names (scanEmbeddedBoardRefs). */
export interface EmbeddedBoardRef {
  board: string;
  /** An address of the page names the link's own posting (Greenhouse's job_app `token=<id>`, an address with Ashby's id). */
  own: boolean;
  /**
   * v381 FIX (G1): the page shows the board itself: its embed (Greenhouse's /embed/ iframe or script, Ashby's
   * /<board>/embed script), not a plain link to the board's pages (a partner's board, a sister company's).
   */
  embed: boolean;
}

/**
 * The boards of `kind` a page's raw HTML embeds or links to (E3), each once (case aside), in the order the page names
 * them, a board whose address names the link's own posting first (Greenhouse's job_app iframe `token=<id>`, an Ashby
 * address with the posting's id): Greenhouse's embed (job_app, job_board, job_board/js: `for=<board>`) and board
 * pages on its hosts (the EU twins too); Ashby's embed script (jobs.ashbyhq.com/<board>/embed) and board pages. Each
 * name as the board registry reads it (boardOfAddress); its shape is checked when it is confirmed (embeddedPostingOf).
 */
export function scanEmbeddedBoardRefs(html: string, link: Pick<EmbeddedLink, 'kind' | 'externalId'>): EmbeddedBoardRef[] {
  const text = unescapedForScan(html);
  const named: Array<EmbeddedBoardRef & { at: number }> = [];
  for (const match of text.matchAll(PLATFORM_ADDRESS)) {
    const host = match[1]!.toLowerCase();
    if ((link.kind === 'greenhouse') !== host.endsWith('greenhouse.io')) continue;
    const address = `https://${host}${match[2] ?? ''}`;
    const found = boardOfAddress(address);
    if (!found || found.kind !== link.kind) continue;
    const key = found.name.toLowerCase();
    let own = false;
    let embed = false;
    try {
      const url = new URL(address);
      own = link.kind === 'greenhouse' ? url.searchParams.get('token') === link.externalId : url.pathname.toLowerCase().includes(link.externalId.toLowerCase());
      if (link.kind === 'greenhouse' && !own) own = url.pathname.replace(/\/+$/, '').endsWith(`/jobs/${link.externalId}`);
      embed = link.kind === 'greenhouse' ? /^\/embed\//i.test(url.pathname) : /^\/[^/]+\/embed(?:\/|$)/i.test(url.pathname);
    } catch {
      own = false;
    }
    const known = named.find((entry) => entry.board.toLowerCase() === key);
    if (known) {
      known.own ||= own;
      known.embed ||= embed;
      continue;
    }
    named.push({ board: found.name, own, embed, at: match.index ?? 0 });
  }
  return named.sort((a, b) => Number(b.own) - Number(a.own) || a.at - b.at).map(({ board, own, embed }) => ({ board, own, embed }));
}

/** The boards scanEmbeddedBoardRefs reads, by name (see there). */
export function scanEmbeddedBoards(html: string, link: Pick<EmbeddedLink, 'kind' | 'externalId'>): string[] {
  return scanEmbeddedBoardRefs(html, link).map((ref) => ref.board);
}

// ------------------------------------------------------------------------------------- G7: the company the page names

/** Words a company's name or board may end with that do not change whose it is ("Inc", "Careers", "HQ"). */
const NAME_TAIL_WORDS = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'gmbh', 'ag', 'sa', 'sas', 'bv', 'nv', 'plc', 'pty', 'corp',
  'corporation', 'co', 'company', 'careers', 'career', 'jobs', 'hq', 'hiring', 'team',
]);

/** A name's letters and digits, word by word, without the tail words above or a leading "the". */
function nameCore(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && NAME_TAIL_WORDS.has(words[words.length - 1]!)) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join('');
}

/** Whether a name a page gives spells the board's own name ("Velvet Harbor, Inc." for velvet-harbor: yes). */
export function spellsBoardName(name: string, board: string): boolean {
  const core = nameCore(name);
  return core.length >= 2 && core === nameCore(board);
}

/**
 * v381 FIX (G7): the company a page names for itself (its JSON-LD Organization's name, a JobPosting's hiringOrganization
 * name, else og:site_name), only when it spells `board`'s own name: a page never names another company for a board's
 * posting (a page on any site may embed any board). Null for none.
 */
export function pageCompanyName(html: string, pageUrl: string, board: string): string | null {
  let site: ReturnType<typeof parseSitePage> | null = null;
  try {
    site = parseSitePage(html, pageUrl);
  } catch {
    site = null;
  }
  const hiring = pageJobPosting(html, pageUrl)?.hiringOrganization?.name ?? null;
  for (const candidate of [site?.organization?.name, hiring, site?.siteName]) {
    const name = (candidate ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (name && spellsBoardName(name, board)) return name;
  }
  return null;
}

// --------------------------------------------------------------------------------------------- E4: confirm, then read

/** What asking one board about the link's posting came to. */
type Confirmation =
  | {
      kind: 'found';
      posting: AddablePosting;
      raw: RawPosting;
      listedCompany: string | undefined;
      /** v381 FIX (G7): the board (its posting, or its source's companyName) names the company. */
      named: boolean;
    }
  /** The board lists it, but not publicly (an Ashby posting reached by its own link only): the board is the site's. */
  | { kind: 'unlisted' }
  /** The board answered without the posting (Greenhouse's 404 on the posting; an Ashby board's list without it). */
  | { kind: 'absent' }
  /** No such board (an Ashby board's 404, a name of no board's shape, a 404 or 410 the client threw). */
  | { kind: 'gone' }
  /** Try later or can't read: the verdict, nothing written. */
  | { kind: 'failed'; read: PageJobRead };

interface ReadContext {
  signal: AbortSignal;
  /** The Ashby board lists this link's read uses (each through the process's feed cache: primeAshbyList). */
  ashbyBoards: AshbyBoardReads;
  /** v381 FIX (M1): the boards (lower case) whose list was one kept from another link's read. */
  reusedLists: Set<string>;
  /** Retry read and Edit job's read: no kept list (PageReadOptions.freshFeed). */
  freshFeed: boolean;
  /** Confirmations left (EMBEDDED_BOARD_CONFIRMS). */
  left: number;
}

/**
 * v381 FIX (REVIEW381-beh M1): an Ashby board's whole list for this read, through the process's feed cache (boards/
 * feed-cache.ts linkFeedCache, keyed `ashby:<board>`: one read a board within BOARD_FEED_CACHE_SECONDS, whatever the
 * links); `fresh` reads it again. The shared read carries no caller's signal; this read waits for it under its own.
 */
function primeAshbyList(deps: AppDeps, posting: AddablePosting, ctx: ReadContext, fresh: boolean): void {
  const key = posting.board.toLowerCase();
  if (!fresh && ctx.ashbyBoards.has(key)) return;
  const http = requireIngest(deps).http;
  // v381 INT-2: the listing read the direct link's read shares (boards/ashby.ts ashbyBoardListing: a non-board answer is never kept)
  const hit = linkFeedCache(deps).lookup(`ashby:${key}`, () => ashbyBoardListing(http, posting), { fresh: fresh || ctx.freshFeed });
  if (hit.reused) ctx.reusedLists.add(key);
  else ctx.reusedLists.delete(key);
  ctx.ashbyBoards.set(key, untilAborted(hit.value as Promise<HttpAnswer>, ctx.signal));
}

/** Asks `board` about the link's posting (E4): one read of the board's API, after its terms. */
async function confirmOn(deps: AppDeps, link: EmbeddedLink, board: string, ctx: ReadContext): Promise<Confirmation> {
  ctx.left -= 1;
  const posting = embeddedPostingOf(link, board);
  if (!posting) return { kind: 'gone' };
  // v37 FIX-37B (E2): a board whose source's terms an admin recorded as not allowing automated access is never read.
  if (await termsRefusalOfPosting(deps.db, posting)) return { kind: 'failed', read: { kind: 'unreadable', reason: 'terms' } };
  const ingest = requireIngest(deps);
  let answer: PostingAnswer;
  let config: Record<string, unknown> | undefined;
  try {
    config = (await boardSourceOfPosting(deps.db, posting))?.config;
    const read = () => fetchPosting(ingest.http, posting, { config, signal: ctx.signal, boards: ctx.ashbyBoards });
    if (link.kind === 'ashby') primeAshbyList(deps, posting, ctx, false);
    answer = await read();
    // v381 FIX (M1, v38 FIX-C's rule): a posting missing from a list kept from another link's read is no sign it is
    // gone (the list may be older than it): the list is read again (fresh) once.
    if (link.kind === 'ashby' && !answer.found && ctx.reusedLists.has(posting.board.toLowerCase())) {
      primeAshbyList(deps, posting, ctx, true);
      answer = await read();
    }
  } catch (error) {
    if (error instanceof IngestHttpError && (error.status === 404 || error.status === 410)) return { kind: 'gone' };
    // Never the error's own text: it holds the board's API address.
    const known = [RobotsRefusal, HostHeldError, IngestHttpError, IngestError, OutboundRefusedError, PostingUnreadableError].some((type) => error instanceof type);
    if (!known && !ctx.signal.aborted) deps.log.warn(`[jobs] a company page's ${link.kind} board could not be read`, error instanceof Error ? error.name : 'unknown');
    return { kind: 'failed', read: boardLinkFailure(error, ctx.signal, link.kind) };
  }
  if (answer.found) {
    const sourceNamed = typeof config?.companyName === 'string' && config.companyName.trim() !== '';
    const named = sourceNamed || answer.raw.company.name !== nameFromSlug(posting.board);
    return { kind: 'found', posting, raw: answer.raw, listedCompany: answer.listedCompany, named };
  }
  if (answer.unlisted) return { kind: 'unlisted' };
  if (link.kind === 'ashby') {
    const list = await ctx.ashbyBoards.get(posting.board.toLowerCase())?.catch(() => null);
    return list?.status === 404 ? { kind: 'gone' } : { kind: 'absent' };
  }
  return { kind: 'absent' };
}

/**
 * Whether a Greenhouse board itself answers (its board resource, /v1/boards/<token>): a 404 of one posting on a board
 * that answers is the board's own word that the posting is gone. Null when it could not be asked now (with the verdict).
 */
async function greenhouseBoardAnswers(deps: AppDeps, board: string, ctx: ReadContext): Promise<boolean | { failed: PageJobRead }> {
  try {
    const answer = await requireIngest(deps).http.getJson(`${GREENHOUSE_API}/${encodeURIComponent(board)}`, { signal: ctx.signal, allow: [404] });
    return answer.status !== 404 && isRecord(answer.data);
  } catch (error) {
    if (error instanceof IngestHttpError && (error.status === 404 || error.status === 410)) return false;
    return { failed: boardLinkFailure(error, ctx.signal, 'greenhouse') };
  }
}

/**
 * The posting as the board's API read it, kept as the company's job (E4): its keys the company link's (`link`), the API's
 * own link's, the board's posting address's (`link`, `ats`) and, for Greenhouse, the site's `ghjid` key (ingest/keys.ts:
 * `<site>:<id>`, as a career page's ?gh_jid= is keyed). v381 FIX (SP v381 FIXES-381 G2; REVIEW381-beh H2): its Apply link
 * is always the board's own address of the posting (Greenhouse's absolute_url, on the company's site when the board puts
 * it there; Ashby's jobUrl), never the person's link, which is a key only (any path, subdomain or kept parameter of it
 * could otherwise become a shared job's Apply link).
 */
export function embeddedRaw(raw: RawPosting, link: EmbeddedLink, posting: AddablePosting): RawPosting {
  const domain = registrableDomain(link.link);
  const ghjid = link.kind === 'greenhouse' && domain ? ghjidKeyOf(domain, link.externalId) : null;
  const keys = tidyKeys([
    ...(raw.keys ?? []),
    ...keysOfAddress(link.link),
    ...keysOfAddress(raw.url),
    ...keysOfAddress(boardPostingUrl(posting.kind as EmbeddedKind, posting.board, posting.externalId)),
    ...(ghjid ? [{ kind: 'ghjid' as const, key: ghjid }] : []),
  ]);
  return { ...raw, keys };
}

/** What readEmbeddedBoardLink came to: the board's answer, or today's page read (the page this read made, or none). */
export type EmbeddedRead = { kind: 'read'; read: PageJobRead } | { kind: 'page'; page: JobPageFetch | null };

/**
 * Remembers a confirmed board and counts the misses of those that did not hold the link (and whose page no longer names
 * them: G1), in one transaction that takes the site's lock first (v381 FIX L1: lockSites).
 */
async function settleMemory(
  deps: AppDeps,
  link: EmbeddedLink,
  confirmed: { board: string; via: EmbeddedVia } | null,
  missed: readonly string[],
): Promise<void> {
  const others = missed.filter((board) => board.toLowerCase() !== confirmed?.board.toLowerCase());
  if (!confirmed && others.length === 0) return;
  const constants = constantsOf(deps);
  const at = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      await lockSites(t, [{ site: link.site, kind: link.kind }]);
      if (confirmed) {
        await rememberEmbeddedBoard(t, {
          site: link.site,
          kind: link.kind,
          board: confirmed.board,
          via: confirmed.via,
          link: link.link,
          at,
          perSite: constants.get('EMBEDDED_BOARDS_PER_SITE'),
        });
      }
      await noteEmbeddedMisses(t, link.site, link.kind, others, constants.get('EMBEDDED_BOARD_MISSES'));
    },
    { label: 'add job: a company page board' },
  );
}

/** Stores the found posting (E4) and answers its job; `pageName` the company the read page names (G7), or null. */
async function storeFound(
  deps: AppDeps,
  link: EmbeddedLink,
  found: Extract<Confirmation, { kind: 'found' }>,
  options: PageReadOptions,
  pageName: string | null,
): Promise<PageJobRead> {
  // v381 FIX (G7): a board that names no company: the page's own name for it (it spells the board's), else the slug.
  const companyName = !found.named && pageName ? pageName : null;
  const read = companyName ? { ...found.raw, company: { ...found.raw.company, name: companyName } } : found.raw;
  const raw = embeddedRaw(read, link, found.posting);
  const stored = await storeReadPosting(deps, found.posting, raw, found.listedCompany, {
    ...(options.importRead ? { importRead: options.importRead } : {}),
    ...(options.approved ? { approved: true } : {}),
    // v381 FIX (G3): a person's link found the board on a company's website (an admin import's read marks it its own).
    ...(options.importRead ? {} : { foundOnCompanySite: true }),
    ...(companyName ? { sourceCompanyName: companyName } : {}), // v381 FIX (G7)
  });
  const job = await deps.db.one<{ held: boolean }>('SELECT held_since IS NOT NULL AS held FROM jobs WHERE id = ?', [stored.jobId]);
  return { kind: 'shared', jobId: stored.jobId, created: stored.created, held: job?.held === true };
}

/**
 * Reads a company page's job link from the board its site embeds (see the top). Null for any other link (the caller
 * reads it as today). Otherwise the board's answer, or `page`: no board held the posting, and the caller reads the page
 * for its JobPosting from `page` (the read made here) or, when none was made, reads it itself. `fetchPage` is
 * jobs/add/page.ts fetchJobPage (the shared reader's one read). Outside any transaction.
 */
export async function readEmbeddedBoardLink(
  deps: AppDeps,
  url: string,
  options: PageReadOptions,
  fetchPage: (url: string) => Promise<JobPageFetch>,
): Promise<EmbeddedRead | null> {
  const link = embeddedLinkOf(url);
  if (!link) return null;
  deps.db.assertNoTx('reading a company page board');
  // v381 FIX (G4; REVIEW381-beh owner 2): a site on crawl_opt_outs is never read through its board either: the opt-out's
  // answer, as the page read gives it, with no request.
  if (await isOptedOut(deps.db, new URL(link.link).hostname.toLowerCase())) return { kind: 'read', read: { kind: 'unreadable', reason: 'opted_out' } };
  const confirms = constantsOf(deps).get('EMBEDDED_BOARD_CONFIRMS');
  const ctx: ReadContext = {
    signal: AbortSignal.timeout(options.timeoutMs ?? ADD_JOB_FETCH_TIMEOUT_MS),
    ashbyBoards: new Map(),
    reusedLists: new Set(),
    freshFeed: options.freshFeed === true,
    left: confirms,
  };
  /** Each board asked (lower case) and its answer when it did not hold the posting. */
  const answers = new Map<string, 'absent' | 'gone'>();

  // 1. The site's remembered boards (no page read), one confirmation kept for the page's board (G1).
  const remembered = await embeddedBoardsOf(deps.db, link.site, link.kind);
  const firstLeft = Math.max(1, confirms - 1);
  for (const entry of remembered.slice(0, firstLeft)) {
    if (ctx.left <= 0) break;
    const answer = await confirmOn(deps, link, entry.board, ctx);
    if (answer.kind === 'found' || answer.kind === 'unlisted') {
      await settleMemory(deps, link, { board: entry.board, via: entry.confirmedVia }, []);
      return { kind: 'read', read: answer.kind === 'found' ? await storeFound(deps, link, answer, options, null) : { kind: 'unreadable', reason: 'unlisted' } };
    }
    if (answer.kind === 'failed') return { kind: 'read', read: answer.read };
    answers.set(entry.board.toLowerCase(), answer.kind);
  }

  // 2. One read of the page (G1: also when every remembered board answered "not here"), scanned for the boards it names.
  const page = await fetchPage(url);
  if (page.kind !== 'page') return { kind: 'page', page };
  const refs = scanEmbeddedBoardRefs(page.html, link);
  const named = new Set(refs.map((ref) => ref.board.toLowerCase()));
  // A remembered board that did not hold the link misses it only when its page no longer names the board (G1).
  const missed = () => remembered.filter((entry) => answers.has(entry.board.toLowerCase()) && !named.has(entry.board.toLowerCase())).map((entry) => entry.board);
  // The page's boards not asked yet, then (with confirmations left) the remembered ones step 1 did not reach: a site's
  // page that names none of its boards (a script-only embed) is still read from a board a run named.
  const toAsk = [
    ...refs.map((ref) => ({ board: ref.board, via: 'page' as EmbeddedVia, onPage: true })),
    ...remembered.map((entry) => ({ board: entry.board, via: entry.confirmedVia, onPage: false })),
  ];
  let unasked = false;
  for (const next of toAsk) {
    const key = next.board.toLowerCase();
    if (answers.has(key)) continue;
    if (ctx.left <= 0) {
      if (next.onPage) unasked = true;
      break;
    }
    const answer = await confirmOn(deps, link, next.board, ctx);
    if (answer.kind === 'found' || answer.kind === 'unlisted') {
      await settleMemory(deps, link, { board: next.board, via: next.via }, missed());
      if (answer.kind === 'unlisted') return { kind: 'read', read: { kind: 'unreadable', reason: 'unlisted' } };
      const pageName = answer.named ? null : pageCompanyName(page.html, page.finalUrl, answer.posting.board);
      return { kind: 'read', read: await storeFound(deps, link, answer, options, pageName) };
    }
    if (answer.kind === 'failed') {
      await settleMemory(deps, link, null, missed());
      return { kind: 'read', read: answer.read };
    }
    answers.set(key, answer.kind);
  }
  await settleMemory(deps, link, null, missed());

  // Closed only by a board the page shows (its embed, or an address of this posting) answering the posting gone while it
  // answers itself, once every board the page names was asked (G1).
  if (!unasked) {
    for (const ref of refs) {
      if (!(ref.embed || ref.own) || answers.get(ref.board.toLowerCase()) !== 'absent') continue;
      const itself = link.kind === 'greenhouse' ? await greenhouseBoardAnswers(deps, ref.board, ctx) : true;
      if (typeof itself === 'object') return { kind: 'read', read: itself.failed };
      if (itself) return { kind: 'read', read: { kind: 'closed' } };
    }
  }
  return { kind: 'page', page };
}

/**
 * The board a company page's link is remembered with, as a closed link offers it (v3.7 C7): its site's one remembered
 * board of the link's kind; null for none, or (v381 FIX, REVIEW381-beh L5) when the site has several (which one holds the
 * link is unknown).
 */
export async function embeddedBoardOfLink(deps: Pick<AppDeps, 'db'>, url: string): Promise<{ kind: EmbeddedKind; name: string } | null> {
  const link = embeddedLinkOf(url);
  if (!link) return null;
  const boards = await embeddedBoardsOf(deps.db, link.site, link.kind);
  return boards.length === 1 ? { kind: link.kind, name: boards[0]!.board } : null;
}

/**
 * v381 FIX (REVIEW381-beh L5): the board a company page's link landed on: the board of the job's own Greenhouse or Ashby
 * source (the read stored it there), or null for another link or a job no such board keeps.
 */
export async function embeddedBoardOfJob(deps: Pick<AppDeps, 'db'>, url: string, jobId: number): Promise<{ kind: EmbeddedKind; name: string } | null> {
  const link = embeddedLinkOf(url);
  if (!link) return null;
  const rows = await deps.db.all<{ kind: string; config: unknown }>(
    'SELECT s.kind, s.config FROM job_source_links l JOIN job_sources s ON s.id = l.source_id WHERE l.job_id = ? AND s.kind = ? ORDER BY s.id',
    [jobId, link.kind],
  );
  for (const row of rows) {
    const config = typeof row.config === 'string' ? (JSON.parse(row.config) as Record<string, unknown>) : ((row.config ?? {}) as Record<string, unknown>);
    const board = embeddedBoardOfSource({ kind: row.kind as never, config });
    if (board) return { kind: board.kind, name: board.board };
  }
  return null;
}
