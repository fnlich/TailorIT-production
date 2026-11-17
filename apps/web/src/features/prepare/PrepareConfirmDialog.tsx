'use client';

import { useState } from 'react';
import { usePublicConstants } from '../../lib/constants';
// Relative, not '@/': the web tests draw this view.
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { confirmTitle } from './copy';

// v2.0: the confirm before Prepare & Queue (docs/design/v2.0/08-ui.md, "The confirm"): title "Prepare & Queue" (or
// "Prepare & Queue 5 jobs"), the body MSG_PREPARE_CONFIRM, the checkbox MSG_PREPARE_CONFIRM_DONT_SHOW, Cancel and
// Continue. It shows while GET /api/prepare/settings says skipConfirm: false; Continue with the box ticked saves
// skipConfirm: true first (the caller's `onContinue`). Cancel saves nothing.

export interface PrepareConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many saved jobs the request names. */
  count: number;
  /** Continue: `dontShowAgain` is the box. Reject to keep the dialog open with the error shown. */
  onContinue: (dontShowAgain: boolean) => Promise<void> | void;
  /** Where focus goes when it closes (the pressed Prepare & Queue, or its row's action now). */
  finalFocus?: () => HTMLElement | boolean | null;
}

export function PrepareConfirmDialog({ open, onOpenChange, count, onContinue, finalFocus }: PrepareConfirmDialogProps) {
  const { t } = usePublicConstants();
  const [dontShow, setDontShow] = useState(false);
  // The box starts unticked each time the dialog opens.
  const [openedFor, setOpenedFor] = useState(open);
  if (openedFor !== open) {
    setOpenedFor(open);
    if (open) setDontShow(false);
  }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title={confirmTitle(count)}
      description={t('MSG_PREPARE_CONFIRM')}
      confirmLabel="Continue"
      busyLabel="Starting..."
      onConfirm={() => onContinue(dontShow)}
      // v2.0 fix (UX-16): first focus on Continue, so a Space press answers instead of ticking "Don't show this again".
      focusConfirm
      finalFocus={finalFocus}
    >
      <span data-prepare-confirm-dont-show="">
        <Checkbox checked={dontShow} onCheckedChange={setDontShow} label={t('MSG_PREPARE_CONFIRM_DONT_SHOW')} />
      </span>
    </ConfirmDialog>
  );
}
