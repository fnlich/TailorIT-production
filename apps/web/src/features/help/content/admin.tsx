'use client';

import { ShieldCheckIcon } from '@/components/ui/icons';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, Ui } from '../parts';

// v34 HELP (PLAN G6): Admin, for administrators in the app only (never on the public page).

function AdminTabs() {
  return (
    <>
      <P>
        <AppPage href="/settings/admin">Admin</AppPage> (the account menu, administrators only) runs the server:
      </P>
      <Bullets>
        <li>
          <Ui>Sources</Ui>, <Ui>Hosts</Ui>, <Ui>Candidates</Ui> and <Ui>Runs</Ui>: where jobs come from, how each site is read,
          new sources found, and each reading run (pause, continue, read again).
        </li>
        <li>
          <Ui>Import links</Ui>: job links pasted, from a spreadsheet file or a shared sheet, read once.
        </li>
        <li>
          <Ui>Review</Ui>: jobs people added that TailorIT could not verify (approve one as it was added, retry the read, or
          reject it), reports about jobs, new jobs and closed links the extension found.
        </li>
        <li>
          <Ui>Companies</Ui>: company details and the companies that asked not to be read.
        </li>
        {/* v34 FIX-COPY (final review sec F2, as FIX-API builds it): the budget stops new AI calls; running ones finish.
            v34 INT-2: the budget's one sentence, as Admin › AI, the start line and docs/directory/CHECKLIST.md say it. */}
        <li>
          <Ui>AI</Ui>: the server AI&apos;s health, its status (with an API key, today&apos;s spend against the daily budget)
          and who pays for it (Billed to). With an API key, TailorIT stops starting AI calls when today&apos;s spend reaches
          the daily budget; calls already running finish. The day is a UTC day, and the Anthropic workspace&apos;s own spend
          limit is the hard guard. <Ui>AI usage</Ui>: the tokens and API price of each kind of AI task over the last day, week or month.
        </li>
        <li>
          <Ui>Users</Ui>: each account&apos;s type, Paid term (extend it or set an end date), its own daily AI budget, extra
          credit, and the history of every change. <Ui>Delete account</Ui> (the account&apos;s sheet, last section)
          deletes another account and everything in it when you type its address to confirm. An account shown as{' '}
          <Ui>Being deleted</Ui> finishes on its own within a day, or at once with Delete account. An administrator deletes
          their own account in Settings › Account, and only while another administrator can sign in.
        </li>
        <li>
          <Ui>Constants</Ui>: every limit, default and message of the app, changed at runtime; the guide&apos;s numbers follow
          them.
        </li>
        <li>
          <Ui>Announcements</Ui>: a slim bar on every signed-in page (information, warning or critical) with an optional end date.
        </li>
      </Bullets>
      <P>An admin is not exempt from the limits: make your own account Paid in Users if you need more.</P>
    </>
  );
}

export const ADMIN_SECTION: GuideSection = {
  id: 'admin',
  title: 'Admin',
  icon: ShieldCheckIcon,
  adminOnly: true,
  keywords: ['admin', 'sources', 'users', 'constants', 'review'],
  topics: [{ id: 'admin-tabs', title: "The admin's pages", Body: AdminTabs }],
};
