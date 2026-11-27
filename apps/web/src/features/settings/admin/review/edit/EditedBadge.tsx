'use client';

import { Badge } from '@/components/ui/Badge';
import { PencilSimpleIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';

// v38 REVEDIT (SP v38 PLAN.md E4): "Edited by an admin" (LABEL_JOB_EDITED_BY_ADMIN) on Admin › Review's rows and in its
// editor (Review is admins' only; the Jobs page shows its own mark to admins alone: features/jobs/verification/
// EditedJobBadge.tsx).

export function EditedBadge({ className }: { className?: string }) {
  const { t } = usePublicConstants();
  return (
    <Badge tone="sky" icon={<PencilSimpleIcon size={12} weight="bold" aria-hidden="true" />} className={className} data-edited-badge="">
      {t('LABEL_JOB_EDITED_BY_ADMIN')}
    </Badge>
  );
}
