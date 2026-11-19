'use client';

import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import { usePublicConstants } from '@/lib/constants';
import { readField, type AutofillDraft } from '../draft';
import { initialFormState, profileFormReducer, type ProfileFormAction, type ProfileFormState } from './formState';

/** What a field reads and does through its key. */
export interface ProfileForm {
  state: ProfileFormState;
  dispatch: (action: ProfileFormAction) => void;
  /** True while a save runs: every control is disabled. */
  busy: boolean;
  read: (key: string) => unknown;
  /** The text at `key` ('' for anything else). */
  text: (key: string) => string;
  set: (key: string, value: unknown) => void;
  /** The message of exactly this field. */
  error: (key: string) => string | undefined;
  /** The first message of this field or of a place inside it (a list's chips, an answer's value). */
  errorWithin: (key: string) => string | undefined;
  isFromResume: (key: string) => boolean;
  /** v32 FIX-API (SF-1): filled from the AI's reading of an uploaded file, and not changed since. */
  isFromAi: (key: string) => boolean;
  /** v32 FIX-API (SF-1): the field's fill mark in words ("AI read, check it", "From your resume"), null without one. */
  markText: (key: string) => string | null;
}

const ProfileFormContext = createContext<ProfileForm | null>(null);

export function ProfileFormProvider({
  state,
  dispatch,
  busy,
  children,
}: {
  state: ProfileFormState;
  dispatch: (action: ProfileFormAction) => void;
  busy: boolean;
  children: ReactNode;
}) {
  const { t } = usePublicConstants();
  const form = useMemo<ProfileForm>(
    () => ({
      state,
      dispatch,
      busy,
      read: (key) => readField(state.draft, key),
      text: (key) => {
        const value = readField(state.draft, key);
        return typeof value === 'string' ? value : '';
      },
      set: (key, value) => dispatch({ type: 'set', key, value }),
      error: (key) => state.errors[key],
      errorWithin: (key) =>
        state.errors[key] ??
        Object.entries(state.errors).find(([place]) => place.startsWith(`${key}.`))?.[1],
      isFromResume: (key) => state.fromResume.has(key),
      isFromAi: (key) => state.fromAi.has(key),
      markText: (key) => (state.fromAi.has(key) ? t('LABEL_AUTOFILL_AI_READ') : state.fromResume.has(key) ? 'From your resume' : null),
    }),
    [state, dispatch, busy, t],
  );
  return <ProfileFormContext.Provider value={form}>{children}</ProfileFormContext.Provider>;
}

export function useProfileForm(): ProfileForm {
  const form = useContext(ProfileFormContext);
  if (!form) throw new Error('useProfileForm is used outside ProfileFormProvider');
  return form;
}

/** The reducer for a form that starts from `draft`. */
export function useProfileFormState(draft: AutofillDraft) {
  return useReducer(profileFormReducer, draft, initialFormState);
}
