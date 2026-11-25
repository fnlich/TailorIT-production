'use client';

import { JOB_REVIEW_NOTE_MAX } from '@tailorit/shared/reviews';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { allConfirmText, type AllAction, type AllLane } from './all';
import { noteProblem } from './copy';

// v37 REVIEW (SP v37 PLAN.md R3): the confirm of a decision on every item "Select all N" took, loaded or not: the
// server's count in the title ("Approve 340 jobs?"), what the decision does, a note for the reviews' decisions (kept
// with each, as the selection's BulkDialog keeps it), and the requests' progress while TailorIT works through them. It
// opens on Cancel: a quick Enter never publishes or closes hundreds of jobs.
// v37 FIX-REV (REVIEW361-ux M1, L6): Cancel gives focus back to the control that opened it (`finalFocus`, the caller's
// useConfirmReturn); while it works, Stop ends it after the turn under way (the caller's `onStop`), and the result line
// says what was done.

export interface AllAsk {
  lane: AllLane;
  action: AllAction;
}

/** v37 FIX-REV (L6): the Stop button's words, before and after it was pressed. */
export const ALL_STOP_WORDS = { stop: 'Stop', stopping: 'Stopping after this turn...' } as const;

export function AllDialog({
  ask,
  count,
  countError,
  progress,
  onCancel,
  onConfirm,
  finalFocus,
  onStop,
  stopping = false,
}: {
  /** The decision asked for, or null while the dialog is closed. */
  ask: AllAsk | null;
  /** The server's count (undefined while it is read). */
  count: number | undefined;
  /** The count's failure. */
  countError: unknown;
  /** The running total's words while the requests run, else null. */
  progress: string | null;
  onCancel: () => void;
  /** Runs the decision; rejects with the words to show (the dialog stays open). */
  onConfirm: (note: string) => Promise<void>;
  /** v37 FIX-REV (M1): where focus goes when it closes (ConfirmDialog's); Base UI's default (the opener) when absent. */
  finalFocus?: () => HTMLElement | boolean | null;
  /** v37 FIX-REV (L6): stop after the turn under way (offered while the requests run). */
  onStop?: () => void;
  /** Stop was pressed: the turn under way finishes first. */
  stopping?: boolean;
}) {
  const { t } = usePublicConstants();
  const [note, setNote] = useState('');
  const takesNote = ask?.action === 'approve' || ask?.action === 'reject';
  const problem = takesNote ? noteProblem(note, JOB_REVIEW_NOTE_MAX, (max) => t('MSG_TEXT_TOO_LONG', { max })) : null;
  const words = ask ? allConfirmText(ask.lane, ask.action, count ?? null) : null;
  return (
    <ConfirmDialog
      open={ask !== null}
      onOpenChange={(open) => {
        if (open || progress !== null) return;
        setNote('');
        onCancel();
      }}
      tone={ask?.action === 'reject' || ask?.action === 'dismissed' ? 'destructive' : 'primary'}
      title={words?.title ?? ''}
      description={countError ? `The count could not be read. ${userMessage(countError)}` : words?.description}
      confirmLabel={words?.confirm ?? 'Confirm'}
      busyLabel="Working..."
      confirmDisabled={!count || problem !== null}
      focusCancel
      {...(finalFocus ? { finalFocus } : {})}
      onConfirm={async () => {
        await onConfirm(takesNote ? note.trim() : '');
        setNote('');
      }}
    >
      {takesNote && Boolean(count) && (
        <Field label="Note" optional error={problem ?? undefined} hint="Kept with each decision, as plain text.">
          <Textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} disabled={progress !== null} />
        </Field>
      )}
      {progress && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-muted-foreground" role="status" data-all-progress="">
            {progress}
          </p>
          {onStop && (
            <Button variant="outline" size="sm" className="max-sm:h-11" disabled={stopping} focusableWhenDisabled onClick={onStop} data-all-stop="">
              {stopping ? ALL_STOP_WORDS.stopping : ALL_STOP_WORDS.stop}
            </Button>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
