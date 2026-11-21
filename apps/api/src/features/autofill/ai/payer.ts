import type { Request } from 'express';
import { ownPayer, payerOf, payerOfGrant, type PersonPayer } from '../../../core/accounts/payer';
import { userOf } from '../../../core/auth/guards';
import { grantHolds, liveGrantById } from '../../../core/auth/grants';
import type { AppDeps } from '../../../core/context';
import { countActivity } from '../../sharing/activity';
import { staleBefore } from '../agent/queue'; // v33 SHARE-3 (review)

// v33 SHARE-3 (PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5 "A's extension applying B's jobs"): who pays for the AI
// help the extension asks for (pick, classify, draft, answer, and a tailoring from the panel). The extension is A's (its
// token is A's: a token never names a shared profile), but when it runs a job B prepared on A's profile, B pays: the
// owner's own AI pays only for the owner's own jobs.
//
// The rule: the token holds exactly one running row of A's auto-apply queue (claimed_by = the token, state running);
// that row was prepared by someone else (prepared_by <> A) under a grant that is live and still holds `prepare:run`
// (assertGrantLive's predicate); and the request names no resume, or the row's. The review: the run is a live one,
// started within AUTOFILL_AGENT_RUN_TIMEOUT_MS (agent/queue.ts staleBefore: a run past it is stale, whether or not
// releaseStaleRuns has moved it to needs-you yet), so a row left "running" never makes B pay for A's later fills. Then
// the payer is that grantee under the grant (payerOfGrant), and the work is counted in the grant's activity (area apply,
// via extension). Otherwise (A's own row, no row, two rows, a stale run, a revoked or narrowed grant, another resume) A
// pays: ownPayer(A, 'extension').
// A session request (the Settings page) pays as any request does: payerOf(req).

/** The running queue row a token holds, as the payer rule reads it. */
interface RunningRow {
  prepared_by: string;
  grant_id: string | null;
  resume_id: string | null;
}

const RUNNING_ROWS = `SELECT prepared_by, grant_id, resume_id FROM autofill_agent_queue
   WHERE user_id = ? AND claimed_by = ? AND state = 'running' AND started_at > ? ORDER BY created_at, seq LIMIT 2`;

/**
 * The payer of a token's AI request on `ownerId`'s profile (see above): B under a live grant when the token runs exactly
 * one row B prepared (and the request's resume is that row's or none), else the owner's own.
 */
export async function payerOfQueueRun(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  ownerId: string,
  tokenId: string,
  resumeId: string | null,
): Promise<PersonPayer> {
  const rows = await deps.db.all<RunningRow>(RUNNING_ROWS, [ownerId, tokenId, staleBefore(deps)]);
  const row = rows.length === 1 ? rows[0]! : null;
  if (row && row.prepared_by !== ownerId && row.grant_id !== null && (resumeId === null || resumeId === row.resume_id)) {
    const grant = await liveGrantById(deps, row.grant_id);
    if (grant && grant.owner.id === ownerId && grant.granteeId === row.prepared_by && grantHolds(grant, 'prepare:run')) {
      return payerOfGrant(grant, 'prepare:run');
    }
  }
  return ownPayer(ownerId, 'extension');
}

/**
 * Who pays for an autofill AI request: a token's by the running queue row (payerOfQueueRun), a session's by the request
 * (payerOf). A grantee paying for the extension's help is counted in the grant's activity (once per request).
 */
export async function autofillPayerOf(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  req: Request,
  resumeId: string | null = null,
): Promise<PersonPayer> {
  const token = req.authVia === 'token' ? req.extensionToken : undefined;
  if (!token) return payerOf(req);
  const ownerId = userOf(req).id;
  const payer = await payerOfQueueRun(deps, ownerId, token.id, resumeId);
  if (payer.grantId !== null) {
    countActivity(deps, { grantId: payer.grantId, ownerId, actorId: payer.id, area: 'apply', action: 'write', via: 'extension' });
  }
  return payer;
}
