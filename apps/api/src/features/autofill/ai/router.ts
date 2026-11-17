import { Router, type Request } from 'express';
import {
  AutofillAnswerRequestSchema,
  AutofillClassifyRequestSchema,
  AutofillDraftRequestSchema,
  AutofillPickRequestSchema,
} from '@tailorit/shared/autofill';
import { userOf } from '../../../core/auth/guards';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { asyncHandler, notFound } from '../../../core/http/errors';
import { parseInput } from '../../../core/http/validate';
import { allow, perAccountLimit } from '../auth';
import { sensitiveAnswerScreen } from '../profile/sensitive-screen';
import { answerTaskInput } from './answer';
import { classifyTaskInput } from './classify';
import { draftTaskInput } from './draft';
import { pickTaskInput, type AnswerScreen } from './pick';
import { answerTask } from './tasks';
import { MINUTE_MS, HOUR_MS, DAY_MS } from '@tailorit/shared';

// The extension's AI steps (work package AF, Phases 4 and 6, and v2 Phase D), mounted at /api/autofill:
//   POST /ai/pick      Settings or a token (ai:run) AutofillPickRequest → 200 AutofillPickTask, or 202 {taskId}
//   POST /ai/classify  Settings or a token (ai:run) AutofillClassifyRequest → 200 AutofillClassifyTask, or 202
//                      {taskId}
//   POST /ai/draft     Settings or a token (ai:run) AutofillDraftRequest → 200 AutofillDraftTask, or 202 {taskId};
//                      404 when the resume it names is not the account's (also the panel's custom question and
//                      "Edit with AI")
//   POST /ai/answer    Settings or a token (ai:run) AutofillAnswerRequest → 200 AutofillAnswerTask, or 202
//                      {taskId}; 404 when the resume it names is not the account's
// Each screens its items (screen.ts; a pick's values and an answer's options also against the person's sensitive
// answers), queues one task (or reattaches to its twin still in flight) and waits up to AUTOFILL_AI_WAIT_MS for it;
// the extension polls a 202's task on GET /api/ai/tasks/:id. The log names the account, the task, counts and the
// time; never a label, an option, a value, a question or anything Claude answered.

/** Requests of one kind per account: a minute's and an hour's (v30 ST3: the constant AUTOFILL_AI_PER_HOUR). A form pass
 *  asks once per kind (answers in batches of ten). */
export const AI_REQUESTS_PER_MINUTE = 20;
/**
 * Draft requests per account: a minute's and a day's (v30 ST3: the constant AUTOFILL_DRAFTS_PER_DAY). Since v2 every
 * form's open questions are drafted (up to three a request), and "Edit with AI" and the custom question ask one at a
 * time.
 */
export const DRAFT_REQUESTS_PER_MINUTE = 20;

/** A draft's or an answer's resume is read when the task runs; one that is not the account's is refused now (404). */
async function requireOwnResume(deps: AppDeps, userId: string, resumeId: string | null): Promise<void> {
  if (resumeId === null) return;
  const own = await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId]);
  if (!own) throw notFound('That resume');
}

/**
 * The value screen for this request: the person's sensitive answers, compared yes or no (profile/sensitive-screen.ts),
 * for a caller that may read them: the Settings session, or a token with `profile:sensitive`. A token without that
 * scope never holds them, and a screen run for it would let it test guesses against them (the few genders and races
 * above all), so its items are screened by their own text alone. v3.0 D2: the answers are read once, as the request
 * is screened (sensitiveAnswerScreen).
 */
async function answerScreenFor(deps: AppDeps, req: Request): Promise<AnswerScreen> {
  const mayRead = req.authVia !== 'token' || req.extensionToken?.scopes.includes('profile:sensitive') === true;
  if (!mayRead) return () => false;
  return sensitiveAnswerScreen(deps, userOf(req).id);
}

export function createAutofillAiRouter(deps: AppDeps): Router {
  const router = Router();
  // v30 ST3: the hourly and daily limits are constants; v30 INT-0: read on each request, so an admin's edit applies at once.
  const perHour = () => constantsOf(deps).get('AUTOFILL_AI_PER_HOUR');
  const draftsPerDay = () => constantsOf(deps).get('AUTOFILL_DRAFTS_PER_DAY');
  const limits = (name: string) => [
    perAccountLimit(`autofill-ai-${name}`, AI_REQUESTS_PER_MINUTE, MINUTE_MS),
    perAccountLimit(`autofill-ai-${name}-hour`, perHour, HOUR_MS),
  ];

  router.post(
    '/ai/pick',
    allow('either', 'ai:run'),
    ...limits('pick'),
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillPickRequestSchema, req.body ?? {}, 'request');
      const { input, screened } = pickTaskInput(request, await answerScreenFor(deps, req));
      await answerTask(deps, res, { kind: 'autofill_pick', userId, input, items: input.items.length, screened });
    }),
  );

  router.post(
    '/ai/classify',
    allow('either', 'ai:run'),
    ...limits('classify'),
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillClassifyRequestSchema, req.body ?? {}, 'request');
      const { input, screened } = classifyTaskInput(request);
      await answerTask(deps, res, { kind: 'autofill_classify', userId, input, items: input.items.length, screened });
    }),
  );

  router.post(
    '/ai/draft',
    allow('either', 'ai:run'),
    perAccountLimit('autofill-ai-draft', DRAFT_REQUESTS_PER_MINUTE, MINUTE_MS),
    perAccountLimit('autofill-ai-draft-day', draftsPerDay, DAY_MS),
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillDraftRequestSchema, req.body ?? {}, 'request');
      await requireOwnResume(deps, userId, request.resumeId);
      const { input, screened } = draftTaskInput(request);
      await answerTask(deps, res, { kind: 'autofill_draft', userId, input, items: input.questions.length, screened });
    }),
  );

  router.post(
    '/ai/answer',
    allow('either', 'ai:run'),
    ...limits('answer'),
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillAnswerRequestSchema, req.body ?? {}, 'request');
      await requireOwnResume(deps, userId, request.resumeId);
      const { input, screened } = answerTaskInput(request, await answerScreenFor(deps, req));
      await answerTask(deps, res, { kind: 'autofill_answer', userId, input, items: input.items.length, screened });
    }),
  );

  return router;
}
