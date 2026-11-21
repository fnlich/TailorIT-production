'use client';

import {
  COVER_LETTER_MODES,
  PREPARE_RESUME_MODES,
  PREPARE_RESUME_MODE_LABELS,
  type PrepareSettings,
  type PrepareSettingsBody,
} from '@tailorit/shared/prepare';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../../components/ui/Button';
import { Field } from '../../../components/ui/Field';
import { Notice } from '../../../components/ui/Notice';
import { RadioGroup } from '../../../components/ui/RadioGroup';
import { Skeleton } from '../../../components/ui/Skeleton';
import { useToast } from '../../../components/ui/Toast';
import { isProfileRefusal, userMessage } from '../../../lib/api';
import { usePublicConstants, type PublicMessageKey } from '../../../lib/constants';
import { Section, SwitchRow } from '../parts';
import { NotShared, OWN_ACCESS, refusedRead, type ProfileAccess } from '../../sharing/access'; // v33 SHARE-7
import { fetchPrepareSettings, prepareSettingsKeys, savePrepareSettings } from './api';
import { LETTER_MODE_HINT, LETTER_MODE_LABEL, PREPARE_COPY, RESUME_MODE_HINT } from './copy';
import { PrepareFilters } from './PrepareFilters';

// v2.0: Settings › Prepare & Queue (/settings#prepare; docs/design/v2.0/08-ui.md, "Settings › Prepare & Queue"; A29):
// - Resume (A29/A30): "Only my default resume", "Use my best-matched resume" or "Always tailor" (the constants' words),
//   beside
// - Cover letters: "Only when the application requires it" (the default) or "Always";
// - Ask before using AI: the Prepare & Queue confirm, on or off (the inverse of "Don't show this again");
// - the Prepare filters, with a live preview and their own save bar.
// The three settings save as they change (PUT /api/prepare/settings); the filters save together.

/** The section's anchor (/settings#prepare). v31 AUTO: the Auto-apply page opens the same filters in a dialog instead. */
export const PREPARE_ANCHOR = 'prepare';

/**
 * v33 SHARE-7 (PLAN F9 "Permissions": Job settings): `access` is what the tab's profile may do here (Settings computes
 * it; the person's own profile by default): without the See box "Not shared with you." and nothing is asked for;
 * without the Change box the settings are shown, not changed. `filters`: the Prepare filters, read with Prepare &
 * queue's See box (as the server serves them, so a See only share shows them too) and changed with Job settings'
 * Change box.
 */
export function PrepareSection({
  className,
  access = OWN_ACCESS,
  sensitive = OWN_ACCESS,
  filters = OWN_ACCESS,
}: {
  className?: string;
  access?: ProfileAccess;
  /** v33 SHARE-7: the Sensitive answers boxes (the filters' eligibility switches). */
  sensitive?: ProfileAccess;
  /** v33 SHARE-7: the filters' boxes (See: prepare:view; Change: settings:edit). */
  filters?: ProfileAccess;
}) {
  const eligibility = !sensitive.see ? 'hidden' : sensitive.change ? 'shown' : 'readOnly'; // as filtersAccessOf
  const settings = useQuery({
    queryKey: prepareSettingsKeys.settings,
    queryFn: ({ signal }) => fetchPrepareSettings(signal),
    enabled: access.ready && access.see, // v33 SHARE-7
  });
  useScrollToAnchor(PREPARE_ANCHOR, settings.isSuccess);
  // v33 SHARE-7: not shared with the person (or a read refused because of it).
  const settingsShared = !(access.ready && !access.see) && !(settings.isError && refusedRead(settings.error));
  if (!settingsShared && filters.ready && !filters.see) {
    return (
      <Section title={PREPARE_COPY.title} description={PREPARE_COPY.description} id={PREPARE_ANCHOR} className={className}>
        <NotShared owner={access.owner} />
      </Section>
    );
  }
  return (
    <Section title={PREPARE_COPY.title} description={PREPARE_COPY.description} id={PREPARE_ANCHOR} className={className}>
      <div className="flex flex-col gap-8">
        {!settingsShared ? (
          <NotShared owner={access.owner} />
        ) : settings.data ? (
          <PrepareSettingsForm settings={settings.data} readOnly={!access.change} />
        ) : settings.isError ? (
          <Notice
            tone="error"
            title={PREPARE_COPY.loadFailed}
            action={
              <Button variant="outline" size="sm" loading={settings.isFetching} onClick={() => void settings.refetch()}>
                {PREPARE_COPY.tryAgain}
              </Button>
            }
          >
            {userMessage(settings.error, 'Please try again in a moment.')}
          </Notice>
        ) : (
          <div className="grid gap-6 md:grid-cols-2" aria-busy="true" aria-label="Loading Prepare & Queue settings">
            <Skeleton className="h-28 w-full" rounded="control" />
            <Skeleton className="h-28 w-full" rounded="control" />
          </div>
        )}
        {filters.ready && (
          <PrepareFilters shared={filters.see} owner={filters.owner} access={{ readOnly: !filters.change, eligibility }} />
        )}
      </div>
    </Section>
  );
}

/**
 * Scrolls to #`anchor` once its content is in: the page opens behind the sign-in check, so the browser's own jump
 * to the address's #prepare finds nothing yet.
 */
function useScrollToAnchor(anchor: string, ready: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    if (window.location.hash !== `#${anchor}`) return;
    document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  }, [anchor, ready]);
}

function PrepareSettingsForm({ settings, readOnly = false }: { settings: PrepareSettings; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = usePublicConstants();
  const save = useMutation({
    mutationFn: (body: PrepareSettingsBody) => savePrepareSettings(body),
    // Shown at once; put back if the server refuses.
    onMutate: (body) => {
      const before = queryClient.getQueryData<PrepareSettings>(prepareSettingsKeys.settings);
      if (before) queryClient.setQueryData<PrepareSettings>(prepareSettingsKeys.settings, { ...before, ...stripUndefined(body) });
      return { before };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(prepareSettingsKeys.settings, saved);
      toast.success(PREPARE_COPY.saved);
    },
    onError: (error, _body, context) => {
      if (context?.before) queryClient.setQueryData(prepareSettingsKeys.settings, context.before);
      // v33 SHARE-7: a shared profile's refusal is the shell's one alert, not a toast too.
      if (isProfileRefusal(error)) return;
      toast.error(PREPARE_COPY.saveFailed, userMessage(error));
    },
  });

  return (
    <>
      <div className="grid gap-x-8 gap-y-6 md:grid-cols-2" data-prepare-settings="">
        <Field label={PREPARE_COPY.resume} hint={PREPARE_COPY.resumeHint}>
          <RadioGroup
            name="resume-mode"
            value={settings.resumeMode}
            disabled={save.isPending || readOnly}
            onValueChange={(resumeMode) => resumeMode !== settings.resumeMode && save.mutate({ resumeMode })}
            options={PREPARE_RESUME_MODES.map((mode) => ({
              value: mode,
              label: t(PREPARE_RESUME_MODE_LABELS[mode] as PublicMessageKey),
              description: RESUME_MODE_HINT[mode],
            }))}
          />
        </Field>
        <Field label={PREPARE_COPY.letters}>
          <RadioGroup
            name="letter-mode"
            value={settings.letterMode}
            disabled={save.isPending || readOnly}
            onValueChange={(letterMode) => letterMode !== settings.letterMode && save.mutate({ letterMode })}
            options={COVER_LETTER_MODES.map((mode) => ({
              value: mode,
              label: LETTER_MODE_LABEL[mode],
              description: LETTER_MODE_HINT[mode],
            }))}
          />
        </Field>
      </div>
      <SwitchRow
        title={PREPARE_COPY.askTitle}
        hint={PREPARE_COPY.askHint}
        checked={!settings.skipConfirm}
        disabled={save.isPending || readOnly}
        onCheckedChange={(ask) => save.mutate({ skipConfirm: !ask })}
      />
    </>
  );
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
