'use client';

// v20 FIX-A (SEC-5): the public constants module only. The whole table (@tailorit/shared/constants' CONSTANTS) holds
// the daily AI budgets, the prices and the capacity threshold, which must never reach a browser; types are erased.
import type { MessageKey, MessageParams, PublicConstantKey, PublicConstants } from '@tailorit/shared/constants';
import {
  PUBLIC_CONSTANT_DEFAULTS,
  PublicConstantsResponseSchema,
  renderMessage,
  resetText,
  setSharedMessages,
  type PublicConstantsResponse,
} from '@tailorit/shared/constants/public';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { apiFetch } from './api';

// v2.0: the constants the web shows (docs/design/v2.0/02-constants.md, "What the web reads"; 08-ui.md, "Shared
// pieces"). Error bodies always carry a message the server rendered already; these are for the words the web shows
// before any request: the Prepare confirm, the usage line, the filter labels, the Subscribe and credit dialogs. An
// admin's change reaches the page within the stale time, or at once on the next focus.

/** React Query key of GET /api/constants/public. */
export const PUBLIC_CONSTANTS_QUERY_KEY = ['constants', 'public'] as const;
/** How long the public constants are fresh (02: once per session, 5 minutes, again on focus). */
export const PUBLIC_CONSTANTS_STALE_MS = 5 * 60_000;

/** The public constants' messages (every message is public): the keys `t` renders. */
export type PublicMessageKey = Extract<MessageKey, PublicConstantKey>;

/** GET /api/constants/public (session). */
export function fetchPublicConstants(signal?: AbortSignal): Promise<PublicConstantsResponse> {
  // v30 CT (edit B, INT-1): the shared checks' words follow the answer, so an admin's edit reaches them in the browser.
  return apiFetch<PublicConstantsResponse>('/api/constants/public', { schema: PublicConstantsResponseSchema, signal }).then(
    (answer) => {
      setSharedMessages(answer.values);
      return answer;
    },
  );
}

/**
 * Every public constant at its default: what the web shows until the server answers, and if it never does. The
 * defaults are the constants file's (generated into the public module), so the words are right unless an admin changed
 * them.
 */
export { PUBLIC_CONSTANT_DEFAULTS };

/**
 * Message `key` of `values` with its placeholders filled, as the API's constants service fills them: {reset_time} is
 * resetText(DAY_RESET_TIME, DAY_RESET_ZONE_LABEL) and {contact_email} is ADMIN_CONTACT_EMAIL, unless `params` names
 * them; a placeholder with no value renders as nothing (renderMessage).
 */
export function renderPublicMessage(values: PublicConstants, key: PublicMessageKey, params: MessageParams = {}): string {
  return renderMessage(values[key], {
    contact_email: values.ADMIN_CONTACT_EMAIL ?? '',
    reset_time: resetText(values.DAY_RESET_TIME, values.DAY_RESET_ZONE_LABEL),
    ...params,
  });
}

/**
 * v2.0 fix wave (REQ-3): a text past its length, in MSG_TEXT_TOO_LONG's words ("Use at most {max} characters."). A form
 * check takes the page's `(max) => t('MSG_TEXT_TOO_LONG', { max })`, so an admin's words show; without one (a test, a
 * check run before the constants are read) it reads the default.
 */
export type TooLongText = (max: number) => string;
export const defaultTooLong: TooLongText = (max) => renderPublicMessage(PUBLIC_CONSTANT_DEFAULTS, 'MSG_TEXT_TOO_LONG', { max });

export interface PublicConstantsState {
  /** The server's values once they are read; the defaults until then (and when the read failed). */
  values: PublicConstants;
  /** The server's version of the values (null until read): it goes up with every admin change. */
  version: number | null;
  /** True once the server's values are in. */
  isLoaded: boolean;
  isError: boolean;
  /** One value: get('FREE_AUTO_APPLY_PER_DAY'). */
  get: <K extends PublicConstantKey>(key: K) => PublicConstants[K];
  /** A message with its placeholders filled: t('MSG_AUTO_APPLY_USAGE', {used: 3, limit: 7}) → "3 of 7 used today". */
  t: (key: PublicMessageKey, params?: MessageParams) => string;
}

/**
 * The public constants (GET /api/constants/public through React Query: 5-minute stale time, read again on focus), with
 * `t(key, params)` to render a message. Usable anywhere under the app's QueryProvider.
 */
export function usePublicConstants(): PublicConstantsState {
  const query = useQuery({
    queryKey: PUBLIC_CONSTANTS_QUERY_KEY,
    queryFn: ({ signal }) => fetchPublicConstants(signal),
    staleTime: PUBLIC_CONSTANTS_STALE_MS,
    refetchOnWindowFocus: true,
  });
  const values = query.data?.values ?? PUBLIC_CONSTANT_DEFAULTS;
  const get = useCallback(<K extends PublicConstantKey>(key: K) => values[key], [values]);
  const t = useCallback((key: PublicMessageKey, params?: MessageParams) => renderPublicMessage(values, key, params), [values]);
  const version = query.data?.version ?? null;
  const { isSuccess, isError } = query;
  return useMemo(
    () => ({ values, version, isLoaded: isSuccess, isError, get, t }),
    [values, version, isSuccess, isError, get, t],
  );
}
