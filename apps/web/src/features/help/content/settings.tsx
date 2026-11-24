'use client';

import { GearSixIcon } from '@/components/ui/icons';
import { DELETE_COPY } from '../../account-deletion/copy';
import { ACCOUNT_COPY } from '../../settings/account';
import { GROUP_SETTINGS } from '../../notifications/copy';
import { useBoxName } from '../boxes';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, PublicLink, See, Ui } from '../parts';

// v34 HELP: Settings and Integrations: the account, profile and contact details, job preferences, notifications, and
// the Integrations page's two tabs.

function SettingsPage() {
  const boxName = useBoxName();
  // v35 OPSWEB (PLAN H8): the guide has no admin docs, so the admins' own notification group is not listed.
  const groups = Object.entries(GROUP_SETTINGS)
    .filter(([group]) => group !== 'admin')
    .map(([, group]) => group.title);
  return (
    <>
      <P>
        <AppPage href="/settings">Settings</AppPage> (the account menu) has these sections:
      </P>
      <Bullets>
        <li>
          <Ui>{ACCOUNT_COPY.title}</Ui>: your account type (and the date a Paid term ends), {ACCOUNT_COPY.autoApplies.toLowerCase()},{' '}
          {ACCOUNT_COPY.aiUse.toLowerCase()} as a percent, your resumes against your plan, whether AI job search is included,
          and your extra credit. <Ui>{ACCOUNT_COPY.subscribe}</Ui> and <Ui>{ACCOUNT_COPY.buyCredit}</Ui> show how to reach the
          admin (TailorIT takes no payments itself).{' '}
          <Ui>{DELETE_COPY.openSelf}</Ui>, last in the section, deletes your account and everything in it when you type
          your email address to confirm; the <PublicLink href="/privacy#choices">Privacy policy</PublicLink> says what
          goes and what stays.
        </li>
        <li>
          <Ui>Profile</Ui>: your display name and the email you sign in with. <Ui>Contact details</Ui>: phone, location,
          and the links to your professional profile and portfolio, which cover letters use when your resume lacks them.
        </li>
        <li>
          <Ui>Job preferences</Ui>: what you are looking for, and <Ui>Where you live</Ui> (country, state or province, city
          and time zone), which <Ui>Jobs I can apply to</Ui> and the location filter check jobs against.
        </li>
        <li>
          <Ui>Prepare</Ui>: the resume, cover letter and ask-first settings and your Prepare filters (see{' '}
          <See to="auto-settings">Prepare settings</See>).
        </li>
        <li>
          <Ui>Notification settings</Ui>: turn each group of notifications off or on: {groups.join(', ')}. Notifications stay
          in the app (the bell and the Notifications page).
        </li>
      </Bullets>
      <P>
        On a profile someone shared with you, Settings shows that person&apos;s preferences and filters, which you change only
        with their <Ui>{boxName('settings:edit')}</Ui> box (without it the form says so); your own account and
        notifications are not there.
      </P>
    </>
  );
}

function Integrations() {
  return (
    <>
      <P>
        <AppPage href="/settings/integrations">Integrations</AppPage> (the account menu) connects TailorIT to your AI. It is
        only ever your own: it is not shown while you work on someone else&apos;s profile.
      </P>
      <Bullets>
        <li>
          <Ui>AI assistants</Ui>: TailorIT&apos;s MCP address (with Copy), the apps you connected (with Disconnect), Claude
          and ChatGPT with <Ui>Connect</Ui> (see <See to="mcp-connect-claude">Connect Claude</See>), <Ui>How your AI works with
          TailorIT</Ui> (revision rounds and custom instructions), <Ui>Requests your AI could not do</Ui>, and{' '}
          <Ui>Advanced: personal access tokens</Ui>.
        </li>
        <li>
          <Ui>Connections</Ui>: the email and calendar apps TailorIT will connect to in a later version; their Connect says
          they are not available yet.
        </li>
      </Bullets>
    </>
  );
}

export const SETTINGS_SECTION: GuideSection = {
  id: 'settings',
  title: 'Settings',
  icon: GearSixIcon,
  keywords: ['settings', 'account', 'preferences', 'integrations', 'notifications'],
  topics: [
    { id: 'settings-page', title: 'Settings', keywords: ['account', 'profile', 'contact', 'where you live', 'notifications', 'delete account'], Body: SettingsPage },
    { id: 'settings-integrations', title: 'Integrations', keywords: ['mcp', 'tokens', 'connections'], Body: Integrations },
  ],
};
