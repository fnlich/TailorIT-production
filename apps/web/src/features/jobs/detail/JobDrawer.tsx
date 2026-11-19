'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { useRef, useState } from 'react';
import { BACKDROP } from '@/components/ui/Dialog';
import { JobDetailPanel, type DrawerNav } from './JobDetailPanel';

// v32 JOBS2 (E3): below 1024 px the list fills the page and a job opens over it, the whole window (from 1024 px the job
// sits in the pane beside the list instead). It is a modal dialog (Base UI) named by the job's title (an h2: the page
// keeps its one h1); focus moves to that title and, on close (Back, Escape, the browser's Back), returns to where the
// page says (the job's row). v31 FIX-JOBS drew it as a 600 px drawer at every width.

export interface JobDrawerProps {
  /** The job in the address (`?jobId=`): the sheet is open while there is one. */
  jobId: number | null;
  onClose: () => void;
  nav: DrawerNav;
  /** Where focus goes when the sheet closes (the job's row; see JobsPage). */
  finalFocus: () => HTMLElement | boolean | null;
  onJobsHidden: (hidden: { jobId?: number; companyId?: number }) => void;
  /** The row's quick Apply asked for this job: its posting opens as soon as the job is read. */
  applyIntent: number | null;
  onApplyIntentHandled: () => void;
}

export function JobDrawer({ jobId, onClose, nav, finalFocus, onJobsHidden, applyIntent, onApplyIntentHandled }: JobDrawerProps) {
  const popup = useRef<HTMLDivElement>(null);
  // While the sheet slides out the job it showed stays in it (the address has no job any more).
  const [shown, setShown] = useState(jobId);
  if (jobId !== null && jobId !== shown) setShown(jobId);

  return (
    <BaseDialog.Root
      open={jobId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={BACKDROP} />
        <BaseDialog.Popup
          ref={popup}
          initialFocus={() => popup.current?.querySelector<HTMLElement>('[data-drawer-title]') ?? popup.current ?? true}
          finalFocus={finalFocus}
          className={
            'fixed inset-0 z-50 flex w-full flex-col bg-surface text-foreground shadow-dialog outline-none ' +
            'transition-transform duration-300 ease-out-soft data-ending-style:translate-x-full data-starting-style:translate-x-full'
          }
          data-job-drawer=""
        >
          {shown !== null && (
            <JobDetailPanel
              jobId={shown}
              variant="sheet"
              nav={nav}
              onClose={onClose}
              onJobsHidden={onJobsHidden}
              applyIntent={applyIntent === shown}
              onApplyIntentHandled={onApplyIntentHandled}
            />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
