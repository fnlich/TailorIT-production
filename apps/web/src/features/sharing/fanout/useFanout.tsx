'use client';

import { type FanoutSavedOn, type ProfileChoice, type SharePermission } from '@tailorit/shared/sharing';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, type ReactElement } from 'react';
// Relative, not '@/': the web tests draw these parts.
import {
  NO_SHARED_PROFILES,
  SHARING_PROFILES_QUERY_KEY,
  fetchSharedProfiles,
  profileName,
  useDocumentProfile,
} from '../../../components/shell/profile/useProfile';
import { useGateAlert } from '../../../components/ui/AlertDialog';
import { useToast } from '../../../components/ui/Toast';
import { ME_QUERY_KEY, fetchMe } from '../../../lib/auth';
import { usePublicConstants, type PublicMessageKey } from '../../../lib/constants';
import { fanoutKeys, fetchSavedOn } from './api';
import { FANOUT_COPY, NAMES_SHOWN } from './copy';
import type { FanoutReport, ReportLine } from './results';
import { fanoutProfiles, hasSharedProfiles, tabChoice, type FanoutProfile, type LabelOf } from './targets';

// v34 FANWEB: the hooks every multi-profile part shares: the profiles an action offers (from the shell's list of shared
// profiles: nothing is asked for), the one message of a result (a toast, or one alert when a profile was refused), and
// "Saved on" (which other profiles have a job in their Job Tracker, read for the jobs on screen in one request).

export interface FanoutChoices {
  /** You first, then every shared profile (off without the action's boxes). */
  profiles: FanoutProfile[];
  /** The person has a shared profile: the multi-profile parts show (hidden otherwise). */
  available: boolean;
  /** The tab's own profile as a target ('me' or its key). */
  tab: ProfileChoice;
  /** Reads a box's name. */
  label: LabelOf;
  /** v34 FANWEB fix (sharing L5): the shell's list of shared profiles is in (else `profiles` is You alone). */
  loaded: boolean;
}

/**
 * The profiles an action needing `perms` offers, from the shell's list of shared profiles and the signed-in account as
 * they are in the cache (the shell reads both; nothing is asked for here, so the parts draw without the shell too).
 * `fetch`: the list is read when the cache has none (the form over every profile, which waits for it).
 */
export function useFanoutChoices(perms: readonly SharePermission[], options: { fetch?: boolean } = {}): FanoutChoices {
  const tab = useDocumentProfile();
  const list = useQuery({
    queryKey: SHARING_PROFILES_QUERY_KEY,
    queryFn: ({ signal }) => fetchSharedProfiles(signal),
    enabled: options.fetch === true,
  });
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: ({ signal }) => fetchMe(signal), enabled: false });
  const shared = (list.data ?? NO_SHARED_PROFILES).profiles;
  const account = me.data?.account ?? null;
  const { t } = usePublicConstants();
  const label = useCallback<LabelOf>((key) => t(key as PublicMessageKey), [t]);
  const key = perms.join(' ');
  const profiles = useMemo(
    () => fanoutProfiles(shared, tab, key ? (key.split(' ') as SharePermission[]) : [], (profile) => profileName(profile, account)),
    [shared, tab, key, account],
  );
  return { profiles, available: hasSharedProfiles(shared), tab: tabChoice(tab), label, loaded: list.data !== undefined };
}

export interface ReportShow {
  /**
   * Shows the result: a toast when every profile did it, else one alert with each profile's line. Its Undo closes the
   * toast as it runs (v34 FANWEB fix: never pressed twice).
   */
  show: (report: FanoutReport, undo?: () => void) => void;
  /** The alert: render once. */
  element: ReactElement;
}

/**
 * v36 FIX-WEB (ux M1): what a result's toast says under its title. With `toastLines`, each profile's line ("Ana Lopez:
 * 1 removed, 2 applied: left as is") then the notes, up to NAMES_SHOWN profiles; past that, how many profiles, and the
 * toast's button is Details (the alert, which holds every line and the Undo). Without, the description as before.
 */
export interface ToastView {
  lines: ReportLine[];
  notes: string[];
  /** More profiles than a toast lists: the toast says how many and offers Details. */
  many: boolean;
}

/** The toast's body of a result that no profile refused (pure: the tests read it). */
export function toastView(report: FanoutReport): ToastView {
  const notes = report.notes ?? (report.description ? [report.description] : []);
  if (!report.toastLines) return { lines: [], notes: report.description ? [report.description] : [], many: false };
  const lines = report.lines.filter((line) => line.ok);
  if (lines.length > NAMES_SHOWN) return { lines: [], notes: [FANOUT_COPY.doneOnProfiles(lines.length), ...notes], many: true };
  return { lines, notes, many: false };
}

/** The toast's body: each profile's line, then each note, a line apiece. */
export function ToastLines({ view }: { view: ToastView }) {
  if (view.lines.length === 0 && view.notes.length <= 1) return view.notes[0] ?? null;
  return (
    <span className="flex flex-col gap-0.5" data-fanout-toast="">
      {view.lines.map((line) => (
        <span key={line.profile} data-fanout-toast-line={line.profile}>
          <span className="font-semibold text-foreground">{line.name}</span>
          {`: ${line.text}`}
        </span>
      ))}
      {view.notes.map((note) => (
        <span key={note} data-fanout-toast-note="">
          {note}
        </span>
      ))}
    </span>
  );
}

/** The one message of a multi-profile result (a refused profile also reads the list of shared profiles again). */
export function useFanoutReport(): ReportShow {
  const toast = useToast();
  const gate = useGateAlert();
  const client = useQueryClient();
  const { show: showAlert, alert } = gate;
  const show = useCallback(
    (report: FanoutReport, undo?: () => void) => {
      const action = undo && report.done ? { label: FANOUT_COPY.undo, onClick: undo } : undefined;
      if (!report.refused) {
        const view = toastView(report);
        // v36 FIX-WEB (ux M1): past NAMES_SHOWN profiles the toast's one button opens every profile's line (and Undo).
        const details = view.many
          ? {
              label: FANOUT_COPY.details,
              onClick: () =>
                showAlert({
                  title: report.title,
                  tone: 'info',
                  message: <ReportLines report={report} lead={FANOUT_COPY.resultLeadDone} />,
                  dismissLabel: FANOUT_COPY.ok,
                  action: action ? { label: action.label, onAction: action.onClick } : undefined,
                  dataAttributes: { 'data-fanout-details': String(report.lines.length) },
                }),
            }
          : action;
        let id = '';
        const description = view.lines.length > 0 || view.notes.length > 0 ? <ToastLines view={view} /> : undefined;
        id = toast.toast({
          type: report.done ? 'success' : 'info',
          title: report.title,
          description,
          timeout: details ? 10_000 : undefined,
          action: details
            ? {
                label: details.label,
                onClick: () => {
                  toast.dismiss(id);
                  details.onClick();
                },
              }
            : undefined,
        });
        return;
      }
      // A box changed or a share ended meanwhile: the switcher, the menus and the reasons read it again.
      void client.invalidateQueries({ queryKey: SHARING_PROFILES_QUERY_KEY });
      showAlert({
        title: report.title,
        tone: 'warning',
        message: <ReportLines report={report} />,
        dismissLabel: FANOUT_COPY.ok,
        action: action ? { label: action.label, onAction: action.onClick } : undefined,
        dataAttributes: { 'data-fanout-refused': String(report.lines.filter((line) => !line.ok).length) },
      });
    },
    [toast, client, showAlert],
  );
  return { show, element: alert };
}

/**
 * The alert's body: each profile's line, the refused ones first. v34 FIX-WEB (final review U-L2): "Not done on every
 * profile:" only when a profile refused; done everywhere with a switch kept, "Done, with exceptions:".
 */
export function ReportLines({ report, lead }: { report: FanoutReport; lead?: string }) {
  const lines = [...report.lines].sort((a, b) => Number(a.ok) - Number(b.ok));
  const refusedSome = lines.some((line) => !line.ok);
  return (
    <span className="flex flex-col gap-1.5" data-fanout-report="">
      <span data-fanout-lead={refusedSome ? 'refused' : lead ? 'done' : 'kept'}>
        {refusedSome ? FANOUT_COPY.resultLead : (lead ?? FANOUT_COPY.resultLeadKept)}
      </span>
      <span className="flex flex-col gap-1 text-[13px] leading-5">
        {lines.map((line) => (
          <span key={line.profile} data-fanout-line={line.profile} data-ok={line.ok ? 'true' : 'false'}>
            <span className="font-semibold text-foreground">{line.name}</span>
            <span className="text-muted-foreground">{`: ${line.text}`}</span>
          </span>
        ))}
      </span>
      {(report.notes && report.notes.length > 0 ? report.notes : report.description ? [report.description] : []).map((note) => (
        <span key={note} className="text-[13px] leading-5 text-muted-foreground" data-fanout-note="">
          {note}
        </span>
      ))}
    </span>
  );
}

// Saved on ----------------------------------------------------------------------------------------------------------

/** One read names at most this many jobs (FANOUT_SAVED_ON_MAX). */
export const SAVED_ON_CHUNK = 100;

/** Splits ids into reads of at most SAVED_ON_CHUNK, in the list's order (a read's key stays put as the list grows). */
export function savedOnChunks(ids: readonly number[]): number[][] {
  const unique = [...new Set(ids)];
  const out: number[][] = [];
  for (let start = 0; start < unique.length; start += SAVED_ON_CHUNK) out.push(unique.slice(start, start + SAVED_ON_CHUNK));
  return out;
}

/** Where one job is saved: every profile that has it (the tab's own too), and the other ones' names. */
export interface SavedOnJob {
  choices: ReadonlySet<ProfileChoice>;
  /** The profiles other than the tab's own, by name (the "Saved on" mark). */
  others: string[];
}

/**
 * Which profiles have each job in their Job Tracker: GET /api/profiles/jobs/saved-on for the jobs on screen, in reads
 * of at most 100 (an active entry at any status, on the person's own profile and each share with the Job Tracker's
 * See). Off while the person has no shared profile. A map of job id → where it is saved.
 */
export function useSavedOn(jobIds: readonly number[]): ReadonlyMap<number, SavedOnJob> {
  const { profiles, available, tab } = useFanoutChoices([]);
  const client = useQueryClient();
  const chunks = useMemo(() => (available ? savedOnChunks(jobIds) : []), [available, jobIds]);
  // A stable combine: the map is made again only when a read or the profiles change (the rows are memoized).
  const combine = useCallback(
    (results: ReadonlyArray<{ data?: FanoutSavedOn }>) => savedOnByJob(results.map((result) => result.data), profiles, tab),
    [profiles, tab],
  );
  return useQueries({
    queries: chunks.map((ids) => {
      const seed = ids.length === 1 ? fromListRead(client, ids[0]!) : undefined;
      return {
        queryKey: fanoutKeys.savedOn(ids),
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchSavedOn(ids, signal),
        staleTime: 30_000,
        retry: false,
        ...(seed ? { initialData: seed.data, initialDataUpdatedAt: seed.updatedAt } : {}),
      };
    }),
    combine,
  });
}

/** The saved-on reads as one map (pure: the tests read it). */
export function savedOnByJob(
  reads: ReadonlyArray<{ jobs: ReadonlyArray<{ jobId: number; savedOn: ReadonlyArray<{ profile: ProfileChoice }> }> } | undefined>,
  profiles: readonly FanoutProfile[],
  tab: ProfileChoice,
): Map<number, SavedOnJob> {
  const byJob = new Map<number, SavedOnJob>();
  for (const read of reads) {
    for (const job of read?.jobs ?? []) {
      if (job.savedOn.length === 0) continue;
      const others = job.savedOn
        .filter((entry) => entry.profile !== tab)
        .map((entry) => profiles.find((profile) => profile.choice === entry.profile)?.label)
        .filter((name): name is string => Boolean(name));
      byJob.set(job.jobId, { choices: new Set(job.savedOn.map((entry) => entry.profile)), others });
    }
  }
  return byJob;
}

/**
 * v34 FANWEB fix (spec L12): the detail's one-job read starts from a list read that asked for the same job (the rows'
 * reads of 100), so opening a job the list shows asks nothing again while that read is fresh.
 */
function fromListRead(client: ReturnType<typeof useQueryClient>, jobId: number): { data: FanoutSavedOn; updatedAt: number } | undefined {
  for (const query of client.getQueryCache().findAll({ queryKey: fanoutKeys.savedOnAll })) {
    const ids = String(query.queryKey[2] ?? '').split(',');
    const data = query.state.data as FanoutSavedOn | undefined;
    if (!data || ids.length < 2 || !ids.includes(String(jobId))) continue;
    return {
      data: { profiles: data.profiles, jobs: data.jobs.filter((job) => job.jobId === jobId) },
      updatedAt: query.state.dataUpdatedAt,
    };
  }
  return undefined;
}

/** After a save on several profiles: the "Saved on" reads, the Jobs lists and the Job Tracker read again. */
export function refreshAfterFanoutSave(client: ReturnType<typeof useQueryClient>): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: fanoutKeys.savedOnAll }),
    client.invalidateQueries({ queryKey: ['jobs', 'list'] }),
    client.invalidateQueries({ queryKey: ['jobs', 'detail'] }),
    client.invalidateQueries({ queryKey: ['jobs', 'count'] }),
    client.invalidateQueries({ queryKey: ['tracker'] }),
    client.invalidateQueries({ queryKey: ['sharing', 'overview'] }),
  ]);
}
