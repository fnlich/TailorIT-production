import { Router } from 'express';
import {
  AUTOFILL_SITE_REQUESTS_MAX,
  AutofillSiteRequestBodySchema,
  type AutofillSiteRequestList,
} from '@tailorit/shared/autofill';
import { userOf } from '../../core/auth/guards';
import { nowIso, type AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { allow, perAccountLimit } from './auth';
import { MINUTE_MS } from '@tailorit/shared';

// "Ask TailorIT to support this site" (work package AF, autofill API version 3), mounted at /api/autofill:
//   POST /site-requests  Settings or a token (jobs:lookup) {host} → 204: the account's count for the host, plus one
//   GET  /site-requests  Settings → AutofillSiteRequestList {items, total}, the latest first
// Only the host name is kept (autofill_site_requests: a count, the first and the last time), never more of the page;
// an account keeps its AUTOFILL_SITE_REQUESTS_MAX latest. The log names the account alone, never the host.

/** Requests per account per minute (the panel's button). */
export const SITE_REQUESTS_PER_MINUTE = 10;

/**
 * Records one request for `host`: a new row at 1, else its count plus one and its last time now. v3.0 D2-B: the
 * account's cap (the latest AUTOFILL_SITE_REQUESTS_MAX) holds the person's lock, so two requests at once keep it.
 */
export async function recordSiteRequest(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, host: string): Promise<void> {
  const now = nowIso(deps);
  await deps.db.tx(async (t) => {
    await t.lockPerson(userId);
    await t.run(
      `INSERT INTO autofill_site_requests(user_id, host, request_count, first_requested_at, last_requested_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id, host) DO UPDATE SET request_count = autofill_site_requests.request_count + 1,
         last_requested_at = excluded.last_requested_at`,
      [userId, host, now, now],
    );
    // The latest AUTOFILL_SITE_REQUESTS_MAX are kept.
    await t.run(
      `DELETE FROM autofill_site_requests WHERE user_id = ? AND host NOT IN (
         SELECT host FROM autofill_site_requests WHERE user_id = ?
         ORDER BY last_requested_at DESC, host LIMIT ?)`,
      [userId, userId, AUTOFILL_SITE_REQUESTS_MAX],
    );
  }, { label: 'recordSiteRequest' });
}

/** The account's requests, the latest first. */
export async function listSiteRequests(deps: Pick<AppDeps, 'db'>, userId: string): Promise<AutofillSiteRequestList> {
  const rows = await deps.db.all<{
    host: string;
    request_count: number;
    first_requested_at: string;
    last_requested_at: string;
  }>(
    `SELECT host, request_count, first_requested_at, last_requested_at FROM autofill_site_requests
     WHERE user_id = ? ORDER BY last_requested_at DESC, host LIMIT ?`,
    [userId, AUTOFILL_SITE_REQUESTS_MAX],
  );
  const items = rows.map((row) => ({
    host: row.host,
    count: row.request_count,
    firstRequestedAt: row.first_requested_at,
    lastRequestedAt: row.last_requested_at,
  }));
  return { items, total: items.length };
}

export function createAutofillSiteRequestsRouter(deps: AppDeps): Router {
  const router = Router();
  const askLimit = perAccountLimit('autofill-site-request', SITE_REQUESTS_PER_MINUTE, MINUTE_MS);
  const listLimit = perAccountLimit('autofill-site-requests-list', 60, MINUTE_MS);

  router.post('/site-requests', allow('either', 'jobs:lookup'), askLimit, async (req, res) => {
    const userId = userOf(req).id;
    const { host } = parseInput(AutofillSiteRequestBodySchema, req.body ?? {}, 'request');
    await recordSiteRequest(deps, userId, host);
    deps.log.debug(`[autofill] account ${userId} asked TailorIT to support a site`);
    res.status(204).end();
  });

  router.get('/site-requests', allow('session'), listLimit, async (req, res) => {
    res.json(await listSiteRequests(deps, userOf(req).id));
  });

  return router;
}
