import type { BoardSourceKind } from '@tailorit/shared/sourcing';
import { nowIso, type AppDeps } from '../../core/context';
import { apiBoardOf, BOARD_READABLE_KINDS } from './boards/index'; // v38 FRAME: the board registry
import { linkFeedReads } from './boards/feed-cache'; // v38 FRAME (A3); v38 FIX-C (beh-M2): linkFeedReads
import { clearGoneSighting, settleGoneSighting } from './boards/sightings'; // v38 FIX-C (D2)
import type { LinkToRead } from './boards/types';
import type { IngestHttp } from './http';
import { sourceHashOf } from './normalize';
import { fetchPosting, type AshbyBoardReads, type PostingRef, type WorkableNames } from './postings';
import { storedCompanyName } from '../jobs/add/kept-read'; // v38 FIX-APP (D1)
import type { IngestStore } from './store';

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
 * read, so the re-check reads it only once BOT_USER_AGENT is set, and with it (recheck.ts). v37 BOARDS: and a BambooHR
 * opening's and an iCIMS posting's (new kinds of read, as a Workday site's). v38 FRAME (SP v38 PLAN A3): every board kind
 * whose descriptor reads a stored link's posting (ingest/boards: `posting.refOf`), in the registry's order.
 */
export const READABLE_KINDS: readonly BoardSourceKind[] = BOARD_READABLE_KINDS;

/** A link to read: its source (kind and config) and posting id, and its job's own link (Workday's address parts). */
export type { LinkToRead } from './boards/types';

/**
 * The posting a link names, read from its source's config by the adapters' own rules (v38 FRAME: its board
 * descriptor's `posting.refOf`); null when it names none.
 */
export function postingRefOf(link: LinkToRead): PostingRef | null {
  return apiBoardOf(link.source.kind)?.posting?.refOf?.(link) ?? null;
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
  options: {
    signal?: AbortSignal;
    boards?: AshbyBoardReads;
    names?: WorkableNames;
    /** v37 INT-A: told why an `unreadable` read failed (recheck.ts: a held host or the Workday lane's pause waits). */
    onFailure?: (error: unknown) => void;
  } = {},
): Promise<LinkReadState> {
  let answer;
  try {
    // v38 FRAME (A3): a feed-based platform's board feed, read once and reused briefly. v38 FIX-C (REVIEW38-beh M2): a
    // posting missing from a feed kept from an earlier read has the feed read again (fresh) once before it reads gone.
    const read = (feeds: ReturnType<typeof linkFeedReads>['feeds']) =>
      fetchPosting(http, ref, { config: link.source.config, signal: options.signal, boards: options.boards, names: options.names, feeds });
    const reads = linkFeedReads(deps);
    answer = await read(reads.feeds);
    if (!answer.found && reads.reused()) answer = await read(linkFeedReads(deps, { fresh: true }).feeds);
  } catch (error) {
    options.onFailure?.(error);
    return 'unreadable';
  }
  if (!answer.found) {
    // v38 FIX-C (SP v38 FIXES-38 D2): a gone sign that needs a second sighting (Paycom's empty portal) is gone only once
    // two reads a day apart see it; the first is recorded (boards/sightings.ts), and the read is unanswered for now.
    if (answer.confirmTwice) {
      const sighting = await settleGoneSighting(deps.db, { sourceId: link.source.id, sourceJobId: link.sourceJobId }, deps.now());
      if (!sighting.close) return 'unreadable';
    }
    return 'gone';
  }
  const now = nowIso(deps);
  // v38 FIX-APP (SP v38 FIXES-38 D1): a posting that names no company (ADP's, UKG's, ... read with no source Company name)
  // keeps the company its job has (a name given before), never one made up; with none, it is live and not stored again.
  const unnamed = !answer.raw.company.name.trim();
  const given = unnamed ? await storedCompanyName(deps.db, link.source.id, link.sourceJobId) : null;
  const raw = given ? { ...answer.raw, company: { ...answer.raw.company, name: given } } : answer.raw;
  const item = { raw, sourceHash: sourceHashOf(raw) };
  try {
    await deps.db.tx(
      async (t) => {
        await t.run('UPDATE job_source_links SET liveness_checked_at = ? WHERE source_id = ? AND source_job_id = ?', [
          now,
          link.source.id,
          link.sourceJobId,
        ]);
        await clearGoneSighting(t, { sourceId: link.source.id, sourceJobId: link.sourceJobId }); // v38 FIX-C (D2)
        if (!unnamed || given) await store.upsertBatch(link.source, [item], now); // v38 FIX-APP (D1)
      },
      { label: 'posting read: still listed' },
    );
  } catch (error) {
    // The posting answered: it is live, whatever storing it again did.
    deps.log.warn(`[ingest] the posting ${link.sourceJobId} of source ${link.source.id} answered but could not be stored again`, error);
  }
  return 'live';
}
