import { Router } from 'express';
import { IdParam, RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, TailorRequestSchema, MINUTE_MS } from '@tailorit/shared';
import { AutofillTailorRequestSchema, type AutofillTemplateList } from '@tailorit/shared/autofill';
import { thrownRefusalForReader } from '../../ai/queue'; // v33 SHARE-3 (review)
import { taskViewerOf } from '../../ai/viewer'; // v33 SHARE-3
import { aiUnavailableError } from '../../core/accounts/refusals';
import { actorOf, payerOf, requireUser, userOf } from '../../core/auth/guards'; // v33 SHARE-3 (review): actorOf
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { autofillPayerOf } from '../autofill/ai/payer'; // v33 SHARE-3
import { allow, perAccountLimit } from '../autofill/auth';
import { createTemplateRepository } from '../cover-letter-templates/repository';
import type { TailorService } from './service';

// The tailoring routes (v1.4, work package D):
//   POST /api/tailor                    the web pages (session): TailorRequest → 202 {taskId, deduped}
//   GET  /api/tailor/:taskId            → TailorTaskView (step and message while it runs, the result once done)
//   POST /api/autofill/tailor           Settings or a token (ai:run): AutofillTailorRequest → 202 {taskId, deduped}
//   GET  /api/autofill/tailor/:id       Settings or a token (ai:run) → AutofillTailorTask
//   GET  /api/autofill/templates        Settings or a token (profile:read) → AutofillTemplateList
// Tailoring is costly (several Claude calls), so the service allows the plan's tailorings an hour per account
// (FREE_/PAID_TAILOR_PER_HOUR, v32 FIX-PLAN: Paid's unlimited by default) and answers the same tailoring done in the last
// day with the earlier task; the routes' own limits only stop a flood of requests, for every plan.
// v33 SHARE-3 (PLAN F9 "Who pays"): on a profile shared with them, B tailors A's resume and B pays (payerOf: B's plan,
// budget, credit and tailorings an hour); B reads the progress of A's tailorings (taskViewerOf, documents:view). The
// routes' acting policies are acting.ts's.

/** The service, or a 503 when this server was built without AI (v2.0: MSG_AI_UNAVAILABLE, the server's state never said). */
function serviceOf(deps: AppDeps): TailorService {
  const service = deps.services.tailor;
  if (!service) throw aiUnavailableError(deps);
  return service;
}

/** Mounted at /api/tailor: the session's routes. */
export function createTailorRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  router.post('/', async (req, res) => {
    const body = parseInput(TailorRequestSchema, req.body ?? {});
    res.status(202).json(await serviceOf(deps).start(userOf(req).id, body, { payer: payerOf(req) })); // v33 SHARE-3
  });

  router.get('/:taskId', async (req, res) => {
    const taskId = parseInput(IdParam, req.params.taskId, 'task id');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await serviceOf(deps).view(taskViewerOf(req), taskId)); // v33 SHARE-3
  });

  return router;
}

/** The templates the profile's documents may name: the editor's resume templates, then the letter templates. */
export async function templateList(deps: AppDeps, userId: string): Promise<AutofillTemplateList> {
  return {
    resumeTemplates: RESUME_TEMPLATE_IDS.map((id) => ({ id, name: RESUME_TEMPLATES[id].name })),
    coverLetterTemplates: (await createTemplateRepository(deps)
      .list(userId))
      .map((row) => ({ id: row.id, name: row.name, isSystem: deps.db.dialect.isTrue(row.is_system) })),
  };
}

/** Mounted at /api/autofill: the extension's (and the Settings page's) routes. */
export function createAutofillTailorRouter(deps: AppDeps): Router {
  const router = Router();
  const startLimit = perAccountLimit('autofill-tailor', 10, MINUTE_MS);
  const stateLimit = perAccountLimit('autofill-tailor-state', 120, MINUTE_MS);
  const templatesLimit = perAccountLimit('autofill-templates', 60, MINUTE_MS);

  router.post('/tailor', allow('either', 'ai:run'), startLimit, async (req, res) => {
    const body = parseInput(AutofillTailorRequestSchema, req.body ?? {}, 'request');
    // The posting text the extension sends is a page's: its answers are checked before they are kept.
    // v33 SHARE-3: the extension's tailoring for a job B prepared is B's (autofillPayerOf); the Settings page's, payerOf.
    const payer = await autofillPayerOf(deps, req, body.resumeId ?? null);
    const ownerId = userOf(req).id;
    try {
      res.status(202).json(await serviceOf(deps).start(ownerId, body, { page: true, payer }));
    } catch (error) {
      // v33 SHARE-3 (review; PLAN-sharing §5 "Refusal wording"): a limit of B's (B pays for A's extension's tailoring of
      // a job B prepared) reaches A as payer_limit, and a resume place kept for A in A's own words.
      const reader = actorOf(req).id;
      throw payer.id === reader ? error : thrownRefusalForReader(deps, error, reader === ownerId ? 'owner' : 'other');
    }
  });

  router.get('/tailor/:id', allow('either', 'ai:run'), stateLimit, async (req, res) => {
    const taskId = parseInput(IdParam, req.params.id, 'task id');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await serviceOf(deps).view(taskViewerOf(req), taskId)); // v33 SHARE-3
  });

  router.get('/templates', allow('either', 'profile:read'), templatesLimit, async (req, res) => {
    res.json(await templateList(deps, userOf(req).id));
  });

  return router;
}
