'use client';

import { PROFILE_SELF, type ProfileChoice, type SharingOverviewProfile } from '@tailorit/shared/sharing';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement, type RefObject } from 'react';
// Relative, not '@/': the web tests draw these views.
import { profileName } from '../../components/shell/profile/useProfile';
import { useGateAlert, type GateAlert } from '../../components/ui/AlertDialog';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { ME_QUERY_KEY, fetchMe } from '../../lib/auth';
import { BudgetNote } from '../prepare/PrepareAllConfirmDialog';
import { fetchOverview, fetchPrepareAllPlanOf, invalidateSharing, sharingKeys, startPrepareAllOf } from './api';
import { PROFILES_COPY } from './copy';
import { FANOUT_COPY, NAMES_SHOWN } from './fanout/copy'; // v36 FIX-WEB (ux M1)
import { canPrepare, refusalReason, summarize, type PrepareAllSummary, type Refusal } from './prepareAll';

// v33 SHARE-7 (PLAN F9; SP v33 PLAN-sharing.md §8): "Prepare all profiles": one confirm (the jobs over every profile the
// person may prepare, and their own AI use, which pays for all of it), then one Prepare All per profile, every refusal
// in one alert. v34 FANWEB (PLAN G4: the Tracker's All profiles view gains "Prepare all profiles"): moved out of the
// Profiles page into this hook, so the Profiles page and the Tracker's All profiles view start the same thing.
// v36 APPLYWEB (PLAN A2; SP v36 REQUEST.md: "there will be dropdown right to all button like `Prepare all` so that can
// select the user. if every user will be prepared with their own saved job"): the Auto-apply page's Prepare All ▾ runs
// the same engine over the profiles it picked (`start(profiles)`: each prepares its own saved jobs through its owner's
// filters and settings, the person's own first, one confirm, all on the signed-in person's AI), without the overview
// (`{ overview: false }`). The account it names profiles with is read from the cache (as useFanoutChoices does), never
// useAuth, so a page drawn without the signed-in context (the tests' static Auto-apply page) still draws.

/** How often the overview is read while something prepares or applies, and otherwise. */
export const OVERVIEW_BUSY_MS = 10_000;
export const OVERVIEW_IDLE_MS = 60_000;

type Phase = { kind: 'idle' } | { kind: 'reading' } | { kind: 'confirm'; summary: PrepareAllSummary };

export interface PrepareAllProfiles {
  /** The overview (GET /api/sharing/overview: the person's own, whichever profile the tab works on). */
  overview: ReturnType<typeof useOverview>;
  /** The profiles Prepare all may start on. */
  runnable: SharingOverviewProfile[];
  /** Reads each profile's plan, then asks (every profile the overview says the person may prepare). */
  start: () => void;
  /** v36 APPLYWEB: the same over the profiles given, by their choice and name (no overview needed). */
  startOn: (profiles: readonly ProfileToPrepare[]) => void;
  /** A plan is being read. */
  reading: boolean;
  /** The button can start it. */
  ready: boolean;
  /** The confirm and the refusals' alert: render once. */
  elements: ReactElement;
  /** How a profile of the overview is named ("You", the owner's name). */
  nameOf: (profile: Pick<SharingOverviewProfile, 'profile' | 'name' | 'email'>) => string;
}

/** v36 APPLYWEB: one profile a caller picked for Prepare all (its choice and how it is named). */
export interface ProfileToPrepare {
  profile: ProfileChoice;
  name: string;
}

export interface PrepareAllProfilesOptions {
  /** v36 APPLYWEB: read the overview (default true); the Auto-apply page names its profiles itself. */
  overview?: boolean;
}

function useOverview(enabled: boolean) {
  return useQuery({
    queryKey: sharingKeys.overview,
    queryFn: ({ signal }) => fetchOverview(signal),
    refetchInterval: (query) => (query.state.data?.busy ? OVERVIEW_BUSY_MS : OVERVIEW_IDLE_MS),
    enabled,
  });
}

/** `buttonRef`: the button that starts it (focus goes back there when the confirm closes). */
export function usePrepareAllProfiles(
  buttonRef: RefObject<HTMLButtonElement | null>,
  options: PrepareAllProfilesOptions = {},
): PrepareAllProfiles {
  const withOverview = options.overview !== false;
  const account = useQuery({ queryKey: ME_QUERY_KEY, queryFn: ({ signal }) => fetchMe(signal), enabled: false }).data?.account ?? null;
  const toast = useToast();
  const gate = useGateAlert();
  const queryClient = useQueryClient();
  const overview = useOverview(withOverview);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const nameOf = (profile: Pick<SharingOverviewProfile, 'profile' | 'name' | 'email'>): string =>
    profile.profile === PROFILE_SELF ? PROFILES_COPY.you : profileName(profile, account);
  const runnable = overview.data?.profiles.filter(canPrepare) ?? [];

  const start = async (picked?: readonly ProfileToPrepare[]) => {
    if (phase.kind !== 'idle') return;
    const list: ProfileToPrepare[] | null = picked
      ? [...picked]
      : overview.data
        ? runnable.map((profile) => ({ profile: profile.profile as ProfileChoice, name: nameOf(profile) }))
        : null;
    if (!list || list.length === 0) return;
    setPhase({ kind: 'reading' });
    const reads = await Promise.all(
      list.map(async (profile) => {
        try {
          return { profile: profile.profile, name: profile.name, plan: await fetchPrepareAllPlanOf(profile.profile) };
        } catch (error) {
          return { profile: profile.profile, name: profile.name, error };
        }
      }),
    );
    setPhase({ kind: 'confirm', summary: summarize(reads, "Its jobs couldn't be read. Try again in a moment.") });
  };

  const run = async (summary: PrepareAllSummary) => {
    const refused: Refusal[] = [...summary.refused];
    let started = 0;
    // v36 FIX-WEB (ux M1): what started on each profile, for the toast's lines.
    const lines: PreparedOn[] = [];
    // One profile after another, the person's own first: each start counts against the person's own limits.
    for (const one of summary.runs) {
      try {
        const answer = await startPrepareAllOf(one.profile, one.applicationIds);
        // Started now or waiting for the runner: both are on their way.
        const count = answer.results.filter((result) => result.outcome === 'started' || result.outcome === 'queued').length;
        started += count;
        if (count > 0) lines.push({ profile: one.profile, name: one.name, started: count });
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
      if (started > 0) toast.success(PROFILES_COPY.started(started, lines.length), preparedOnLines(lines));
      return;
    }
    gate.show(refusedAlert(refused, started, lines.length));
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
    startOn: (picked) => void start(picked),
    reading: phase.kind === 'reading',
    ready: withOverview ? Boolean(overview.data) && runnable.length > 0 && phase.kind === 'idle' : phase.kind === 'idle',
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

export function RefusalList({ lead, refused }: { lead?: string; refused: readonly Refusal[] }) {
  return (
    <div className="flex flex-col gap-1.5" data-refusals="">
      {lead && <p className="text-[13px] leading-5 text-muted-foreground">{lead}</p>}
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

/** v36 FIX-WEB (ux M1): one profile where Prepare all profiles started something. */
export interface PreparedOn {
  profile: ProfileChoice;
  name: string;
  started: number;
}

/**
 * v36 FIX-WEB (ux M1): the success toast's lines, each profile's count ("You: 25 preparing", "Ana Lopez: 3 preparing"),
 * up to NAMES_SHOWN profiles (past that the title's count says it); null for one profile (the title says it all).
 */
export function preparedOnLines(lines: readonly PreparedOn[]): ReactElement | undefined {
  if (lines.length < 2 || lines.length > NAMES_SHOWN) return undefined;
  return (
    <span className="flex flex-col gap-0.5" data-prepare-all-lines="">
      {lines.map((line) => (
        <span key={line.profile} data-prepare-all-line={line.profile}>
          <span className="font-semibold text-foreground">{line.name}</span>
          {`: ${FANOUT_COPY.prepareStarted(line.started)}`}
        </span>
      ))}
    </span>
  );
}

/**
 * The alert when a profile did not start (pure: the tests read it). v36 FIX-WEB (APPLYWEB's open item): the alert's
 * sentence (a <p>) holds only words; the list of profiles goes under it (the alert's children), so no <p> or <ul> sits
 * inside a <p> (React warned on /profiles).
 */
export function refusedAlert(refused: readonly Refusal[], started: number, profiles: number): GateAlert {
  return {
    title: PROFILES_COPY.refusedTitle(refused.length),
    tone: 'warning',
    message:
      started > 0 ? (
        <span className="text-sm leading-5 text-foreground" data-prepare-all-started="">
          {PROFILES_COPY.started(started, profiles)}
        </span>
      ) : (
        PROFILES_COPY.refusedLead
      ),
    children: <RefusalList lead={started > 0 ? PROFILES_COPY.refusedLead : undefined} refused={refused} />,
    dataAttributes: { 'data-prepare-all-refused': String(refused.length) },
  };
}
