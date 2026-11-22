import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath } from '@/features/public/paths'; // v34 PUBLIC
import { apiOrigin as apiOriginFrom, forwardedAddress } from '@/lib/addresses'; // v34 ORIGIN2: forwardedAddress
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from '@/lib/navigation';

/*
 * Optimistic sign-in gate (Next 16's "proxy", formerly middleware). It only looks for the session cookie; the API
 * decides whether the session is real, and a 401 from any call sends the browser back here.
 *
 * - "/"                → /jobs (signed in) or /login
 * - app pages          → /login?next=<page> when there is no session cookie
 * - /login             → `next` (or /jobs) when the cookie belongs to a live session; a dead cookie is cleared
 * - /dev/*             → open without a session outside production (the kit page)
 * - public pages       → open without a session (v34 PUBLIC: /guide, /privacy, /terms, /support, the 4 brand icons)
 * - /api/*, Next files, root icons and /brand icons → never reach this function (matcher below)
 */

/** Must match apps/api/src/core/auth/session.ts SESSION_COOKIE. */
const SESSION_COOKIE = 'ti_session';

/** API_INTERNAL_URL, else http://<API_HOST>:<API_PORT> (lib/addresses.ts). */
function apiOrigin(): string {
  return apiOriginFrom(process.env);
}

type SessionVerdict = 'valid' | 'invalid' | 'unknown';

/** Asks the API whether the cookie is a live session. Anything but a clear answer is "unknown". */
async function sessionVerdict(request: NextRequest): Promise<SessionVerdict> {
  try {
    const response = await fetch(`${apiOrigin()}/api/auth/me`, {
      // v34 ORIGIN2: and the page's address (lib/addresses.ts forwardedAddress): a session works at its own only.
      headers: { cookie: request.headers.get('cookie') ?? '', accept: 'application/json', ...forwardedAddress(request.headers) },
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return 'unknown';
    const body = (await response.json()) as { account?: unknown };
    if (!body || typeof body !== 'object' || !('account' in body)) return 'unknown';
    return body.account ? 'valid' : 'invalid';
  } catch {
    return 'unknown';
  }
}

function isLoginPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/login/');
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === '/') {
    return NextResponse.redirect(new URL(hasSession ? DEFAULT_AFTER_SIGN_IN : '/login', request.url));
  }

  if (isLoginPath(pathname)) {
    if (!hasSession) return NextResponse.next();
    const verdict = await sessionVerdict(request);
    if (verdict === 'valid') {
      const next = safeNextPath(request.nextUrl.searchParams.get('next'));
      return NextResponse.redirect(new URL(next, request.url));
    }
    const response = NextResponse.next();
    // A cookie the API no longer knows would otherwise bounce between /login and the app.
    if (verdict === 'invalid') response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  if ((pathname === '/dev' || pathname.startsWith('/dev/')) && process.env.NODE_ENV !== 'production') {
    return NextResponse.next();
  }

  // v34 PUBLIC (PLAN G8): the public pages (/guide, /privacy, /terms, /support) and the brand icons (/brand/*) open
  // without a session, signed in or not; nothing else does (features/public/paths.ts isPublicPath).
  if (isPublicPath(pathname)) return NextResponse.next();

  if (!hasSession) {
    // Client navigations carry Next's internal `_rsc` parameter; it does not belong in the page to come back to.
    const params = new URLSearchParams(search);
    params.delete('_rsc');
    const query = params.toString();
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${query ? `?${query}` : ''}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except the API rewrite and Next internals (its built files and fonts under _next/ and, in development,
  // __nextjs_font/).
  // v31 OAUTH: and the MCP endpoint, the well-known documents and the OAuth endpoints the API answers
  // (features/oauth/passthrough.ts): an AI app calling them has no session to sign in with.
  // v34 PUBLIC (the review's finding 10): and only real static files: a file at the root with an image, text or manifest
  // extension (the app's icon.svg, a favicon.ico) and the brand icons (/brand/<name>.png|svg). Before, any path whose
  // last part had a dot skipped the gate, so an app page such as /companies/1.json opened without a session.
  // (One line: features/oauth/passthrough.test.ts reads the literal.)
  matcher: ['/((?!api|_next/|__nextjs_font/|mcp(?:/|$)|\\.well-known/|oauth/(?:authorize|token|register|revoke)(?:/|$)|[^/]+\\.(?:ico|png|svg|txt|xml|webmanifest)$|brand/[^/]+\\.(?:png|svg)$).*)'],
};
