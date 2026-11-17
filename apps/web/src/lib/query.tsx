'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ACCOUNT_QUERY_KEY } from './account';
import { ApiError, isLimitError } from './api';
import { redirectToLogin } from './navigation';

/**
 * `not_signed_in` from any call (outside /api/auth/*) means the session is gone: send the person to sign in, then
 * back here. Other 401s (a wrong sign-in code answers `validation_failed`) are the caller's to show.
 */
function onAuthError(error: unknown): void {
  if (error instanceof ApiError && error.isSessionExpired) redirectToLogin();
}

/** Retries only what might succeed on a second try: network failures and 5xx, never 4xx answers. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

const isAccountQuery = (query: Query<unknown, unknown, unknown> | undefined) => query?.queryKey[0] === ACCOUNT_QUERY_KEY[0];

export function makeQueryClient(): QueryClient {
  /**
   * v2.0: a limit refusal (the AI usage, the resume limit, a Paid-only feature, the server AI) means the account's
   * counts or plan moved: GET /api/account is read again so the usage line and the buttons agree with the server
   * (docs/design/v2.0/08-ui.md, "useAccount"). The account's own read never triggers itself.
   */
  const onLimitError = (error: unknown, query?: Query<unknown, unknown, unknown>) => {
    if (isLimitError(error) && !isAccountQuery(query)) void client.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        onAuthError(error);
        onLimitError(error, query);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        onAuthError(error);
        onLimitError(error);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  return client;
}

let browserClient: QueryClient | undefined;

/** One client per browser tab; a fresh one for every server render. */
export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient();
  browserClient ??= makeQueryClient();
  return browserClient;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(getQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
