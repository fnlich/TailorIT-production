'use client';

import type { MessageParams, PublicConstantKey, PublicConstants } from '@tailorit/shared/constants';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { PUBLIC_CONSTANT_DEFAULTS, renderPublicMessage, type PublicMessageKey } from '@/lib/constants';
import type { GuideFrame } from './model';

// v34 HELP: what the guide's prose reads while it is drawn. Every number and every message it shows comes from the
// public constants (PLAN G6: no literal limits, no message retyped): in the app the server's values (usePublicConstants,
// so an admin's change shows), on the public page their defaults (GET /api/constants/public needs a session, and a
// signed-out read would send the visitor to sign in).

export interface GuideValues {
  frame: GuideFrame;
  /** The public constants the guide quotes. */
  values: PublicConstants;
}

export interface GuideApi extends GuideValues {
  get: <K extends PublicConstantKey>(key: K) => PublicConstants[K];
  t: (key: PublicMessageKey, params?: MessageParams) => string;
}

const GuideContext = createContext<GuideValues>({ frame: 'public', values: PUBLIC_CONSTANT_DEFAULTS });

export function GuideProvider({ value, children }: { value: GuideValues; children: ReactNode }) {
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}

/** The guide's frame, constants and their readers. */
export function useGuide(): GuideApi {
  const value = useContext(GuideContext);
  return useMemo(
    () => ({
      ...value,
      get: <K extends PublicConstantKey>(key: K) => value.values[key],
      t: (key: PublicMessageKey, params?: MessageParams) => renderPublicMessage(value.values, key, params),
    }),
    [value],
  );
}
