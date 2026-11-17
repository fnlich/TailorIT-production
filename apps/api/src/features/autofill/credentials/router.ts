import { Router, type ErrorRequestHandler } from 'express';
import {
  AutofillCredentialQuerySchema,
  AutofillSignInIdSchema,
  PutAutofillSignInBodySchema,
} from '@tailorit/shared/autofill';
import { userOf } from '../../../core/auth/guards';
import type { AppDeps } from '../../../core/context';
import { AppError, notFound, sendError } from '../../../core/http/errors';
import { parseInput } from '../../../core/http/validate';
import { allow, perAccountLimit } from '../auth';
import { credentialFor, deleteSignIn, listSignIns, saveSignIn } from './repository';
import { MINUTE_MS, HOUR_MS } from '@tailorit/shared';

// The person's job-site sign-ins (work package AF, autofill API version 3, Phase 5), mounted at /api/autofill:
//   GET    /credentials?host=&path=  a token only (credentials:read: a connection made with "sign in to job sites for
//                              me") → AutofillCredential {host, email, password}: the sign-in for that host, else, on
//                              a job site that makes an applicant sign in (version 6: on ADP's and ClearCompany's hosts,
//                              under their candidate paths alone, which `path` names), the one for every site; 404
//                              otherwise. Cache-Control no-store, no ETag. 30 an hour per account. The read is recorded
//                              (the host, never the path).
//   GET    /sign-ins           Settings → AutofillSignInList (host, email, times, last read: never a password)
//   PUT    /sign-ins           Settings PutAutofillSignInBody {host, email, password?} → AutofillSignInItem
//   DELETE /sign-ins/:id       Settings → 204; 404 for another account's or none
// The extension's worker reads one only for a sign-in in Sign-in mode Auto, and keeps it in memory for that sign-in.
// Nothing here logs a password, an email, a host or a page's path: the debug lines name the account, the token and
// whether the site's own sign-in or the one for every site answered. Refusals are answered here, so the shared error
// handler never logs these paths (the query names the host and the page's path), and a failure on our side is logged by
// its sentence and its cause's class name alone.

/** Sign-ins read per account per hour: one per Auto sign-in. */
export const CREDENTIAL_READS_PER_HOUR = 30;
/** The Settings page's calls per account per minute. */
export const SIGN_IN_CALLS_PER_MINUTE = 30;

/** A refusal as the shared handler answers it, a library's client error (a path that does not decode) unlogged. */
function refusalOf(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const { status, statusCode } = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  const code = typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : 500;
  if (Number.isInteger(code) && code >= 400 && code < 500) {
    return code === 404 ? notFound() : new AppError('validation_failed', 'The request is not valid.', { status: code });
  }
  return new AppError('internal', 'Something went wrong on our side. Please try again.', { cause: error });
}

export function createAutofillCredentialsRouter(deps: AppDeps): Router {
  const router = Router();
  const readLimit = perAccountLimit('autofill-credential-read', CREDENTIAL_READS_PER_HOUR, HOUR_MS);
  const settingsLimit = perAccountLimit('autofill-sign-ins', SIGN_IN_CALLS_PER_MINUTE, MINUTE_MS);

  router.get('/credentials', allow('token', 'credentials:read'), readLimit, async (req, res) => {
    const userId = userOf(req).id;
    const { host, path } = parseInput(AutofillCredentialQuerySchema, req.query, 'query');
    const credential = await credentialFor(deps, userId, host, path);
    if (!credential) throw notFound('A job-site sign-in for this site');
    const which = credential.host === host ? "the site's own" : 'the one for every site';
    deps.log.debug(`[autofill] token ${req.extensionToken?.id ?? '?'} of account ${userId} read a job-site sign-in (${which})`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(credential);
  });

  router.get('/sign-ins', allow('session'), settingsLimit, async (req, res) => {
    res.json(await listSignIns(deps, userOf(req).id));
  });

  router.put('/sign-ins', allow('session'), settingsLimit, async (req, res) => {
    const userId = userOf(req).id;
    const body = parseInput(PutAutofillSignInBodySchema, req.body ?? {}, 'sign-in');
    const item = await saveSignIn(deps, userId, body);
    deps.log.debug(`[autofill] account ${userId} saved a job-site sign-in${body.password === undefined ? ' (email only)' : ''}`);
    res.json(item);
  });

  router.delete('/sign-ins/:id', allow('session'), settingsLimit, async (req, res) => {
    const userId = userOf(req).id;
    const id = parseInput(AutofillSignInIdSchema, req.params.id, 'sign-in id');
    await deleteSignIn(deps, userId, id);
    deps.log.debug(`[autofill] account ${userId} deleted a job-site sign-in`);
    res.status(204).end();
  });

  const answerRefusal: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const refusal = refusalOf(error);
    if (refusal.status >= 500) {
      const cause = refusal.cause === undefined ? '' : ` (${refusal.cause instanceof Error ? refusal.cause.name : typeof refusal.cause})`;
      deps.log.error(`[${req.requestId}] [autofill] job-site sign-in: ${refusal.message}${cause}`);
    }
    sendError(res, refusal, req.requestId);
  };
  router.use(answerRefusal);

  return router;
}
