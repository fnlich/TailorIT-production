import { EXTENSION_SCOPES, type ExtensionScope } from '@tailorit/shared/autofill';

// What a connected browser may do, as Settings › Autofill › Extension tells it. A connection keeps the scopes its
// connect code carried: one made before TailorIT added a scope (autofill API 2 added adding jobs and cover letters; 3
// editing the profile, marking jobs Applied, auto-apply and job-site sign-ins) is refused there, "Connect the
// extension again", so its row says so before the extension does. API 4 (Workable), 5 and 6 (more ATSs) added no
// scope: a connection made under 3 stays as it is, and only the extension needs updating.

/**
 * The scopes a connection carries only when its box was ticked: the sensitive answers, and reading the saved job-site
 * password (Sign-in mode Auto).
 */
const OPT_IN: readonly ExtensionScope[] = ['profile:sensitive', 'credentials:read'];

/** The scopes every connection made now carries, whatever its boxes say. */
const EVERY_CONNECTION: readonly ExtensionScope[] = EXTENSION_SCOPES.filter((scope) => !OPT_IN.includes(scope));

/** Whether a connection lacks a scope every connection made now carries: connecting it again gives them all. */
export function isOlderConnection(scopes: readonly string[]): boolean {
  return EVERY_CONNECTION.some((scope) => !scopes.includes(scope));
}
