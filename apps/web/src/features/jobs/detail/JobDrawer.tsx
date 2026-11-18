'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { useRef, useState } from 'react';
import { BACKDROP } from '@/components/ui/Dialog';
import { JobDetailPanel, type DrawerNav } from './JobDetailPanel';

// v31 FIX-JOBS: a job opens in a drawer from the right (REV-UX UX-1: no permanent list-and-detail split). It is a
// modal dialog (Base UI): 600 px from 640 px up, the whole window on a phone; its name is the job's title (an h2, the
// page keeps its one h1, UX-7); focus moves to that title and, on close, returns to where the page says (the job's
// row). It is the kit's Sheet in a narrower size with its own bar and footer, built here on the tokens (design 20
// rule 2, "Need a new primitive?"): the kit's Sheet has two sizes (768 px and 1280 px) and no `finalFocus`.

export interface JobDrawerProps {
  /** The job in the address (`?jobId=`): the drawer is open while there is one. */
  jobId: number | null;
  onClose: () => void;
  nav: DrawerNav;
  /** Where focus goes when the drawer closes (the job's row; see JobsPage). */
  finalFocus: () => HTMLElement | boolean | null;
  onJobsHidden: (hidden: { jobId?: number; companyId?: number }) => void;
  /** The row's quick Apply asked for this job: its posting opens as soon as the job is read. */
  applyIntent: number | null;
  onApplyIntentHandled: () => void;
}

export function JobDrawer({ jobId, onClose, nav, finalFocus, onJobsHidden, applyIntent, onApplyIntentHandled }: JobDrawerProps) {
  const popup = useRef<HTMLDivElement>(null);
  // While the drawer slides out the job it showed stays in it (the address has no job any more).
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
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface text-foreground shadow-dialog outline-none ' +
            'sm:max-w-[600px] sm:border-l sm:border-border ' +
            'transition-transform duration-300 ease-out-soft data-ending-style:translate-x-full data-starting-style:translate-x-full'
          }
          data-job-drawer=""
        >
          {shown !== null && (
            <JobDetailPanel
              jobId={shown}
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
