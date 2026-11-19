import { Router } from 'express';
import { IdParam, RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, TailorRequestSchema, MINUTE_MS } from '@tailorit/shared';
import { AutofillTailorRequestSchema, type AutofillTemplateList } from '@tailorit/shared/autofill';
import { aiUnavailableError } from '../../core/accounts/refusals';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
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
    res.status(202).json(await serviceOf(deps).start(userOf(req).id, body));
  });

  router.get('/:taskId', async (req, res) => {
    const taskId = parseInput(IdParam, req.params.taskId, 'task id');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await serviceOf(deps).view(userOf(req).id, taskId));
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
    res.status(202).json(await serviceOf(deps).start(userOf(req).id, body, { page: true }));
  });

  router.get('/tailor/:id', allow('either', 'ai:run'), stateLimit, async (req, res) => {
    const taskId = parseInput(IdParam, req.params.id, 'task id');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await serviceOf(deps).view(userOf(req).id, taskId));
  });

  router.get('/templates', allow('either', 'profile:read'), templatesLimit, async (req, res) => {
    res.json(await templateList(deps, userOf(req).id));
  });

  return router;
}
