import { Router, type RequestHandler } from 'express';
import { MINUTE_MS } from '@tailorit/shared';
import { AccountDeleteBodySchema, type AccountDeleteCheck, type AccountDeletionResult } from '@tailorit/shared/account-deletion';
import { ownProfileOnly } from '../../core/auth/grants';
import { rateKeyOf, requireUser, userOf } from '../../core/auth/guards';
import { clearSessionCookie } from '../../core/auth/session';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { refuse } from '../../core/http/refuse';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import { confirmsAccount, deleteAccount, deletionRefusalOf } from './service';

// v34 ACCTDEL (PLAN G10): Settings › Account › Delete my account, mounted at /api/account/delete (session; `never` on a
// shared profile: ./acting.ts).
//   GET  /   → AccountDeleteCheck: { refusal } (why the person cannot delete their account now, or null), so the row
//            says it before anything is typed (the last administrator who can sign in)
//   POST /   AccountDeleteBody ({ email }: the account's address, typed) → 204, the session cookie cleared; or 202
//            AccountDeletionResult { state: 'pending', message } when the account is off and the rest finishes on its
//            own (the daily pass), the cookie cleared too
// The account and everything it holds go at once (./service.ts); the person is signed out (their sessions are gone).
// Refused: the address does not match (400, MSG_ACCOUNT_DELETE_EMAIL), the last administrator who can sign in (409,
// MSG_ACCOUNT_DELETE_LAST_ADMIN).

/** Tries per person per minute (an anti-flood route limit: each one reads and may delete a whole account). */
export const ACCOUNT_DELETE_TRIES_PER_MINUTE = 5;

/** The anti-flood limit of a deletion route, per person (the self route and Admin › Users'). */
export function deleteTries(name: string): RequestHandler {
  return keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: ACCOUNT_DELETE_TRIES_PER_MINUTE,
    key: (req) => `${name}:${rateKeyOf(req, MINUTE_MS)}`,
    message: (seconds) => `There have been too many tries to delete an account. ${waitSentence(seconds)}`,
  });
}

/** 400: the typed address is not the account's (its words on the form's field too). */
export function emailMismatch(deps: AppDeps) {
  const words = constantsOf(deps).message('MSG_ACCOUNT_DELETE_EMAIL');
  return refuse(deps, 'validation_failed', 'MSG_ACCOUNT_DELETE_EMAIL', undefined, { fields: { email: words } });
}

/** Never while the request names a shared profile (the route guard refuses it first; this holds before it decides). */
const ownProfileOnlyHere: RequestHandler = (req, _res, next) => {
  if (req.acting || req.actingCandidate) return next(ownProfileOnly());
  next();
};

/** Mounted at /api/account/delete. */
export function createAccountDeletionRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/', ownProfileOnlyHere, async (req, res) => {
    const me = userOf(req);
    const check: AccountDeleteCheck = { refusal: await deletionRefusalOf(deps, me) };
    res.json(check);
  });
  router.post('/', ownProfileOnlyHere, deleteTries('account-delete'), async (req, res) => {
    const me = userOf(req);
    const body = parseInput(AccountDeleteBodySchema, req.body ?? {}, 'confirmation');
    if (!confirmsAccount(me, body.email)) {
      throw emailMismatch(deps);
    }
    const done = await deleteAccount(deps, me.id, 'self');
    // Signed out either way: the account is off from the first step (its sessions refused, then deleted with it).
    clearSessionCookie(req, res, deps); // v34 INT-B (ORIGIN2): its Secure flag follows the request's public origin
    if (done.state === 'pending') {
      const answer: AccountDeletionResult = { state: 'pending', message: constantsOf(deps).message('MSG_ACCOUNT_DELETE_PENDING') };
      res.status(202).json(answer);
      return;
    }
    res.status(204).end();
  });
  return router;
}
