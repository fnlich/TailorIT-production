import type { JobSourceTermsStatus } from '@tailorit/shared';
import { addablePosting, parseAtsUrl, type AddablePosting } from '@tailorit/shared/autofill';
import type { DbQueries } from '../../core/db/types';
import { workdayLinkPosting } from './adapters/workday';
import { boardNameOf, boardOfUrl, candidateName, careerSiteOfUrl } from './discovery/boards';
import { sourcesOfBoards, type BoardRef } from './discovery/offer';
import { termsForbidReads } from './sources';
import type { SourceRecord } from './types';

// v37 FIX-37B (SP v37 FIXES-37 E2): the one terms gate. Terms an admin recorded on a source as not allowing automated
// access stop EVERY read of that source's board, for every kind and by every path. v37 INT-2b (the coordinator's
// ruling, binding): only the terms that say no, Forbidden and Needs a contract (sources.ts termsForbidReads), stop the
// board-level reads below; Not checked keeps its v3.6 meaning (the source never RUNS until an admin records its terms:
// termsAllowReads, the scheduler and Run now), and people's adds, imports and re-checks of its board's links read them:
//   - its runs (scheduler.ts dueSources) and Run now (service.ts checkRunnable): the source itself;
//   - Add source's Test (router.ts): the board tested, when a source of it says no;
//   - a link to one of its postings: Add job, Add by link, a tracker entry's link, the extension's add and From page, the
//     MCP tool, an admin's and a person's import, the link queue, Retry read, an admin's approval and the page re-checks
//     (autofill/jobs.ts readAndStore for the ATS reads, jobs/add/page.ts readPageToSharedJob for the page and board reads:
//     the reason `terms`);
//   - a reported posting's re-check (recheck.ts) and discovery's validation (discovery/validate.ts): linked, unread.
// "The board" is every source that reads it (discovery/offer.ts sourcesOfBoards: Add job's link keepers too; an iCIMS
// board's career site on its host), and for a Workday posting its tenant's one-posting sources as well as its career site;
// a page's career site (its host). Any one of them saying no stops the read: nothing is sent.

/** A board's source whose recorded terms don't let TailorIT read it. */
export interface TermsRefusal {
  sourceId: number;
  status: JobSourceTermsStatus;
}

/** An ATS read refused by its board's terms (autofill/jobs.ts readAndStore's AppError `cause`: verdict.ts reads it `terms`). */
export class TermsRefusalError extends Error {
  constructor(readonly refusal: TermsRefusal) {
    super("The board's terms don't allow automated access.");
    this.name = 'TermsRefusalError';
  }
}

/** A board as discovery keeps it, or nothing (a name its kind's normaliser refuses). */
function refOf(kind: BoardRef['kind'], raw: string): BoardRef[] {
  const name = candidateName(kind, raw);
  return name ? [{ kind, name }] : [];
}

/**
 * The boards an ATS posting's read reads: its board, and for a Workday posting its tenant (Add job's one-posting kind)
 * and the career site its page names (<host>/<site>, or <host>/recruiting/<tenant>/<site> on myworkdaysite.com).
 */
export function boardsOfPosting(posting: AddablePosting): BoardRef[] {
  const boards = refOf(posting.kind, posting.board);
  if (posting.kind === 'workday' && posting.workday) {
    const { host, site } = posting.workday;
    const shared = /\.myworkdaysite\.com$/i.test(host);
    boards.push(...refOf('workday_site', shared ? `${host}/recruiting/${posting.board}/${site}` : `${host}/${site}`));
  }
  return boards;
}

/** The boards a link names (its ATS posting's, the board its address names, its career site's host), each once. */
export function boardsOfLink(url: string): BoardRef[] {
  const boards: BoardRef[] = [];
  const posting = addablePosting(parseAtsUrl(url)) ?? workdayLinkPosting(url);
  if (posting) boards.push(...boardsOfPosting(posting));
  const named = boardOfUrl(url);
  if (named) boards.push(named);
  const site = careerSiteOfUrl(url);
  if (site) boards.push(site);
  const seen = new Set<string>();
  return boards.filter((board) => {
    const key = `${board.kind}\n${board.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first source of these boards whose terms don't let TailorIT read it, or null (one statement). */
export async function termsRefusalOfBoards(db: DbQueries, boards: readonly BoardRef[]): Promise<TermsRefusal | null> {
  if (boards.length === 0) return null;
  for (const sources of (await sourcesOfBoards(db, boards)).values()) {
    const refusing = sources.find((source) => termsForbidReads(source.termsStatus)); // v37 INT-2b: the terms that say no
    if (refusing) return { sourceId: refusing.id, status: (refusing.termsStatus ?? 'unchecked') as JobSourceTermsStatus };
  }
  return null;
}

/** termsRefusalOfBoards for the boards a link names. */
export function termsRefusalOfLink(db: DbQueries, url: string): Promise<TermsRefusal | null> {
  return termsRefusalOfBoards(db, boardsOfLink(url));
}

/** termsRefusalOfBoards for the boards an ATS posting's read reads. */
export function termsRefusalOfPosting(db: DbQueries, posting: AddablePosting): Promise<TermsRefusal | null> {
  return termsRefusalOfBoards(db, boardsOfPosting(posting));
}

/**
 * A source's own terms, then its board's other sources' (and its job's link's boards, `link`): the re-check's read of one
 * of its links.
 */
export async function termsRefusalOfSource(
  db: DbQueries,
  source: Pick<SourceRecord, 'id' | 'kind' | 'config' | 'termsStatus'>,
  link?: string,
): Promise<TermsRefusal | null> {
  if (termsForbidReads(source.termsStatus)) return { sourceId: source.id, status: source.termsStatus as JobSourceTermsStatus }; // v37 INT-2b
  const named = boardNameOf(source.kind as BoardRef['kind'], source.config);
  return termsRefusalOfBoards(db, [...(named ? [{ kind: source.kind as BoardRef['kind'], name: named }] : []), ...(link ? boardsOfLink(link) : [])]);
}
