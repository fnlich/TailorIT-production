import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';
import { DAY_MS } from '@tailorit/shared';

// v30 DB-JOBS (D1g; docs/design/part2/11-database.md §8.1-8.2): the retention rules that need no partition, as daily
// steps of the account feature. Each deletes in batches through an index on its age column (11 §8.1: "batches of
// 10,000"), one statement a batch outside any transaction, so no lock outlives a batch; each window is a constant an
// admin may change. The partitioned tables (job_postings_raw, ai_task_payloads, job_texts) are D5L's housekeeping.
//   viewMarks      user_job_state: a view mark older than USER_JOB_VIEW_KEEP_DAYS; a hidden job stays hidden forever
//   draftAnswers   application_draft_answers: DRAFT_ANSWERS_KEEP_DAYS_AFTER_APPLY after applying, once every record of
//                  the entry holds what was sent (submitted answers, or prepared ones copied into answers_used); and
//                  those of an entry taken out of Saved Jobs more than DRAFT_ANSWERS_KEEP_DAYS_UNSAVED ago
//   closedJobFacts job_facts, job_facts_certifications, job_facts_eligibility of a job closed more than
//                  JOB_ANALYSIS_CLOSED_KEEP_DAYS ago that no tracker entry names (recomputable; a reopened job's facts
//                  are built again with it)
//   closedJobAnalyses job_analyses of a text no open, recently closed or tracked job has, made more than
//                  JOB_ANALYSIS_CLOSED_KEEP_DAYS ago (an AI analysis costs money to redo, so only texts nobody needs)
// Kept forever (11 §8.2): jobs, their texts, links and keys; applications and their records; snapshots; ledgers.

/** Rows one statement deletes at most (11 §8.1). */
export const RETENTION_BATCH = 10_000;
/** Drafts one statement of draftAnswers looks at (each holds a form's answers, a few dozen at most). */
export const DRAFT_BATCH = 1_000;

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const cutoffOf = (deps: Deps, days: number) => new Date(deps.now().getTime() - days * DAY_MS).toISOString();

/** Runs `step` until a pass deletes fewer than `batch` rows; answers the rows deleted. */
async function inBatches(step: () => Promise<number>, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await step();
    total += deleted;
    if (deleted < batch) return total;
  }
}

const VIEW_MARKS = `DELETE FROM user_job_state WHERE (user_id, job_id) IN (
    SELECT user_id, job_id FROM user_job_state WHERE hidden_at IS NULL AND viewed_at < ? LIMIT ?)`;

/** user_job_state: view marks past USER_JOB_VIEW_KEEP_DAYS (idx_user_job_state_viewed). Hidden jobs stay. */
export const pruneViewMarks: DailyStep = {
  name: 'viewMarks',
  run: async (deps) => {
    const cutoff = cutoffOf(deps, constantsOf(deps).get('USER_JOB_VIEW_KEEP_DAYS'));
    return inBatches(async () => (await deps.db.run(VIEW_MARKS, [cutoff, RETENTION_BATCH])).changes, RETENTION_BATCH);
  },
};

/** The drafts still holding answers, a page at a time (application_draft_answers' unique key leads with draft_id). */
const DRAFTS_WITH_ANSWERS = 'SELECT DISTINCT draft_id AS id FROM application_draft_answers WHERE draft_id > ? ORDER BY draft_id LIMIT ?';

/**
 * Of `ids`, the drafts whose answers go: an entry applied to (not Saved) whose records are all older than the cutoff
 * and each hold what was sent (no prepared record without its copied answers); or an entry still Saved but taken out of
 * Saved Jobs (archived) before the un-saved cutoff.
 */
const DUE_DRAFT_ANSWERS = (list: string) => `DELETE FROM application_draft_answers da USING application_drafts d, applications a
  WHERE da.draft_id = d.id AND a.id = d.application_id AND d.id IN (${list})
    AND (
      (a.current_status = 1 AND a.archived_at IS NOT NULL AND a.archived_at < @unsaved)
      OR (a.current_status <> 1
          AND EXISTS (SELECT 1 FROM application_apply_records r WHERE r.application_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM application_apply_records r WHERE r.application_id = a.id
                            AND (r.applied_at >= @applied OR (r.answers = 'prepared' AND r.answers_used IS NULL)))))`;

/** application_draft_answers past their windows (11 §8.2). */
export const pruneDraftAnswers: DailyStep = {
  name: 'draftAnswers',
  run: async (deps) => {
    const constants = constantsOf(deps);
    const applied = cutoffOf(deps, constants.get('DRAFT_ANSWERS_KEEP_DAYS_AFTER_APPLY'));
    const unsaved = cutoffOf(deps, constants.get('DRAFT_ANSWERS_KEEP_DAYS_UNSAVED'));
    let after = '';
    let deleted = 0;
    for (;;) {
      const ids = (await deps.db.all<{ id: string }>(DRAFTS_WITH_ANSWERS, [after, DRAFT_BATCH])).map((row) => row.id);
      if (ids.length === 0) return deleted;
      const named = Object.fromEntries(ids.map((id, index) => [`d${index}`, id]));
      const list = ids.map((_, index) => `@d${index}`).join(', ');
      deleted += (await deps.db.run(DUE_DRAFT_ANSWERS(list), { ...named, applied, unsaved })).changes;
      if (ids.length < DRAFT_BATCH) return deleted;
      after = ids[ids.length - 1]!;
    }
  },
};

/** A job closed before the cutoff that no tracker entry names (jobs `j`; idx_app_job). */
const CLOSED_UNTRACKED = `NOT j.active AND j.closed_at < @cutoff
  AND NOT EXISTS (SELECT 1 FROM applications ap WHERE ap.job_id = j.id)`;

/** One page of facts to delete: job ids after `after`, in order (job_facts' primary key, the job's by id). */
const CLOSED_FACTS_PAGE = `SELECT f.job_id FROM job_facts f JOIN jobs j ON j.id = f.job_id
  WHERE f.job_id > @after AND ${CLOSED_UNTRACKED} ORDER BY f.job_id LIMIT @limit`;

/** job_facts* of closed jobs nobody tracks, past JOB_ANALYSIS_CLOSED_KEEP_DAYS. */
export const pruneClosedJobFacts: DailyStep = {
  name: 'closedJobFacts',
  run: async (deps) => {
    const cutoff = cutoffOf(deps, constantsOf(deps).get('JOB_ANALYSIS_CLOSED_KEEP_DAYS'));
    let after = 0;
    let deleted = 0;
    for (;;) {
      const ids = (await deps.db.all<{ job_id: number }>(CLOSED_FACTS_PAGE, { after, cutoff, limit: RETENTION_BATCH })).map(
        (row) => row.job_id,
      );
      if (ids.length === 0) return deleted;
      const list = deps.db.dialect.list(ids.length);
      deleted += await deps.db.tx(
        async (t) => {
          await t.run(`DELETE FROM job_facts_certifications WHERE job_id IN (${list})`, ids);
          await t.run(`DELETE FROM job_facts_eligibility WHERE job_id IN (${list})`, ids);
          return (await t.run(`DELETE FROM job_facts WHERE job_id IN (${list})`, ids)).changes;
        },
        { label: 'pruneClosedJobFacts' },
      );
      if (ids.length < RETENTION_BATCH) return deleted;
      after = ids[ids.length - 1]!;
    }
  },
};

/**
 * One page of analyses to delete: made before the cutoff, of a text that no job still needs (an open job, one closed
 * since the cutoff, or one a tracker entry names; jobs by idx_jobs_hash). A text no job has any more goes too.
 */
const CLOSED_ANALYSES_PAGE = `SELECT a.id FROM job_analyses a
  WHERE a.id > @after AND a.created_at < @cutoff
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.content_hash = a.content_hash
      AND (j.active OR j.closed_at >= @cutoff OR EXISTS (SELECT 1 FROM applications ap WHERE ap.job_id = j.id)))
  ORDER BY a.id LIMIT @limit`;

/** job_analyses of texts only closed, untracked jobs have, past JOB_ANALYSIS_CLOSED_KEEP_DAYS. */
export const pruneClosedJobAnalyses: DailyStep = {
  name: 'closedJobAnalyses',
  run: async (deps) => {
    const cutoff = cutoffOf(deps, constantsOf(deps).get('JOB_ANALYSIS_CLOSED_KEEP_DAYS'));
    let after = 0;
    let deleted = 0;
    for (;;) {
      const ids = (await deps.db.all<{ id: number }>(CLOSED_ANALYSES_PAGE, { after, cutoff, limit: RETENTION_BATCH })).map((row) => row.id);
      if (ids.length === 0) return deleted;
      // The jobs and facts naming one (closed, untracked) lose the reference (ON DELETE SET NULL).
      deleted += (await deps.db.run(`DELETE FROM job_analyses WHERE id IN (${deps.db.dialect.list(ids.length)})`, ids)).changes;
      if (ids.length < RETENTION_BATCH) return deleted;
      after = ids[ids.length - 1]!;
    }
  },
};

/** The account feature's retention steps (v30 DB-JOBS), after v2.0's. */
export const RETENTION_DAILY: readonly DailyStep[] = [pruneViewMarks, pruneDraftAnswers, pruneClosedJobFacts, pruneClosedJobAnalyses];
