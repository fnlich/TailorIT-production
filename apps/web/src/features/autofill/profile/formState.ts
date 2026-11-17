import type { AutofillSeed } from '@tailorit/shared/autofill';
import { fieldKeyOf, withoutKeys, withoutMessages, writeField, type AutofillDraft } from '../draft';
import { mergeSeed, seedHintKeys } from '../mergeSeed';

// The Profile tab's form state: the draft, its messages and its "From your resume" marks change together in one
// reducer, so an edit clears its own message and mark in the same step, and a fill from the resume merges into the
// draft as it stands when the seed arrives (not as it stood when the button was pressed), clearing the messages of
// the fields it fills.

export interface ProfileFormState {
  draft: AutofillDraft;
  /** Messages by field key (see draft.ts). */
  errors: Record<string, string>;
  /** The fields "Fill from my resume" filled and nothing has changed since. */
  fromResume: ReadonlySet<string>;
  /** The seed's sentences to check ("Check how your name was split."), each once. */
  notes: string[];
  /** The last fill, for its toast: a new object each time. */
  lastFill: { count: number; label: string | null } | null;
}

export type ProfileFormAction =
  /** One field typed into: its message and mark go. */
  | { type: 'set'; key: string; value: unknown }
  /** A list changed (an entry added, moved or removed); `clears` names what loses its messages and marks. */
  | { type: 'change'; recipe: (draft: AutofillDraft) => AutofillDraft; clears: string | null }
  /** A save was refused: `messages` by place, as validation and the server name them. */
  | { type: 'refused'; messages: Record<string, string> }
  /** "Fill from my resume": the seed merged into the empty fields, which get their marks and lose their messages. */
  | { type: 'fill'; seed: AutofillSeed }
  /** The draft as it is about to be saved (cleanDraft): texts trimmed, empty rows dropped. */
  | { type: 'cleaned'; draft: AutofillDraft }
  | { type: 'discard'; draft: AutofillDraft };

export function initialFormState(draft: AutofillDraft): ProfileFormState {
  return { draft, errors: {}, fromResume: new Set(), notes: [], lastFill: null };
}

function clearing(state: ProfileFormState, key: string | null): Pick<ProfileFormState, 'errors' | 'fromResume'> {
  if (key === null) return { errors: state.errors, fromResume: state.fromResume };
  return { errors: withoutMessages(state.errors, key), fromResume: withoutKeys(state.fromResume, key) };
}

export function profileFormReducer(state: ProfileFormState, action: ProfileFormAction): ProfileFormState {
  switch (action.type) {
    case 'set':
      return { ...state, ...clearing(state, action.key), draft: writeField(state.draft, action.key, action.value) };
    case 'change':
      return { ...state, ...clearing(state, action.clears), draft: action.recipe(state.draft) };
    case 'refused': {
      const errors: Record<string, string> = {};
      for (const [place, message] of Object.entries(action.messages)) {
        errors[fieldKeyOf(place, state.draft)] ??= message;
      }
      return { ...state, errors };
    }
    case 'fill': {
      const merged = mergeSeed(state.draft.profile, action.seed);
      const keys = seedHintKeys(merged.profile, merged.filled);
      return {
        ...state,
        draft: { ...state.draft, profile: merged.profile },
        // A filled field has changed, so its message goes, as it does when the field is typed into.
        errors: keys.reduce((errors, key) => withoutMessages(errors, key), state.errors),
        fromResume: new Set([...state.fromResume, ...keys]),
        // The seed writes a sentence per entry: two degrees from one school would say the same thing twice.
        notes: [...new Set(action.seed.notes)],
        lastFill: { count: keys.length, label: action.seed.source?.label ?? null },
      };
    }
    case 'cleaned':
      return { ...state, draft: action.draft };
    case 'discard':
      return initialFormState(action.draft);
  }
}
