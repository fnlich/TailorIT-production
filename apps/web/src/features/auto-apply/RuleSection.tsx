'use client';

import type { AutofillAgentSettings } from '@tailorit/shared/autofill';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { CaretDownIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Slider } from '@/components/ui/Slider';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { autoApplyKeys, saveAgentSettings } from './api';

/** The slider saves this long after it last moved, so arrow keys held down send one save. */
const SLIDER_SAVE_DELAY_MS = 600;
/** Below this minimum the page warns that the rule takes jobs that barely match. */
const LOW_MATCH = 50;

/** A whole percentage from 0 to 100, or null for text that is not one. */
function percentOf(text: string): number | null {
  if (!/^\s*\d{1,3}\s*%?\s*$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return value >= 0 && value <= 100 ? value : null;
}

/**
 * v2.0: the optional rule "Save new jobs of at least N% match to Saved Jobs" (A4: it saves, never queues, never spends
 * AI), off until the person turns it on, in a collapsible "Auto-save new jobs" under the Saved pane. The switch saves
 * at once; the threshold saves as the slider is let go (or as the page is left), or as its box is left or Enter is
 * pressed. One save runs at a time: a change made meanwhile waits for it, then goes, so the last one always wins. The
 * new jobs are those TailorIT first sees after the rule is turned on.
 */
export function RuleSection({ settings }: { settings: AutofillAgentSettings }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const hintId = useId();
  const headingId = useId();
  const panelId = useId();
  const [expanded, setExpanded] = useState(settings.ruleEnabled);
  const [minMatch, setMinMatch] = useState(settings.minMatch);
  const [typed, setTyped] = useState(String(settings.minMatch));
  // The saved threshold (a save's answer, a reload) replaces what is shown, as it changes.
  const [shownFor, setShownFor] = useState(settings.minMatch);
  if (shownFor !== settings.minMatch) {
    setShownFor(settings.minMatch);
    setMinMatch(settings.minMatch);
    setTyped(String(settings.minMatch));
  }
  // A change made while a save runs: sent once that save is done (the ref for the logic, the state for the switch).
  const queuedRef = useRef<AutofillAgentSettings | null>(null);
  const [queued, setQueued] = useState<AutofillAgentSettings | null>(null);
  // The slider's save waiting for the keys or the pointer to rest.
  const sliderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sliderValue = useRef<number | null>(null);

  /** The settings as they will be once every save asked for is done. */
  const latest = (): AutofillAgentSettings =>
    queuedRef.current ?? queryClient.getQueryData<AutofillAgentSettings>(autoApplyKeys.settings) ?? settings;

  const save = useMutation({
    mutationFn: saveAgentSettings,
    onMutate: () => queryClient.getQueryData<AutofillAgentSettings>(autoApplyKeys.settings) ?? settings,
    onSuccess: (saved, asked, before) => {
      queryClient.setQueryData<AutofillAgentSettings>(autoApplyKeys.settings, saved);
      if (asked.ruleEnabled !== before.ruleEnabled) {
        toast.success(
          saved.ruleEnabled ? 'Auto-save turned on' : 'Auto-save turned off',
          saved.ruleEnabled ? `New jobs of at least ${saved.minMatch}% match will be saved to Saved Jobs.` : undefined,
        );
      } else if (asked.minMatch !== before.minMatch) {
        toast.success(`Minimum match set to ${saved.minMatch}%`);
      }
    },
    onError: (error, _asked, before) => {
      const shown = before ?? settings;
      setMinMatch(shown.minMatch);
      setTyped(String(shown.minMatch));
      toast.error('Auto-save could not be saved', userMessage(error, 'Please try again.'));
    },
    onSettled: () => {
      const next = queuedRef.current;
      queuedRef.current = null;
      setQueued(null);
      if (next) save.mutate(next);
    },
  });

  /** Saves `next`, now or once the save running now is done. */
  const send = (next: AutofillAgentSettings) => {
    if (save.isPending) {
      queuedRef.current = next;
      setQueued(next);
      return;
    }
    const current = queryClient.getQueryData<AutofillAgentSettings>(autoApplyKeys.settings) ?? settings;
    if (next.ruleEnabled !== current.ruleEnabled || next.minMatch !== current.minMatch) save.mutate(next);
  };

  const cancelSliderSave = () => {
    if (sliderTimer.current) clearTimeout(sliderTimer.current);
    sliderTimer.current = null;
    sliderValue.current = null;
  };

  // Leaving the page with the slider's save still waiting: it goes now, as the page goes.
  useEffect(
    () => () => {
      if (!sliderTimer.current || sliderValue.current === null) return;
      clearTimeout(sliderTimer.current);
      const current = queryClient.getQueryData<AutofillAgentSettings>(autoApplyKeys.settings);
      if (!current || current.minMatch === sliderValue.current) return;
      void saveAgentSettings({ ruleEnabled: current.ruleEnabled, minMatch: sliderValue.current })
        .then((saved) => queryClient.setQueryData<AutofillAgentSettings>(autoApplyKeys.settings, saved))
        .catch(() => undefined);
    },
    [queryClient],
  );

  const commit = (value: number) => {
    cancelSliderSave();
    setMinMatch(value);
    setTyped(String(value));
    send({ ruleEnabled: latest().ruleEnabled, minMatch: value });
  };

  const commitSlider = (value: number) => {
    if (sliderTimer.current) clearTimeout(sliderTimer.current);
    sliderValue.current = value;
    sliderTimer.current = setTimeout(() => {
      sliderTimer.current = null;
      sliderValue.current = null;
      send({ ruleEnabled: latest().ruleEnabled, minMatch: value });
    }, SLIDER_SAVE_DELAY_MS);
  };

  const commitTyped = () => {
    const value = percentOf(typed);
    if (value === null) {
      setTyped(String(minMatch));
      return;
    }
    commit(value);
  };

  const ruleEnabled = queued?.ruleEnabled ?? settings.ruleEnabled;
  return (
    <section aria-label="Auto-save new jobs" className="rounded-card border border-border bg-surface shadow-card" data-rule-section="">
      <h2 id={headingId} className="text-[15px] leading-5 font-semibold text-foreground">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((open) => !open)}
          className="flex w-full items-center gap-3 rounded-card px-4 py-3.5 text-left -outline-offset-2 hover:bg-surface-low sm:px-5"
        >
          <span className="min-w-0 flex-1">
            Auto-save new jobs
            <span className="block text-[13px] leading-5 font-normal text-muted-foreground">
              {ruleEnabled ? `On: new jobs of at least ${minMatch}% match are saved` : 'Off'}
            </span>
          </span>
          <CaretDownIcon
            size={16}
            aria-hidden="true"
            className={clsx('shrink-0 text-muted-foreground transition-transform duration-150', expanded && 'rotate-180')}
          />
        </button>
      </h2>
      <div id={panelId} hidden={!expanded} className="border-t border-border px-4 py-4 sm:px-5">
      <p className="mb-4 text-sm leading-5 text-muted-foreground">
        Off unless you turn it on. When it is on, TailorIT saves new jobs whose match with your best resume for them
        reaches the minimum below to your Saved Jobs. It never prepares or queues them, so it never uses your AI usage:
        Prepare &amp; Queue the ones you want. Only jobs TailorIT first sees after you turn it on count; jobs you track
        already are left out.
      </p>
      <div className="flex flex-col gap-5">
        <Switch
          checked={ruleEnabled}
          label={`Save new jobs of at least ${minMatch}% match to Saved Jobs`}
          // Never disabled while saving, which would take the focus away: a change made meanwhile is sent after it.
          onCheckedChange={(on) => {
            // The threshold shown goes with it (a slider save still waiting is this one).
            cancelSliderSave();
            send({ ruleEnabled: on, minMatch });
          }}
        />
        <div className="flex flex-col gap-2 sm:max-w-md">
          <span aria-hidden="true" className="text-sm leading-5 font-medium text-foreground">
            Minimum match
          </span>
          <div className="flex items-center gap-4">
            <Slider
              value={minMatch}
              min={0}
              max={100}
              step={1}
              thumbLabels={['Minimum match']}
              formatValue={(value) => `${value}%`}
              onValueChange={(value) => {
                setMinMatch(value);
                setTyped(String(value));
              }}
              onValueCommitted={commitSlider}
              className="min-w-0 flex-1"
            />
            <Input
              aria-label="Minimum match in percent"
              aria-describedby={hintId}
              inputMode="numeric"
              value={typed}
              maxLength={4}
              onChange={(event) => setTyped(event.target.value)}
              onBlur={commitTyped}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitTyped();
                }
              }}
              trailing={<span className="text-sm text-muted-foreground">%</span>}
              wrapperClassName="w-24 shrink-0"
              className="text-right"
            />
          </div>
          <p id={hintId} className="text-[13px] leading-5 text-muted-foreground">
            From 0 to 100%. Changing it while the rule is on weighs the new jobs again from when the rule was turned on.
          </p>
        </div>
        {minMatch < LOW_MATCH && (
          <Notice tone="warning" title="That minimum is low">
            At {minMatch}%, the rule saves jobs that barely match your resume.
          </Notice>
        )}
      </div>
      </div>
    </section>
  );
}
