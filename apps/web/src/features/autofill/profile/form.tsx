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
  /** v33 SHARE-7: the sensitive answers (`sensitive.*`) on a shared profile, by the owner's Sensitive answers boxes. */
  sensitive: SensitiveGate;
}

/**
 * v33 SHARE-7 (PLAN F9 "masked in the profile"; SP v33 PLAN-sharing.md §9): how the sensitive answers show. `shown`:
 * the person's own, or a shared profile with both Sensitive answers boxes; `readOnly`: See without Change (shown, never
 * changed or sent); `hidden`: no See box (never read: not drawn, and the Review leaves them out).
 */
export type SensitiveGate = 'shown' | 'readOnly' | 'hidden';

const ProfileFormContext = createContext<ProfileForm | null>(null);

export function ProfileFormProvider({
  state,
  dispatch,
  busy,
  sensitive = 'shown',
  children,
}: {
  state: ProfileFormState;
  dispatch: (action: ProfileFormAction) => void;
  busy: boolean;
  /** v33 SHARE-7: the sensitive answers' gate (the person's own profile: shown). */
  sensitive?: SensitiveGate;
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
      sensitive,
    }),
    [state, dispatch, busy, t, sensitive],
  );
  return <ProfileFormContext.Provider value={form}>{children}</ProfileFormContext.Provider>;
}

/**
 * v33 SHARE-7: fields shown and never changed (every control off, as while a save runs; `set` does nothing): a shared
 * profile's sensitive answers without their Change box, its contact email and phone.
 */
export function ReadOnlyFields({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  const form = useProfileForm();
  const locked = useMemo<ProfileForm>(() => ({ ...form, busy: true, set: () => undefined }), [form]);
  // Always the same element, so the fields keep their own state when it turns on or off.
  return <ProfileFormContext.Provider value={readOnly ? locked : form}>{children}</ProfileFormContext.Provider>;
}

/** v33 SHARE-7: fields of the sensitive answers (`sensitive.*`): not drawn without See, shown and not changed without Change. */
export function SensitiveFields({ children }: { children: ReactNode }) {
  const { sensitive } = useProfileForm();
  if (sensitive === 'hidden') return null;
  return <ReadOnlyFields readOnly={sensitive === 'readOnly'}>{children}</ReadOnlyFields>;
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
