import type { Router } from 'express';
import { z } from 'zod';
import type { AiBackgroundWork } from '@tailorit/shared';
import { createBackgroundGate, type BackgroundGate } from '../../ai/background';
import { capacityOf, readUsageSummary, requireAi } from '../../ai/index';
import { adminRouter } from '../../core/admin/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/index';
import { parseInput } from '../../core/http/validate';
import { NOT_IMPORT_HELD_SQL, NOT_IMPORT_NOTE_HELD_SQL, rereadScopeOf, type RereadScope } from '../job-analysis/backlog'; // v35 INT-A: the import holds
import { JOB_ANALYSIS_PROMPT_VERSION } from '../../ai/prompts/job-analysis/job-analysis';
import { MIN_TEXT_FOR_AI } from '../job-analysis/service';
import { AI_FAILURES_BEFORE_GIVING_UP, AI_SET_ASIDE_UNTIL } from '../job-analysis/store';

// Administrator: Claude CLI health, a test prompt, the background AI work still to do and (v1.3 C) what AI used. Owned by work package F4
// (see docs/ARCHITECTURE.md §9). v30 ST4: an adminRouter (core/admin): its guard and its answers.

const TestBody = z.object({
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, 'Use a Claude model name such as claude-sonnet-5-5.')
    .optional(),
});

/** How many rows of the group meet `condition` (0 for none): portable, where `sum(<condition>)` is SQLite's. */
const countWhere = (condition: string) => `coalesce(sum(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0)`;

/**
 * The jobs the add-time backlog (job-analysis/backlog.ts, its `candidates`) has left, counted with its rules: a live job
 * with at least MIN_TEXT_FOR_AI characters of text whose text has no Claude analysis of the current prompt version and,
 * in `saved` mode, that someone has saved. It is `waiting` unless its text rests in job_ai_attempts: `backingOff`, or
 * `gaveUp` from the third failure on. A text the backlog has set aside for good (AI_SET_ASIDE_UNTIL: too short once
 * trimmed) counts nowhere. Jobs are counted, not texts (jobs that share a text count each). Exported so a test can
 * check its query plan.
 *
 * v3.0 PG-G: on PostgreSQL. The posting's text lives in job_texts (features/jobs/text.ts), which keeps the length of
 * its plain text (`text_chars`): the length is read from there, by the text's key, only for a job no current analysis
 * has read (a correlated subquery: PostgreSQL runs it per remaining job, after the analyses' anti-join), so the count
 * never scans the texts. The jobs row holds no text any more, so `content_hash` and `active` are read from it as they
 * are (SQLite's INDEXED BY and its IN-list trick are gone). The set-aside time is a typed timestamptz literal.
 *
 * v2.0 (INT, P4): a text Claude read at an older prompt version waits only as JOB_ANALYSIS_V2_REREAD (`reread`) has
 * the backlog read it again: `all` every one; `saved` only while someone has the job at Saved (every counted job, in
 * `saved` mode); `off` none of them.
 */
export function jobBacklogSql(savedOnly: boolean, reread: RereadScope, d: Dialect): string {
  const resting = `t.next_attempt_at < CAST('${AI_SET_ASIDE_UNTIL}' AS timestamptz)`;
  const saved = 'EXISTS (SELECT 1 FROM applications p WHERE p.job_id = j.id AND p.current_status = 1 AND p.archived_at IS NULL)';
  const olderReading =
    "EXISTS (SELECT 1 FROM job_analyses o WHERE o.content_hash = j.content_hash AND o.source = 'ai' AND o.version < @version)";
  const rereadRule =
    reread === 'all' || (reread === 'saved' && savedOnly)
      ? ''
      : reread === 'off'
        ? `AND NOT ${olderReading} `
        : `AND (NOT ${olderReading} OR ${saved}) `;
  return (
    `SELECT ${countWhere('t.content_hash IS NULL')} AS waiting, ${countWhere(`${resting} AND t.attempts < @givenUpAt`)} AS "backingOff", ` +
    `${countWhere(`${resting} AND t.attempts >= @givenUpAt`)} AS "gaveUp" ` +
    'FROM jobs j ' +
    'LEFT JOIN job_ai_attempts t ON t.content_hash = j.content_hash AND t.version = @version AND t.next_attempt_at > @now ' +
    `WHERE j.active = ${d.true} ` +
    // v35 INT-A (H3): a job held from an admin's import waits for its approval, as the backlog's candidates do.
    `AND ${NOT_IMPORT_HELD_SQL} AND ${NOT_IMPORT_NOTE_HELD_SQL} ` +
    (savedOnly ? `AND ${saved} ` : '') +
    "AND NOT EXISTS (SELECT 1 FROM job_analyses a WHERE a.content_hash = j.content_hash AND a.source = 'ai' AND a.version = @version) " +
    rereadRule +
    'AND (SELECT x.text_chars FROM job_texts x WHERE x.job_id = j.id) >= @minText'
  );
}

/** The background gate as Background work shows it: first the settings that keep background work off altogether. */
function gateState(deps: AppDeps, gate: BackgroundGate): AiBackgroundWork['gate'] {
  const off = (reason: string): AiBackgroundWork['gate'] => ({ open: false, reason, retryAt: null });
  if (!deps.config.ai.enabled) return off('AI is turned off (AI_ENABLED=false)');
  if (deps.config.ai.backgroundSlots <= 0) return off('background AI work is turned off (AI_CLI_BACKGROUND_SLOTS=0)');
  if (!deps.services.ai) return off('AI is not set up on this server');
  const answer = gate.allowed();
  if (answer.ok) return { open: true, reason: null, retryAt: null };
  return { open: false, reason: answer.reason, retryAt: new Date(answer.retryAtMs).toISOString() };
}

/**
 * Reads Admin › AI › Background work from the database: no AI call, no write. A mode without a backlog (jobs `lazy` or
 * `off`, resumes `off`) counts nothing. Rows of disabled accounts are left out, as the resume backlog and the match
 * worker skip them.
 */
function createBackgroundWork(deps: AppDeps): () => Promise<AiBackgroundWork> {
  const { config } = deps;
  const jobMode = config.ai.jobAnalysis;
  const gate = createBackgroundGate(deps);
  // v2.0: the statement by JOB_ANALYSIS_V2_REREAD's value, read at each call (an admin may change it at runtime).
  const jobsSql = () => (jobMode === 'ingest' || jobMode === 'saved' ? jobBacklogSql(jobMode === 'saved', rereadScopeOf(deps), deps.db.dialect) : null);
  const resumesSql =
    config.ai.resumeAnalysis === 'auto'
      ? `SELECT ${countWhere("b.state = 'waiting'")} AS waiting, ${countWhere("b.state = 'queued'")} AS queued, ` +
        `${countWhere("b.state = 'failed'")} AS failed FROM resume_analysis_backlog b JOIN users u ON u.id = b.user_id ` +
        "WHERE b.state IN ('waiting', 'queued', 'failed') AND u.disabled_at IS NULL"
      : null;
  // `resume_match_due = true` (the dialect's true) reads the partial index idx_app_match_due (`WHERE resume_match_due`).
  const matchesSql =
    'SELECT count(*) AS due FROM applications a JOIN users u ON u.id = a.user_id ' +
    `WHERE a.resume_match_due = ${deps.db.dialect.true} AND u.disabled_at IS NULL`;

  return async () => {
    const jobSql = jobsSql();
    const jobs = jobSql
      ? await deps.db.one<{ waiting: number; backingOff: number; gaveUp: number }>(jobSql, {
          minText: MIN_TEXT_FOR_AI,
          version: JOB_ANALYSIS_PROMPT_VERSION,
          now: nowIso(deps),
          givenUpAt: AI_FAILURES_BEFORE_GIVING_UP,
        })
      : undefined;
    const resumes = resumesSql ? await deps.db.one<{ waiting: number; queued: number; failed: number }>(resumesSql) : undefined;
    const matches = await deps.db.one<{ due: number }>(matchesSql);
    return {
      jobs: {
        mode: jobMode,
        waiting: jobs?.waiting ?? 0,
        backingOff: jobs?.backingOff ?? 0,
        gaveUp: jobs?.gaveUp ?? 0,
        perHourCap: config.ai.jobAnalysisPerHour,
      },
      resumes: {
        mode: config.ai.resumeAnalysis,
        waiting: resumes?.waiting ?? 0,
        queued: resumes?.queued ?? 0,
        failed: resumes?.failed ?? 0,
        perHourCap: config.ai.resumeAnalysisPerHour,
      },
      matches: { due: matches?.due ?? 0 },
      gate: gateState(deps, gate),
    };
  };
}

/** Mounted at /api/admin/ai. */
export function createAdminAiRouter(deps: AppDeps): Router {
  const backgroundWork = createBackgroundWork(deps);
  return adminRouter(deps, {
    resource: 'AI',
    routes(router, { handle }) {
      /** GET /api/admin/ai/health[?force=1] → AiHealth (`claude --version` + `claude auth status`, cached 60 s). */
      router.get(
        '/health',
        handle((req) => {
          const force = /^(1|true|yes)$/i.test(String(req.query.force ?? ''));
          return requireAi(deps).health(force);
        }),
      );

      /** POST /api/admin/ai/test {model?} → {ok, model, ms, answer, error?}: one tiny JSON echo through the CLI. */
      router.post(
        '/test',
        handle((req) => {
          const body = parseInput(TestBody, req.body ?? {}, 'test request');
          return requireAi(deps).test({ model: body.model });
        }),
      );

      /**
       * GET /api/admin/ai/background → AiBackgroundWork: what Claude still has to read in the background (added jobs,
       * uploaded resumes), the resume matches TailorIT is to choose again, and whether background work may start a task now.
       */
      router.get('/background', handle(() => backgroundWork()));

      /**
       * v1.3 C (decision 8): GET /api/admin/ai/usage → AiUsageSummary: per task kind, over the last 1, 7 and 30 days, the
       * prompt runs and CLI calls, the input, output and prompt-cache tokens, the cache hit rate, the cost at API prices
       * and the items answered from the result cache. Read from the usage ledger (ai_usage_hourly); no AI call.
       */
      router.get('/usage', handle(() => readUsageSummary(deps.db, deps.now().getTime())));

      /**
       * v2.0 (03-ai-usage.md, "What the admin sees"): GET /api/admin/ai/capacity → AiCapacity, Admin › AI's "Server AI
       * status": the seat's utilization, whether the capacity block is on, the threshold, the reading that sets it (its
       * source, window and end), every live reading, and today's charged total and write-offs over every account. Only
       * admins ever see any of it; no AI call.
       */
      router.get('/capacity', handle(() => capacityOf(deps).view()));
    },
  });
}
