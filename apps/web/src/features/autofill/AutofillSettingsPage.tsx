'use client';

import { clsx } from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabPanel } from '@/components/ui/SegmentedControl';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
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

function readTab(value: string | null): AutofillTab {
  return AUTOFILL_TABS.some((tab) => tab.value === value) ? (value as AutofillTab) : 'profile';
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
  const tab = readTab(searchParams.get('tab'));
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

  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-7 pb-20', PAGE_GUTTER)}>
      <PageHeader
        title="Autofill"
        description="What the extension fills into job applications."
      />
      <UnderlineTabs
        aria-label="Autofill sections"
        items={AUTOFILL_TABS}
        value={tab}
        onValueChange={(next) => replace({ tab: next, connect: null })}
        size="md"
        className="mt-6"
      >
        {/* Kept mounted, so switching tabs never loses unsaved changes. */}
        <TabPanel value="profile" className="mt-6" keepMounted>
          <ProfileTab />
        </TabPanel>
        <TabPanel value="answers" className="mt-6">
          <AnswersTab />
        </TabPanel>
        <TabPanel value="sign-in" className="mt-6">
          <SignInTab />
        </TabPanel>
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
      </UnderlineTabs>
    </div>
  );
}
