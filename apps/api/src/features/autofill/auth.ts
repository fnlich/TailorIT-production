import type { RequestHandler } from 'express';
import type { ExtensionScope } from '@tailorit/shared/autofill';
import { userOf } from '../../core/auth/guards';
import { forbidden, notSignedIn } from '../../core/http/errors';
import { keyedRateLimit } from '../../core/rate-limit';

// Who may call an autofill route. The Settings page comes with the session cookie; the extension's service worker
// with its token (core/auth/extension-tokens.ts), which reaches only /api/autofill/* and its own AI tasks
// (tokenScope), and only with the scopes its connect code carried.

/** A token's refusal for a scope its connection lacks (made before the scope existed, or without its box ticked). */
export const NOT_IN_SCOPE = 'This connection may not do that. Connect the extension again from Settings › Autofill.';

/**
 * Route guard. 'session': the Settings page only. 'token': the extension only. 'either': both, a token only when it
 * holds `scope`. For a token request, attachBearer has already set the version header on the answer, and tokenScope
 * has checked the request's.
 */
export function allow(who: 'session' | 'token' | 'either', scope?: ExtensionScope): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(notSignedIn());
    if (req.authVia === 'token') {
      if (who === 'session') return next(forbidden('Do this on the Settings › Autofill page in TailorIT.'));
      if (scope && !req.extensionToken?.scopes.includes(scope)) {
        return next(forbidden(NOT_IN_SCOPE));
      }
    } else if (who === 'token') return next(forbidden('Only the TailorIT extension uses this.'));
    next();
  };
}

/** "1 second", "30 seconds", "2 minutes". */
const amountOf = (count: number, unit: 'second' | 'minute') => `${count} ${unit}${count === 1 ? '' : 's'}`;

/**
 * "Please wait 30 seconds and try again." (minutes from 90 seconds on, so always two or more). An anti-flood route
 * limit's words (technical, A18: not a constant). v30 ST3: one sentence for both units, the same words as before.
 */
export function waitSentence(seconds: number): string {
  const amount = seconds < 90 ? amountOf(seconds, 'second') : amountOf(Math.ceil(seconds / 60), 'minute');
  return `Please wait ${amount} and try again.`;
}

/**
 * The per-account rate limit every autofill route but redeem has (redeem has one global failure limit), keyed by the
 * route's name and the account. It reads the account, so it goes after the route's allow(). A limit given as a function
 * is read on each request (a constant: an admin's edit applies at once).
 */
export function perAccountLimit(name: string, limit: number | (() => number), windowMs: number): RequestHandler {
  return keyedRateLimit({
    windowMs,
    limit: typeof limit === 'number' ? limit : () => limit(),
    key: (req) => `${name}:${userOf(req).id}`,
    message: (seconds) => `There have been too many autofill requests. ${waitSentence(seconds)}`,
  });
}
