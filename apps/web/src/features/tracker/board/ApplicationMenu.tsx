'use client';

import { ArrowsLeftRightIcon } from '@phosphor-icons/react/ArrowsLeftRight';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react/ArrowsOutSimple';
import { APPLICATION_STATUSES, STATUS_INFO, type ApplicationStatus, type ApplicationSummary } from '@tailorit/shared';
import {
  MenuItem,
  MenuLinkItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
} from '@/components/ui/Menu';
import { ArchiveIcon, ArrowCounterClockwiseIcon, ArrowSquareOutIcon, ArrowsClockwiseIcon, RobotIcon } from '@/components/ui/icons';
import { RETRY_READ_COPY, canRetryRead } from '@/features/jobs/verification/copy'; // v31 JOBSWEB
import { usePublicConstants } from '@/lib/constants';
import { prepareBlockReason } from '../draft';
import { StatusIcon } from '../status';

export interface ApplicationActions {
  onOpen: (application: ApplicationSummary) => void;
  onMove: (application: ApplicationSummary, status: ApplicationStatus) => void;
  onArchive: (application: ApplicationSummary) => void;
  onRestore: (application: ApplicationSummary) => void;
  /** v2.0: Prepare & Queue a Saved entry (its card menu); absent where the screen has no such action. */
  onPrepare?: (application: ApplicationSummary) => void;
  /**
   * v31 JOBSWEB: Retry read of the entry's job when it is the person's own, TailorIT having not read its link
   * (POST /api/jobs/:id/verify); absent where the screen has no such action.
   */
  onRetryRead?: (application: ApplicationSummary) => void;
}

/**
 * The card menu (the ⋯ button, a right-click and a long press): Open application, View job posting, Prepare & Queue,
 * Retry read (v31: a job only the person sees), Move to stage › (every status, the current one disabled), Archive /
 * Restore application. v32 LAYOUT (E9): "Move to stage", as the selection bar says it; on a phone, where the board shows
 * one lane at a time, this is how a card changes lanes.
 */
export function ApplicationMenuItems({ application, actions }: { application: ApplicationSummary; actions: ApplicationActions }) {
  const { t } = usePublicConstants();
  return (
    <>
      <MenuItem icon={<ArrowsOutSimpleIcon size={16} />} onClick={() => actions.onOpen(application)}>
        Open application
      </MenuItem>
      {application.postingUrl && (
        <MenuLinkItem
          href={application.postingUrl}
          icon={<ArrowSquareOutIcon size={16} />}
          render={<a href={application.postingUrl} target="_blank" rel="noopener noreferrer" />}
        >
          View job posting
        </MenuLinkItem>
      )}
      {actions.onPrepare && prepareBlockReason(application) === null && (
        <MenuItem icon={<RobotIcon size={16} />} onClick={() => actions.onPrepare?.(application)}>
          Prepare &amp; Queue
        </MenuItem>
      )}
      {actions.onRetryRead && application.jobId !== null && canRetryRead(application) && (
        <MenuItem icon={<ArrowsClockwiseIcon size={16} />} onClick={() => actions.onRetryRead?.(application)}>
          {RETRY_READ_COPY.button}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuSub label={t('LABEL_TRACKER_MOVE_TO_STAGE')} icon={<ArrowsLeftRightIcon size={16} />}>
        <MenuSubContent width="w-52">
          <MenuRadioGroup
            value={String(application.currentStatus)}
            onValueChange={(value) => actions.onMove(application, Number(value) as ApplicationStatus)}
          >
            {APPLICATION_STATUSES.map((status) => (
              <MenuRadioItem
                key={status}
                value={String(status)}
                icon={<StatusIcon status={status} size={16} />}
                disabled={status === application.currentStatus}
                closeOnClick
              >
                {STATUS_INFO[status].label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
      <MenuSeparator />
      {application.archivedAt ? (
        <MenuItem icon={<ArrowCounterClockwiseIcon size={16} />} onClick={() => actions.onRestore(application)}>
          Restore application
        </MenuItem>
      ) : (
        <MenuItem icon={<ArchiveIcon size={16} />} onClick={() => actions.onArchive(application)}>
          Archive application
        </MenuItem>
      )}
    </>
  );
}
