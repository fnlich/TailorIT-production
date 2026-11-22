'use client';

import type { PrepareFilterKey, ProfileChoice } from '@tailorit/shared/sharing';
import { useCallback, useState, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { LockSimpleIcon } from '../../../components/ui/icons';
import { FANOUT_COPY, namesList } from '../../sharing/fanout/copy';
import { ApplyToChoice, scopeTargets, type ApplyScope } from '../../sharing/fanout/parts';
import { boxName } from '../../sharing/fanout/targets';
import { useFanoutChoices, type FanoutChoices } from '../../sharing/fanout/useFanout';
import { FILTER_FIELD_LABEL } from './filters';
import type { FieldMarks, PrepareFiltersFormState, SaveFiltersInput } from './PrepareFiltersForm';

// v34 FANWEB (PLAN G3: "Apply to: This profile | choose profiles | All profiles"): where a Prepare filters form's
// changes go, shared by Settings › Prepare & Queue and the Auto-apply page's Filters dialog. This profile: a PATCH of
// the filters changed. Several profiles: each filter has its "Apply" mark (a changed one is ticked; an unchanged one
// ticked is sent as it is, so every profile can be set to a value the tab's profile has already), and the marked
// filters go to every profile chosen in one request. Hidden while the person has no shared profile.
// v34 FANWEB fix: the profiles chosen are exactly the ones ticked (the form's own profile is never added: from the form
// over every profile you may change only Ana's); the form over every profile (`everyProfile`) always sends through the
// fan-out, and waits for the shell's list of shared profiles (never the tab's single PATCH); the custom filter by
// severalFiltersPatch's rule (its words go only when typed here).

export interface FiltersScope {
  choices: FanoutChoices;
  scope: ApplyScope;
  /** The changes go to several profiles (the marks show). */
  several: boolean;
  marks: FieldMarks | undefined;
  /** There is something to save (a change; with several profiles, a marked filter, or a change not ticked: said). */
  dirty: boolean;
  /** v34 FANWEB fix (spec L6): with several profiles, the filters changed here whose mark is unticked (not sent). */
  unticked: PrepareFilterKey[];
  /** v34 FANWEB fix (sharing L5): the form over every profile waits for the list of shared profiles. */
  waiting: boolean;
  /** What to send, or null (the form's errors are shown, or nothing is marked). */
  input: () => SaveFiltersInput | null;
  /** "Apply to: …" (null: no shared profile, or a form that cannot change). */
  control: ReactNode;
}

export function useFiltersScope(
  state: PrepareFiltersFormState,
  options: {
    readOnly?: boolean;
    start?: ApplyScope;
    allowThis?: boolean;
    /** The profile the form's values are (default the tab's; the form over every profile: your own, 'me'). */
    self?: ProfileChoice;
    /** The form over every profile: always the fan-out (never the tab's PATCH), once the list of profiles is read. */
    everyProfile?: boolean;
  } = {},
): FiltersScope {
  const { readOnly = false, start = { kind: 'this' }, allowThis = true, everyProfile = false } = options;
  const choices = useFanoutChoices(['settings:edit'], { fetch: everyProfile });
  const self = options.self ?? choices.tab;
  const [scope, setScopeState] = useState<ApplyScope>(start);
  const setScope = useCallback((next: ApplyScope) => setScopeState(next), []);
  const several = everyProfile || (choices.available && scope.kind !== 'this');
  const waiting = everyProfile && !choices.loaded;
  const marks: FieldMarks | undefined = several ? { isMarked: state.marked, toggle: state.toggleMark } : undefined;
  const unticked = several ? state.changed.filter((key) => !state.marked(key)) : [];
  const dirty = several ? state.applying.length > 0 || !state.result.ok || state.dirty : state.dirty;
  const input = (): SaveFiltersInput | null => {
    if (waiting) return null;
    const plan = state.patch(several);
    if (!plan) return null;
    if (!several) return plan.patch ? { patch: plan.patch, targets: null } : null;
    if (!plan.patch && !plan.customHeld) return null;
    const targets = scope.kind === 'this' ? scopeTargets({ kind: 'all' }, self) : scopeTargets(scope, self);
    return { patch: plan.patch, targets, customHeld: plan.customHeld ? { self, here: plan.customHeld.here } : null };
  };
  const control =
    choices.available && !readOnly ? (
      <ApplyToChoice
        scope={scope}
        onChange={setScope}
        profiles={choices.profiles}
        label={choices.label}
        tab={self}
        allowThis={allowThis}
      />
    ) : null;
  return { choices, scope, several, marks, dirty, unticked, waiting, input, control };
}

/** v34 FANWEB fix (spec L6): the filters changed but not ticked, by their names ("Job type and Minimum pay"). */
export function untickedWords(keys: readonly PrepareFilterKey[]): string {
  return namesList(keys.map((key) => FILTER_FIELD_LABEL[key]));
}

/**
 * v34 FANWEB (SPECS-W2: "a missing Job settings › Change on the current shared profile says so plainly in the form"):
 * the line over a read-only form on a shared profile.
 */
export function ReadOnlyLine({ owner, label, settings = false }: { owner: string | null; label: (key: string) => string; settings?: boolean }) {
  const box = boxName('settings:edit', label);
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-control bg-surface-low px-3.5 py-2.5 text-[13px] leading-5 text-muted-foreground"
      data-filters-read-only-line=""
    >
      <LockSimpleIcon size={14} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{settings ? FANOUT_COPY.readOnlySettings(owner, box) : FANOUT_COPY.readOnlyNote(owner, box)}</span>
    </p>
  );
}
