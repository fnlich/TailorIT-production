import type { DbQueries } from '../../../core/db/types';

// v38 FIX-C (SP v38 FIXES-38 D2; REVIEW38-beh M1): a gone sign a platform's page gives that is not as sure as a 404 (a
// PostingAnswer `{ found: false, confirmTwice: true }`: Paycom's empty portal page, the portal's own shell with no job in
// it). A link no one stored yet (Add job's read of a new link) is closed at once. A stored job's live link closes only
// when its reads see the sign twice, at least GONE_SIGHTINGS_APART_MS apart: the first sighting is recorded
// (job_source_links.gone_seen_at, migration 0070), not acted on; a read that finds the posting clears it.
// Callers: jobs/add/board-link.ts (every link read: Add job, imports, the link queue, Retry read, Edit job's read) and
// ingest/liveness.ts (the re-check of a reported posting).

/** The least time between the two sightings that close a stored job (the owner's decision D2: a day). */
export const GONE_SIGHTINGS_APART_MS = 24 * 60 * 60 * 1000;

/** A stored link of a posting: its source and its id there. */
export interface SightedLink {
  sourceId: number;
  sourceJobId: string;
}

/** What a sighting comes to: close the posting now, or wait (recorded) until `until` before a second sighting can close it. */
export type SightingVerdict = { close: true } | { close: false; firstSeenAt: string; until: string };

/**
 * A sighting of the gone sign on `link` (a stored link, or null for a posting no source stores live): no live stored link
 * closes at once; else the first sighting is recorded and the verdict waits, and a sighting at least
 * GONE_SIGHTINGS_APART_MS after the first closes.
 */
export async function settleGoneSighting(db: DbQueries, link: SightedLink | null, now: Date): Promise<SightingVerdict> {
  if (!link) return { close: true };
  const at = now.toISOString();
  const row = await db.one<{ seen: string | Date }>(
    `UPDATE job_source_links SET gone_seen_at = COALESCE(gone_seen_at, CAST(? AS timestamptz))
     WHERE source_id = ? AND source_job_id = ? AND missing_since IS NULL
     RETURNING gone_seen_at AS seen`,
    [at, link.sourceId, link.sourceJobId],
  );
  // No live link of that posting (closed meanwhile, or never stored): nothing to wait for.
  if (!row) return { close: true };
  const first = new Date(row.seen).getTime();
  if (now.getTime() - first >= GONE_SIGHTINGS_APART_MS) return { close: true };
  return { close: false, firstSeenAt: new Date(first).toISOString(), until: new Date(first + GONE_SIGHTINGS_APART_MS).toISOString() };
}

/** A read found the posting: a sighting recorded on its link is forgotten (the next gone sign is a first one again). */
export async function clearGoneSighting(db: DbQueries, link: SightedLink): Promise<void> {
  await db.run('UPDATE job_source_links SET gone_seen_at = NULL WHERE source_id = ? AND source_job_id = ? AND gone_seen_at IS NOT NULL', [
    link.sourceId,
    link.sourceJobId,
  ]);
}

/** The live stored link of posting `sourceJobId` under `sourceId`, or null (the sighting's link, for board-link.ts). */
export async function liveLinkOf(db: DbQueries, sourceId: number, sourceJobId: string): Promise<SightedLink | null> {
  const row = await db.one<{ source_id: number }>(
    'SELECT source_id FROM job_source_links WHERE source_id = ? AND source_job_id = ? AND missing_since IS NULL',
    [sourceId, sourceJobId],
  );
  return row ? { sourceId, sourceJobId } : null;
}
