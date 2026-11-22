import { dehydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';
import { apiOrigin } from '@/lib/addresses';

// v34 PUBLIC (PLAN G8; the review's finding 3): the public constants read on the server for the public pages, so their
// HTML already names the operator, the contact address and the retention days (a reviewer, a crawler or a reader without
// JavaScript sees the real values, never "no contact" while the browser's read is on its way). app/(public)/layout.tsx
// reads GET /api/constants/public (no session: it answers signed out) and hands the answer to the browser's query cache
// through a HydrationBoundary, under lib/constants.ts's key, so usePublicConstants() starts with it.
//
// One read per PUBLIC_CONSTANTS_REVALIDATE_SECONDS per server process (kept in memory here: the layout renders for each
// request); a failed read keeps the last good answer, or gives null (the browser then reads them itself, and the pages
// draw neutral lines until it has). HELP's /guide renders under the same layout; INT may move this helper to lib/ if
// another frame needs it.

/** lib/constants.ts PUBLIC_CONSTANTS_QUERY_KEY (that module is a client module; public.test.ts keeps the two equal). */
export const PUBLIC_CONSTANTS_KEY = ['constants', 'public'] as const;
/** How long the server keeps an answer before it reads the constants again (an admin's change shows within it). */
export const PUBLIC_CONSTANTS_REVALIDATE_SECONDS = 300;
/** How long the server waits for the API before it renders without the values. */
const READ_TIMEOUT_MS = 2500;

/** GET /api/constants/public's answer, as the browser's query cache holds it. */
export interface PublicConstantsAnswer {
  version: number;
  values: Record<string, unknown>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function isAnswer(body: unknown): body is PublicConstantsAnswer {
  if (!body || typeof body !== 'object') return false;
  const { version, values } = body as { version?: unknown; values?: unknown };
  return typeof version === 'number' && !!values && typeof values === 'object' && !Array.isArray(values);
}

let kept: { answer: PublicConstantsAnswer; at: number } | null = null;

/** Forgets the kept answer (tests). */
export function forgetPublicConstantsOnServer(): void {
  kept = null;
}

/**
 * The public constants for a server render: the kept answer while it is fresh, else a new read of the API
 * (API_INTERNAL_URL, else API_HOST:API_PORT); on a failed read the last good answer, or null.
 */
export async function readPublicConstantsOnServer(
  options: { env?: Record<string, string | undefined>; fetcher?: Fetcher; now?: () => number } = {},
): Promise<PublicConstantsAnswer | null> {
  const { env = process.env, fetcher = fetch, now = Date.now } = options;
  if (kept && now() - kept.at < PUBLIC_CONSTANTS_REVALIDATE_SECONDS * 1000) return kept.answer;
  try {
    const response = await fetcher(`${apiOrigin(env)}/api/constants/public`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) return kept?.answer ?? null;
    const body: unknown = await response.json();
    if (!isAnswer(body)) return kept?.answer ?? null;
    kept = { answer: body, at: now() };
    return body;
  } catch {
    return kept?.answer ?? null;
  }
}

/** The browser query cache's starting state: the answer under the public constants' key (nothing when null). */
export function publicConstantsState(answer: PublicConstantsAnswer | null, now: number = Date.now()): DehydratedState {
  const client = new QueryClient();
  if (answer) client.setQueryData(PUBLIC_CONSTANTS_KEY, answer, { updatedAt: now });
  return dehydrate(client);
}
