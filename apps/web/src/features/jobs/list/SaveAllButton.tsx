'use client';

import { UsersThreeIcon } from '@phosphor-icons/react/UsersThree';
import type { JobsQuery, SaveAllPreview, SavedJobRef } from '@tailorit/shared';
import type { FanoutSaveAllAnswer, FanoutSaveAllPreviewAnswer, FanoutTargets } from '@tailorit/shared/sharing';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePublicConstants } from '@/lib/constants';
import { fetchSaveAllPreview, listQueryString } from '../api';
import {
  SAVE_ALL_FAILED,
  UNDO_SAVE_ALL_FAILED,
  nothingToSaveCopy,
  saveAllConfirmCopy,
  saveAllHint,
  saveAllResultCopy,
  saveAllUndoneCopy,
} from '../format';
import { failure, useSaveAll, useUndoSaveAll, type useJobsList } from '../hooks';
import { BookmarksSimpleIcon } from '../icons';
import { BAR_BUTTON, BAR_WORD } from './styles'; // v31 FIX-JOBS: the results bar's button look
import { previewSaveAllOn, saveAllTo } from '../../sharing/fanout/api'; // v34 FANWEB
import { FANOUT_COPY } from '../../sharing/fanout/copy';
import { ProfilesDialog } from '../../sharing/fanout/parts';
import { fanoutReport, nameOf, refusalText, type FanoutReport } from '../../sharing/fanout/results';
import { boxName, type FanoutProfile, type LabelOf } from '../../sharing/fanout/targets';
import { refreshAfterFanoutSave } from '../../sharing/fanout/useFanout';
import { browserDay, savedItems, useSaveToProfiles } from '../../sharing/fanout/useSaveTo';

/** The success toast stays this long, so its Undo can be reached. */
const UNDO_TOAST_MS = 10_000;

/** The confirm being shown: the numbers, and the filters they were counted for (the save is made for exactly these). */
interface Confirming {
  preview: SaveAllPreview;
  queryString: string;
}

export interface SaveAllButtonProps {
  query: JobsQuery;
  list: ReturnType<typeof useJobsList>;
}

/**
 * "Save all" in the results bar, styled like the sort menu beside it. A click counts what the filters match (the
 * button spins meanwhile), then asks "Save N jobs?" (at most SAVE_BATCH_MAX, in the order the list shows them; tracked jobs keep
 * their status), or says there is nothing new to save. The success toast offers Undo for 10 s. v31 FIX-JOBS: the
 * full-width results bar has room for its word at every width.
 */
export function SaveAllButton({ query, list }: SaveAllButtonProps) {
  const toast = useToast();
  const saveAll = useSaveAll();
  const undo = useUndoSaveAll();
  // v2.0: one click's batch is the public constant SAVE_BATCH_MAX (an admin may change it).
  const constants = usePublicConstants();
  // v30 WEB-JOBS: the server counts the matches up to JOB_SEARCH_COUNT_CAP ("10,000+").
  const countCap = constants.get('JOB_SEARCH_COUNT_CAP');
  const queryString = listQueryString(query);
  /** The filters on screen now (null once the list is gone): a count that comes back for other filters is dropped. */
  const shownQuery = useRef<string | null>(queryString);
  useEffect(() => {
    shownQuery.current = queryString;
    return () => {
      shownQuery.current = null;
    };
  }, [queryString]);
  /** Set from the click to the count's answer: a second click meanwhile does nothing. */
  const counting = useRef(false);
  const [pendingCount, setPendingCount] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [open, setOpen] = useState(false);

  const total = list.data?.pages[0]?.total ?? 0;
  const disabled = list.isPending || !list.data || list.isPlaceholderData || total === 0 || saveAll.isPending || undo.isPending;

  const start = async () => {
    if (counting.current) return;
    const asked = queryString;
    counting.current = true;
    setPendingCount(true);
    try {
      const preview = await fetchSaveAllPreview(asked);
      if (shownQuery.current !== asked) return;
      if (preview.willSave === 0) {
        const copy = nothingToSaveCopy(preview.matched, countCap);
        toast.info(copy.title, copy.description);
        return;
      }
      setConfirming({ preview, queryString: asked });
      setOpen(true);
    } catch (error) {
      if (shownQuery.current === asked) failure(toast, SAVE_ALL_FAILED, error);
    } finally {
      counting.current = false;
      setPendingCount(false);
    }
  };

  const undoSave = (items: readonly SavedJobRef[]) => {
    undo.mutate(items, {
      onSuccess: ({ affected }) => {
        const copy = saveAllUndoneCopy(affected);
        toast.info(copy.title, copy.description);
      },
      onError: (error) => failure(toast, UNDO_SAVE_ALL_FAILED, error),
    });
  };

  // Rejecting keeps the dialog open with the server's sentence (ConfirmDialog).
  const confirm = async () => {
    if (!confirming) return;
    const result = await saveAll.mutateAsync({ queryString: confirming.queryString });
    const copy = saveAllResultCopy(result, countCap);
    if (result.items.length === 0) {
      toast.info(copy.title, copy.description);
      return;
    }
    const items = result.items;
    const id = toast.toast({
      type: 'success',
      title: copy.title,
      description: copy.description,
      timeout: UNDO_TOAST_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          // One Undo per toast: it closes as the undo starts.
          toast.dismiss(id);
          undoSave(items);
        },
      },
    });
  };

  const copy = confirming ? saveAllConfirmCopy(confirming.preview, countCap) : null;
  return (
    <>
      <Tooltip content={saveAllHint(constants.get('SAVE_BATCH_MAX'))}>
        <button
          type="button"
          disabled={disabled}
          aria-busy={pendingCount || undefined}
          onClick={() => void start()}
          className={BAR_BUTTON}
        >
          {pendingCount ? <Spinner size={14} /> : <BookmarksSimpleIcon size={15} aria-hidden="true" />}
          <span className={BAR_WORD}>Save all</span>
        </button>
      </Tooltip>
      {copy && (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          tone="primary"
          title={copy.title}
          description={copy.description}
          confirmLabel={copy.confirmLabel}
          busyLabel={copy.busyLabel}
          onConfirm={confirm}
        >
          {copy.note ? <p className="leading-5 text-muted-foreground">{copy.note}</p> : null}
        </ConfirmDialog>
      )}
    </>
  );
}

// v34 FANWEB (PLAN G2, G4: "Save all gets Save to…") ------------------------------------------------------------------

/** What Save all to profiles says: where it saved and how many, a profile's refusal in the one alert. */
export function saveAllToReport(answer: FanoutSaveAllAnswer, profiles: readonly FanoutProfile[], label: LabelOf): FanoutReport {
  return fanoutReport(answer, {
    profiles,
    label,
    did: (result) => result.items.length > 0,
    detail: (result) => FANOUT_COPY.savedCounts(result.items.length, result.alreadyTracked, 0),
    title: FANOUT_COPY.savedOn,
    none: FANOUT_COPY.saveAllConfirmNone,
    // v34 FANWEB fix (spec M2): a profile that saved nothing, named with why.
    nothing: (result, name) => (result.alreadyTracked > 0 ? FANOUT_COPY.allSavedAlready(name) : FANOUT_COPY.noNewMatches(name)),
  });
}

/**
 * The confirm's numbers: each profile's own matches for this search, and how many it saves. v34 FANWEB fix (both
 * reviews; FANOUT's preview now counts with the save's box, Job Tracker › Change): a profile shared to see only is no
 * longer counted; 'all' names it in `left`, drawn here as a line with the box it needs. `profiles`: how many profiles
 * save something (the title's words).
 */
export function saveAllToLines(
  preview: FanoutSaveAllPreviewAnswer,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
): { total: number; saving: number; lines: { profile: string; name: string; text: string; ok: boolean }[] } {
  let total = 0;
  let saving = 0;
  const lines = preview.results.map((result) => {
    if (!result.ok) return { profile: result.profile, name: nameOf(profiles, result.profile, result.name), text: refusalText(profiles, result, label), ok: false };
    total += result.willSave;
    if (result.willSave > 0) saving += 1;
    return { profile: result.profile, name: nameOf(profiles, result.profile, result.name), text: FANOUT_COPY.willSave(result.willSave), ok: true };
  });
  const leftLines = preview.left.map((one) => {
    const profile = profiles.find((entry) => entry.choice === one.profile);
    const box = profile && !profile.allowed ? profile.missing[0] : undefined;
    return {
      profile: one.profile as string,
      name: nameOf(profiles, one.profile, one.name),
      text: box ? FANOUT_COPY.needs(boxName(box, label)) : FANOUT_COPY.unavailable,
      ok: false,
    };
  });
  return { total, saving, lines: [...lines, ...leftLines] };
}

/**
 * "Save all to…" beside Save all, once the person has a shared profile: the profiles first, then the confirm with each
 * profile's own count (its matches for this search that it does not have yet: each saves its own list, its own resume),
 * then one request (POST /api/profiles/jobs/save-all), one message and Undo.
 */
export function SaveAllToButton({ query, list }: SaveAllButtonProps) {
  const client = useQueryClient();
  const saveTo = useSaveToProfiles();
  const queryString = listQueryString(query);
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState<{ targets: FanoutTargets; queryString: string; preview: FanoutSaveAllPreviewAnswer } | null>(null);
  const [open, setOpen] = useState(false);
  if (!saveTo.available) return null;
  const total = list.data?.pages[0]?.total ?? 0;
  const disabled = list.isPending || !list.data || list.isPlaceholderData || total === 0;

  const count = async (targets: FanoutTargets) => {
    const preview = await previewSaveAllOn(targets, queryString);
    setConfirming({ targets, queryString, preview });
    setOpen(true);
  };

  const confirm = async () => {
    if (!confirming) return;
    const answer = await saveAllTo(confirming.targets, confirming.queryString, browserDay());
    void refreshAfterFanoutSave(client);
    const items = savedItems(answer);
    saveTo.show(saveAllToReport(answer, saveTo.profiles, saveTo.label), items.length > 0 ? () => void saveTo.undo(items) : undefined);
  };

  const shown = confirming ? saveAllToLines(confirming.preview, saveTo.profiles, saveTo.label) : null;
  return (
    <>
      <Tooltip content={FANOUT_COPY.saveAllToTip}>
        <button type="button" disabled={disabled} onClick={() => setChoosing(true)} className={BAR_BUTTON} data-save-all-to="">
          <UsersThreeIcon size={15} aria-hidden="true" />
          <span className={BAR_WORD}>{FANOUT_COPY.saveAllTo}</span>
        </button>
      </Tooltip>
      <ProfilesDialog
        open={choosing}
        onOpenChange={setChoosing}
        title={FANOUT_COPY.saveAllToTitle}
        help={FANOUT_COPY.saveAllToHelp}
        profiles={saveTo.profiles}
        label={saveTo.label}
        initial={[saveTo.tab]}
        confirmLabel={() => FANOUT_COPY.saveAllContinue}
        onConfirm={count}
      />
      {shown && (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          tone="primary"
          title={shown.total > 0 ? FANOUT_COPY.saveAllConfirmTitle(shown.saving) : FANOUT_COPY.saveAllConfirmNone}
          description={FANOUT_COPY.saveAllConfirmLine}
          confirmLabel={FANOUT_COPY.saveAllConfirmLabel}
          busyLabel={FANOUT_COPY.saveAllBusy}
          confirmDisabled={shown.total === 0}
          onConfirm={confirm}
        >
          <ul className="flex flex-col gap-1" aria-label="Jobs per profile" data-save-all-to-confirm="">
            {shown.lines.map((line) => (
              <li key={line.profile} className="flex items-baseline justify-between gap-3" data-save-all-to-line={line.profile}>
                <span className="truncate text-foreground">{line.name}</span>
                <span className="shrink-0 text-muted-foreground">{line.text}</span>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
      {saveTo.element}
    </>
  );
}
