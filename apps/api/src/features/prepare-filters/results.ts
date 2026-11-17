import { FilterReasonEntrySchema, type FilterReasonEntry, type FilterVerdict } from '@tailorit/shared';
import type { DbClient, DbQueries } from '../../core/db/index';

// v2.0 P4: each saved job's latest filter verdict (prepare_filter_results, 0824): the "Filtered: on-site" label of the
// Saved list and the Tracker card. Fresh while its filters_revision and facts_version are current; a stale one is
// computed again by the next read that records (PrepareFilterService.evaluate with `record`).
// v3.0 D2-F: on the async client.

export interface StoredFilterResult {
  applicationId: string;
  jobId: number | null;
  verdict: 'pass' | 'fail';
  reasons: FilterReasonEntry[];
  filtersRevision: number;
  factsVersion: number;
  checkedAt: string;
}

/** recordFilterResults's upsert. */
export const UPSERT_RESULT_SQL = `INSERT INTO prepare_filter_results(application_id, user_id, job_id, verdict, reasons, filters_revision, facts_version, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(application_id) DO UPDATE SET job_id = excluded.job_id, verdict = excluded.verdict, reasons = excluded.reasons,
       filters_revision = excluded.filters_revision, facts_version = excluded.facts_version, checked_at = excluded.checked_at`;

type Stamp = { filtersRevision: number; factsVersion: number; checkedAt: string };
type ResultInput = { applicationId: string; jobId: number; verdict: FilterVerdict };

/** One verdict's values, in UPSERT_RESULT_SQL's order. */
export function filterResultValues(userId: string, row: ResultInput, stamp: Stamp): Array<string | number> {
  return [
    row.applicationId,
    userId,
    row.jobId,
    row.verdict.verdict,
    JSON.stringify(row.verdict.reasons),
    stamp.filtersRevision,
    stamp.factsVersion,
    stamp.checkedAt,
  ];
}

/** Writes the verdicts in one transaction of their own, so a later refusal of the request leaves the labels. */
export async function recordFilterResults(
  db: Pick<DbClient, 'atomic'>,
  userId: string,
  rows: readonly ResultInput[],
  stamp: Stamp,
): Promise<void> {
  if (rows.length === 0) return;
  await db.atomic(
    async (t) => {
      for (const row of rows) await t.run(UPSERT_RESULT_SQL, filterResultValues(userId, row, stamp));
    },
    { label: 'recordFilterResults' },
  );
}

/** A stored verdict row. */
export interface FilterResultRow {
  application_id: string;
  job_id: number | null;
  verdict: 'pass' | 'fail';
  reasons: string;
  filters_revision: number;
  facts_version: number;
  checked_at: string;
}

/** The SELECT of readFilterResults, given the dialect's JSON-array table. */
export const readResultsSql = (jsonEach: string) =>
  'SELECT application_id, job_id, verdict, reasons, filters_revision, facts_version, checked_at FROM prepare_filter_results ' +
  `WHERE user_id = ? AND application_id IN (SELECT value FROM ${jsonEach})`;

/** The stored verdicts of the person's applications (any revision; the caller tells fresh from stale). */
export async function readFilterResults(
  db: DbQueries,
  userId: string,
  applicationIds: readonly string[],
): Promise<Map<string, StoredFilterResult>> {
  if (applicationIds.length === 0) return new Map();
  const rows = await db.all<FilterResultRow>(readResultsSql(db.dialect.jsonEach('?')), [userId, JSON.stringify(applicationIds)]);
  return filterResultsOf(rows);
}

/** Stored verdict rows as results, by application (a reason that no longer reads is left out). */
export function filterResultsOf(rows: readonly FilterResultRow[]): Map<string, StoredFilterResult> {
  const out = new Map<string, StoredFilterResult>();
  for (const row of rows) {
    let reasons: FilterReasonEntry[] = [];
    try {
      const value: unknown = JSON.parse(row.reasons);
      reasons = Array.isArray(value)
        ? value.map((entry) => FilterReasonEntrySchema.safeParse(entry)).flatMap((parsed) => (parsed.success ? [parsed.data] : []))
        : [];
    } catch {
      reasons = [];
    }
    out.set(row.application_id, {
      applicationId: row.application_id,
      jobId: row.job_id,
      verdict: row.verdict,
      reasons,
      filtersRevision: row.filters_revision,
      factsVersion: row.facts_version,
      checkedAt: row.checked_at,
    });
  }
  return out;
}
