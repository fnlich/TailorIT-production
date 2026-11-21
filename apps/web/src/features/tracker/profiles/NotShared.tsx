'use client';

import { Notice } from '@/components/ui/Notice';
import { ALL_PROFILES_COPY } from './scope';

/**
 * v33 SHARE-9 (PLAN-sharing.md §9 "Permission-aware UI": "A GET that gets 403 renders 'Not shared with you.' inline"):
 * where a shared profile's read was refused, the place says so (an info notice, never a red error with Try again,
 * which could never succeed). `title` names what is not shared.
 */
export function NotSharedNotice({ title }: { title: string }) {
  return (
    <Notice tone="info" title={title}>
      {ALL_PROFILES_COPY.notShared}
    </Notice>
  );
}
