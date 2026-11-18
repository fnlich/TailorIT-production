import { isLoopbackAddress } from '@tailorit/shared/oauth';

// v3.1 OAUTH: the addresses an OAuth client may send people back to (its redirect URIs). OAuth 2.1 and the MCP
// authorization spec: https, or http on this machine (a native app's callback: Claude Code's http://localhost:<port>/
// callback); never a fragment, a user or password, or another scheme. A presented address must equal a registered one
// exactly, except that on this machine the port is ignored (RFC 8252 §7.3; Claude Code registers
// http://localhost/callback and http://127.0.0.1/callback and listens on a port of the moment).

/** The longest redirect address. */
export const REDIRECT_URI_MAX = 2000;
/** The most redirect addresses one client registers. */
export const REDIRECT_URIS_MAX = 10;

/** Why `uri` cannot be a redirect address, or null when it can. A short technical reason, for the client's developer. */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > REDIRECT_URI_MAX) return 'not an address';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'not an address';
  }
  if (url.hash || uri.includes('#')) return 'has a fragment';
  if (url.username || url.password) return 'has a user or password';
  if (url.protocol === 'https:') return url.hostname ? null : 'has no host';
  if (url.protocol === 'http:' && isLoopbackAddress(uri)) return null;
  return 'is neither https nor http on this machine';
}

/** Whether a presented redirect address is the registered one: exactly, or on this machine with any port. */
export function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  if (!isLoopbackAddress(registered) || !isLoopbackAddress(presented)) return false;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }
  return (
    a.protocol === 'http:' &&
    b.protocol === 'http:' &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search &&
    !b.hash &&
    !b.username &&
    !b.password
  );
}

/** The host a person is sent to, as the consent page shows it (with the port on this machine). */
export function redirectHostOf(uri: string): string {
  const url = new URL(uri);
  return isLoopbackAddress(uri) ? url.host : url.hostname;
}
