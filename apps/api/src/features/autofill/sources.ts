import type { DbQueries } from '../../core/db/types';
import { NEW_SOURCE_COLUMNS, NEW_SOURCE_PLACEHOLDERS, newSourceValues, toSourceRecord, type NewSource, type SourceRow } from '../ingest/sources';
import type { SourceKind, SourceRecord } from '../ingest/types';

// v3.0 D2-B: the job sources Add job (jobs.ts) and adding a job from a page (from-page.ts) store their jobs under, read
// and made on the async client (`deps.db`, or a transaction's handle). ingest/sources.ts keeps the admin console's
// reads and writes; insertSourceIfNameFree makes a row as its insertSource does (the same columns and defaults).
//
// The concurrency audit (11-database.md §9.3): a new source is made with the unique key job_sources(kind, name) and
// ON CONFLICT DO NOTHING, never "look for the name, then insert". Two adds that make one source at the same time (two
// postings of a board TailorIT has no source for; the first two page jobs) then make it once: the add that finds the
// name taken looks again, and uses the source the other made (PostgreSQL's ON CONFLICT waits for the other
// transaction, so the look that follows sees its row). On SQLite each add's transaction runs alone anyway.

/** The sources of a kind, newest first (listSourceRecords' order). */
export async function sourcesOfKind(db: DbQueries, kind: SourceKind): Promise<SourceRecord[]> {
  const rows = await db.all<SourceRow>('SELECT * FROM job_sources WHERE kind = ? ORDER BY created_at DESC, id DESC', [kind]);
  return rows.map(toSourceRecord);
}

/** The first source of a kind (the oldest), whatever its name: the job pages' one source. */
export async function firstSourceOfKind(db: DbQueries, kind: SourceKind): Promise<SourceRecord | null> {
  const row = await db.one<SourceRow>('SELECT * FROM job_sources WHERE kind = ? ORDER BY id LIMIT 1', [kind]);
  return row ? toSourceRecord(row) : null;
}

/**
 * A new source, made as insertSource makes one; null, and nothing written, when its kind already has a source of its
 * name (UNIQUE(kind, name)).
 */
export async function insertSourceIfNameFree(db: DbQueries, source: NewSource, now: string): Promise<SourceRecord | null> {
  // v30 S1-API: the same columns and values as insertSource (its host, recorded terms, robots.txt status, next run).
  const row = await db.one<SourceRow>(
    `INSERT INTO ${NEW_SOURCE_COLUMNS} VALUES (${NEW_SOURCE_PLACEHOLDERS}) ON CONFLICT(kind, name) DO NOTHING RETURNING *`,
    newSourceValues(source, now),
  );
  return row ? toSourceRecord(row) : null;
}
