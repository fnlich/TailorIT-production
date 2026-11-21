import { Router } from 'express';
import { STATUS, MINUTE_MS } from '@tailorit/shared';
import {
  AutofillAgentIdSchema,
  AutofillAgentQueueQuerySchema,
  AutofillAgentResultBodySchema,
  AutofillAgentSettingsSchema,
  agentCanApply,
  type AutofillAgentCleared,
  type AutofillAgentNext,
  type AutofillAgentOpened,
  type AutofillAgentSettings,
} from '@tailorit/shared/autofill';
import { userOf } from '../../../core/auth/guards';
import type { AppDeps } from '../../../core/context';
import { AppError, asyncHandler } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { parseInput } from '../../../core/http/validate';
import { bestResumes } from '../../applications/resume-choice';
import { createApplication } from '../../applications/service';
import { matchResumeForJob } from '../../jobs/match';
import { allow, perAccountLimit } from '../auth';
import { newInFlight } from '../jobs';
import { markApplied } from '../tracker';
import {
  advanceRuleCursor,
  claimNext,
  clearFinished,
  finishMarkedApplied,
  finishRun,
  listQueue,
  openForTab,
  pageQueue,
  queueRow,
  readAgentSettings,
  releaseStaleRuns,
  removeQueued,
  resultEffect,
  rowForMarkApplied,
  tombstoneOf,
  ruleCandidates,
  saveAgentSettings,
  type RuleCandidate,
  type StoredAgentSettings,
} from './queue';
import { reservationRunOf, settleReservation, usageOf } from './reservations';

// The auto-apply agent (work package AF, autofill API version 3, Phase 5), mounted at /api/autofill:
//   GET    /agent/next                   a token (agent:run) → AutofillAgentNext {item, dailyLimit}: this browser's own
//                                        running job again, else (v2.0) under the daily auto-apply limit the oldest
//                                        queued job, now running for it with one use reserved; else null. With the rule
//                                        on and no job taken, the rule saves the new jobs that pass it (v2.0: never
//                                        queues them)
//   POST   /agent/:id/result             a token (agent:run) AutofillAgentResultBody → 204; `submitted` (taken in any
//                                        state but submitted) marks the job Applied (POST /applied's way, with the
//                                        run's resume); 404 for another account's row, 409 for another result of a
//                                        row not running, or of a run another browser took that is still connected
//   POST   /agent/queue                  v2.0: 409 conflict, MSG_DIRECT_QUEUE_REMOVED (A4: jobs are queued by Prepare &
//                                        Queue alone); kept one release for an older open page
//   POST   /agent/queue/:id/applied      v2.0 Settings → 204: Mark as applied (the manual flow): the job Applied, the row
//                                        submitted (`manual` when no run took it), never counted toward the daily limit
//   GET    /agent/queue                  Settings, or (v1.5 Q2) a token (agent:run) with ?state=&cursor=&limit= →
//                                        AutofillAgentQueueList (240 reads a minute, apart from changes); a query
//                                        answers one page; v2.0: with `autoApply` (the window's usage), and a token's
//                                        list never holds a `manual` row
//   POST   /agent/:id/opened             (v1.5 Q2) a token (agent:run) → AutofillAgentOpened: the Queue tab's run
//                                        takes the queued row before it opens its tab (never the agent's)
//   DELETE /agent/queue/:id              Settings → 204; 409 while a browser runs it
//   POST   /agent/queue/clear-finished   Settings → {removed}
//   GET    /agent/settings               Settings → AutofillAgentSettings {ruleEnabled, minMatch}
//   PUT    /agent/settings               Settings AutofillAgentSettings → the same
// The agent is the extension's worker, polling with its token; a page can never start it. v2.0: a Free account's daily
// auto-apply limit is reserved at the claim (reservations.ts); the per-minute limits below only keep a broken worker
// from flooding TailorIT. The debug lines name the account, the source and the state or reason codes, never a job, a
// posting or anything the form held.

/** The worker's asks for the next job per account per minute. */
export const AGENT_NEXT_PER_MINUTE = 60;
/** Results per account per minute. */
export const AGENT_RESULTS_PER_MINUTE = 60;
/** The Auto-apply page's changes per account per minute. */
export const AGENT_PAGE_CALLS_PER_MINUTE = 60;
/** The Auto-apply page's reads of the queue per account per minute (it polls while the agent runs), counted apart. */
export const AGENT_QUEUE_READS_PER_MINUTE = 240;
/** v1.5 Q2: the Queue tab's claims per account per minute. */
export const AGENT_OPENED_PER_MINUTE = 60;
/** Jobs the rule weighs per ask. */
export const RULE_BATCH = 50;
/** How long one ask may spend choosing the best resume for the rule's jobs. */
export const RULE_CHOICE_BUDGET_MS = 1_000;

/** The same rule, as it stood: still on, turned on at the same time, at the same threshold. */
const sameRule = (a: StoredAgentSettings, b: StoredAgentSettings) =>
  a.ruleEnabled && b.ruleEnabled && a.enabledAt === b.enabledAt && a.minMatch === b.minMatch;

/**
 * v2.0 (A4): the rule saves; it never queues, never prepares and never spends AI. Of the next RULE_BATCH jobs first seen
 * since its cursor (ruleCandidates: new since the rule was turned on, open, on a board TailorIT reads, neither tracked,
 * queued, let go nor hidden), in the order TailorIT first saw them, each whose application page the agent fills
 * (agentCanApply) and whose keyword match with the account's best resume for it (bestResumes, read-only, never AI;
 * scored as the lookup's match) is at least `minMatch` becomes a Saved Tracker entry, with that resume as TailorIT's
 * choice (origin auto), as the Jobs page's Save makes it. The person then Prepares & Queues it. The settings are read
 * again after the chooser's wait: a rule turned off or changed meanwhile saves nothing (the next ask weighs under the
 * new one). Each job is weighed once: the cursor moves past the jobs weighed, but stops before one the chooser did not
 * reach within its budget, and before all of them when the account has no resume (they are weighed once it has one).
 * Answers how many it saved.
 */
async function ruleSaves(deps: AppDeps, userId: string, settings: StoredAgentSettings): Promise<number> {
  const enabledAt = settings.enabledAt ?? deps.now().toISOString();
  const from = settings.cursor ?? { at: enabledAt, jobId: 0 };
  const candidates = await ruleCandidates(deps, userId, { enabledAt, from }, RULE_BATCH);
  const ids = candidates.filter((job) => agentCanApply(job.apply_url)).map((job) => job.id);
  const { choices } = ids.length
    ? await bestResumes(deps, userId, ids, RULE_CHOICE_BUDGET_MS, { quiet: true })
    : { choices: new Map() };
  if (!sameRule(await readAgentSettings(deps, userId), settings)) return 0;
  let weighed: RuleCandidate | null = null;
  let saved = 0;
  for (const job of candidates) {
    if (!ids.includes(job.id)) {
      weighed = job;
      continue;
    }
    const choice = choices.get(job.id);
    if (!choice || choice.resumeId === null) break;
    let passes = false;
    try {
      const scored = await matchResumeForJob(deps, userId, job.id, choice.resumeId);
      passes =
        scored !== null &&
        scored.readable &&
        scored.result.total > 0 &&
        scored.result.percentage >= settings.minMatch;
    } catch (error) {
      deps.log.warn('[autofill] agent rule: a match failed', error instanceof Error ? error.name : 'unknown');
    }
    if (passes) {
      // A job tracked meanwhile (the person saved it, or a second ask) keeps its entry as it is.
      const tracked = await deps.db.one('SELECT 1 FROM applications WHERE user_id = ? AND job_id = ?', [userId, job.id]);
      if (!tracked) {
        await createApplication(deps, userId, { jobId: job.id, status: STATUS.saved }, { matchedResume: choice });
        saved += 1;
      }
    }
    weighed = job;
  }
  if (weighed) await advanceRuleCursor(deps, userId, weighed);
  return saved;
}

export function createAutofillAgentRouter(deps: AppDeps): Router {
  const router = Router();
  const nextLimit = perAccountLimit('autofill-agent-next', AGENT_NEXT_PER_MINUTE, MINUTE_MS);
  const resultLimit = perAccountLimit('autofill-agent-result', AGENT_RESULTS_PER_MINUTE, MINUTE_MS);
  const pageLimit = perAccountLimit('autofill-agent-page', AGENT_PAGE_CALLS_PER_MINUTE, MINUTE_MS);
  const queueReadLimit = perAccountLimit('autofill-agent-queue-read', AGENT_QUEUE_READS_PER_MINUTE, MINUTE_MS);
  const openedLimit = perAccountLimit('autofill-agent-opened', AGENT_OPENED_PER_MINUTE, MINUTE_MS);
  /** A submitted job is always one TailorIT has: the add-job reads are never needed, but the Applied path takes one. */
  const inFlight = newInFlight();

  router.get(
    '/agent/next',
    allow('token', 'agent:run'),
    nextLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const tokenId = req.extensionToken!.id;
      const released = await releaseStaleRuns(deps, userId);
      const body: AutofillAgentNext = await claimNext(deps, userId, tokenId);
      let source = body.item ? 'queue' : body.dailyLimit?.reached ? 'the daily limit reached' : 'none';
      if (!body.item) {
        const settings = await readAgentSettings(deps, userId);
        if (settings.ruleEnabled) {
          const saved = await ruleSaves(deps, userId, settings);
          if (saved > 0) source += `, the rule saved ${saved} job(s)`;
        }
      }
      deps.log.debug(
        `[autofill] agent next for account ${userId}: ${source}${released ? `, ${released} stale run(s) released` : ''}`,
      );
      res.json(body);
    }),
  );

  router.post(
    '/agent/:id/result',
    allow('token', 'agent:run'),
    resultLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const id = parseInput(AutofillAgentIdSchema, req.params.id, 'auto-apply job id');
      const body = parseInput(AutofillAgentResultBodySchema, req.body ?? {}, 'result');
      let row: Awaited<ReturnType<typeof queueRow>>;
      try {
        row = await queueRow(deps, userId, id);
      } catch (error) {
        // A row the person removed or cleared: a submission it reports late still marks the job Applied.
        const tombstone = error instanceof AppError && body.state === 'submitted' ? await tombstoneOf(deps, userId, id) : null;
        if (!tombstone) throw error;
        const resumeId = tombstone.resumeId ?? undefined;
        await markApplied(
          deps,
          userId,
          { jobId: tombstone.jobId, ...(resumeId ? { resumeId } : {}) },
          inFlight,
          { mayAdd: false },
          { apply: { via: (await reservationRunOf(deps, id)) ?? 'agent', queueId: id, resumeId: tombstone.resumeId } },
        );
        // v2.0: a form that was sent counts, even from a row removed since (04's settlement table).
        await settleReservation(deps, id, 'used', 'submitted');
        deps.log.debug(`[autofill] agent result for account ${userId}: submitted, of a row taken out of the queue`);
        res.status(204).end();
        return;
      }
      const outcome = await resultEffect(deps, row, body, req.extensionToken!.id);
      if (outcome === 'finish') {
        // The tracker first: a submitted application is Applied even when the row is removed meanwhile, with the
        // resume the run attached as the entry's when the entry is made or restored now.
        if (body.state === 'submitted') {
          const resumeId = row.resume_id ?? undefined;
          await markApplied(
            deps,
            userId,
            { jobId: row.job_id, ...(resumeId ? { resumeId } : {}) },
            inFlight,
            { mayAdd: false },
            { apply: { via: row.run === 'tab' ? 'tab' : 'agent', queueId: row.id, resumeId: row.resume_id } },
          );
        }
        await finishRun(deps, userId, id, body);
      }
      deps.log.debug(
        `[autofill] agent result for account ${userId}: ${body.state}${body.reason ? ` (${body.reason})` : ''}` +
          `${outcome === 'unchanged' ? ', reported again' : ''}`,
      );
      res.status(204).end();
    }),
  );

  // v2.0 (A4): no path queues a job directly any more; kept one release so an older open page hears why.
  router.post('/agent/queue', allow('session'), pageLimit, (req) => {
    deps.log.debug(`[autofill] account ${userOf(req).id} asked to queue jobs directly: refused (Prepare & Queue)`);
    throw refuse(deps, 'conflict', 'MSG_DIRECT_QUEUE_REMOVED');
  });

  // v2.0: Mark as applied (the manual flow; a failed or needs-you row the person finished by hand). Never counted.
  router.post(
    '/agent/queue/:id/applied',
    allow('session'),
    pageLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const id = parseInput(AutofillAgentIdSchema, req.params.id, 'auto-apply job id');
      const row = await rowForMarkApplied(deps, userId, id);
      if (row.state !== 'submitted') {
        const resumeId = row.resume_id ?? undefined;
        await markApplied(
          deps,
          userId,
          { jobId: row.job_id, ...(resumeId ? { resumeId } : {}) },
          inFlight,
          { mayAdd: false },
          { apply: { via: 'manual', queueId: row.id, resumeId: row.resume_id } },
        );
        await finishMarkedApplied(deps, userId, id);
      }
      deps.log.debug(`[autofill] account ${userId} marked an auto-apply job applied by hand (was ${row.state})`);
      res.status(204).end();
    }),
  );

  // v1.5 Q2: a token too (the Queue tab); a query answers one page. v2.0: the window's usage; a token never sees a
  // `manual` row. v33 SHARE-5: nor one that waits for the owner's OK (a job someone the profile is shared with prepared).
  router.get('/agent/queue', allow('either', 'agent:run'), queueReadLimit, async (req, res) => {
    const userId = userOf(req).id;
    const query = parseInput(AutofillAgentQueueQuerySchema, req.query ?? {}, 'query');
    await releaseStaleRuns(deps, userId);
    const token = req.extensionToken !== undefined;
    const options = { omitManual: token, omitHeld: token, autoApply: await usageOf(deps, userId) };
    const paged = query.state !== undefined || query.cursor !== undefined || query.limit !== undefined;
    res.json(paged ? await pageQueue(deps, userId, query, options) : await listQueue(deps, userId, options));
  });

  // v1.5 Q2: the Queue tab's sequential run takes a queued row before it opens the job's tab.
  router.post('/agent/:id/opened', allow('token', 'agent:run'), openedLimit, async (req, res) => {
    const userId = userOf(req).id;
    const id = parseInput(AutofillAgentIdSchema, req.params.id, 'auto-apply job id');
    const released = await releaseStaleRuns(deps, userId);
    const body: AutofillAgentOpened = await openForTab(deps, userId, req.extensionToken!.id, id);
    deps.log.debug(
      `[autofill] agent tab run for account ${userId}: ${body.state}${body.reason ? ` (${body.reason})` : ''}` +
        `${released ? `, ${released} stale run(s) released` : ''}${body.dailyLimit?.reached && !body.item ? ', the daily limit reached' : ''}`,
    );
    res.json(body);
  });

  router.post('/agent/queue/clear-finished', allow('session'), pageLimit, async (req, res) => {
    const body: AutofillAgentCleared = { removed: await clearFinished(deps, userOf(req).id) };
    res.json(body);
  });

  router.delete('/agent/queue/:id', allow('session'), pageLimit, async (req, res) => {
    const id = parseInput(AutofillAgentIdSchema, req.params.id, 'auto-apply job id');
    await removeQueued(deps, userOf(req).id, id);
    res.status(204).end();
  });

  router.get('/agent/settings', allow('session'), pageLimit, async (req, res) => {
    const { ruleEnabled, minMatch } = await readAgentSettings(deps, userOf(req).id);
    const body: AutofillAgentSettings = { ruleEnabled, minMatch };
    res.json(body);
  });

  router.put('/agent/settings', allow('session'), pageLimit, async (req, res) => {
    const userId = userOf(req).id;
    const settings = parseInput(AutofillAgentSettingsSchema, req.body ?? {}, 'settings');
    const saved = await saveAgentSettings(deps, userId, settings);
    deps.log.debug(`[autofill] account ${userId} set the auto-apply rule ${saved.ruleEnabled ? 'on' : 'off'}`);
    res.json(saved);
  });

  return router;
}
