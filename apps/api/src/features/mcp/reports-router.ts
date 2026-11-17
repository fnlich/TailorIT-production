import { Router, type RequestHandler } from 'express';
import { IdParam, MINUTE_MS } from '@tailorit/shared';
import type { McpUnsupportedCleared } from '@tailorit/shared/mcp';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { forbidden, notFound } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import { clearUnsupported, deleteUnsupported, listUnsupported } from './tools-report';

// v1.5 Q2: Settings › Integrations › "Your own AI (MCP)" › "Requests your AI could not do", mounted at
// /api/mcp/unsupported, the session only (an extension token: 403; an MCP token is no credential under /api):
//   GET    /       → McpUnsupportedList (newest first)
//   DELETE /:id    → 204; 404 for another account's report or one already deleted
//   DELETE /       → {removed}

const sessionOnly: RequestHandler = (req, _res, next) => {
  if (req.authVia === 'token') return next(forbidden('See these on the Settings › Integrations page.'));
  next();
};

export function createMcpReportsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser, sessionOnly);
  const limit = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: 60,
    key: (req) => `mcp-unsupported:${userOf(req).id}`,
    message: (seconds) => `There have been too many requests about your AI's reports. ${waitSentence(seconds)}`,
  });

  router.get('/', limit, async (req, res) => {
    res.json(await listUnsupported(deps, userOf(req).id));
  });

  router.delete('/:id', limit, async (req, res) => {
    const id = parseInput(IdParam, req.params.id, 'report');
    if (!(await deleteUnsupported(deps, userOf(req).id, id))) throw notFound('That report');
    res.status(204).end();
  });

  router.delete('/', limit, async (req, res) => {
    const body: McpUnsupportedCleared = { removed: await clearUnsupported(deps, userOf(req).id) };
    res.json(body);
  });

  return router;
}
