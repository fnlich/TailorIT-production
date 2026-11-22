'use client';

import { isSharePermission, rowOfPermission, SHARE_COLUMN_LABELS } from '@tailorit/shared/sharing';
import { useGuide } from './context';
import type { PublicMessageKey } from '@/lib/constants';

// v34 HELP (review #38): a sharing box by the words the Sharing page shows ("Job settings › Change"), read from the
// row's and the column's label constants, so an admin's rename reaches the guide too.

/** "Job Tracker › See" for a SharePermission; null for anything else. */
export function useBoxName(): (box: string | null) => string | null {
  const { t } = useGuide();
  return (box) => {
    if (!box || !isSharePermission(box)) return null;
    const row = rowOfPermission(box);
    const column = row.see === box ? SHARE_COLUMN_LABELS.see : SHARE_COLUMN_LABELS.change;
    return `${t(row.label as PublicMessageKey)} › ${t(column as PublicMessageKey)}`;
  };
}
