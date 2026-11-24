import type { JobSourceDiscoveredVia } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbTx } from '../../../core/db/types';
import { offerBoards, offerToDiscovery } from './offer';
import { BOARD_KINDS, boardOfUrl, careerSiteOfUrl, type FoundBoard } from './boards';
import { lockState, writeState } from './state';

// v30 S2: discovery's link signals (docs/design/part2/12-job-sourcing.md §4.1, signals 2 and 5), once a day:
//   2. the links in applications and page jobs, every account's: each one's ATS board is offered as
//      `application_link`. Only the board is kept, never the account, the job or the link. (v30 INT-4, the
//      coordinator's one-source rule: an employer's own career site in those links is S5's daily step
//      ingest.career_sites' signal, career/discover.ts, so one host is never offered by both.)
//   5. cross-links: a shared job whose Apply link is on a board no board source of it reads (a feed's posting, a
//      published page job, an import) offers that board as `cross_link`.
// Each signal walks its table once, in the order rows were made, from its high-water mark (discovery_state 'links'),
// in batches of LINK_BATCH rows, each batch's offers and its mark in one transaction; a pass reads LINK_BATCHES_PER_PASS
// batches at least, then walks on until it is caught up or LINK_PASS_BUDGET_MS is spent, and goes on from its mark
// the next day. offerLink is the same step for one address, for the readers that find links elsewhere (a company
// website's Careers link, signal 4; an adapter's JSON-LD).
//
// v36 SOURCES (SP v36 PLAN S6): a held job (jobs.held_since: waiting in Admin › Review › New jobs) offers nothing, in
// any signal: its board becomes a candidate only once an admin approves the job (job-reviews/decide.ts offers it then).
// The mark still moves past it.
//
// v30 FIX-PERF (PG-LOAD PGL-18): a pass read at most LINK_BATCHES_PER_PASS batches (100,000 rows) a signal a day,
// against 150,000 new Tracker entries a day at 11 §1.2's base case: the applications signal fell 50,000 entries
// further behind every day. A batch is 7.7 ms warm at mix B's size, so catching up takes seconds.

/** Rows read per batch. */
export const LINK_BATCH = 1000;
/** Batches per signal a pass reads at least (100,000 rows), however long they take. */
export const LINK_BATCHES_PER_PASS = 100;
/** v30 FIX-PERF (PGL-18): how long a signal's walk goes on past LINK_BATCHES_PER_PASS batches until caught up. */
export const LINK_PASS_BUDGET_MS = 10 * 60_000;
/** discovery_state's key of the link signals' marks. */
export const LINKS_STATE = 'links';

/** The link signals' high-water marks: the last application (its seq) and the last jobs (their ids) read. */
export interface LinkMarks {
  applicationSeq: number;
  pageJobId: number;
  crossJobId: number;
}

const NO_MARKS: LinkMarks = { applicationSeq: 0, pageJobId: 0, crossJobId: 0 };

/** The kinds whose sources read a board's own listing (Add job's one-posting Workday kind is none). */
const LISTING_BOARD_KINDS = Object.keys(BOARD_KINDS).filter((kind) => kind !== 'workday');

/** What a link pass did. */
export interface LinkPass {
  /** Rows read per signal. */
  applications: number;
  pageJobs: number;
  crossLinks: number;
  /** Boards offered (each once per batch) and how many were new candidates. */
  offered: number;
  added: number;
}

/** The board (or career site, while the switch is on) an address names, as discovery offers it. */
export function boardToOffer(address: string, careerSites: boolean): FoundBoard | null {
  return boardOfUrl(address) ?? (careerSites ? careerSiteOfUrl(address) : null);
}

/** Offers the board an address names (signal 4's Careers links, an adapter's cross-links), in the caller's transaction. */
export async function offerLink(deps: AppDeps, t: DbTx, address: string, via: JobSourceDiscoveredVia, at: string) {
  const board = boardToOffer(address, constantsOf(deps).get('SITE_READER_CAREER_PAGES'));
  return board ? offerToDiscovery(deps, t, { kind: board.kind, name: board.name, via, at }) : null;
}

/**
 * Offers each distinct board of `addresses` once; answers how many were offered and how many were new candidates.
 * v3.0.1 FIX-PERF2 (PGL-25): the batch's boards in one offer (offerBoards: a few statements for all of them).
 */
async function offerAll(deps: AppDeps, t: DbTx, addresses: readonly string[], via: JobSourceDiscoveredVia, at: string, careerSites: boolean) {
  const boards = new Map<string, FoundBoard>();
  for (const address of addresses) {
    const board = boardToOffer(address, careerSites);
    if (board) boards.set(`${board.kind}:${board.name}`, board);
  }
  const results = await offerBoards(deps, t, [...boards.values()], via, at);
  return { offered: boards.size, added: results.filter((result) => result.outcome === 'added').length };
}

/** One signal's walk: batches after its mark, each batch's offers and the mark moved in one transaction. */
async function walk(
  deps: AppDeps,
  mark: keyof LinkMarks,
  read: (t: DbTx, after: number) => Promise<Array<{ at: number; url: string | null }>>,
  via: JobSourceDiscoveredVia,
  pass: LinkPass,
  careerSites: boolean,
  budgetMs: number,
): Promise<number> {
  let rows = 0;
  const started = performance.now();
  for (let batch = 0; batch < LINK_BATCHES_PER_PASS || performance.now() - started < budgetMs; batch += 1) {
    const n = await deps.db.tx(
      async (t) => {
        const marks = await lockState<LinkMarks>(t, LINKS_STATE, NO_MARKS, nowIso(deps));
        const found = await read(t, marks[mark]);
        if (found.length === 0) return 0;
        const offered = await offerAll(deps, t, found.map((row) => row.url ?? '').filter(Boolean), via, nowIso(deps), careerSites);
        pass.offered += offered.offered;
        pass.added += offered.added;
        await writeState(t, LINKS_STATE, { ...marks, [mark]: Math.max(...found.map((row) => Number(row.at))) }, nowIso(deps));
        return found.length;
      },
      { label: `discovery ${mark}` },
    );
    rows += n;
    if (n < LINK_BATCH) break;
  }
  return rows;
}

/**
 * One pass of the link signals (see the top). Reads nothing outside: offers only. `budgetMs`: how long each signal's
 * walk may go on past LINK_BATCHES_PER_PASS batches (LINK_PASS_BUDGET_MS).
 */
export async function sweepLinks(deps: AppDeps, options: { budgetMs?: number } = {}): Promise<LinkPass> {
  const pass: LinkPass = { applications: 0, pageJobs: 0, crossLinks: 0, offered: 0, added: 0 };
  const careerSites = constantsOf(deps).get('SITE_READER_CAREER_PAGES');
  const budgetMs = Math.max(0, options.budgetMs ?? LINK_PASS_BUDGET_MS);
  // Signal 2: applications' links (the posting's own, else its job's), every account's; the account is never read.
  pass.applications = await walk(
    deps,
    'applicationSeq',
    (t, after) =>
      t.all(
        `SELECT a.seq AS at, CASE WHEN j.held_since IS NULL THEN COALESCE(NULLIF(a.posting_url, ''), j.apply_url) END AS url
         FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
         WHERE a.seq > ? ORDER BY a.seq LIMIT ?`,
        [after, LINK_BATCH],
      ),
    'application_link',
    pass,
    false, // v30 INT-4: career sites in applications are S5's ingest.career_sites signal
    budgetMs,
  );
  // Signal 2: page jobs, a person's own (their link is the page they saw).
  pass.pageJobs = await walk(
    deps,
    'pageJobId',
    (t, after) =>
      t.all(
        `SELECT j.id AS at, CASE WHEN j.held_since IS NULL THEN j.apply_url END AS url
         FROM jobs j WHERE j.id > ? AND j.owner_user_id IS NOT NULL ORDER BY j.id LIMIT ?`,
        [after, LINK_BATCH],
      ),
    'application_link',
    pass,
    false, // v30 INT-4: career sites of page jobs are S5's ingest.career_sites signal
    budgetMs,
  );
  // Signal 5: shared jobs whose Apply link is on a board kind's platform that no board source of theirs reads. Every
  // shared job is walked (the mark moves past each), only those offer.
  pass.crossLinks = await walk(
    deps,
    'crossJobId',
    (t, after) =>
      t.all(
        `SELECT j.id AS at,
           CASE WHEN j.held_since IS NULL
             AND j.apply_platform IN ('greenhouse', 'lever', 'ashby', 'workable', 'workday', 'bamboohr', 'breezy', 'site')
             AND NOT EXISTS (SELECT 1 FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
                                             WHERE l.job_id = j.id AND s.kind = ANY(string_to_array(?, ',')))
           THEN j.apply_url END AS url
         FROM jobs j WHERE j.id > ? AND j.owner_user_id IS NULL ORDER BY j.id LIMIT ?`,
        [LISTING_BOARD_KINDS.join(','), after, LINK_BATCH],
      ),
    'cross_link',
    pass,
    careerSites,
    budgetMs,
  );
  if (pass.offered > 0) {
    deps.log.info(
      `[discovery] links: ${pass.applications} applications, ${pass.pageJobs} page jobs, ${pass.crossLinks} shared jobs read; ` +
        `${pass.offered} boards offered, ${pass.added} new`,
    );
  }
  return pass;
}
