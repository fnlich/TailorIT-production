'use client';

import type { JobsQuery, SaveAllPreview, SavedJobRef } from '@tailorit/shared';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
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
import { useSaveAll, useUndoSaveAll, type useJobsList } from '../hooks';
import { BookmarksSimpleIcon } from '../icons';
import { BAR_BUTTON } from './styles'; // v31 FIX-JOBS: the results bar's button look

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
      if (shownQuery.current === asked) toast.error(SAVE_ALL_FAILED, userMessage(error));
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
      onError: (error) => toast.error(UNDO_SAVE_ALL_FAILED, userMessage(error)),
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
          {pendingCount ? <Spinner size={14} /> : <BookmarksSimpleIcon size={15} />}
          Save all
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
