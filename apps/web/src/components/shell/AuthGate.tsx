'use client';

import { PROFILE_SELF } from '@tailorit/shared/sharing';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { PageEyebrowContext } from '@/components/ui/PageHeader';
import { PageSpinner } from '@/components/ui/Spinner';
import { UNREACHABLE_MESSAGE } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { redirectToLogin } from '@/lib/navigation';
import { bindAccount, isActing, isOwnOnlyPath, switchProfile } from '@/lib/profile';
import { ProfileRuntime } from './profile/ProfileRuntime';
import { useProfileEyebrow } from './profile/useProfile';

/**
 * Shows `children` only once the session's account is known. No account (an expired or revoked cookie) → the
 * sign-in page, remembering this one; the API unreachable → a sentence and Try again.
 *
 * v33 SHARE-4 (PLAN-sharing.md §9): then the tab's profile. A profile chosen for another account is dropped and the
 * page loads again on the person's own (lib/profile.ts bindAccount); a page only ever done on one's own profile
 * (Integrations, Admin, Sharing, an AI app's consent) opened while the tab works on a shared one switches the tab back
 * first ("Back on your profile."), and draws nothing of itself until then. The shell's ProfileRuntime runs beside the
 * page.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { account, status, error, refresh } = useAuth();
  const pathname = usePathname();
  const signedOut = status === 'ready' && account === null;
  const accountId = account?.id ?? null;
  // Once per account: the binding may drop the tab's shared profile (and load the page again).
  const binding = useMemo(() => (accountId ? bindAccount(accountId) : 'ok'), [accountId]);
  const backToOwn = accountId !== null && binding === 'ok' && isActing() && isOwnOnlyPath(pathname);

  useEffect(() => {
    if (signedOut) redirectToLogin();
  }, [signedOut]);

  useEffect(() => {
    if (binding === 'reload') window.location.reload();
  }, [binding]);

  useEffect(() => {
    if (!backToOwn) return;
    void switchProfile(PROFILE_SELF, {
      to: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      accountId,
      notice: { kind: 'back' },
    });
  }, [backToOwn, accountId]);

  if (status === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col px-4 py-16">
        <Notice
          tone="error"
          title="Your account didn't load."
          action={
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        >
          {error?.isUnreachable || !error ? UNREACHABLE_MESSAGE : error.message}
        </Notice>
      </div>
    );
  }
  if (status === 'loading' || !account) return <PageSpinner label={signedOut ? 'Opening the sign-in page...' : 'Loading...'} />;
  if (binding === 'reload' || backToOwn) return <PageSpinner label="Opening your profile..." />;
  return (
    <>
      <ProfileRuntime account={account} />
      <ProfileEyebrow>{children}</ProfileEyebrow>
    </>
  );
}

/**
 * v33 SHARE-4 (INT-B): a page's title names the profile the tab works on. Every PageHeader h1 without an eyebrow of its
 * own shows "<name>'s profile" above the title while the tab works on a shared profile (components/ui PageHeader's
 * PageEyebrowContext); on the person's own profile, nothing.
 */
export function ProfileEyebrow({ children }: { children: ReactNode }) {
  return <PageEyebrowContext.Provider value={useProfileEyebrow()}>{children}</PageEyebrowContext.Provider>;
}
