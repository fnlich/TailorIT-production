'use client';

import type { FanoutTargets } from '@tailorit/shared/sharing';
import { useState } from 'react';
// Relative, not '@/': the web tests draw these parts.
import { Button } from '../../../components/ui/Button';
import { Checkbox } from '../../../components/ui/Checkbox';
import { UsersThreeIcon } from '@phosphor-icons/react/UsersThree';
import { FANOUT_COPY } from './copy';
import { ProfilesDialog } from './parts';
import type { FanoutReport } from './results';
import { useFanoutChoices, useFanoutReport, type FanoutChoices } from './useFanout';

// v34 FANWEB (PLAN G3: "Prepare settings and the Auto-save rule get the same Apply to profiles"): settings that save as
// they change (a radio, a switch) copied to other profiles: the person ticks which of them and which profiles, and one
// request applies those settings, as the tab's profile has them now, on each (FANOUT's PATCH: only the fields sent change
// there). Off for a profile whose owner did not tick Job settings › Change (named). Hidden without a shared profile.
// v34 FANWEB fix (both reviews): hidden too on a tab whose profile is shared without Job settings › Change (v3.3: no
// write control while working on it, as Save to), and nothing is ticked when it opens (the person ticks what to copy).

/** One setting the dialog offers: its name and its value here ("Cover letters: Always"). */
export interface ApplyField<K extends string> {
  key: K;
  label: string;
  value: string;
}

/**
 * Whether "Apply to other profiles…" shows: a shared profile is there, another profile to copy to, and the tab's own
 * profile may be changed (its Job settings › Change on a shared profile; always on your own).
 */
export function applyOthersShown(choices: Pick<FanoutChoices, 'available' | 'profiles'>): boolean {
  const current = choices.profiles.find((profile) => profile.current);
  return choices.available && Boolean(current?.allowed) && choices.profiles.some((profile) => !profile.current);
}

/** The PATCH of the settings ticked, as `values` has them now (only those fields). */
export function tickedBody<K extends string, V extends Record<K, unknown>>(values: V, keys: readonly K[]): Partial<Pick<V, K>> {
  const body: Partial<Pick<V, K>> = {};
  for (const key of keys) body[key] = values[key];
  return body;
}

export function ApplyOthers<K extends string>({
  title = FANOUT_COPY.applyOthersTitle,
  help,
  fields,
  perform,
  disabled,
}: {
  title?: string;
  help: string;
  fields: readonly ApplyField<K>[];
  /** Applies the ticked settings on `targets`; answers what to say. */
  perform: (targets: FanoutTargets, keys: readonly K[]) => Promise<FanoutReport>;
  disabled?: boolean;
}) {
  const choices = useFanoutChoices(['settings:edit']);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<K>>(() => new Set());
  const report = useFanoutReport();
  if (!applyOthersShown(choices)) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<UsersThreeIcon size={14} aria-hidden="true" />}
        disabled={disabled}
        onClick={() => {
          setTicked(new Set());
          setOpen(true);
        }}
        data-apply-others=""
      >
        {FANOUT_COPY.applyOthers}
      </Button>
      <ProfilesDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        help={help}
        profiles={choices.profiles}
        label={choices.label}
        exclude={(profile) => profile.current}
        ready={ticked.size > 0}
        // v34 FIX-WEB (final review U-L1): the confirm is off until a setting and a profile are ticked: said beside it.
        waiting={FANOUT_COPY.applyNothing}
        confirmLabel={() => FANOUT_COPY.applyConfirm}
        onConfirm={async (targets) => {
          const keys = fields.map((field) => field.key).filter((key) => ticked.has(key));
          report.show(await perform(targets, keys));
        }}
      >
        <fieldset className="flex flex-col gap-2 border-0 p-0" data-apply-fields="">
          <legend className="sr-only">{FANOUT_COPY.applySettingsHelp}</legend>
          {fields.map((field) => (
            <Checkbox
              key={field.key}
              checked={ticked.has(field.key)}
              onCheckedChange={(on) =>
                setTicked((current) => {
                  const next = new Set(current);
                  if (on) next.add(field.key);
                  else next.delete(field.key);
                  return next;
                })
              }
              label={
                <span className="text-sm text-foreground">
                  <span className="font-medium">{field.label}</span>
                  <span className="text-muted-foreground">{`: ${field.value}`}</span>
                </span>
              }
            />
          ))}
        </fieldset>
      </ProfilesDialog>
      {report.element}
    </>
  );
}
