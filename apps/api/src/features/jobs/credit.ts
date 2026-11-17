import { JobCreditSchema, type JobCredit } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';

// v30 S4: the credit line a job's source asks for on its card (docs/design/part2/12-job-sourcing.md §3.6-3.7, §12.1;
// owner question 10, accepted: "Source: Himalayas" where a source's terms require it). Each kind's credit is its
// job_source_kinds row's `attribution` (the baseline's: USAJOBS, Himalayas, Jobicy, Työmarkkinatori), so a new kind's
// credit is a row, not code.
//
// A job shows the credit of the source its fields come from: the store lets the highest-precedence source write a job
// (ingest/store.ts outranks), so a job Greenhouse and Himalayas both list shows Greenhouse's posting and needs no
// credit, and one only Himalayas lists shows "Himalayas". Live links first (a closed job's are all missing), then
// precedence, and on a tie the kind that asks for a credit (it may have written last). One small read per card, by
// the job's links (idx_jsl_job).

/** The job's credit as JSON text (jobs `alias`), or NULL: a column of SUMMARY_COLUMNS (jobs/rows.ts). */
export function jobCreditSql(alias: string): string {
  return jobCreditOfJobSql(`${alias}.id`);
}

/** v30 FIX-B: the same for a job named by an id expression (`a.job_id` of a tracker entry). */
export function jobCreditOfJobSql(jobId: string): string {
  return `(SELECT CAST(ck.attribution AS text) FROM job_source_links cl
      JOIN job_sources cs ON cs.id = cl.source_id JOIN job_source_kinds ck ON ck.kind = cs.kind
      WHERE cl.job_id = ${jobId}
      ORDER BY (cl.missing_since IS NULL) DESC, ck.precedence DESC, (ck.attribution IS NULL), cl.seq
      LIMIT 1)`;
}

/** The credit read from jobCreditSql's text, or null (none, or not a credit the contract takes). */
export function jobCreditOf(text: string | null | undefined): JobCredit | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = JobCreditSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** v30 FIX-B: `{ credit }` when the text holds one, else nothing (the contracts' optional field). */
export function creditFieldOf(text: string | null | undefined): { credit?: JobCredit } {
  const credit = jobCreditOf(text);
  return credit ? { credit } : {};
}

/**
 * v30 FIX-B (REQ-1, UX-10): what an account's own list rows show of their jobs (Saved, the Queue pane, the
 * extension's search): the source's credit line, and `closed` when the job is no longer active. One read for a page's
 * jobs, by id (the jobs' primary key and idx_jsl_job), after the page is chosen.
 */
export interface JobMarks {
  credit?: JobCredit;
  closed?: true;
}

export async function jobMarksOf(db: DbQueries, jobIds: ReadonlyArray<number | null | undefined>): Promise<Map<number, JobMarks>> {
  const ids = [...new Set(jobIds.filter((id): id is number => typeof id === 'number'))];
  const marks = new Map<number, JobMarks>();
  if (ids.length === 0) return marks;
  const rows = await db.all<{ id: number; active: boolean; credit_json: string | null }>(
    `SELECT j.id, j.active, ${jobCreditSql('j')} AS credit_json FROM jobs j WHERE j.id IN (${db.dialect.list(ids.length)})`,
    ids,
  );
  for (const row of rows) marks.set(row.id, { ...creditFieldOf(row.credit_json), ...(row.active === false ? { closed: true as const } : {}) });
  return marks;
}
