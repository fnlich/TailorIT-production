'use client';

import { PROFILE_SELF, type ProfileChoice, type SharingOverviewProfile } from '@tailorit/shared/sharing';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement, type RefObject } from 'react';
// Relative, not '@/': the web tests draw these views.
import { profileName } from '../../components/shell/profile/useProfile';
import { useGateAlert } from '../../components/ui/AlertDialog';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../lib/auth';
import { BudgetNote } from '../prepare/PrepareAllConfirmDialog';
import { fetchOverview, fetchPrepareAllPlanOf, invalidateSharing, sharingKeys, startPrepareAllOf } from './api';
import { PROFILES_COPY } from './copy';
import { canPrepare, refusalReason, summarize, type PrepareAllSummary, type Refusal } from './prepareAll';

// v33 SHARE-7 (PLAN F9; SP v33 PLAN-sharing.md §8): "Prepare all profiles": one confirm (the jobs over every profile the
// person may prepare, and their own AI use, which pays for all of it), then one Prepare All per profile, every refusal
// in one alert. v34 FANWEB (PLAN G4: the Tracker's All profiles view gains "Prepare all profiles"): moved out of the
// Profiles page into this hook, so the Profiles page and the Tracker's All profiles view start the same thing.

/** How often the overview is read while something prepares or applies, and otherwise. */
export const OVERVIEW_BUSY_MS = 10_000;
export const OVERVIEW_IDLE_MS = 60_000;

type Phase = { kind: 'idle' } | { kind: 'reading' } | { kind: 'confirm'; summary: PrepareAllSummary };

export interface PrepareAllProfiles {
  /** The overview (GET /api/sharing/overview: the person's own, whichever profile the tab works on). */
  overview: ReturnType<typeof useOverview>;
  /** The profiles Prepare all may start on. */
  runnable: SharingOverviewProfile[];
  /** Reads each profile's plan, then asks. */
  start: () => void;
  /** A plan is being read. */
  reading: boolean;
  /** The button can start it. */
  ready: boolean;
  /** The confirm and the refusals' alert: render once. */
  elements: ReactElement;
  /** How a profile of the overview is named ("You", the owner's name). */
  nameOf: (profile: Pick<SharingOverviewProfile, 'profile' | 'name' | 'email'>) => string;
}

function useOverview() {
  return useQuery({
    queryKey: sharingKeys.overview,
    queryFn: ({ signal }) => fetchOverview(signal),
    refetchInterval: (query) => (query.state.data?.busy ? OVERVIEW_BUSY_MS : OVERVIEW_IDLE_MS),
  });
}

/** `buttonRef`: the button that starts it (focus goes back there when the confirm closes). */
export function usePrepareAllProfiles(buttonRef: RefObject<HTMLButtonElement | null>): PrepareAllProfiles {
  const { account } = useAuth();
  const toast = useToast();
  const gate = useGateAlert();
  const queryClient = useQueryClient();
  const overview = useOverview();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const nameOf = (profile: Pick<SharingOverviewProfile, 'profile' | 'name' | 'email'>): string =>
    profile.profile === PROFILE_SELF ? PROFILES_COPY.you : profileName(profile, account);
  const runnable = overview.data?.profiles.filter(canPrepare) ?? [];

  const start = async () => {
    if (!overview.data || phase.kind !== 'idle') return;
    setPhase({ kind: 'reading' });
    const reads = await Promise.all(
      runnable.map(async (profile) => {
        try {
          return { profile: profile.profile, name: nameOf(profile), plan: await fetchPrepareAllPlanOf(profile.profile) };
        } catch (error) {
          return { profile: profile.profile as ProfileChoice, name: nameOf(profile), error };
        }
      }),
    );
    setPhase({ kind: 'confirm', summary: summarize(reads, "Its jobs couldn't be read. Try again in a moment.") });
  };

  const run = async (summary: PrepareAllSummary) => {
    const refused: Refusal[] = [...summary.refused];
    let started = 0;
    let profiles = 0;
    // One profile after another, the person's own first: each start counts against the person's own limits.
    for (const one of summary.runs) {
      try {
        const answer = await startPrepareAllOf(one.profile, one.applicationIds);
        // Started now or waiting for the runner: both are on their way.
        const count = answer.results.filter((result) => result.outcome === 'started' || result.outcome === 'queued').length;
        started += count;
        if (count > 0) profiles += 1;
      } catch (error) {
        refused.push({ profile: one.profile, name: one.name, message: refusalReason(error, 'Nothing started. Try again in a moment.') });
      }
    }
    void invalidateSharing(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['auto-apply'] });
    void queryClient.invalidateQueries({ queryKey: ['tracker'] });
    // v34 FANWEB fix (spec L13): one message, as every action on several profiles: a toast when every profile started,
    // else one alert that says what started and which profiles did not.
    if (refused.length === 0) {
      if (started > 0) toast.success(PROFILES_COPY.started(started, profiles));
      return;
    }
    gate.show({
      title: PROFILES_COPY.refusedTitle(refused.length),
      tone: 'warning',
      message: (
        <span className="flex flex-col gap-2">
          {started > 0 && (
            <span className="text-sm leading-5 text-foreground" data-prepare-all-started="">
              {PROFILES_COPY.started(started, profiles)}
            </span>
          )}
          <RefusalList lead={PROFILES_COPY.refusedLead} refused={refused} />
        </span>
      ),
      dataAttributes: { 'data-prepare-all-refused': String(refused.length) },
    });
  };

  const summary = phase.kind === 'confirm' ? phase.summary : null;
  const elements = (
    <>
      <ConfirmDialog
        open={summary !== null}
        onOpenChange={(open) => !open && setPhase({ kind: 'idle' })}
        tone="primary"
        title={summary && summary.total > 0 ? PROFILES_COPY.confirmTitle(summary.total) : PROFILES_COPY.confirmNone}
        description={summary && summary.total > 0 ? PROFILES_COPY.confirmLine(summary.runs.length) : PROFILES_COPY.confirmNothing}
        confirmLabel={PROFILES_COPY.confirmLabel(summary?.total ?? 0)}
        busyLabel={PROFILES_COPY.starting}
        confirmDisabled={!summary || summary.total === 0}
        // It spends the person's AI on many jobs at once: it opens on Cancel.
        focusCancel
        finalFocus={() => buttonRef.current ?? true}
        onConfirm={async () => {
          if (summary) await run(summary);
        }}
      >
        {summary && <ConfirmBody summary={summary} />}
      </ConfirmDialog>
      {gate.alert}
    </>
  );

  return {
    overview,
    runnable,
    start: () => void start(),
    reading: phase.kind === 'reading',
    ready: Boolean(overview.data) && runnable.length > 0 && phase.kind === 'idle',
    elements,
    nameOf,
  };
}

function ConfirmBody({ summary }: { summary: PrepareAllSummary }) {
  return (
    <div className="flex flex-col gap-3" data-prepare-all-profiles-confirm="">
      {summary.runs.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Jobs per profile">
          {summary.runs.map((run) => (
            <li key={run.profile} className="flex items-baseline justify-between gap-3" data-run={run.profile}>
              <span className="truncate text-foreground">{run.name}</span>
              <span className="num shrink-0 text-muted-foreground">{`${run.taking} ${run.taking === 1 ? 'job' : 'jobs'}`}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.refused.length > 0 && <RefusalList lead={PROFILES_COPY.refusedLead} refused={summary.refused} />}
      {summary.ai && <BudgetNote ai={summary.ai} />}
    </div>
  );
}

export function RefusalList({ lead, refused }: { lead: string; refused: readonly Refusal[] }) {
  return (
    <div className="flex flex-col gap-1.5" data-refusals="">
      <p className="text-[13px] leading-5 text-muted-foreground">{lead}</p>
      <ul className="flex flex-col gap-1 text-[13px] leading-5">
        {refused.map((one) => (
          <li key={one.profile} data-refused={one.profile}>
            <span className="font-semibold text-foreground">{one.name}</span>
            <span className="text-muted-foreground">{`: ${one.message}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
