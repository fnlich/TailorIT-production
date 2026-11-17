import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbQueries } from '../../../core/db/types';
import { migrationsPgDir } from '../../../core/db/pg/migrate';

// v30 E1: the `refdata` schema (docs/design/part2/11-database.md §5.4, 13-company-enrichment.md §10): its names, its
// files and the fingerprint that ties a built schema to the code that reads it.
//
// The schema's tables are the files of apps/api/migrations-pg/refdata/ (NNNN_name.sql), run in order into a fresh
// `refdata_next` at each build: the files named *index* after the dumps are loaded, the others before. A build records
// the fingerprint of the files it ran in its `meta` table; a reader uses `refdata` only when that fingerprint is the
// code's own (a schema built by older files waits for the next build, never half-read).

/** The schema readers use, the one a build loads, and the one a swap moves aside (dropped right after). */
export const REFDATA_SCHEMA = 'refdata';
export const REFDATA_NEXT = 'refdata_next';
export const REFDATA_OLD = 'refdata_old';

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface RefdataFile {
  name: string;
  sql: string;
  /** Runs after the dumps are loaded (its name says `index`). */
  afterLoad: boolean;
}

/** apps/api/migrations-pg/refdata */
export function refdataFilesDir(): string {
  return join(migrationsPgDir(), 'refdata');
}

/** The schema's files, in order. */
export function readRefdataFiles(dir = refdataFilesDir()): RefdataFile[] {
  if (!existsSync(dir)) throw new Error(`The refdata schema's files are missing (${dir}).`);
  return readdirSync(dir)
    .filter((file) => FILE_PATTERN.test(file))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n'), afterLoad: /index/.test(name) }));
}

let fingerprintCache: string | null = null;

/** One hash of the files' names and contents: the format a reader needs a built schema to have. */
export function refdataFingerprint(files?: readonly RefdataFile[]): string {
  if (!files && fingerprintCache) return fingerprintCache;
  const hash = createHash('sha256');
  for (const file of files ?? readRefdataFiles()) hash.update(`${file.name}\n${file.sql}\n`);
  const value = hash.digest('hex').slice(0, 32);
  if (!files) fingerprintCache = value;
  return value;
}

export interface RefdataState {
  /** A built schema of this code's format is in place. */
  ready: boolean;
  buildId: number | null;
  builtAt: string | null;
  /** The schema exists but was built by other files (a new build is needed). */
  stale: boolean;
}

/** Whether `refdata` holds a build the code can read (its meta's fingerprint is the code's). */
export async function refdataState(db: DbQueries): Promise<RefdataState> {
  const exists = await db.one<{ found: boolean }>(`SELECT to_regclass('${REFDATA_SCHEMA}.meta') IS NOT NULL AS found`);
  if (!exists?.found) return { ready: false, buildId: null, builtAt: null, stale: false };
  const rows = await db.all<{ key: string; value: string }>(`SELECT key, value::text AS value FROM ${REFDATA_SCHEMA}.meta`);
  const meta = new Map(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  const ready = meta.get('format') === refdataFingerprint();
  return {
    ready,
    stale: !ready,
    buildId: typeof meta.get('build_id') === 'number' ? (meta.get('build_id') as number) : null,
    builtAt: typeof meta.get('built_at') === 'string' ? (meta.get('built_at') as string) : null,
  };
}
