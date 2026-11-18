import { Router } from 'express';
import { IdParam, MINUTE_MS } from '@tailorit/shared';
import { AutofillConnectBodySchema, AutofillRedeemBodySchema, normalizeConnectCode } from '@tailorit/shared/autofill';
import { serverAiRefusal } from '../../ai/gate';
import { revokeExtensionToken } from '../../core/auth/extension-tokens';
import { userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { asyncHandler, notFound } from '../../core/http/errors';
import { extensionOriginOnly } from '../../core/http/middleware';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { leaveRunsOf } from './agent/queue';
import { allow, perAccountLimit, waitSentence } from './auth';
import { listConnections, mintConnectCode, redeemConnectCode, sessionView } from './connect';
import { notifyExtensionDisconnected } from '../notifications/emitters'; // v31 NOTIFY

// Connecting the TailorIT Autofill extension (work package AF), mounted at /api/autofill:
//   POST   /connect         Settings (session + Origin) {includeSensitive, allowSignIn?} → 201 {code, expiresAt,
//                            extensionIds}
//   POST   /connect/redeem  the extension's worker, no cookie {code, client} → {token, tokenId, expiresAt, scopes,
//                           account, apiVersion}
//   GET    /session         a token: which connection this is → AutofillSession
//   DELETE /session         a token: the extension's Disconnect → 204
//   GET    /tokens          Settings: the connected browsers → AutofillTokenList
//   DELETE /tokens/:id      Settings: Disconnect one → 204 (its auto-apply runs left for the person: needs-you)
// Every route but redeem has a per-account rate limit; redeem has one global limit on refusals instead (there is no
// account yet), which an Origin other than an extension's never reaches: originCheck refuses an http(s) or 'null' one
// on the exact path, and extensionOriginOnly any other on every spelling of it, the app's own included.

/** Connect codes per account per hour. */
export const CONNECT_PER_HOUR = 10;
/** Refused redeems per 10 minutes, every caller together. */
export const REDEEM_FAILURES_PER_10_MINUTES = 30;
/**
 * How long GET /session waits for the Claude CLI's status (cached for a minute) before saying AI is unavailable. The
 * Settings page gives the extension 3 s to redeem a code, read GET /session and answer, so the wait stays well below.
 */
export const AI_STATUS_WAIT_MS = 2_000;

/**
 * Starts the Claude CLI's status check without waiting for it (a cold one runs the CLI twice), so the GET /session
 * that pairing leads to finds it cached. One check runs at a time; a failure is the session's to report.
 */
function warmAiStatus(deps: AppDeps): void {
  void deps.services.ai?.health().catch(() => undefined);
}

/**
 * Whether TailorIT can run Claude for this person now, waiting AI_STATUS_WAIT_MS at most (the extension gives up at
 * 25 s). v20 FIX-A (SEC-4): the person's own gate is folded in, so their used-up AI usage reads the same as the
 * server's capacity block (both false): the answer never tells the server's state apart from the person's, as the AI
 * routes' vague MSG_AI_UNAVAILABLE does not.
 */
async function aiAvailable(deps: AppDeps, userId: string): Promise<boolean> {
  const ai = deps.services.ai;
  if (!ai) return false;
  if ((await serverAiRefusal(deps, userId)) !== null) return false;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), AI_STATUS_WAIT_MS);
  });
  try {
    return (await Promise.race([ai.health(), late]))?.available ?? false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createAutofillConnectRouter(deps: AppDeps): Router {
  const router = Router();
  const connectLimit = perAccountLimit('autofill-connect', CONNECT_PER_HOUR, 60 * MINUTE_MS);
  // Far above what the worker or the page sends (the page polls GET /tokens every 3 s while it shows a code).
  const sessionLimit = perAccountLimit('autofill-session', 60, MINUTE_MS);
  const disconnectLimit = perAccountLimit('autofill-disconnect', 10, MINUTE_MS);
  const tokensLimit = perAccountLimit('autofill-tokens', 60, MINUTE_MS);
  const revokeLimit = perAccountLimit('autofill-revoke', 30, MINUTE_MS);
  const redeemLimit = keyedRateLimit({
    windowMs: 10 * MINUTE_MS,
    limit: REDEEM_FAILURES_PER_10_MINUTES,
    // One counter for every caller: the code is the only thing a redeem names.
    key: () => 'autofill-redeem',
    message: (seconds) => `There have been too many attempts to connect an extension. ${waitSentence(seconds)}`,
    counts: (_req, status) => status >= 400,
  });

  router.post('/connect', allow('session'), connectLimit, async (req, res) => {
    const { includeSensitive, allowSignIn } = parseInput(AutofillConnectBodySchema, req.body ?? {}, 'request');
    const minted = await mintConnectCode(deps, userOf(req).id, includeSensitive, allowSignIn);
    warmAiStatus(deps);
    res.status(201).json(minted);
  });

  // The code alone names the account: this never reads req.user, so a cookie gains nothing here. Only an extension's
  // worker calls it, so any other Origin is refused, on whatever spelling of the path, before the limit counts it.
  router.post('/connect/redeem', extensionOriginOnly, redeemLimit, async (req, res) => {
    const { code, client } = parseInput(AutofillRedeemBodySchema, req.body ?? {}, 'request');
    const userAgent = req.get('user-agent') ?? null;
    res.json(await redeemConnectCode(deps, normalizeConnectCode(code)!, { client, userAgent }));
  });

  router.get(
    '/session',
    allow('token'),
    sessionLimit,
    asyncHandler(async (req, res) => {
      res.json(await sessionView(deps, userOf(req), req.extensionToken!.id, await aiAvailable(deps, userOf(req).id)));
    }),
  );

  router.delete('/session', allow('token'), disconnectLimit, async (req, res) => {
    const tokenId = req.extensionToken!.id;
    const ended = await revokeExtensionToken(deps, userOf(req).id, tokenId, 'extension');
    // v31 NOTIFY: the person learns in TailorIT that this browser no longer works with it (after the revoke committed).
    if (ended) await notifyExtensionDisconnected(deps, { userId: userOf(req).id, tokenId });
    deps.log.debug(`[autofill] token ${tokenId} disconnected by the extension`);
    res.status(204).end();
  });

  // The Extension tab reads this as it opens, before Connect is clicked: time enough to have the AI status cached.
  router.get('/tokens', allow('session'), tokensLimit, async (req, res) => {
    warmAiStatus(deps);
    res.json(await listConnections(deps, userOf(req).id));
  });

  // Another account's connection, or one that already ended, is "not found".
  // The person's Disconnect also leaves the browser's auto-apply runs for them (needs-you, cancelled): a browser cut off
  // can no longer report them (audit A6). The extension's own Disconnect keeps them, for a browser that connects again.
  router.delete('/tokens/:id', allow('session'), revokeLimit, async (req, res) => {
    const userId = userOf(req).id;
    const tokenId = parseInput(IdParam, req.params.id, 'connection');
    const left = await deps.db.tx(async () => {
      if (!(await revokeExtensionToken(deps, userId, tokenId, 'user'))) throw notFound('That connection');
      return leaveRunsOf(deps, userId, tokenId);
    }, { label: 'autofill disconnect' });
    deps.log.debug(
      `[autofill] token ${tokenId} disconnected from Settings${left ? `, ${left} auto-apply run(s) left for the person` : ''}`,
    );
    res.status(204).end();
  });

  return router;
}
