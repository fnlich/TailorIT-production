import type { RunContinueResult, RunsContinueResult, RunsPauseResult } from '@tailorit/shared';
import type { AdminActor } from '../../core/admin/index';
import { nowIso, type AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { notifyRunsControl, type RunsControlScope } from '../notifications/index'; // v31 RUNS (INT-1: NOTIFY's)
import { RUNS_PAUSED_KEY, runsPaused, runsPausedState } from './pause-state';
import { NEW_READ_KIND_OF } from './scheduler';
import { requireIngest } from './service';
import { adminRun, adminSource, getSourceRecord, type AdminRunDetail, type AdminSource } from './sources';
import { SCHEDULED_KINDS, UNRUN_KINDS } from './types';

// v31 RUNS: an admin's Pause and Continue (docs/design/v3.1/22-runs-pause.md, SP\v31\PLAN.md §4 RUNS, D5), behind the
// routes of router.ts (POST /api/admin/runs/pause, /continue, /:id/pause, /:id/continue; /api/admin/sources/:id/pause,
// /:id/continue). What a pause is, as every process reads it, is pause-state.ts.
//
//   Pause every run    app_settings' `ingest:paused`; every running run is asked to stop. The worker starts nothing
//                      (no due source, no robots.txt read, no discovery validation, no review re-check, no enrichment
//                      step that reads an outside host); Run now refuses (MSG_INGEST_RUNS_PAUSED).
//   Continue           the key goes; the sources whose last run was paused are due now; a stop asked during the pause
//                      that has not taken effect yet is taken back.
//   Pause one run      the run is asked to stop; its source keeps its schedule (the next run after its cadence).
//   Continue one run   the source runs again now, from the top (a Run now; its source's own pause goes with it).
//   Pause one source   job_sources.paused_at, paused_by; its running run is asked to stop; no run of it starts.
//   Continue a source  its pause goes; due now when its last run was paused.
// Each is idempotent (a second Pause keeps the first one's time and admin). The process that runs a run stops it at its
// next safe point within RUN_STOP_POLL_MS (service.ts checkStops); this process looks at once. After each change is
// committed, NOTIFY's notifyRunsControl tells the other admins who did what (scope `all`, or the source's name for a
// source or a run).

/** The kinds the worker's due queue runs (a paused one is due again when continued). */
const scheduledKinds = () => [...new Set([...SCHEDULED_KINDS, ...Object.keys(NEW_READ_KIND_OF)])].join(',');

/** This process's runs that were asked to stop, stopped now (the others' processes look within RUN_STOP_POLL_MS). */
async function stopHere(deps: AppDeps): Promise<void> {
  try {
    await deps.services.ingest?.checkStops();
  } catch (error) {
    deps.log.warn('[ingest] could not stop the paused runs of this process at once; they stop at the next look', error);
  }
}

/**
 * Tells the other admins (NOTIFY's notifyRunsControl) once the change is committed: the admin by their name (their
 * email when they have none). NOTIFY's never throws; a failure here still never fails the admin's request.
 */
async function announce(deps: AppDeps, actor: AdminActor, action: 'paused' | 'continued', scope: RunsControlScope): Promise<void> {
  try {
    const name = (await deps.db.one<{ name: string | null }>('SELECT name FROM users WHERE id = ?', [actor.id]))?.name?.trim();
    await notifyRunsControl(deps, { actorId: actor.id, actorName: name || actor.email, action, scope });
  } catch (error) {
    deps.log.warn('[ingest] the other admins could not be told of a runs pause', error);
  }
}

/** POST /api/admin/runs/pause: every run paused (or still paused, since the first pause). */
export async function pauseAllRuns(deps: AppDeps, actor: AdminActor): Promise<RunsPauseResult> {
  const at = nowIso(deps);
  const { started, stopping } = await deps.db.tx(
    async (t) => {
      const added = await t.run(
        `INSERT INTO app_settings(key, value, updated_at, updated_by) VALUES (?, CAST(? AS json), CAST(? AS timestamptz), ?)
         ON CONFLICT (key) DO NOTHING`,
        [RUNS_PAUSED_KEY, JSON.stringify({ at, by: actor.id }), at, actor.id],
      );
      const asked = await t.run(
        "UPDATE job_source_runs SET stop_requested_at = CAST(? AS timestamptz) WHERE status = 'running' AND stop_requested_at IS NULL",
        [at],
      );
      return { started: added.changes > 0, stopping: asked.changes };
    },
    { label: 'pause every run' },
  );
  await stopHere(deps);
  const paused = await runsPausedState(deps.db);
  if (started) await announce(deps, actor, 'paused', { kind: 'all' });
  return { paused: paused ?? { at, by: actor.email }, stopping };
}

/** POST /api/admin/runs/continue: runs go on; the sources whose last run was paused are due now. */
export async function continueAllRuns(deps: AppDeps, actor: AdminActor): Promise<RunsContinueResult> {
  const at = nowIso(deps);
  const { was, resumed } = await deps.db.tx(
    async (t) => {
      const gone = await t.one<{ value: unknown; updated_at: string | null }>(
        'DELETE FROM app_settings WHERE key = ? RETURNING value, updated_at',
        [RUNS_PAUSED_KEY],
      );
      if (!gone) return { was: false, resumed: 0 };
      // A stop asked since the pause began that its run has not reached yet is taken back (the run goes on).
      await t.run(
        "UPDATE job_source_runs SET stop_requested_at = NULL WHERE status = 'running' AND stop_requested_at >= CAST(? AS timestamptz)",
        [gone.updated_at ?? at],
      );
      const due = await t.run(
        `UPDATE job_sources SET next_run_at = CAST(@at AS timestamptz)
         WHERE last_status = 'paused' AND paused_at IS NULL AND kind = ANY(string_to_array(@kinds, ','))
           AND (lease_until IS NULL OR lease_until < CAST(@at AS timestamptz))`,
        { at, kinds: scheduledKinds() },
      );
      return { was: true, resumed: due.changes };
    },
    { label: 'continue every run' },
  );
  if (was) await announce(deps, actor, 'continued', { kind: 'all' });
  return { paused: null, resumed };
}

/** POST /api/admin/runs/:id/pause: the run is asked to stop at its next safe point. Answers the run. */
export async function pauseRun(deps: AppDeps, runId: number, actor: AdminActor): Promise<AdminRunDetail> {
  const at = nowIso(deps);
  const asked = await deps.db.one<{ name: string; fresh: boolean }>(
    `UPDATE job_source_runs r SET stop_requested_at = COALESCE(r.stop_requested_at, CAST(? AS timestamptz))
     FROM job_sources s WHERE r.id = ? AND r.status = 'running' AND s.id = r.source_id
     RETURNING s.name, r.stop_requested_at = CAST(? AS timestamptz) AS fresh`,
    [at, runId, at],
  );
  if (!asked) {
    const run = await adminRun(deps.db, runId);
    if (!run) throw notFound('That run');
    if (run.status === 'paused') return run;
    throw refuse(deps, 'conflict', 'MSG_INGEST_RUN_NOT_RUNNING');
  }
  await stopHere(deps);
  if (asked.fresh) await announce(deps, actor, 'paused', { kind: 'source', sourceName: asked.name });
  return (await adminRun(deps.db, runId))!;
}

/**
 * POST /api/admin/runs/:id/continue: a paused run's source runs again now, from the top (a Run now in this process),
 * its own pause taken off. Refused while every run is paused.
 */
export async function continueRun(deps: AppDeps, runId: number, actor: AdminActor): Promise<RunContinueResult> {
  const run = await adminRun(deps.db, runId);
  if (!run) throw notFound('That run');
  if (run.status !== 'paused') throw refuse(deps, 'conflict', 'MSG_INGEST_RUN_NOT_PAUSED');
  if (await runsPaused(deps)) throw refuse(deps, 'conflict', 'MSG_INGEST_RUNS_PAUSED');
  // Continue on a run is "run it again now": the source's own pause goes with it.
  await deps.db.run('UPDATE job_sources SET paused_at = NULL, paused_by = NULL WHERE id = ? AND paused_at IS NOT NULL', [run.sourceId]);
  const quick = run.sourceKind === 'seed' || run.sourceKind === 'csv' || run.sourceKind === 'json';
  const started = await requireIngest(deps).run(run.sourceId, 'manual', { bypassSlots: quick });
  await announce(deps, actor, 'continued', { kind: 'source', sourceName: run.sourceName });
  return { runId: started.runId, sourceId: run.sourceId };
}

/** POST /api/admin/sources/:id/pause: no run of the source starts until Continue; its running run stops. */
export async function pauseSource(deps: AppDeps, sourceId: number, actor: AdminActor): Promise<AdminSource> {
  const source = await getSourceRecord(deps.db, sourceId);
  if (!source) throw notFound('That job source');
  if (UNRUN_KINDS.includes(source.kind)) throw refuse(deps, 'validation_failed', 'MSG_INGEST_SOURCE_NEVER_PAUSED');
  const at = nowIso(deps);
  const fresh = await deps.db.tx(
    async (t) => {
      const set = await t.run('UPDATE job_sources SET paused_at = CAST(? AS timestamptz), paused_by = ? WHERE id = ? AND paused_at IS NULL', [
        at,
        actor.id,
        sourceId,
      ]);
      await t.run(
        "UPDATE job_source_runs SET stop_requested_at = CAST(? AS timestamptz) WHERE source_id = ? AND status = 'running' AND stop_requested_at IS NULL",
        [at, sourceId],
      );
      return set.changes > 0;
    },
    { label: 'pause source' },
  );
  await stopHere(deps);
  if (fresh) await announce(deps, actor, 'paused', { kind: 'source', sourceName: source.name });
  return (await adminSource(deps.db, sourceId, deps.services.ingest?.isRunning(sourceId) ?? false, at))!;
}

/** POST /api/admin/sources/:id/continue: its pause goes; due now when its last run was paused. */
export async function continueSource(deps: AppDeps, sourceId: number, actor: AdminActor): Promise<AdminSource> {
  const source = await getSourceRecord(deps.db, sourceId);
  if (!source) throw notFound('That job source');
  const at = nowIso(deps);
  const was = await deps.db.tx(
    async (t) => {
      const row = await t.one<{ paused_at: string | null }>('SELECT paused_at FROM job_sources WHERE id = ? FOR UPDATE', [sourceId]);
      if (!row?.paused_at) return false;
      await t.run(
        `UPDATE job_sources SET paused_at = NULL, paused_by = NULL,
           next_run_at = CASE WHEN last_status = 'paused' AND kind = ANY(string_to_array(@kinds, ',')) THEN CAST(@at AS timestamptz)
             ELSE next_run_at END
         WHERE id = @id`,
        { id: sourceId, at, kinds: scheduledKinds() },
      );
      // A stop the pause asked that its run has not reached yet is taken back (the run goes on).
      await t.run(
        "UPDATE job_source_runs SET stop_requested_at = NULL WHERE source_id = ? AND status = 'running' AND stop_requested_at >= CAST(? AS timestamptz)",
        [sourceId, row.paused_at],
      );
      return true;
    },
    { label: 'continue source' },
  );
  if (was) await announce(deps, actor, 'continued', { kind: 'source', sourceName: source.name });
  return (await adminSource(deps.db, sourceId, deps.services.ingest?.isRunning(sourceId) ?? false, at))!;
}
