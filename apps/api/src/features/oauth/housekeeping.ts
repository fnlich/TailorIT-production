import { DAY_MS } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';

// v3.1 OAUTH: the daily housekeeping of the OAuth records, each older than OAUTH_RECORD_KEEP_DAYS past its end.
// - grants no token keeps alive any more (consented, never exchanged; or every token expired: the app was idle past
//   OAUTH_REFRESH_IDLE_DAYS) are revoked (`unused`), so they leave the person's count;
// - revoked grants are deleted, and with them their tokens and requests (mcp_unsupported_reports keep their rows);
// - ended requests and expired tokens are deleted (a spent refresh token stays until its own end, so its reuse is still
//   caught: exchange.ts);
// - registrations and client documents no grant or request uses are deleted.

function cutoff(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): { now: string; before: string } {
  const now = deps.now();
  return { now: now.toISOString(), before: new Date(now.getTime() - constantsOf(deps).get('OAUTH_RECORD_KEEP_DAYS') * DAY_MS).toISOString() };
}

export const OAUTH_DAILY: readonly DailyStep[] = [
  {
    name: 'grants',
    run: async (deps) => {
      const { now, before } = cutoff(deps);
      const unused = await deps.db.run(
        `UPDATE oauth_grants g SET revoked_at = ?, revoked_reason = 'unused'
          WHERE g.revoked_at IS NULL AND g.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.revoked_at IS NULL
                              AND t.rotated_at IS NULL AND t.expires_at > ?)`,
        [now, before, now],
      );
      // (No token of such a grant works: none needs revoking.)
      const deleted = await deps.db.run('DELETE FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?', [before]);
      return unused.changes + deleted.changes;
    },
  },
  {
    name: 'records',
    run: async (deps) => {
      const { before } = cutoff(deps);
      const requests = await deps.db.run('DELETE FROM oauth_requests WHERE expires_at < ? AND (code_expires_at IS NULL OR code_expires_at < ?)', [
        before,
        before,
      ]);
      const tokens = await deps.db.run('DELETE FROM oauth_tokens WHERE expires_at < ?', [before]);
      const clients = await deps.db.run(
        `DELETE FROM oauth_clients c
          WHERE ((c.kind = 'dcr' AND c.created_at < ?) OR (c.kind = 'cimd' AND c.expires_at < ?))
            AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = c.id)`,
        [before, before],
      );
      return requests.changes + tokens.changes + clients.changes;
    },
  },
];
