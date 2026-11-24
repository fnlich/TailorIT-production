'use client';

import type {
  FanoutCopySavedAnswer,
  FanoutItem,
  FanoutShareAllAnswer,
  FanoutShareAllPreviewAnswer,
  FanoutTargets,
  ProfileChoice,
} from '@tailorit/shared/sharing';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';
// Relative, not '@/': the web tests draw these parts.
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { useToast } from '../../../components/ui/Toast';
import { isProfileRefusal, userMessage } from '../../../lib/api';
import { usePublicConstants } from '../../../lib/constants';
import { tabCan, useTabProfile } from '../access';
import { copySavedTo, previewShareAll, startShareAll } from './api';
import { FANOUT_COPY } from './copy';
import { ProfilesDialog } from './parts';
import { fanoutReport, leftOutText, nameOf, refusalText, type FanoutReport } from './results';
import { boxName, type FanoutProfile, type LabelOf } from './targets';
import { refreshAfterFanoutSave, useFanoutChoices, useFanoutReport } from './useFanout';
import { browserDay, copyInBatches, nothingSaved, savedItems, useUndoSaved } from './useSaveTo';

// v36 APPLYWEB (PLAN A3-A5; SP v36 REQUEST.md: "There will be `Share All` button with dropdown if have any granted user.
// if clicked, the saved jobs will be shared to the other user", the Select bar's "`Share` with dropdown", "Add `share
// to` bullet on every job list ... dropdown"): sharing saved jobs from the tab's profile to other profiles. A share is
// v3.4's Copy to: the job alone, saved at Saved on each target (never the notes, history, documents, kit or queue row);
// a job the target had removed from Saved comes back; one tracked there at any other status is left alone.
// - The targets: the profiles the person may save to (their own, and each profile shared with them with Job Tracker ›
//   Change), never the tab's own (the jobs are there already). A share's grants run owner → grantee, so the people the
//   person shared their own profile with are not targets (PLAN A3). The tab's profile needs Job Tracker › See to be read.
// - A few jobs (the Select bar's Share ▾, a row's Share to ›): POST /api/profiles/applications/copy, in batches of
//   SAVE_BATCH_MAX, one message and Undo (the copies archived while still Saved).
// - Every saved job (Share All ▾): APPLYAPI's pair, the preview (per target: will be added, already there, back in
//   Saved; SHARE_ALL_MAX at most), one confirm, then the start of exactly the previewed entries, one message and Undo.
// No notification: each shared profile's activity log counts it.

/** The targets of a share from the tab's profile: every profile but the tab's own (off ones listed with their reason). */
export function shareTargets(profiles: readonly FanoutProfile[]): FanoutProfile[] {
  return profiles.filter((profile) => !profile.current);
}

/**
 * The profiles a share sends: 'all' (the menu's All profiles) is every target that is on, never the tab's own, so the
 * source is never its own target; a list is kept as it is.
 */
export function shareTargetList(targets: FanoutTargets, profiles: readonly FanoutProfile[]): ProfileChoice[] {
  if (targets !== 'all') return [...targets];
  return shareTargets(profiles)
    .filter((profile) => profile.allowed)
    .map((profile) => profile.choice);
}

/**
 * One profile's line of a share's result: "2 added, 1 already there, 1 back in Saved". v36 FIX-WEB (ux M1): in the order
 * Share All's question gave them (will be added, already there, back in Saved), so the result reads as that question
 * done.
 */
export function sharedCounts(result: { saved: number; restored: number; alreadyTracked: number; notFound: number; notReached: number; incomplete?: boolean }): string {
  return FANOUT_COPY.sharedCounts(result.saved, result.alreadyTracked, result.restored, result.notFound, result.notReached, result.incomplete === true);
}

/**
 * v36 FIX-WEB (D3; sec L2): the profiles Share All's start sends: exactly those its preview answered for (never 'all',
 * and never a profile the preview refused), so a profile shared or allowed after the question gets nothing nobody saw.
 */
export function startTargets(preview: Pick<FanoutShareAllPreviewAnswer, 'results'>): ProfileChoice[] {
  return preview.results.filter((result) => result.ok).map((result) => result.profile);
}

type SaveFields = { saved: number; restored: number; alreadyTracked: number; notFound: number; notReached: number; incomplete?: boolean };

const shareOptions = (profiles: readonly FanoutProfile[], label: LabelOf) => ({
  profiles,
  label,
  did: (result: SaveFields) => result.saved + result.restored > 0,
  detail: (result: SaveFields) => sharedCounts(result),
  title: FANOUT_COPY.sharedWith,
  none: FANOUT_COPY.nothingShared,
  nothing: (result: SaveFields, name: string) => nothingSaved(result, name),
  // v36 FIX-WEB (ux M1): the toast says each profile's counts too.
  toastLines: true,
});

/** What a share of a few jobs says (Copy to's answer in a share's words; a refused source is its own line). */
export function shareReport(answer: FanoutCopySavedAnswer, profiles: readonly FanoutProfile[], label: LabelOf): FanoutReport {
  const report = fanoutReport(answer, shareOptions(profiles, label));
  const refused = answer.sources.filter((source) => !source.ok);
  if (refused.length === 0) return report;
  return {
    ...report,
    refused: true,
    lines: [
      ...refused.map((source) => ({
        profile: source.profile,
        name: nameOf(profiles, source.profile, source.name),
        ok: false,
        text: source.ok ? '' : source.message,
      })),
      ...report.lines,
    ],
  };
}

/**
 * What Share All's start says: each target's line, the source's refusal, the entries that left Saved meanwhile. v36
 * FIX-WEB (D2, FIX-API): a target whose share ended or lost its box while the start ran stops there ("incomplete",
 * the rest not reached): its line says "stopped part-way" and the message is the alert, as for a refused profile.
 */
export function shareAllReport(answer: FanoutShareAllAnswer, profiles: readonly FanoutProfile[], label: LabelOf): FanoutReport {
  const shared = fanoutReport({ results: answer.results, left: answer.left }, shareOptions(profiles, label));
  const report = answer.results.some((result) => result.ok && result.incomplete) ? { ...shared, refused: true } : shared;
  const source = answer.source;
  if (!source.ok) {
    return {
      ...report,
      refused: true,
      lines: [{ profile: source.profile, name: nameOf(profiles, source.profile, source.name), ok: false, text: source.message }, ...report.lines],
    };
  }
  if (source.gone === 0) return report;
  const gone = FANOUT_COPY.shareAllGone(source.gone);
  return {
    ...report,
    description: [report.description, gone].filter(Boolean).join(' '),
    notes: [...(report.notes ?? []), gone],
  };
}

/** One line of Share All's confirm. */
export interface ShareAllLine {
  profile: ProfileChoice;
  name: string;
  ok: boolean;
  text: string;
}

/** What Share All's confirm shows, from its preview. */
export interface ShareAllView {
  title: string;
  description: string;
  lines: ShareAllLine[];
  /** "Share at most 500 at once: …" when the source holds more than SHARE_ALL_MAX. */
  over: string | null;
  /** The shares 'all' left out, with the box they need. */
  left: string | null;
  /** Something would be added or come back somewhere: the confirm can start. */
  ready: boolean;
  /** The confirm's button. */
  confirmLabel: string;
}

/**
 * Share All's confirm from its preview (pure: the tests read it). `tooMany` renders MSG_SHARE_ALL_TOO_MANY ("Share at
 * most {max} saved jobs at once."), said when the source holds more than SHARE_ALL_MAX.
 */
export function shareAllView(
  preview: FanoutShareAllPreviewAnswer,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
  tooMany: (max: number) => string,
): ShareAllView {
  const source = preview.source;
  if (!source.ok) {
    return {
      title: FANOUT_COPY.nothingShared,
      description: source.message,
      lines: [],
      over: null,
      left: null,
      ready: false,
      confirmLabel: FANOUT_COPY.share,
    };
  }
  const lines: ShareAllLine[] = preview.results.map((result) =>
    result.ok
      ? {
          profile: result.profile,
          name: nameOf(profiles, result.profile, result.name),
          ok: true,
          text: FANOUT_COPY.shareAllCounts(result.added, result.alreadyThere, result.backInSaved, result.notFound),
        }
      : { profile: result.profile, name: nameOf(profiles, result.profile, result.name), ok: false, text: refusalText(profiles, result, label) },
  );
  const usable = preview.results.filter((result) => result.ok).length;
  const fresh = preview.results.reduce((sum, result) => sum + (result.ok ? result.added + result.backInSaved : 0), 0);
  const left = leftOutText(preview.left, profiles, label);
  const over = source.over > 0 ? `${tooMany(source.max)} ${FANOUT_COPY.shareAllNewest(source.taking, source.saved)}` : null;
  if (source.taking === 0 || preview.applicationIds.length === 0) {
    return { title: FANOUT_COPY.shareAllNone, description: FANOUT_COPY.shareAllNoneLine, lines: [], over: null, left, ready: false, confirmLabel: FANOUT_COPY.share };
  }
  if (fresh === 0) {
    return { title: FANOUT_COPY.shareAllNothingNew, description: FANOUT_COPY.shareAllNothingNewLine, lines, over, left, ready: false, confirmLabel: FANOUT_COPY.share };
  }
  return {
    title: FANOUT_COPY.shareAllConfirmTitle(source.taking),
    description: FANOUT_COPY.shareAllLine(usable),
    lines,
    over,
    left,
    ready: true,
    confirmLabel: FANOUT_COPY.shareAllConfirmLabel(source.taking),
  };
}

/** Share All's confirm while it is open (its start sends the profiles this preview answered for: startTargets). */
interface ShareAllPhase {
  preview: FanoutShareAllPreviewAnswer;
}

/** A Choose profiles… of a few entries (their ids on the tab's profile, and where the job is already, for one row). */
interface ChooseFew {
  kind: 'few';
  applicationIds: string[];
  savedOn?: ReadonlySet<ProfileChoice>;
  onDone?: () => void;
  finalFocus?: () => HTMLElement | boolean | null;
}

type Choosing = ChooseFew | { kind: 'all'; finalFocus?: () => HTMLElement | boolean | null } | null;

export interface ShareSaved {
  /** Every profile of the person (the tab's marked `current`): ProfileMenuItems' list, with `exclude`. */
  profiles: FanoutProfile[];
  /** The targets listed (the tab's own left out; off ones with their reason). */
  targets: FanoutProfile[];
  /** Leaves the tab's own profile out of a menu (ProfileMenuItems' `exclude`). */
  exclude: (profile: FanoutProfile) => boolean;
  labelOf: LabelOf;
  /** Some target is on: Share shows. */
  available: boolean;
  /** Why nothing can be shared from the tab's profile (it is shared without Job Tracker › See), or null. */
  blocked: string | null;
  /** The tab's profile ('me' or its key): the source. */
  source: ProfileChoice;
  /** Shares these entries of the tab's profile to `targets`; one message with Undo. A whole refusal throws. */
  share: (applicationIds: readonly string[], targets: FanoutTargets, onDone?: () => void) => Promise<void>;
  /** Choose profiles… for these entries (one row: `savedOn` shows where the job is already). */
  chooseFor: (applicationIds: readonly string[], options?: Omit<ChooseFew, 'kind' | 'applicationIds'>) => void;
  /** Share All to `targets`: its preview, then its confirm. */
  shareAll: (targets: FanoutTargets, finalFocus?: () => HTMLElement | boolean | null) => void;
  /** Share All's Choose profiles… (then the preview and the confirm). */
  chooseAll: (finalFocus?: () => HTMLElement | boolean | null) => void;
  /** Share All's preview is being read. */
  allPending: boolean;
  /** The dialogs and the result's alert: render once. */
  elements: ReactElement;
}

/** Sharing saved jobs from the tab's profile (see the module's note). */
export function useShareSaved(): ShareSaved {
  const client = useQueryClient();
  const toast = useToast();
  const choices = useFanoutChoices(['tracker:edit']);
  const { profiles, label, tab: source } = choices;
  const { get, t } = usePublicConstants();
  const batch = get('SAVE_BATCH_MAX');
  const report = useFanoutReport();
  const { show } = report;
  const undoSaved = useUndoSaved(report, choices);
  const tabProfile = useTabProfile();
  const [choosing, setChoosing] = useState<Choosing>(null);
  const [phase, setPhase] = useState<ShareAllPhase | null>(null);
  const [allPending, setAllPending] = useState(false);
  const [allFocus, setAllFocus] = useState<(() => HTMLElement | boolean | null) | undefined>(undefined);

  const targets = shareTargets(profiles);
  const exclude = useCallback((profile: FanoutProfile) => profile.current, []);
  const blocked = tabCan(tabProfile, 'tracker:view') ? null : FANOUT_COPY.prepareBlocked(boxName('tracker:view', label));
  const available = choices.available && targets.some((profile) => profile.allowed);

  const share = useCallback(
    async (applicationIds: readonly string[], to: FanoutTargets, onDone?: () => void) => {
      const items: FanoutItem[] = [...new Set(applicationIds)].map((applicationId) => ({ profile: source, applicationId }));
      const list = shareTargetList(to, profiles);
      if (items.length === 0 || list.length === 0) return;
      const day = browserDay();
      const answer = await copyInBatches(items, list, batch, (slice, targetsNow) => copySavedTo(slice, targetsNow, day));
      void refreshAfterFanoutSave(client);
      const made = savedItems(answer);
      show(shareReport(answer, profiles, label), made.length > 0 ? () => void undoSaved(made, FANOUT_COPY.shareUndone) : undefined);
      onDone?.();
    },
    [source, profiles, batch, client, show, label, undoSaved],
  );

  /** A share from a menu: its refusal is a toast (the dialog says its own). */
  const shareNow = useCallback(
    (applicationIds: readonly string[], to: FanoutTargets, onDone?: () => void) =>
      share(applicationIds, to, onDone).catch((error: unknown) => {
        if (!isProfileRefusal(error)) toast.error(FANOUT_COPY.nothingShared, userMessage(error, 'Please try again.'));
      }),
    [share, toast],
  );

  const readPreview = useCallback(
    async (to: FanoutTargets) => {
      const list = shareTargetList(to, profiles);
      const preview = await previewShareAll(source, list);
      setPhase({ preview });
    },
    [profiles, source],
  );

  const shareAll = useCallback(
    (to: FanoutTargets, finalFocus?: () => HTMLElement | boolean | null) => {
      if (allPending) return;
      setAllFocus(() => finalFocus);
      setAllPending(true);
      void readPreview(to)
        .catch((error: unknown) => {
          if (!isProfileRefusal(error)) toast.error(FANOUT_COPY.nothingShared, userMessage(error, 'Please try again.'));
        })
        .finally(() => setAllPending(false));
    },
    [allPending, readPreview, toast],
  );

  const view = phase ? shareAllView(phase.preview, profiles, label, (max) => t('MSG_SHARE_ALL_TOO_MANY', { max })) : null;
  const choosingFew = choosing?.kind === 'few' ? choosing : null;
  const elements = (
    <>
      <ProfilesDialog
        open={choosing !== null}
        onOpenChange={(open) => !open && setChoosing(null)}
        title={
          choosing?.kind === 'all'
            ? FANOUT_COPY.shareAllTitle
            : choosingFew && choosingFew.applicationIds.length > 1
              ? FANOUT_COPY.shareSelectedTitle(choosingFew.applicationIds.length)
              : FANOUT_COPY.shareOneTitle
        }
        help={choosing?.kind === 'all' ? FANOUT_COPY.shareAllHelp : FANOUT_COPY.shareHelp}
        profiles={profiles}
        label={label}
        exclude={exclude}
        savedOn={choosingFew?.savedOn}
        confirmLabel={(count) => (choosing?.kind === 'all' ? FANOUT_COPY.shareAllNext : FANOUT_COPY.shareConfirm(count))}
        busyLabel={choosing?.kind === 'all' ? FANOUT_COPY.shareAllReading : FANOUT_COPY.shareAllBusy}
        finalFocus={choosing?.finalFocus}
        onConfirm={async (to) => {
          if (choosing?.kind === 'all') {
            setAllFocus(() => choosing.finalFocus);
            await readPreview(to);
            return;
          }
          if (choosingFew) await share(choosingFew.applicationIds, to, choosingFew.onDone);
        }}
      />
      <ConfirmDialog
        open={view !== null}
        onOpenChange={(open) => !open && setPhase(null)}
        tone="primary"
        title={view?.title ?? ''}
        description={view?.description}
        confirmLabel={view?.confirmLabel ?? FANOUT_COPY.share}
        busyLabel={FANOUT_COPY.shareAllBusy}
        confirmDisabled={!view?.ready}
        focusCancel
        finalFocus={allFocus}
        onConfirm={async () => {
          if (!phase || !view?.ready) return;
          // v36 FIX-WEB (D3): the profiles the question named, never 'all' read again.
          const answer = await startShareAll(source, startTargets(phase.preview), phase.preview.applicationIds, browserDay());
          void refreshAfterFanoutSave(client);
          const made = savedItems(answer);
          show(shareAllReport(answer, profiles, label), made.length > 0 ? () => void undoSaved(made, FANOUT_COPY.shareUndone) : undefined);
        }}
      >
        {view && <ShareAllBody view={view} />}
      </ConfirmDialog>
      {report.element}
    </>
  );

  return {
    profiles,
    targets,
    exclude,
    labelOf: label,
    available,
    blocked,
    source,
    share: shareNow,
    chooseFor: (applicationIds, options = {}) => setChoosing({ kind: 'few', applicationIds: [...applicationIds], ...options }),
    shareAll,
    chooseAll: (finalFocus) => setChoosing({ kind: 'all', finalFocus }),
    allPending,
    elements,
  };
}

/** Share All's confirm body: each target's line (the refused ones first), the cap, the shares left out. */
export function ShareAllBody({ view }: { view: ShareAllView }) {
  const lines = [...view.lines].sort((a, b) => Number(a.ok) - Number(b.ok));
  return (
    <div className="flex flex-col gap-3" data-share-all-confirm="">
      {lines.length > 0 && (
        <ul className="flex flex-col gap-1 text-[13px] leading-5" aria-label={FANOUT_COPY.profilesGroup}>
          {lines.map((line) => (
            <li key={line.profile} data-share-all-line={line.profile} data-ok={line.ok ? 'true' : 'false'}>
              <span className="font-semibold text-foreground">{line.name}</span>
              <span className="text-muted-foreground">{`: ${line.text}`}</span>
            </li>
          ))}
        </ul>
      )}
      {view.over && (
        <p className="text-[13px] leading-5 text-foreground" data-share-all-over="">
          {view.over}
        </p>
      )}
      {view.left && <p className="text-[13px] leading-5 text-muted-foreground">{view.left}</p>}
    </div>
  );
}
