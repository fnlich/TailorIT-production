import { ADMIN_BULK_MAX } from '@tailorit/shared/reviews';
import {
  ADMIN_SOURCE_BULK_OUTCOMES,
  type AdminSourceAllAction,
  type AdminSourceBulkAction,
  type AdminSourcesAllCount,
  type AdminSourcesAllResult,
  type AdminSourcesBulkResult,
} from '@tailorit/shared/sourcing';
import { countLabel } from '../../../../lib/format';

// v30 S1-WEB: Admin › Sources' bulk actions (12 §9.8: bulk enable and disable; CT adds "run now"). One request names at
// most ADMIN_BULK_MAX sources (14 §6.2), so a larger choice goes out in turns and the answers are put together; each
// source is answered done, skipped (already so, forbidden by its terms or robots, gone) or failed, with why. Pure.

type Outcome = (typeof ADMIN_SOURCE_BULK_OUTCOMES)[number];

/**
 * The bulk bar's buttons. v31 RUNS: turning a source off reads "Disable" (it said "Pause"), since Pause is now an admin's
 * pause of runs (Admin › Runs), apart from Enabled.
 */
export const BULK_ACTION_LABEL: Record<AdminSourceBulkAction, string> = {
  enable: 'Enable',
  disable: 'Disable',
  run_now: 'Run now',
};

/** What a done source became, for the toast: "12 sources enabled". */
const DONE_WORDS: Record<AdminSourceBulkAction, string> = {
  enable: 'enabled',
  disable: 'disabled',
  run_now: 'due to run now',
};

/** `ids` in turns of at most `size`, in their order. */
export function chunkIds<T>(ids: readonly T[], size: number = ADMIN_BULK_MAX): T[][] {
  const turns: T[][] = [];
  for (let start = 0; start < ids.length; start += size) turns.push(ids.slice(start, start + size));
  return turns;
}

/** The answers of every turn as one: the rows in order, the counts added up. */
export function mergeBulkResults(results: readonly AdminSourcesBulkResult[]): AdminSourcesBulkResult {
  const counts: Partial<Record<Outcome, number>> = {};
  for (const result of results) {
    for (const outcome of ADMIN_SOURCE_BULK_OUTCOMES) {
      const count = result.counts[outcome];
      if (count) counts[outcome] = (counts[outcome] ?? 0) + count;
    }
  }
  return { results: results.flatMap((result) => result.results), counts };
}

/**
 * Sends `ids` in turns (one after another, so the server never holds two of them at once), and joins the answers. A turn
 * that fails answers each of its sources failed, with `failure`'s words, and the next turn still goes.
 */
export async function runBulk(
  ids: readonly number[],
  send: (ids: readonly number[]) => Promise<AdminSourcesBulkResult>,
  failure: (error: unknown) => string,
): Promise<AdminSourcesBulkResult> {
  const answers: AdminSourcesBulkResult[] = [];
  for (const turn of chunkIds(ids)) {
    try {
      answers.push(await send(turn));
    } catch (error) {
      const message = failure(error);
      answers.push({ results: turn.map((id) => ({ id, outcome: 'failed' as const, message })), counts: { failed: turn.length } });
    }
  }
  return mergeBulkResults(answers);
}

/** The rows that were not done, with their names (when shown) and the server's words. */
export interface BulkProblem {
  id: number | string;
  name: string;
  outcome: Exclude<Outcome, 'done'>;
  message: string;
}

export function bulkProblems(result: AdminSourcesBulkResult, nameOf: (id: number | string) => string | undefined): BulkProblem[] {
  return result.results
    .filter((row): row is typeof row & { outcome: Exclude<Outcome, 'done'> } => row.outcome !== 'done')
    .map((row) => ({
      id: row.id,
      name: nameOf(row.id) ?? `Source ${row.id}`,
      outcome: row.outcome,
      message: row.message ?? (row.outcome === 'skipped' ? 'Skipped.' : 'It could not be changed.'),
    }));
}

/**
 * What a bulk action did, for the notice above the table (not a toast: a toast would sit on the bulk bar's buttons):
 * what was done, how many were skipped or failed, and the notice's tone.
 */
export function bulkSummary(
  action: AdminSourceBulkAction,
  result: AdminSourcesBulkResult,
): { title: string; description: string | null; tone: 'success' | 'warning' | 'error' } {
  const done = result.counts.done ?? 0;
  const skipped = result.counts.skipped ?? 0;
  const failed = result.counts.failed ?? 0;
  const title = done > 0 ? `${countLabel(done, 'source', 'sources')} ${DONE_WORDS[action]}` : `No source ${DONE_WORDS[action]}`;
  const rest = [skipped ? `${skipped} skipped` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
  return {
    title,
    description: rest ? `${rest}:` : null,
    tone: failed > 0 && done === 0 ? 'error' : rest ? 'warning' : 'success',
  };
}

// v35 OPSWEB (PLAN H6): Enable all / Disable all for everything the filter shows (the server's AdminSourcesAll*), and
// the same for the sources one import found (Admin › Runs' Sources found).

/** "1,240 sources" (with thousands marks, unlike countLabel). */
export function counted(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** The confirm of Enable all / Disable all: "Enable 42 sources?" and what it does. */
export function allConfirmText(
  action: AdminSourceAllAction,
  count: AdminSourcesAllCount,
): { title: string; description: string; confirm: string; changes: number } {
  const changes = action === 'enable' ? count.canEnable : count.canDisable;
  const verb = action === 'enable' ? 'Enable' : 'Disable';
  const rest = count.total - changes;
  const be = rest === 1 ? 'is' : 'are';
  const left = rest > 0 ? ` The other ${rest.toLocaleString('en-US')} shown ${be} ${action === 'enable' ? 'on already or cannot run' : 'off already'}.` : '';
  return {
    title: `${verb} ${counted(changes, 'source', 'sources')}?`,
    description:
      action === 'enable'
        ? `They run on their schedule from now on.${left}`
        : `They stop running until an admin turns them on again; their jobs stay listed until a run closes them.${left}`,
    confirm: `${verb} ${counted(changes, 'source', 'sources')}`,
    changes,
  };
}

/** One line for what Enable all / Disable all did: "42 sources enabled", and the skipped and failed ones. */
export function allResultLine(result: Pick<AdminSourcesAllResult, 'action' | 'counts'>): { text: string; tone: 'success' | 'warning' | 'error' } {
  const done = result.counts.done ?? 0;
  const skipped = result.counts.skipped ?? 0;
  const failed = result.counts.failed ?? 0;
  const head = done > 0 ? `${counted(done, 'source', 'sources')} ${DONE_WORDS[result.action]}` : `No source ${DONE_WORDS[result.action]}`;
  const rest = [skipped ? `${skipped.toLocaleString('en-US')} skipped` : '', failed ? `${failed.toLocaleString('en-US')} failed` : ''].filter(Boolean).join(', ');
  return { text: rest ? `${head}; ${rest}.` : `${head}.`, tone: failed > 0 && done === 0 ? 'error' : rest ? 'warning' : 'success' };
}
// end v35 OPSWEB
