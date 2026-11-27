'use client';

import { clsx } from 'clsx';
import { Badge } from '@/components/ui/Badge';
import { HelpTip } from '@/components/ui/HelpTip';
import { PencilSimpleIcon } from '@/components/ui/icons';
import { useIsAdmin } from '@/lib/auth';
import { usePublicConstants } from '@/lib/constants';

// v38 REVEDIT (SP v38 PLAN.md E4: "Admins see an 'Edited by an admin' mark (admin-only, like 'Approved by an admin');
// people see the job normally"): the job's mark on its card and its details, for an administrator only (the API sends
// `adminEditedAt` to admins alone too: jobs/add/approval-view.ts). A chip with its "?", above a row's stretched link (a
// press on it opens the tip, never the row).

/** Keeps a press on the "?" from reaching the row or card under it. */
const keep = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** Whether this viewer sees the mark of `job`. */
export function useEditedMark(job: { adminEditedAt?: string }): boolean {
  return useIsAdmin() && Boolean(job.adminEditedAt);
}

export function EditedJobBadge({ job, className }: { job: { adminEditedAt?: string }; className?: string }) {
  const { t } = usePublicConstants();
  const shown = useEditedMark(job);
  if (!shown) return null;
  const title = t('LABEL_JOB_EDITED_BY_ADMIN');
  return (
    <span
      className={clsx('relative z-10 inline-flex items-center gap-1', className)}
      data-edited-state=""
      onClick={keep}
      onKeyDown={keep}
      onMouseDown={keep}
      onPointerDown={keep}
      onTouchStart={keep}
    >
      <Badge tone="sky" icon={<PencilSimpleIcon size={12} weight="bold" aria-hidden="true" />} data-edited-badge="">
        {title}
      </Badge>
      <HelpTip label={title}>{t('MSG_JOB_EDITED_BY_ADMIN')}</HelpTip>
    </span>
  );
}
