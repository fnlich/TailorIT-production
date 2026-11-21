'use client';

import { useEffect } from 'react';
import { forgetProfile } from '@/lib/profile';

/**
 * v33 SHARE-4 (PLAN-sharing.md §9 "Storing the profile key"): the sign-in page forgets the tab's profile, in storage
 * and in this document (the page after sign-in is reached without a load), so whoever signs in starts on their own.
 */
export function ForgetProfile(): null {
  useEffect(() => {
    forgetProfile({ document: true });
  }, []);
  return null;
}
