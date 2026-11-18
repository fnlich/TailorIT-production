import { addablePosting, parseAtsUrl } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../core/context';
import { ashbyBoard } from './adapters/ashby';
import { greenhouseToken } from './adapters/greenhouse';
import { leverSite } from './adapters/lever';
import { workableAccount } from './adapters/workable';
import { workdayTenant } from './adapters/workday';
import type { IngestHttp } from './http';
import { sourceHashOf } from './normalize';
import { fetchPosting, type AshbyBoardReads, type PostingRef, type WorkableNames } from './postings';
import type { IngestStore } from './store';
import type { SourceRecord } from './types';

// One posting's own read, by the link that names it: the read today's liveness check made, kept for the re-checks of
// the extension's closed reports (recheck.ts, 14 §5.1 step 3) with today's identity. v30 S1-API: the daily check of
// the open jobs no enabled source listed (at most LIVENESS_CHECKS_PER_DAY a day, after INGEST_DAILY_AT's run) is
// retired with them (12-job-sourcing.md §8.6, §13): boards close their jobs by their listings (two misses, DB-INGEST),
// a job no source verifies for JOB_UNVERIFIED_HIDE_DAYS leaves search (unverified.ts), and a report makes its listing
// source due and asks for its posting once (recheck.ts). Wave 4's per-posting kinds (Workday sites, career pages) read
// their postings inside their own runs.
//
// The links read here: Greenhouse, Lever, Ashby (the board's listing, read once per call), Workable (the posting's own
// address; one no longer published is gone) and Workday (the read its job's own page makes, its host's robots.txt asked
// first); never a page job's (nothing reads those again). A posting still there is stored as a run stores it (its
// last-verified time moves on, and the link's liveness_checked_at); a gone one changes nothing here.

/** What a source Add job made carries in its config (`addedBy`): v31 FIX-LINK, kept in types.ts (the store reads it). */
export { ADDED_BY_AUTOFILL } from './types';

/**
 * The kinds whose postings TailorIT can read one at a time. v30 FIX-A (INT-4 open item S3 C): a Workday career site's
 * (S3's workday_site) too: its posting is read as Add job's Workday posting is (the job's own page link), a new kind of
 * read, so the re-check reads it only once BOT_USER_AGENT is set, and with it (recheck.ts).
 */
export const READABLE_KINDS = ['greenhouse', 'lever', 'ashby', 'workable', 'workday', 'workday_site'] as const;

/** A link to read: its source (kind and config) and posting id, and its job's own link (Workday's address parts). */
export interface LinkToRead {
  source: SourceRecord;
  sourceJobId: string;
  jobUrl: string;
}

/** The posting a link names, read from its source's config by the adapters' own rules; null when it names none. */
export function postingRefOf(link: LinkToRead): PostingRef | null {
  const { source, sourceJobId } = link;
  const config = source.config;
  if (source.kind === 'workday' || source.kind === 'workday_site') {
    // The tenant is the source's; the site, location and name are the job's own link's, the posting the link's id.
    const tenant = workdayTenant(typeof config.tenant === 'string' ? config.tenant : '');
    const posting = addablePosting(parseAtsUrl(link.jobUrl));
    if (!tenant || posting?.kind !== 'workday' || !posting.workday || posting.board !== tenant) return null;
    // The job's link names the posting the link's id names, or (a posting added by its requisition's address, …_JR123,
    // whose job links the page Workday named, …_JR123-2) one of that requisition's postings.
    const id = sourceJobId.toLowerCase();
    const named = posting.externalId.toLowerCase();
    const ofRequisition = named.startsWith(`${id}-`) && /^\d+$/.test(named.slice(id.length + 1));
    if (named !== id && !ofRequisition) return null;
    return { kind: 'workday', board: tenant, externalId: sourceJobId, region: 'global', workday: posting.workday };
  }
  if (source.kind === 'ashby') {
    const board = ashbyBoard(typeof config.board === 'string' ? config.board : '');
    return board ? { kind: 'ashby', board, externalId: sourceJobId, region: 'global' } : null;
  }
  if (source.kind === 'workable') {
    const account = workableAccount(typeof config.account === 'string' ? config.account : '');
    return account ? { kind: 'workable', board: account, externalId: sourceJobId, region: 'global' } : null;
  }
  if (source.kind === 'greenhouse') {
    const board = greenhouseToken(typeof config.token === 'string' ? config.token : '');
    return board ? { kind: 'greenhouse', board, externalId: sourceJobId, region: 'global' } : null;
  }
  if (source.kind === 'lever') {
    const board = leverSite(typeof config.site === 'string' ? config.site : '');
    const region = typeof config.region === 'string' && config.region.toLowerCase() === 'eu' ? 'eu' : 'global';
    return board ? { kind: 'lever', board, externalId: sourceJobId, region } : null;
  }
  return null;
}

/** What one link's read found: still there (stored again), gone (nothing written), or not answered. */
export type LinkReadState = 'live' | 'gone' | 'unreadable';

/** What a link's read writes with: the store's upsert. */
export type LinkReadStore = Pick<IngestStore, 'upsertBatch'>;

/**
 * Reads one link's posting (see the top), outside any transaction: `live` stores it as a run would and moves the
 * link's liveness_checked_at; `gone` writes nothing (the caller closes, if it decides to: closeLink); `unreadable` for a
 * read that failed, a robots.txt refusal or a held host. `ref` from postingRefOf.
 */
export async function readLink(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  { http, store }: { http: IngestHttp; store: LinkReadStore },
  link: LinkToRead,
  ref: PostingRef,
  options: { signal?: AbortSignal; boards?: AshbyBoardReads; names?: WorkableNames } = {},
): Promise<LinkReadState> {
  let answer;
  try {
    answer = await fetchPosting(http, ref, { config: link.source.config, signal: options.signal, boards: options.boards, names: options.names });
  } catch {
    return 'unreadable';
  }
  if (!answer.found) return 'gone';
  const now = nowIso(deps);
  const item = { raw: answer.raw, sourceHash: sourceHashOf(answer.raw) };
  try {
    await deps.db.tx(
      async (t) => {
        await t.run('UPDATE job_source_links SET liveness_checked_at = ? WHERE source_id = ? AND source_job_id = ?', [
          now,
          link.source.id,
          link.sourceJobId,
        ]);
        await store.upsertBatch(link.source, [item], now);
      },
      { label: 'posting read: still listed' },
    );
  } catch (error) {
    // The posting answered: it is live, whatever storing it again did.
    deps.log.warn(`[ingest] the posting ${link.sourceJobId} of source ${link.source.id} answered but could not be stored again`, error);
  }
  return 'live';
}
