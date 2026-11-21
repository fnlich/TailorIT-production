'use client';

import { PROFILE_SELF } from '@tailorit/shared/sharing'; // v33 SHARE-7
import { clsx } from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { PageSpinner } from '@/components/ui/Spinner';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabPanel } from '@/components/ui/SegmentedControl';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { useProfile } from '@/components/shell/profile/useProfile'; // v33 SHARE-7
import { NotShared, accessOf } from '@/features/sharing/access'; // v33 SHARE-7
import { useAuth } from '@/lib/auth'; // v33 SHARE-7
import { switchProfile } from '@/lib/profile'; // v33 SHARE-7
import { AnswersTab } from './answers/AnswersTab';
import { ExtensionTab } from './extension/ExtensionTab';
import { pairingState } from './extensionBridge';
import { ProfileTab } from './profile/ProfileTab';
import { SignInTab } from './sign-in/SignInTab';

const AUTOFILL_TABS = [
  { value: 'profile', label: 'Profile' },
  { value: 'answers', label: 'Saved answers' },
  { value: 'sign-in', label: 'Job-site sign-in' },
  { value: 'extension', label: 'Extension' },
] as const;
type AutofillTab = (typeof AUTOFILL_TABS)[number]['value'];

/**
 * v33 SHARE-7 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §9 "While acting, these are hidden"): job-site sign-ins
 * and the extension's pairing are the profile owner's own: on a shared profile only Profile and Saved answers show.
 */
const SHARED_PROFILE_TABS: readonly AutofillTab[] = ['profile', 'answers'];

/** v33 SHARE-7: a tab only ever the person's own (hidden on a shared profile): opening it switches the tab back first. */
export function isOwnOnlyTab(value: string | null): boolean {
  return value !== null && AUTOFILL_TABS.some((tab) => tab.value === value) && !SHARED_PROFILE_TABS.includes(value as AutofillTab);
}

function readTab(value: string | null, acting = false): AutofillTab {
  const tabs = acting ? AUTOFILL_TABS.filter((tab) => SHARED_PROFILE_TABS.includes(tab.value)) : AUTOFILL_TABS;
  return tabs.some((tab) => tab.value === value) ? (value as AutofillTab) : 'profile';
}

/**
 * Settings › Autofill (/settings/autofill?tab=profile|answers|sign-in|extension): the profile the TailorIT extension
 * fills job applications from, the answers it saved for questions the profile does not cover, the job-site sign-ins its
 * Sign-in mode Auto uses, and the browsers it is connected in. The extension's options page opens
 * ?tab=extension&connect=1&state=… to connect.
 */
export function AutofillSettingsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // v33 SHARE-7: what the tab's profile may do here (the owner's Autofill info and Sensitive answers boxes).
  const profileView = useProfile();
  const acting = profileView.acting;
  const access = accessOf(profileView, 'autofill:view', 'autofill:edit');
  const sensitiveAccess = accessOf(profileView, 'sensitive:view', 'sensitive:edit');
  const tab = readTab(searchParams.get('tab'), acting);
  // v33 SHARE-7 (PLAN-sharing.md §9): Job-site sign-in or Extension opened on a shared profile (a link, the address):
  // the tab goes back to the person's own first ("Back on your profile."), on the same address.
  const { account } = useAuth();
  const backToOwn = acting && isOwnOnlyTab(searchParams.get('tab'));
  const accountId = account?.id;
  useEffect(() => {
    if (!backToOwn) return;
    const hash = window.location.hash;
    void switchProfile(PROFILE_SELF, {
      to: `${window.location.pathname}${window.location.search}${hash}`,
      accountId,
      notice: { kind: 'back' },
    }).then((done) => {
      // The same address with a #fragment is no new document: load it again, now on the person's own profile.
      if (done.ok && hash) window.location.reload();
    });
  }, [backToOwn, accountId]);
  const tabs = acting ? AUTOFILL_TABS.filter((item) => SHARED_PROFILE_TABS.includes(item.value)) : AUTOFILL_TABS;
  /** v33 SHARE-7: a part the owner did not share says so; nothing is asked for until the boxes are known. */
  const shared = (part: ReactNode) => (!access.ready ? <PageSpinner /> : access.see ? part : <NotShared owner={access.owner} />);
  const state = pairingState(searchParams.get('state'));
  // The Extension tab's boxes, held here: that tab is unmounted while Profile shows, and the choices made in it stay.
  const [includeSensitive, setIncludeSensitive] = useState(true);
  // Reading the saved job-site password is asked for each connection, and never by default.
  const [allowSignIn, setAllowSignIn] = useState(false);

  /** The address with `changes` applied (null drops a parameter); the pairing state is kept until it is used. */
  const replace = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) params.delete(name);
      else params.set(name, value);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  if (backToOwn) return <PageSpinner label="Back to your profile..." />; // v33 SHARE-7
  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-7 pb-20', PAGE_GUTTER)}>
      <PageHeader
        title="Autofill"
        description="What the extension fills into job applications."
      />
      <UnderlineTabs
        aria-label="Autofill sections"
        items={tabs}
        value={tab}
        onValueChange={(next) => replace({ tab: next, connect: null })}
        size="md"
        className="mt-6"
      >
        {/* Kept mounted, so switching tabs never loses unsaved changes. */}
        <TabPanel value="profile" className="mt-6" keepMounted>
          {shared(<ProfileTab access={access} sensitiveAccess={sensitiveAccess} />)}
        </TabPanel>
        <TabPanel value="answers" className="mt-6">
          {shared(<AnswersTab access={access} />)}
        </TabPanel>
        {/* v33 SHARE-7: job-site sign-ins and the extension are the profile owner's own (always locked). */}
        {!acting && (
          <TabPanel value="sign-in" className="mt-6">
            <SignInTab />
          </TabPanel>
        )}
        {!acting && (
          <TabPanel value="extension" className="mt-6">
            <ExtensionTab
              pairingState={state}
              focusConnect={searchParams.get('connect') === '1'}
              includeSensitive={includeSensitive}
              onIncludeSensitiveChange={setIncludeSensitive}
              allowSignIn={allowSignIn}
              onAllowSignInChange={setAllowSignIn}
              onPairingUsed={() => replace({ state: null, connect: null })}
            />
          </TabPanel>
        )}
      </UnderlineTabs>
    </div>
  );
}
