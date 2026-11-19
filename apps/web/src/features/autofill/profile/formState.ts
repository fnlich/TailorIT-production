import { fieldKeyOf, withoutKeys, withoutMessages, writeField, type AutofillDraft } from '../draft';
import { aiHintKeys, mergeSeed, seedHintKeys, type MergedSeed } from '../mergeSeed';

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
  /** v32 FIX-API (SF-1): of those, the ones the AI read from an uploaded file ("AI read, check it"). */
  fromAi: ReadonlySet<string>;
  /** The seed's sentences to check ("Check how your name was split."), each once. */
  notes: string[];
  /** The last fill, for its toast: a new object each time (`replaced`: the person's yes to using the resume's). */
  lastFill: { count: number; label: string | null; replaced?: boolean; kept?: number } | null;
  /** v32 FILL: the last seed filled from, so the page can offer its values where the person's were kept. */
  lastSeed: MergedSeed | null;
}

export type ProfileFormAction =
  /** One field typed into: its message and mark go. */
  | { type: 'set'; key: string; value: unknown }
  /** A list changed (an entry added, moved or removed); `clears` names what loses its messages and marks. */
  | { type: 'change'; recipe: (draft: AutofillDraft) => AutofillDraft; clears: string | null }
  /** A save was refused: `messages` by place, as validation and the server name them. */
  | { type: 'refused'; messages: Record<string, string> }
  /**
   * "Fill from my resume": the seed merged into the empty fields, which get their marks and lose their messages.
   * v32 FILL: `replace`, the fields where the person said yes to the resume's value over their own; `defaults`, the
   * values the page was given that are no answer of the person's (mergeSeed).
   */
  | { type: 'fill'; seed: MergedSeed; replace?: readonly string[]; defaults?: Readonly<Record<string, unknown>> }
  /** The draft as it is about to be saved (cleanDraft): texts trimmed, empty rows dropped. */
  | { type: 'cleaned'; draft: AutofillDraft }
  | { type: 'discard'; draft: AutofillDraft };

export function initialFormState(draft: AutofillDraft): ProfileFormState {
  return { draft, errors: {}, fromResume: new Set(), fromAi: new Set(), notes: [], lastFill: null, lastSeed: null };
}

function clearing(state: ProfileFormState, key: string | null): Pick<ProfileFormState, 'errors' | 'fromResume' | 'fromAi'> {
  if (key === null) return { errors: state.errors, fromResume: state.fromResume, fromAi: state.fromAi };
  return { errors: withoutMessages(state.errors, key), fromResume: withoutKeys(state.fromResume, key), fromAi: withoutKeys(state.fromAi, key) };
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
      const merged = mergeSeed(state.draft.profile, action.seed, action.replace, action.defaults);
      const keys = seedHintKeys(merged.profile, merged.filled);
      // A list put in whole loses the marks of the entries it replaced.
      const before = action.replace?.length
        ? merged.filled.reduce((marks, field) => withoutKeys(marks, `profile.${field}`), state.fromResume)
        : state.fromResume;
      // v32 FIX-API (SF-1): every field filled now is marked again: "AI read, check it" when the AI read it.
      const aiBefore = keys.reduce((marks, key) => withoutKeys(marks, key), merged.filled.reduce((marks, field) => withoutKeys(marks, `profile.${field}`), state.fromAi));
      return {
        ...state,
        draft: { ...state.draft, profile: merged.profile },
        // A filled field has changed, so its message goes, as it does when the field is typed into.
        errors: keys.reduce((errors, key) => withoutMessages(errors, key), state.errors),
        fromResume: new Set([...before, ...keys]),
        fromAi: new Set([...aiBefore, ...aiHintKeys(keys, action.seed.fromAi)]),
        // The seed writes a sentence per entry: two degrees from one school would say the same thing twice.
        notes: [...new Set(action.seed.notes)],
        lastFill: {
          count: keys.length,
          label: action.seed.source?.label ?? null,
          ...(action.replace?.length ? { replaced: true } : {}),
          // v32 FILL: the answers kept though the resume says otherwise, for the toast.
          ...(merged.kept.length > 0 && !action.replace?.length ? { kept: merged.kept.length } : {}),
        },
        lastSeed: action.seed,
      };
    }
    case 'cleaned':
      return { ...state, draft: action.draft };
    case 'discard':
      return initialFormState(action.draft);
  }
}
