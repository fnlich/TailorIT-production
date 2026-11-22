import { pruneExpiredLoginCodes } from '../../core/auth/codes';
import { pruneExpiredSessions } from '../../core/auth/session';
import { configuredAdminEmails, promoteConfiguredAdmins } from '../../core/auth/users';
import type { AppDeps } from '../../core/context';
import type { Feature } from '../../core/feature';
import { AUTH_ACTING } from './acting'; // v33 SHARE-1
import { createAuthRouter } from './router';
import { createAuthService, signInOptions } from './service';

const PRUNE_EVERY_MS = 60 * 60_000;

/**
 * Startup: drop expired sessions and codes (then hourly), promote ADMIN_EMAILS accounts that already exist, and say
 * in the log what would otherwise fail quietly (nobody can sign in, nobody is an administrator).
 */
export async function startAuth(deps: AppDeps): Promise<() => void> {
  const prune = async () => {
    try {
      const sessions = await pruneExpiredSessions(deps);
      const codes = await pruneExpiredLoginCodes(deps);
      if (sessions || codes) deps.log.debug(`[auth] pruned ${sessions} expired session(s), ${codes} expired code(s)`);
    } catch (error) {
      deps.log.warn('[auth] could not prune expired sessions', error);
    }
  };
  await prune();

  const promoted = await promoteConfiguredAdmins(deps);
  if (promoted) deps.log.info(`[auth] ${promoted} account(s) listed in ADMIN_EMAILS were made administrators.`);
  if (configuredAdminEmails(deps).length === 0) {
    deps.log.warn('[auth] No administrator is configured. Add your address to ADMIN_EMAILS in .env and restart.');
  }

  const options = signInOptions(deps);
  if (!options.google.available && !options.email.available) {
    deps.log.warn(
      '[auth] Nobody can sign in: set GOOGLE_CLIENT_ID, or SMTP_HOST, SMTP_USER and SMTP_PASS, in .env and restart.',
    );
  }
  if (options.email.devCodesInConsole) {
    deps.log.info('[auth] SMTP is not configured: sign-in codes are printed in this console instead of emailed.');
  }
  if (deps.config.auth.devFixedCode) {
    // Loud on purpose: with this set, the sign-in page is open to whoever uses this computer (v34 FIX-API, the final
    // security review F1: only from this computer; with the test servers' opt-in, from every address).
    const rule = `[auth] ${'!'.repeat(100)}`;
    deps.log.warn(rule);
    if (deps.config.auth.devFixedCodeAnyAddress) {
      deps.log.warn(
        '[auth] AUTH_DEV_FIXED_CODE is set with AUTH_DEV_FIXED_CODE_ANY_ADDRESS (TailorIT\'s test servers only): anyone who ' +
          'can reach this server, through a tunnel or from the network too, can sign in as any address, administrators included.',
      );
    } else {
      deps.log.warn(
        '[auth] AUTH_DEV_FIXED_CODE is set: anyone using this computer can sign in as any address with it, administrators ' +
          'included. It works only from this computer (a page at localhost, 127.0.0.1 or [::1], with no tunnel or proxy in ' +
          'between); through a tunnel or from another device it is a wrong code.',
      );
    }
    deps.log.warn('[auth] Use it for automated tests only, and clear it before anyone else uses this computer or its TailorIT.');
    deps.log.warn(rule);
  }

  const timer = setInterval(() => void prune(), PRUNE_EVERY_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    deps.services.auth?.mailer?.close();
  };
}

// Passwordless sign-in (Google + email code) and sessions. Owned by work package F3.
export const authFeature: Feature = {
  name: 'auth',
  services: (deps) => {
    deps.services.auth = createAuthService(deps);
  },
  routes: [{ path: '/api/auth', router: createAuthRouter, acting: AUTH_ACTING /* v33 SHARE-1 */ }],
  start: startAuth,
};
