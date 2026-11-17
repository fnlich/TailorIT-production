import { linkKey, type JobKeyKind } from '@tailorit/shared';
import { isLinkedInHost, parseAtsUrl } from '@tailorit/shared/autofill';
import type { DbQueries } from '../../core/db/types';

// v3.0 DB-INGEST (11-database.md §5.5, 12-job-sourcing.md §7.1): the shared identity keys a job is known by (job_keys),
// replacing v2.0's single jobs.link_key. A key names one job (the primary key (key_kind, key), COLLATE "C"); a job has
// a few. Written in the job's transaction (store.ts), read by ingest's matching order (step 2: a posting's key names the
// job) and by the autofill lookup (the posting's addresses). The (source, posting id) identity stays in
// job_source_links; an account's private addresses stay in job_link_aliases; a job one account made from a page keeps
// no key at all (no other posting, source or account finds it by its link).
//
// The kinds:
// - `link`: the shared linkKey of an address the job was written with (https, host in lower case, tracking parameters
//   dropped, the rest sorted): each source's apply link of the posting.
// - `ats`: the ATS posting an address names, read by the shared parseAtsUrl (30-odd platforms): `<platform>:<board>:<id>`
//   for the platforms whose board names a posting on any host (Greenhouse, Lever, Ashby, Workable, Workday), else
//   `<platform>:<host>[/<board>]:<id>` (an iCIMS portal, a JazzHR tenant: the host is part of the identity), in lower
//   case as the lookup's postingIdentity compares them. A Workday requisition's postings (…_JR123-1, …_JR123-2) keep
//   their own ids: two postings, two jobs (12 §7.4). A company page's ?gh_jid= names no board: no `ats` key (its
//   `ghjid` key needs E0's domain aliases, 12 §7.1).
// - `ld` (a career page's JSON-LD identifier) and `ghjid` (a company page's ?gh_jid= on a domain aliased to its board):
//   their builders are here for the wave-4 sources that read them (S5's career pages, E0/E1's aliases).

/** One identity key. */
export interface JobKey {
  kind: JobKeyKind;
  key: string;
}

/** The longest key job_keys keeps (its CHECK): a longer address is no key (it is matched by its other keys). */
export const JOB_KEY_MAX_CHARS = 2048;

/** The platforms whose board names a posting on whichever host shows it (the lookup's BOARD_IDENTITY_KINDS). */
const BOARD_KINDS: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'workday']);

/** The preference among a posting's keys when they name different jobs: the posting's ATS identity first. */
const KIND_ORDER: Record<JobKeyKind, number> = { ats: 0, ld: 1, ghjid: 2, link: 3 };

function hostOf(address: string): string | null {
  try {
    return new URL(address.trim()).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The board an ATS address names, as its `ats` keys start (`greenhouse:acme:`); null when it names no ATS posting. */
export function atsBoardOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const host = hostOf(address);
  if (!host || isLinkedInHost(host)) return null;
  const parsed = parseAtsUrl(address);
  if (!parsed || !parsed.externalId) return null;
  // A company page's ?gh_jid= (no board): its identity needs the domain's alias to the board (`ghjid`, E0).
  if (parsed.kind === 'greenhouse' && parsed.board === null) return null;
  const owner = BOARD_KINDS.has(parsed.kind) ? parsed.board : parsed.board ? `${host}/${parsed.board}` : host;
  if (!owner) return null;
  return `${parsed.kind}:${owner}:`.toLowerCase();
}

/** The `ats` key of an address (`greenhouse:acme:4012345`), or null when it names no ATS posting. */
export function atsKeyOf(address: string | null | undefined): string | null {
  const board = atsBoardOf(address);
  if (!board) return null;
  return `${board}${parseAtsUrl(address!)!.externalId}`.toLowerCase();
}

/** The `ld` key of a JSON-LD JobPosting identifier on its hiring organization's domain (S5, wave 4). */
export function ldKeyOf(domain: string, identifier: string): string | null {
  const host = domain.trim().toLowerCase().replace(/\.+$/, '');
  const id = identifier.trim();
  return host && id ? `${host}:${id}` : null;
}

/** The `ghjid` key of a company page's ?gh_jid= (`acme.com:4012345`), for a domain E0 aliases to its board (wave 4). */
export function ghjidKeyOf(domain: string, jobId: string): string | null {
  return ldKeyOf(domain, jobId);
}

/** Keys without repeats or over-long values, in one order (kind, then the key): every writer inserts them so. */
export function tidyKeys(keys: ReadonlyArray<JobKey | null | undefined>): JobKey[] {
  const seen = new Set<string>();
  const out: JobKey[] = [];
  for (const entry of keys) {
    if (!entry || !entry.key || entry.key.length > JOB_KEY_MAX_CHARS) continue;
    const id = `${entry.kind}\u0000${entry.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  // One order for every writer, so two transactions inserting overlapping keys take their row locks in the same order
  // (never each waiting on the other's).
  return out.sort((a, b) => (a.kind === b.kind ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.kind < b.kind ? -1 : 1));
}

/** The keys of an address a shared job is written with: its link and, when it names one, its ATS posting. */
export function keysOfAddress(address: string | null | undefined): JobKey[] {
  if (!address) return [];
  const link = linkKey(address);
  const ats = atsKeyOf(address);
  return tidyKeys([link ? { kind: 'link', key: link } : null, ats ? { kind: 'ats', key: ats } : null]);
}

/** Of the job ids keys name, the one of the strongest key (ats, ld, ghjid, then link); null when none names a job. */
export function strongestMatch(rows: ReadonlyArray<{ key_kind: JobKeyKind; key: string; job_id: number }>): number | null {
  let best: { rank: number; jobId: number } | null = null;
  for (const row of rows) {
    const rank = KIND_ORDER[row.key_kind] ?? 9;
    if (!best || rank < best.rank || (rank === best.rank && row.job_id < best.jobId)) best = { rank, jobId: row.job_id };
  }
  return best?.jobId ?? null;
}

/** `(key_kind, key) IN (...)`'s list for `keys`, with its values. */
function keyList(keys: readonly JobKey[]): { sql: string; values: string[] } {
  return { sql: keys.map(() => '(?, ?)').join(', '), values: keys.flatMap((entry) => [entry.kind, entry.key]) };
}

/** The job_keys rows of these keys (which job each names). Joins the caller's transaction. */
export async function keyHolders(
  db: DbQueries,
  keys: readonly JobKey[],
): Promise<Array<{ key_kind: JobKeyKind; key: string; job_id: number }>> {
  if (keys.length === 0) return [];
  const list = keyList(keys);
  return db.all(`SELECT key_kind, key, job_id FROM job_keys WHERE (key_kind, key) IN (${list.sql})`, list.values);
}

/** The job the strongest of these keys names, or null (step 2 of ingest's matching order). */
export async function jobOfKeys(db: DbQueries, keys: readonly JobKey[]): Promise<number | null> {
  return strongestMatch(await keyHolders(db, keys));
}

/**
 * Gives `jobId` these keys (`ON CONFLICT DO NOTHING`: a key another job holds stays with it). Answers the job that
 * holds a key this call could not take, the strongest first; null when every key is the job's now. Joins the caller's
 * transaction. Two transactions adding overlapping keys at once: the second waits for the first's commit, then finds
 * the key taken.
 */
export async function addJobKeys(db: DbQueries, jobId: number, keys: readonly JobKey[]): Promise<number | null> {
  const tidy = tidyKeys(keys);
  if (tidy.length === 0) return null;
  const taken = await db.all<{ key_kind: JobKeyKind; key: string }>(
    `INSERT INTO job_keys(key_kind, key, job_id) VALUES ${tidy.map(() => '(?, ?, ?)').join(', ')}
     ON CONFLICT (key_kind, key) DO NOTHING RETURNING key_kind, key`,
    tidy.flatMap((entry) => [entry.kind, entry.key, jobId]),
  );
  if (taken.length === tidy.length) return null;
  const mine = new Set(taken.map((row) => `${row.key_kind}\u0000${row.key}`));
  const others = tidy.filter((entry) => !mine.has(`${entry.kind}\u0000${entry.key}`));
  return strongestMatch((await keyHolders(db, others)).filter((row) => row.job_id !== jobId));
}

/** A job's keys, in key order (tests, the admin's view). */
export async function keysOfJob(db: DbQueries, jobId: number): Promise<JobKey[]> {
  return (await db.all<{ key_kind: JobKeyKind; key: string }>('SELECT key_kind, key FROM job_keys WHERE job_id = ? ORDER BY key_kind, key', [jobId])).map(
    (row) => ({ kind: row.key_kind, key: row.key }),
  );
}
