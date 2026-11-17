import type { DbQueries } from '../../core/db/types';
import { DAY_MS } from '@tailorit/shared';

// v3.0 DB-INGEST (12-job-sourcing.md §7.2 step 4, §7.3; 11-database.md §5.5): the fuzzy match. One posting copied to two
// boards (or a board and a feed) differs by a footer, a tracking line or an equal-opportunity paragraph: its words are
// nearly the same, so its text fingerprint (a 64-bit SimHash over the description's word 5-grams, jobs.text_simhash)
// is within a few bits of the other copy's, while two different postings differ in about half of the 64 bits.
//
// A posting with no job by its source id, its keys or its exact text is filed under a job by its fingerprint only when
// everything else agrees: the same company, the same title key (the dedup block, idx_jobs_dedup: a handful of rows even
// for an employer with thousands of open jobs), the same place key, posted within FUZZY_POSTED_WITHIN_DAYS of each other,
// fingerprints within JOB_FUZZY_SIMHASH_BITS (an admin constant, 3), never a job one account made from a page, never a
// job the same source lists, never two postings of one board with different ids. Every such match is logged with its
// distance (job_fuzzy_matches), so an admin can see it and split it.

/** Words a shingle holds (12 §7.3: word 5-grams). */
export const SIMHASH_SHINGLE_WORDS = 5;
/** Days between two postings' times beyond which they are never one job by their text alone (12 §13's unnamed 30). */
export const FUZZY_POSTED_WITHIN_DAYS = 30;
/** Candidates read per fuzzy look, nearest first (the block is a company's open jobs of one title). */
const FUZZY_CANDIDATES = 20;

/** FNV-1a over a string's UTF-16 units from a given offset basis: one 32-bit half of a word's 64-bit hash. */
function fnv1a(text: string, basis: number): number {
  let hash = basis;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** murmur3's finaliser: spreads every input bit over the 32 output bits. */
function mix32(value: number): number {
  let hash = value;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The words a fingerprint reads: NFKC, lower case, runs of letters and digits. */
export function fingerprintWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The text's 64-bit SimHash over its word 5-grams, as a signed 64-bit integer (jobs.text_simhash is a bigint); null for
 * a text of fewer than SIMHASH_SHINGLE_WORDS words. Pure and deterministic: the same text always gives the same value.
 */
export function simhash64(text: string): bigint | null {
  const words = fingerprintWords(text);
  if (words.length < SIMHASH_SHINGLE_WORDS) return null;
  const high = new Uint32Array(words.length);
  const low = new Uint32Array(words.length);
  for (let index = 0; index < words.length; index += 1) {
    high[index] = fnv1a(words[index]!, 0x811c9dc5);
    low[index] = fnv1a(words[index]!, 0x01234567);
  }
  const votes = new Int32Array(64);
  for (let start = 0; start + SIMHASH_SHINGLE_WORDS <= words.length; start += 1) {
    let hi = 0x9e3779b9;
    let lo = 0x7f4a7c15;
    for (let offset = 0; offset < SIMHASH_SHINGLE_WORDS; offset += 1) {
      hi = Math.imul(hi ^ high[start + offset]!, 0x01000193) + offset;
      lo = Math.imul(lo ^ low[start + offset]!, 0x01000193) + offset;
    }
    hi = mix32(hi >>> 0);
    lo = mix32((lo ^ hi) >>> 0);
    for (let bit = 0; bit < 32; bit += 1) {
      votes[bit]! += (lo >>> bit) & 1 ? 1 : -1;
      votes[32 + bit]! += (hi >>> bit) & 1 ? 1 : -1;
    }
  }
  let loBits = 0;
  let hiBits = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (votes[bit]! > 0) loBits |= 1 << bit;
    if (votes[32 + bit]! > 0) hiBits |= 1 << bit;
  }
  return BigInt.asIntN(64, (BigInt(hiBits >>> 0) << 32n) | BigInt(loBits >>> 0));
}

/** Bits that differ between two fingerprints (0-64). */
export function hammingDistance(a: bigint, b: bigint): number {
  let value = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (value > 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

/** A place as the fuzzy match compares it. */
export interface FuzzyPlace {
  city: string | null;
  region: string | null;
  countryCode: string | null;
  isRemote: boolean | number | null;
}

/**
 * The place key of a posting's first place (12 §7.3): `country:region:city`, or `remote:<country or any>`; '' for a
 * posting that names no place (two such postings agree).
 */
export function placeKeyOf(place: FuzzyPlace | null | undefined): string {
  if (!place) return '';
  const part = (value: string | null) => (value ?? '').trim().toLowerCase();
  if (place.isRemote === true || place.isRemote === 1) return `remote:${part(place.countryCode) || 'any'}`;
  return `${part(place.countryCode)}:${part(place.region)}:${part(place.city)}`;
}

export interface FuzzyLook {
  companyId: number;
  titleKey: string;
  simhash: bigint;
  placeKey: string;
  /** The posting's time (posted, else now): candidates within FUZZY_POSTED_WITHIN_DAYS of it. */
  postedAt: string;
  /** The source writing it: a job this source lists is another of its postings. */
  sourceId: number;
  /** The posting's ATS board (`greenhouse:acme:`), when it has one: a job with another posting of that board is not it. */
  atsBoard: string | null;
  /** JOB_FUZZY_SIMHASH_BITS. */
  threshold: number;
}

export interface FuzzyMatch {
  jobId: number;
  distance: number;
}

interface CandidateRow {
  id: number;
  distance: number;
  country_code: string | null;
  region: string | null;
  city: string | null;
  is_remote: boolean | null;
}

/** The byte-order range of `ats` keys of one board: `[prefix, prefix + 1)`. */
export function boardRange(prefix: string): [string, string] {
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`];
}

/**
 * The SQL that keeps a candidate job `j` out of a posting's match: another posting of the same source, or of the same
 * ATS board (a range of its `ats` keys; the parameters are the source id, then the range's two ends, or NULLs when the
 * posting names no board). Shared by the exact-text step and the fuzzy step.
 */
export const NOT_SAME_BOARD_SQL =
  'NOT EXISTS (SELECT 1 FROM job_source_links l WHERE l.job_id = j.id AND l.source_id = ?) ' +
  "AND NOT EXISTS (SELECT 1 FROM job_keys k WHERE k.job_id = j.id AND k.key_kind = 'ats' AND k.key >= CAST(? AS text) " +
  'AND k.key < CAST(? AS text))';

/** NOT_SAME_BOARD_SQL's parameters. */
export function notSameBoardParams(sourceId: number, atsBoard: string | null): [number, string | null, string | null] {
  if (!atsBoard) return [sourceId, null, null];
  const [from, to] = boardRange(atsBoard);
  return [sourceId, from, to];
}

/** The open job a posting is by its fingerprint (12 §7.2 step 4), nearest first; null when none agrees. */
export async function findFuzzyMatch(db: DbQueries, look: FuzzyLook): Promise<FuzzyMatch | null> {
  const at = Date.parse(look.postedAt);
  if (!Number.isFinite(at)) return null;
  const rows = await db.all<CandidateRow>(
    `SELECT j.id, bit_count(CAST((j.text_simhash # CAST(? AS bigint)) AS bit(64))) AS distance,
            l.country_code, l.region, l.city, l.is_remote
       FROM jobs j
       LEFT JOIN LATERAL (SELECT country_code, region, city, is_remote FROM job_locations
                           WHERE job_id = j.id ORDER BY position LIMIT 1) l ON true
      WHERE j.company_id = ? AND j.title_key = ? AND j.active AND j.owner_user_id IS NULL AND j.text_simhash IS NOT NULL
        AND j.posted_sort >= ? AND j.posted_sort <= ? AND ${NOT_SAME_BOARD_SQL}
      ORDER BY distance, j.id LIMIT ${FUZZY_CANDIDATES}`,
    [
      look.simhash.toString(),
      look.companyId,
      look.titleKey,
      new Date(at - FUZZY_POSTED_WITHIN_DAYS * DAY_MS).toISOString(),
      new Date(at + FUZZY_POSTED_WITHIN_DAYS * DAY_MS).toISOString(),
      ...notSameBoardParams(look.sourceId, look.atsBoard),
    ],
  );
  for (const row of rows) {
    if (row.distance > look.threshold) break;
    const place = placeKeyOf({ city: row.city, region: row.region, countryCode: row.country_code, isRemote: row.is_remote });
    if (place === look.placeKey) return { jobId: row.id, distance: row.distance };
  }
  return null;
}

/** Logs a fuzzy match (job_fuzzy_matches). Joins the caller's transaction. */
export async function logFuzzyMatch(
  db: DbQueries,
  entry: { jobId: number; sourceId: number; sourceJobId: string; distance: number; threshold: number; at: string },
): Promise<void> {
  await db.run(
    'INSERT INTO job_fuzzy_matches(job_id, source_id, source_job_id, distance, threshold, matched_at) VALUES (?, ?, ?, ?, ?, ?)',
    [entry.jobId, entry.sourceId, entry.sourceJobId, entry.distance, entry.threshold, entry.at],
  );
}
