import { Router, type RequestHandler } from 'express';
import { IdParam, MINUTE_MS } from '@tailorit/shared';
import { McpTokenCreateBodySchema } from '@tailorit/shared/mcp';
import { publicOriginOf } from '../../config/public-origin'; // v34 ORIGIN
import { rateKeyOf, requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { forbidden, notFound } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import { createMcpToken, listMcpTokens, revokeMcpToken } from './tokens';

// Settings › Integrations › "Your own AI (MCP)" (v1.5 M), mounted at /api/mcp, the session only (an extension token
// never reaches it: tokenScope answers 403 first, and so does this router):
//   GET    /tokens       → McpTokenList (live tokens, newest first; never a secret)
//   POST   /tokens       {name} → 201 McpTokenCreated (the secret, this once)
//   DELETE /tokens/:id   → 204; 404 for another account's token or one already revoked

const sessionOnly: RequestHandler = (req, _res, next) => {
  if (req.authVia === 'token') return next(forbidden('Manage MCP tokens on the Settings › Integrations page.'));
  next();
};

function perAccount(name: string, limit: number): RequestHandler {
  return keyedRateLimit({
    windowMs: MINUTE_MS,
    limit,
    key: (req) => `${name}:${rateKeyOf(req, MINUTE_MS)}`, // v33 SHARE-8: the person (the route is never used while acting)
    message: (seconds) => `There have been too many requests about MCP tokens. ${waitSentence(seconds)}`,
  });
}

export function createMcpTokensRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser, sessionOnly);
  const listLimit = perAccount('mcp-tokens', 60);
  const createLimit = perAccount('mcp-token-create', 20);
  const revokeLimit = perAccount('mcp-token-revoke', 30);

  router.get('/tokens', listLimit, async (req, res) => {
    // v34 ORIGIN: the MCP address of the address the page is open at (config/public-origin.ts).
    res.json(await listMcpTokens(deps, userOf(req).id, publicOriginOf(deps.config, req)));
  });

  router.post('/tokens', createLimit, async (req, res) => {
    const { name } = parseInput(McpTokenCreateBodySchema, req.body ?? {}, 'token');
    const created = await createMcpToken(deps, userOf(req).id, name);
    deps.log.debug(`[mcp] account ${userOf(req).id} made MCP token ${created.id}`);
    res.status(201).json(created);
  });

  router.delete('/tokens/:id', revokeLimit, async (req, res) => {
    const tokenId = parseInput(IdParam, req.params.id, 'token');
    if (!(await revokeMcpToken(deps, userOf(req).id, tokenId))) throw notFound('That MCP token');
    deps.log.debug(`[mcp] account ${userOf(req).id} revoked MCP token ${tokenId}`);
    res.status(204).end();
  });

  return router;
}
