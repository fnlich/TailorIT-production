import { canonicalJobUrl } from '@tailorit/shared';
import { isLinkedInHost } from '@tailorit/shared/autofill';
import {
  ashbyBoard,
  greenhouseToken,
  type AdminEmbeddedSiteForgetResult,
  type AdminEmbeddedSiteRememberResult,
  type AdminEmbeddedSites,
} from '@tailorit/shared/sourcing';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { DbClient, DbQueries } from '../../core/db/types';
import { isCompanyDomain, registrableDomain, siteOfAddress } from '../companies/domain';
import { sharedAddress } from '../jobs/add/address';
import { ghJobIdOf } from './career/keys';
import { isBoardKindHost } from './career/platforms';
import { configString } from './boards/read-json';
import type { RawPosting, SourceRecord } from './types';

// v3.8.1 EMBED (SP v381 PLAN E2): the boards a company's own site embeds, remembered (embedded_boards, migration 0071).
// A careers page on the company's own site (https://<site>/jobs/<id>?gh_jid=<id>, https://<site>/careers?ashby_jid=
// <uuid>) shows a Greenhouse or Ashby job board inside it; its job links name the posting but never the board. Once a
// link's board is confirmed (jobs/add/embedded-board.ts: the posting read from the board's public API), the site is
// remembered with that board, so a later link of the site is read from the board at once, with no read of its page.
// - The site is the link's registrable domain, in lower case (on a shared hosting suffix its whole host: v381 FIX G5,
//   companies/domain.ts siteOfAddress), and only a company's own (isCompanyDomain: never an ATS's, a job board's or a
//   site builder's).
// - Written when a link is confirmed (`page`), and by a Greenhouse run (`posting_url`): a listed posting whose own link
//   is on another host and names its own id in ?gh_jid= is that site's job page of the board (rememberRunEmbeds).
// - At most EMBEDDED_BOARDS_PER_SITE boards a site and kind: the least recently confirmed goes first. A confirmation sets
//   a board's misses back to 0. v381 FIX (SP v381 FIXES-381 G1): a board misses a link only when it did not hold it and
//   the link's page (read then) no longer names it; at EMBEDDED_BOARD_MISSES misses in a row it is forgotten, unless a
//   Greenhouse run names the site (`posting_url`: a run's word is never undone by misses).
// - v381 FIX (G6): an admin's Forget keeps a mark (forgotten_at, forgotten_by): the board is never read for the site's
//   links and neither a link nor a run remembers it for that site again until an admin's Remember again clears it.
// - v381 FIX (REVIEW381-beh L1): every write of a site's boards takes the site's transaction lock first (lockSites, in
//   one order), so two links (or a link and a run) of one site never lock its rows in opposite orders.
// - It is no company alias: company matching and opt-outs never read it (a page's word is never a strong domain alias).
//   The career pages' keys read it as they read the board aliases (career/keys.ts greenhouseBoardsOfDomain), and Admin ›
//   Sources shows a board's sites (and an admin may forget one).

/** The platforms whose boards a company's site embeds and TailorIT reads (embedded_boards.kind). */
export type EmbeddedKind = 'greenhouse' | 'ashby';
/** How a site's board was confirmed (embedded_boards.confirmed_via). */
export type EmbeddedVia = 'page' | 'posting_url' | 'admin';

/** One remembered board of a site. */
export interface EmbeddedBoard {
  site: string;
  kind: EmbeddedKind;
  board: string;
  confirmedVia: EmbeddedVia;
  /** The link that first confirmed it (its shared form), or null. */
  firstLink: string | null;
  firstSeenAt: string;
  lastConfirmedAt: string;
  misses: number;
  /** v381 FIX (G6): when an admin forgot it, or null. */
  forgottenAt: string | null;
}

interface EmbeddedRow {
  site: string;
  kind: EmbeddedKind;
  board: string;
  confirmed_via: EmbeddedVia;
  first_link: string | null;
  first_seen_at: string;
  last_confirmed_at: string;
  misses: number;
  forgotten_at: string | null;
}

const COLUMNS = 'site, kind, board, confirmed_via, first_link, first_seen_at, last_confirmed_at, misses, forgotten_at';

const toBoard = (row: EmbeddedRow): EmbeddedBoard => ({
  site: row.site,
  kind: row.kind,
  board: row.board,
  confirmedVia: row.confirmed_via,
  firstLink: row.first_link,
  firstSeenAt: row.first_seen_at,
  lastConfirmedAt: row.last_confirmed_at,
  misses: Number(row.misses),
  forgottenAt: row.forgotten_at ?? null,
});

/** The longest link kept (job_keys' longest key). */
const LINK_MAX = 2048;

/**
 * The site a job link is on: its registrable domain, lower case (a shared hosting suffix's whole host), when it is a
 * company's own (never an ATS's, a job board's, a site builder's or LinkedIn's); null otherwise.
 */
export function embeddedSiteOf(address: string | null | undefined): string | null {
  if (!address) return null;
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (isLinkedInHost(host)) return null;
  const site = siteOfAddress(address); // v381 FIX (G5)
  return site && isCompanyDomain(registrableDomain(address)) ? site : null;
}

const GREENHOUSE_JOB_ID = /^\d{1,20}$/;
const ASHBY_POSTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The platforms' own hosts: a link there is the board's own, never a company's page. */
const PLATFORM_HOST = /(?:^|\.)(?:greenhouse\.io|ashbyhq\.com)$/;

/** A company page's job link of an embedded board (E1): its kind, the posting's id and its site. */
export interface EmbeddedLinkSite {
  kind: EmbeddedKind;
  /** Greenhouse's job id (digits), or Ashby's posting id (a UUID, lower case). */
  externalId: string;
  /** The site (embeddedSiteOf). */
  site: string;
}

/**
 * v3.8.1 EMBED (E1), here since v381 FIX (Runs' Sources found reads it too): a link on a host that is no platform's (a
 * company's own site, https) naming a posting in ?gh_jid=<digits> or ?ashby_jid=<uuid> (any case), or null.
 */
export function embeddedLinkSiteOf(url: string): EmbeddedLinkSite | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (parsed.protocol !== 'https:' || PLATFORM_HOST.test(host) || isLinkedInHost(host) || isBoardKindHost(host)) return null;
  let found: { kind: EmbeddedKind; externalId: string } | null = null;
  for (const [name, raw] of parsed.searchParams) {
    const key = name.toLowerCase();
    const value = raw.trim();
    if (key === 'gh_jid' && GREENHOUSE_JOB_ID.test(value)) {
      found = { kind: 'greenhouse', externalId: value };
      break;
    }
    if (key === 'ashby_jid' && ASHBY_POSTING_ID.test(value)) found ??= { kind: 'ashby', externalId: value.toLowerCase() };
  }
  if (!found) return null;
  const site = embeddedSiteOf(parsed.href);
  return site ? { ...found, site } : null;
}

/** pg_advisory_xact_lock's first key for a site's boards (any fixed number no other code uses). */
const SITE_LOCK = 7_381_071;

/**
 * v381 FIX (REVIEW381-beh L1): takes the transaction locks of these sites' boards of a kind, in one order (each once),
 * before any of their rows: every writer of a site's rows takes it first, so no two lock its rows in opposite orders.
 */
export async function lockSites(t: DbQueries, sites: ReadonlyArray<{ site: string; kind: EmbeddedKind }>): Promise<void> {
  const keys = [...new Set(sites.map((entry) => `${entry.kind}:${entry.site.toLowerCase()}`))].sort();
  for (const key of keys) await t.run('SELECT pg_advisory_xact_lock(?, hashtext(?))', [SITE_LOCK, key]);
}

/** A site's remembered boards of a kind (an admin's forgotten ones aside), the most recently confirmed first. */
export async function embeddedBoardsOf(db: DbQueries, site: string, kind: EmbeddedKind): Promise<EmbeddedBoard[]> {
  const rows = await db.all<EmbeddedRow>(
    `SELECT ${COLUMNS} FROM embedded_boards
     WHERE site = ? AND kind = ? AND forgotten_at IS NULL ORDER BY last_confirmed_at DESC, board`,
    [site, kind],
  );
  return rows.map(toBoard);
}

/**
 * The sites whose job pages show a board (Admin › Sources), the most recently confirmed first, then the ones an admin
 * forgot (v381 FIX G6: each with its mark, for Remember again).
 */
export async function sitesOfEmbeddedBoard(db: DbQueries, kind: EmbeddedKind, board: string): Promise<EmbeddedBoard[]> {
  const rows = await db.all<EmbeddedRow>(
    `SELECT ${COLUMNS} FROM embedded_boards
     WHERE kind = ? AND lower(board) = lower(?) ORDER BY (forgotten_at IS NOT NULL), last_confirmed_at DESC, site LIMIT 50`,
    [kind, board],
  );
  return rows.map(toBoard);
}

export interface RememberInput {
  site: string;
  kind: EmbeddedKind;
  board: string;
  via: EmbeddedVia;
  /** The link that confirmed it (its shared form), kept only by the board's first confirmation. */
  link: string | null;
  at: string;
  /** EMBEDDED_BOARDS_PER_SITE. */
  perSite: number;
}

/**
 * Remembers (or confirms again) a site's board, in the caller's transaction (which holds the site's lock: lockSites): a
 * new board is kept with how it was confirmed and its link; a known one (whatever its case) has its confirmation time
 * moved and its misses set back to 0, and a run's word (`posting_url`) stays its word from then on (G1: never forgotten
 * by misses). v381 FIX (G6): a board an admin forgot for the site stays forgotten (nothing written). Then the site keeps
 * its `perSite` most recently confirmed boards of the kind (the forgotten ones aside: their marks stay).
 */
export async function rememberEmbeddedBoard(t: DbQueries, input: RememberInput): Promise<void> {
  const link = input.link && input.link.length <= LINK_MAX ? input.link : null;
  await t.run(
    `INSERT INTO embedded_boards(site, kind, board, confirmed_via, first_link, first_seen_at, last_confirmed_at, misses)
     VALUES (?, ?, ?, ?, ?, CAST(? AS timestamptz), CAST(? AS timestamptz), 0)
     ON CONFLICT (site, kind, lower(board)) DO UPDATE SET
       last_confirmed_at = GREATEST(embedded_boards.last_confirmed_at, excluded.last_confirmed_at), misses = 0,
       confirmed_via = CASE WHEN excluded.confirmed_via = 'posting_url' THEN 'posting_url' ELSE embedded_boards.confirmed_via END
     WHERE embedded_boards.forgotten_at IS NULL`,
    [input.site, input.kind, input.board, input.via, link, input.at, input.at],
  );
  await t.run(
    `DELETE FROM embedded_boards WHERE site = ? AND kind = ? AND forgotten_at IS NULL AND lower(board) NOT IN (
       SELECT lower(board) FROM embedded_boards WHERE site = ? AND kind = ? AND forgotten_at IS NULL
       ORDER BY last_confirmed_at DESC, board LIMIT ?)`,
    [input.site, input.kind, input.site, input.kind, Math.max(1, Math.floor(input.perSite))],
  );
}

/**
 * Counts one miss for each of these boards of a site (a link of the site they did not hold, whose page no longer names
 * them: see the top), in the caller's transaction (holding the site's lock); a board at `limit` misses in a row is
 * forgotten, never one a run names (`posting_url`) nor one an admin forgot. Answers the boards forgotten.
 */
export async function noteEmbeddedMisses(t: DbQueries, site: string, kind: EmbeddedKind, boards: readonly string[], limit: number): Promise<string[]> {
  if (boards.length === 0) return [];
  const lower = [...new Set(boards.map((board) => board.toLowerCase()))].sort();
  await t.run(
    `UPDATE embedded_boards SET misses = misses + 1
     WHERE site = ? AND kind = ? AND forgotten_at IS NULL AND lower(board) = ANY(string_to_array(?, ','))`,
    [site, kind, lower.join(',')],
  );
  const gone = await t.all<{ board: string }>(
    `DELETE FROM embedded_boards WHERE site = ? AND kind = ? AND lower(board) = ANY(string_to_array(?, ',')) AND misses >= ?
       AND forgotten_at IS NULL AND confirmed_via <> 'posting_url'
     RETURNING board`,
    [site, kind, lower.join(','), Math.max(1, Math.floor(limit))],
  );
  return gone.map((row) => row.board);
}

/**
 * v381 FIX (G6): an admin forgets one site's board (Admin › Sources' Forget): the mark is kept (who, when), so neither
 * the site's links nor the board's runs remember it again until Remember again. Answers whether it was remembered.
 */
export async function forgetEmbeddedBoard(
  db: DbClient,
  input: { site: string; kind: EmbeddedKind; board: string; by: string | null; at: string },
): Promise<boolean> {
  const site = input.site.toLowerCase();
  return db.tx(
    async (t) => {
      await lockSites(t, [{ site, kind: input.kind }]);
      const { changes } = await t.run(
        `UPDATE embedded_boards SET forgotten_at = CAST(? AS timestamptz), forgotten_by = ?, misses = 0
         WHERE site = ? AND kind = ? AND lower(board) = lower(?) AND forgotten_at IS NULL`,
        [input.at, input.by, site, input.kind, input.board],
      );
      return changes > 0;
    },
    { label: 'admin: forget a company site board' },
  );
}

/** v381 FIX (G6): an admin's Remember again: the mark goes, the board is the site's again. Answers whether it was forgotten. */
export async function rememberEmbeddedBoardAgain(db: DbClient, input: { site: string; kind: EmbeddedKind; board: string }): Promise<boolean> {
  const site = input.site.toLowerCase();
  return db.tx(
    async (t) => {
      await lockSites(t, [{ site, kind: input.kind }]);
      const { changes } = await t.run(
        `UPDATE embedded_boards SET forgotten_at = NULL, forgotten_by = NULL, misses = 0
         WHERE site = ? AND kind = ? AND lower(board) = lower(?) AND forgotten_at IS NOT NULL`,
        [site, input.kind, input.board],
      );
      return changes > 0;
    },
    { label: 'admin: remember a company site board again' },
  );
}

/** The embedded kind and board a source reads (a Greenhouse or Ashby source's), or null for any other source. */
export function embeddedBoardOfSource(source: Pick<SourceRecord, 'kind' | 'config'>): { kind: EmbeddedKind; board: string } | null {
  if (source.kind === 'greenhouse') {
    const board = greenhouseToken(configString(source.config, 'token'));
    return board ? { kind: 'greenhouse', board } : null;
  }
  if (source.kind === 'ashby') {
    const board = ashbyBoard(configString(source.config, 'board'));
    return board ? { kind: 'ashby', board } : null;
  }
  return null;
}

/**
 * GET /api/admin/sources/:id/embedded-sites (Admin › Sources' sheet, SP v381 PLAN E5): the company sites whose job
 * pages show the source's board, the most recently confirmed first, then the forgotten ones (none for a source of another
 * kind).
 */
export async function embeddedSitesOfSource(db: DbQueries, source: SourceRecord): Promise<AdminEmbeddedSites> {
  const board = embeddedBoardOfSource(source);
  if (!board) return { items: [] };
  const sites = await sitesOfEmbeddedBoard(db, board.kind, board.board);
  return {
    items: sites.map((entry) => ({
      site: entry.site,
      confirmedVia: entry.confirmedVia,
      firstLink: entry.firstLink,
      firstSeenAt: entry.firstSeenAt,
      lastConfirmedAt: entry.lastConfirmedAt,
      forgottenAt: entry.forgottenAt, // v381 FIX (G6)
    })),
  };
}

/** POST /api/admin/sources/:id/embedded-sites/forget {site}: an admin forgets one site of the source's board (G6: kept). */
export async function forgetEmbeddedSiteOfSource(
  deps: Pick<AppDeps, 'db' | 'now'>,
  source: SourceRecord,
  site: string,
  by: string | null,
): Promise<AdminEmbeddedSiteForgetResult> {
  const board = embeddedBoardOfSource(source);
  if (!board) return { forgotten: false };
  return { forgotten: await forgetEmbeddedBoard(deps.db, { site, kind: board.kind, board: board.board, by, at: deps.now().toISOString() }) };
}

/** v381 FIX (G6): POST /api/admin/sources/:id/embedded-sites/remember {site}: an admin's Remember again. */
export async function rememberEmbeddedSiteOfSource(db: DbClient, source: SourceRecord, site: string): Promise<AdminEmbeddedSiteRememberResult> {
  const board = embeddedBoardOfSource(source);
  if (!board) return { remembered: false };
  return { remembered: await rememberEmbeddedBoardAgain(db, { site, kind: board.kind, board: board.board }) };
}

/**
 * v381 FIX (REVIEW381-ux L2, REVIEW381-beh L5): the company sites through which an import's run found each of these
 * sources' boards (Runs' Sources found: "Found via acme.com"), by source id: a row of the run whose link is a company
 * page's job link of the board's kind (embeddedLinkSiteOf) that landed on a job the source keeps. A row that landed on no
 * job, a board found through its own link, and a site the board is known for from elsewhere name none.
 */
export async function runEmbeddedSites(db: DbQueries, runId: number, sources: readonly SourceRecord[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const boards = new Map(sources.flatMap((source) => {
    const board = embeddedBoardOfSource(source);
    return board ? [[source.id, board] as const] : [];
  }));
  if (boards.size === 0) return out;
  const rows = await db.all<{ source_id: number; url: string }>(
    `SELECT l.source_id, r.url, min(r.row_number) AS first FROM job_imports i
       JOIN job_import_rows r ON r.import_id = i.id
       JOIN job_source_links l ON l.job_id = r.job_id
     WHERE i.run_id = ? AND r.job_id IS NOT NULL AND r.url IS NOT NULL
       AND (r.url ILIKE '%gh\\_jid=%' OR r.url ILIKE '%ashby\\_jid=%')
       AND l.source_id = ANY(CAST(string_to_array(?, ',') AS bigint[]))
     GROUP BY l.source_id, r.url ORDER BY first, r.url`,
    [runId, [...boards.keys()].join(',')],
  );
  for (const row of rows) {
    const id = Number(row.source_id);
    const board = boards.get(id);
    const link = embeddedLinkSiteOf(row.url);
    if (!board || !link || link.kind !== board.kind) continue;
    const sites = out.get(id) ?? [];
    if (!sites.includes(link.site)) out.set(id, [...sites, link.site]);
  }
  return out;
}

/** The Greenhouse hosts (a posting's own link there is the board's own page, never a company's site). */
const GREENHOUSE_HOST = /(?:^|\.)greenhouse\.io$/;

/**
 * The company sites a Greenhouse run's postings name as their own pages (see the top): a listed posting whose link is
 * on a company's own site (no Greenhouse host) and names its own id in ?gh_jid=, with the first such link of each site.
 * v381 FIX (REVIEW381-beh L4): only an https link, kept in its shared canonical form (no other parameter).
 */
export function embedSitesOfPostings(postings: readonly RawPosting[]): Map<string, string> {
  const sites = new Map<string, string>();
  for (const posting of postings) {
    let url: URL;
    try {
      url = new URL(posting.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || GREENHOUSE_HOST.test(url.hostname.toLowerCase())) continue;
    if (ghJobIdOf(posting.url) !== String(posting.sourceJobId)) continue;
    const site = embeddedSiteOf(posting.url);
    const link = sharedAddress(canonicalJobUrl(url.href));
    if (site && link && !sites.has(site)) sites.set(site, link);
  }
  return sites;
}

/**
 * v3.8.1 EMBED (E2): a Greenhouse run remembers the company sites its board's postings live on (embedSitesOfPostings,
 * `posting_url`), in its own transaction (the sites' locks first, in one order), once its batch is saved; a site an admin
 * forgot for the board stays forgotten (G6); a failure is logged, never the run's.
 */
export async function rememberRunEmbeds(deps: AppDeps, source: SourceRecord, postings: readonly RawPosting[], at: string): Promise<void> {
  if (source.kind !== 'greenhouse') return;
  const board = greenhouseToken(configString(source.config, 'token'));
  if (!board) return;
  const sites = embedSitesOfPostings(postings);
  if (sites.size === 0) return;
  const perSite = constantsOf(deps).get('EMBEDDED_BOARDS_PER_SITE');
  const ordered = [...sites].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  try {
    await deps.db.tx(
      async (t) => {
        await lockSites(t, ordered.map(([site]) => ({ site, kind: 'greenhouse' as const }))); // v381 FIX (L1)
        for (const [site, link] of ordered) {
          await rememberEmbeddedBoard(t, { site, kind: 'greenhouse', board, via: 'posting_url', link, at, perSite });
        }
      },
      { label: 'ingest: the sites a board is embedded on' },
    );
  } catch (error) {
    deps.log.warn('[ingest] the sites a Greenhouse board is embedded on could not be remembered', error instanceof Error ? error.name : 'unknown');
  }
}
