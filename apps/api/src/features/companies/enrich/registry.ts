import { COMPANY_ENRICHMENT_STEPS, type CompanyEnrichmentStep } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import { runsPaused } from '../../ingest/pause-state'; // v31 RUNS

// v30 E1: the enrichment steps' registry (docs/design/part2/13-company-enrichment.md §7, 11-database.md §5.4). A row of
// company_enrichment_queue names the steps due for a company (`steps`: COMPANY_ENRICHMENT_STEPS names, joined by
// queueEnrichment); the worker (worker.ts) gives each name to the step that handles it.
//
// A step is one module's work, made with defineEnrichmentStep and listed once in steps.ts:
//
//   export const companySiteStep = defineEnrichmentStep({
//     name: 'company_site',                         // unique: the logs name it
//     handles: ['company_site', 'logo_dev'],        // the queue's step names it works (each handled by one step only)
//     enabled: (deps) => constantsOf(deps).get('SITE_READER_COMPANY_SITES'),   // optional: while false, its names
//                                                   // wait in the queue untouched (no lease, no attempt)
//     async run(deps, work) {                       // one company; outside any transaction (it may read outside hosts)
//       ...                                         // write in its own short transactions
//       return { kind: 'done' };                    // or { kind: 'wait', until, reason }: due again then, no attempt
//     },                                            //    a throw: a failed attempt, retried with backoff
//   });
//
// `work.steps` are the names of the row this step handles (a subset of `handles`); `work.signal` aborts when the worker
// stops. A step never deletes or edits the queue row itself: the worker does, under the row's lease.

/** One company's work for a step. */
export interface EnrichmentWork {
  companyId: number;
  /** The row's step names this step handles. */
  steps: readonly CompanyEnrichmentStep[];
  /** The row's failed attempts so far (0 the first time). */
  attempts: number;
  /** The worker's clock at the claim (ISO). */
  at: string;
  signal: AbortSignal;
}

/** What a step did: done (its names leave the row), or wait (its names stay, due again at `until`). A throw is a failure. */
export type EnrichmentOutcome = { kind: 'done' } | { kind: 'wait'; until: string; reason: string };

export type EnrichmentDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

export interface EnrichmentStep {
  readonly name: string;
  readonly handles: readonly CompanyEnrichmentStep[];
  /** Whether the step may run now (its switch, its key, its data). Absent: always. */
  enabled?(deps: EnrichmentDeps): boolean | Promise<boolean>;
  /**
   * v31 RUNS: whether the step reads an outside host now (a site, an API). Such a step waits, untouched in the queue,
   * while an admin paused every run (the worker's outside work). Absent: it reads none (it works from the database).
   */
  readsOutside?(deps: EnrichmentDeps): boolean;
  run(deps: EnrichmentDeps, work: EnrichmentWork): Promise<EnrichmentOutcome>;
}

/** A step, checked: a name, and handled names from COMPANY_ENRICHMENT_STEPS. */
export function defineEnrichmentStep(step: EnrichmentStep): EnrichmentStep {
  if (!/^[a-z][a-z0-9_]*$/.test(step.name)) throw new Error(`An enrichment step's name must be a plain word: "${step.name}".`);
  if (step.handles.length === 0) throw new Error(`The enrichment step "${step.name}" handles no step name.`);
  for (const handled of step.handles) {
    if (!(COMPANY_ENRICHMENT_STEPS as readonly string[]).includes(handled)) {
      throw new Error(`The enrichment step "${step.name}" handles "${handled}", which is not one of COMPANY_ENRICHMENT_STEPS.`);
    }
  }
  return Object.freeze({ ...step, handles: Object.freeze([...step.handles]) });
}

/** The step of each handled name; throws when two steps share a name or a handled name. */
export function stepsByName(steps: readonly EnrichmentStep[]): Map<CompanyEnrichmentStep, EnrichmentStep> {
  const names = new Set<string>();
  const byHandled = new Map<CompanyEnrichmentStep, EnrichmentStep>();
  for (const step of steps) {
    if (names.has(step.name)) throw new Error(`Two enrichment steps are named "${step.name}".`);
    names.add(step.name);
    for (const handled of step.handles) {
      const other = byHandled.get(handled);
      if (other) throw new Error(`"${handled}" is handled by two enrichment steps ("${other.name}" and "${step.name}").`);
      byHandled.set(handled, step);
    }
  }
  return byHandled;
}

/**
 * The steps that may run now, and the queue names they handle. v31 RUNS: while every run is paused, not the ones that
 * read an outside host (readsOutside).
 */
export async function enabledSteps(deps: EnrichmentDeps, steps: readonly EnrichmentStep[]): Promise<{ steps: EnrichmentStep[]; names: CompanyEnrichmentStep[] }> {
  const on: EnrichmentStep[] = [];
  const paused = await runsPaused(deps); // v31 RUNS
  for (const step of steps) {
    let enabled = true;
    try {
      if (paused && step.readsOutside?.(deps)) continue; // v31 RUNS: waits for Continue
      enabled = step.enabled ? await step.enabled(deps) : true;
    } catch (error) {
      enabled = false;
      deps.log.error(`[enrich] the step ${step.name} could not tell whether it may run; it waits`, error);
    }
    if (enabled) on.push(step);
  }
  return { steps: on, names: on.flatMap((step) => [...step.handles]) };
}
