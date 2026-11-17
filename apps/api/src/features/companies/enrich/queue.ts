import { COMPANY_ENRICHMENT_STEPS, type CompanyEnrichmentStep } from '@tailorit/shared';
import type { DbClient, DbQueries } from '../../../core/db/types';

// v30 E1: the enrichment queue's rows (company_enrichment_queue, 11-database.md §5.4: company_id, steps, priority,
// due_at, attempts, last_error, leased_until): claimed under a lease, finished by the worker that holds it.
//
// A claim takes the due rows (due_at <= now) nobody holds (leased_until empty or past) that name at least one step
// that may run now, oldest due first (then priority), FOR UPDATE SKIP LOCKED: two workers claiming at once take
// different rows, and a row leased by one is left alone by the other until its lease runs out (a worker that died).
// The lease's own time is the claim's token: a finish writes only while the row's leased_until is still the one its
// claim set (a later claim after the lease ran out has another), so a late finish never undoes newer work.
// v30 FIX-C (INT-4 open item 12): a name queued again while the claim holds the row (`requeued`, resolve.ts
// queueEnrichment) is not the claim's to remove: the finish keeps it due even when the claim did it. A claim starts
// with none.

export interface ClaimedRow {
  companyId: number;
  steps: CompanyEnrichmentStep[];
  attempts: number;
  /** leased_until as this claim set it: the finish's token. */
  lease: string;
}

const knownSteps = (value: unknown): CompanyEnrichmentStep[] =>
  Array.isArray(value) ? value.filter((step): step is CompanyEnrichmentStep => (COMPANY_ENRICHMENT_STEPS as readonly unknown[]).includes(step)) : [];

/** Claims up to `limit` due rows naming one of `names` (see the module's note). */
export async function claimEnrichment(
  db: DbQueries,
  input: { at: string; leaseUntil: string; names: readonly string[]; limit: number },
): Promise<ClaimedRow[]> {
  if (input.names.length === 0 || input.limit <= 0) return [];
  const rows = await db.all<{ company_id: number; steps: string; attempts: number; leased_until: string }>(
    `UPDATE company_enrichment_queue q SET leased_until = CAST(? AS timestamptz), requeued = '[]'::jsonb
     FROM (SELECT company_id FROM company_enrichment_queue
           WHERE due_at <= CAST(? AS timestamptz) AND (leased_until IS NULL OR leased_until <= CAST(? AS timestamptz))
             AND jsonb_exists_any(steps, ARRAY(SELECT jsonb_array_elements_text(CAST(? AS jsonb))))
           ORDER BY due_at, priority DESC, company_id
           LIMIT ? FOR UPDATE SKIP LOCKED) due
     WHERE q.company_id = due.company_id
     RETURNING q.company_id, q.steps::text AS steps, q.attempts, q.leased_until`,
    [input.leaseUntil, input.at, input.at, JSON.stringify(input.names), input.limit],
  );
  return rows
    .map((row) => ({ companyId: row.company_id, steps: knownSteps(JSON.parse(row.steps)), attempts: row.attempts, lease: row.leased_until }))
    .sort((a, b) => a.companyId - b.companyId);
}

export interface FinishInput {
  companyId: number;
  lease: string;
  at: string;
  /** Names done: they leave the row. */
  done: readonly string[];
  /** Names given up after their last failed attempt: they leave the row too. */
  dropped: readonly string[];
  /** A failed attempt: attempts + 1, due again at `retryAt`, its error kept. */
  failed: { error: string; retryAt: string } | null;
  /** A step waits: due again no sooner than this. */
  waitUntil: string | null;
}

export type FinishOutcome = 'deleted' | 'updated' | 'lost' | 'gone';

/** Ends a claim (see the module's note): the row goes when no name is left, else it is released with its new due time. */
export async function finishEnrichment(db: DbClient, input: FinishInput): Promise<FinishOutcome> {
  return db.tx(
    async (t) => {
      const row = await t.one<{ steps: string; requeued: string; attempts: number; due_at: string; leased_until: string | null }>(
        'SELECT steps::text AS steps, requeued::text AS requeued, attempts, due_at, leased_until FROM company_enrichment_queue WHERE company_id = ? FOR UPDATE',
        [input.companyId],
      );
      if (!row) return 'gone';
      if (!row.leased_until || new Date(row.leased_until).getTime() !== new Date(input.lease).getTime()) return 'lost';
      // A name queued again under this claim stays (see the module's note).
      const requeued = new Set((JSON.parse(row.requeued) as unknown[]).filter((step): step is string => typeof step === 'string'));
      const leaving = new Set([...input.done, ...input.dropped].filter((step) => !requeued.has(step)));
      // Sorted, as queueEnrichment's union keeps them.
      const left = (JSON.parse(row.steps) as unknown[]).filter((step): step is string => typeof step === 'string' && !leaving.has(step)).sort();
      if (left.length === 0) {
        await t.run('DELETE FROM company_enrichment_queue WHERE company_id = ?', [input.companyId]);
        return 'deleted';
      }
      const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : new Date(a) > new Date(b) ? a : b);
      let due = row.due_at;
      if (input.failed) due = later(due, input.failed.retryAt)!;
      if (input.waitUntil) due = later(due, input.waitUntil)!;
      // Attempts count the failures in a row of the names still due; a give-up or a success starts them again.
      const attempts = input.failed && input.dropped.length === 0 ? row.attempts + 1 : input.failed ? 0 : input.done.length > 0 ? 0 : row.attempts;
      const error = input.failed ? input.failed.error.slice(0, 1000) : input.done.length > 0 ? null : undefined;
      await t.run(
        `UPDATE company_enrichment_queue SET steps = CAST(? AS jsonb), due_at = CAST(? AS timestamptz), attempts = ?,
           last_error = CASE WHEN CAST(? AS boolean) THEN CAST(? AS text) ELSE last_error END, leased_until = NULL,
           requeued = '[]'::jsonb
         WHERE company_id = ?`,
        [JSON.stringify(left), due, attempts, error !== undefined, error ?? null, input.companyId],
      );
      return 'updated';
    },
    { label: 'enrichment finish' },
  );
}

/** Removes a claimed row (its company is gone, merged, opted out or an account's own), under the claim's lease. */
export async function dropClaimed(db: DbQueries, companyId: number, lease: string): Promise<boolean> {
  const done = await db.run('DELETE FROM company_enrichment_queue WHERE company_id = ? AND leased_until = CAST(? AS timestamptz)', [companyId, lease]);
  return done.changes > 0;
}
