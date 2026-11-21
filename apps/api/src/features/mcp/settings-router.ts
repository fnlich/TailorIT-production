import { Router, type RequestHandler } from 'express';
import { McpSettingsBodySchema } from '@tailorit/shared/mcp';
import { rateKeyOf, requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { forbidden } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import { checkedCustomInstructions, mcpSettings, saveMcpSettings } from './settings';
import { MINUTE_MS } from '@tailorit/shared';

// v1.5 Q1: Settings › Integrations › "Your own AI (MCP)"'s settings, mounted at /api/mcp/settings, the session only (an
// extension token gets 403, as the tokens' routes give it):
//   GET /api/mcp/settings   → McpSettings (the defaults until changed)
//   PUT /api/mcp/settings   McpSettingsBody (reviseRounds 0-5, promptMode, customInstructions) → McpSettings, as saved
// The MCP tool prepare_settings reads and writes the same row.
// v2.0 P5: customInstructions, the person's own words for their AI (07-mcp.md), saved as plain text and at most the
// constant MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS; '' clears them. Never logged.

const sessionOnly: RequestHandler = (req, _res, next) => {
  if (req.authVia === 'token') return next(forbidden('Change these on the Settings › Integrations page.'));
  next();
};

export function createMcpSettingsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser, sessionOnly);
  const limit = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: 60,
    key: (req) => `mcp-settings:${rateKeyOf(req, MINUTE_MS)}`, // v33 SHARE-8
    message: (seconds) => `There have been too many changes to these settings. ${waitSentence(seconds)}`,
  });

  router.get('/', async (req, res) => {
    res.json(await mcpSettings(deps, userOf(req).id));
  });

  router.put('/', limit, async (req, res) => {
    const body = parseInput(McpSettingsBodySchema, req.body ?? {}, 'settings');
    const changes = {
      ...(body.reviseRounds !== undefined ? { reviseRounds: body.reviseRounds } : {}),
      ...(body.promptMode !== undefined ? { promptMode: body.promptMode } : {}),
      ...(body.customInstructions !== undefined
        ? { customInstructions: checkedCustomInstructions(deps, body.customInstructions) }
        : {}),
    };
    const saved = await saveMcpSettings(deps, userOf(req).id, changes);
    deps.log.debug(`[mcp] account ${userOf(req).id} changed its own AI settings`);
    res.json(saved);
  });

  return router;
}
