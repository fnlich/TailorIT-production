'use client';

import {
  AccountSummarySchema,
  type AccountFeature,
  type AccountSummary,
} from '@tailorit/shared/accounts';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';

// v2.0: the person's account as the web shows it (docs/design/v2.0/04-accounts-limits.md, "Subscribe and Buy credit";
// 08-ui.md, "Shared pieces"): the type and term, today's auto-applies, the resume count, the plan's features, the
// extra-credit balance, and how Subscribe and Buy credit work. Never the AI budget or anything about the server.

/** React Query key of GET /api/account. */
export const ACCOUNT_QUERY_KEY = ['account'] as const;

/** GET /api/account (session). */
export function fetchAccount(signal?: AbortSignal): Promise<AccountSummary> {
  return apiFetch<AccountSummary>('/api/account', { schema: AccountSummarySchema, signal });
}

/**
 * The signed-in person's account summary (React Query). It is read again on focus, after any limit error (lib/query.tsx
 * marks it stale) and after every Prepare (the caller's invalidateAccount). `data` is undefined until it is read: a
 * component that needs it shows nothing account-specific until then (the server enforces every limit anyway).
 */
export function useAccount() {
  return useQuery({
    queryKey: ACCOUNT_QUERY_KEY,
    queryFn: ({ signal }) => fetchAccount(signal),
    refetchOnWindowFocus: true,
  });
}

/** Marks the account stale so every view of it reads it again: after a Prepare, a limit error, a change of plan. */
export function invalidateAccount(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
}

/** The summary's flag of each plan feature. */
const FEATURE_FLAGS = {
  ai_job_search: 'aiJobSearch',
  mcp: 'mcp',
  batch_download: 'batchDownload',
} as const satisfies Record<AccountFeature, keyof AccountSummary['features']>;

/**
 * Whether the account's plan turns `feature` off (a Paid-only feature on a Free account): the web then shows the
 * locked-feature dialog instead of asking. False while the account is unknown: the request is made and the server's
 * 403 `paid_feature` shows the same message.
 */
export function isFeatureLocked(account: AccountSummary | null | undefined, feature: AccountFeature): boolean {
  return account ? !account.features[FEATURE_FLAGS[feature]] : false;
}

/**
 * Whether a Subscribe button may show to this account: never to a Paid one (`subscribe.visible` false). While the
 * account is unknown, the limit message's own `subscribe` decides (the server sets it for Free accounts only).
 */
export function subscribeAllowed(account: AccountSummary | null | undefined): boolean {
  return account ? account.subscribe.visible : true;
}
