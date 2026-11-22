'use client';

import type { PublicConstantKey } from '@tailorit/shared/constants';
import { resetText } from '@tailorit/shared/constants';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Ui } from '../parts';
import { GaugeIcon } from '../icons';

// v34 HELP: Plans and limits. Every number is a public constant (an admin may change them in Admin › Constants, and
// the app frame shows the server's values); the daily AI budgets are never shown, only the share of the day used.

type Row = { label: string; free: PublicConstantKey; paid: PublicConstantKey; kind: 'count' | 'switch' };

const ROWS: readonly Row[] = [
  { label: 'Auto-applies by the extension, a day', free: 'FREE_AUTO_APPLY_PER_DAY', paid: 'PAID_AUTO_APPLY_PER_DAY', kind: 'count' },
  { label: 'Resumes of every kind', free: 'FREE_RESUME_LIMIT', paid: 'PAID_RESUME_LIMIT', kind: 'count' },
  { label: 'AI job search (Ask AI)', free: 'FREE_AI_JOB_SEARCH', paid: 'PAID_AI_JOB_SEARCH', kind: 'switch' },
  { label: 'Several resumes in one download, Build resumes (zip)', free: 'FREE_BATCH_DOWNLOAD', paid: 'PAID_BATCH_DOWNLOAD', kind: 'switch' },
  { label: 'Your own AI (MCP)', free: 'FREE_MCP', paid: 'PAID_MCP', kind: 'switch' },
];

function cell(value: unknown, kind: Row['kind']): string {
  if (kind === 'switch') return value === true ? 'Included' : 'Not included';
  if (value === null) return 'Unlimited';
  return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
}

function PlanTable() {
  const { get } = useGuide();
  return (
    <div className="overflow-x-auto rounded-control border border-border">
      <table className="w-full min-w-[20rem] border-collapse text-left text-sm leading-6" data-plans-table="">
        <caption className="sr-only">Free and Paid accounts</caption>
        <thead className="bg-surface-low text-xs font-semibold text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2">
              What
            </th>
            <th scope="col" className="px-3 py-2">
              Free
            </th>
            <th scope="col" className="px-3 py-2">
              Paid
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {ROWS.map((row) => (
            <tr key={row.label}>
              <th scope="row" className="px-3 py-2 font-medium text-foreground">
                {row.label}
              </th>
              <td className="num px-3 py-2 text-foreground">{cell(get(row.free), row.kind)}</td>
              <td className="num px-3 py-2 text-foreground">{cell(get(row.paid), row.kind)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Plans() {
  const { get, t } = useGuide();
  const reset = resetText(get('DAY_RESET_TIME'), get('DAY_RESET_ZONE_LABEL'));
  return (
    <>
      <P>
        TailorIT has two account types, <Ui>Free</Ui> and <Ui>Paid</Ui> (a term with an end date). The server applies every
        limit on every path: the pages, TailorIT&apos;s AI, the extension and your own AI.
      </P>
      <PlanTable />
      <Bullets>
        <li>
          <Ui>The day</Ui> starts again at {reset}: daily counts and today&apos;s AI use begin from zero.
        </li>
        <li>
          <Ui>AI use</Ui>: each AI task TailorIT runs for you is counted at what it cost, first against your daily share, then
          against your <Ui>extra credit</Ui>, which never expires. You see today&apos;s use as a percent, never an amount. Your
          own AI over MCP is never counted.
        </li>
        <li>
          <Ui>Hourly numbers</Ui>: a Free account starts a set number of tailorings and of Prepares by TailorIT&apos;s AI an
          hour (a Prepare waits for the next hour; it is not refused). Paid accounts have none unless an admin sets one.
        </li>
        <li>
          <Ui>Resumes</Ui>: at the Free limit, new resumes of every kind (upload, copy, tailor, Prepare in the{' '}
          {t('LABEL_RESUME_MODE_TAILOR')} mode) are refused, and so are edits to a resume, until you delete some. Renaming
          and deleting always work, and the resume settings that keep an existing resume still work.
        </li>
        <li>
          <Ui>Auto-applies</Ui> count when the extension takes a job and are given back when it does not send it; at the limit
          jobs stay queued for the next day. Marking a job applied, applying yourself, and Applied set in the Job Tracker
          never count.
        </li>
        <li>
          <Ui>Paid terms</Ui>: Settings › Account shows when yours ends, and the bell tells you once it ends within{' '}
          {get('PAID_ENDING_DAYS')} days; then the account is Free again.
        </li>
      </Bullets>
      <P>
        <Ui>Subscribe</Ui> and <Ui>Buy extra credit</Ui> show how to reach the admin
        {get('ADMIN_CONTACT_EMAIL') ? ` (${get('ADMIN_CONTACT_EMAIL')})` : ''}: TailorIT takes no payments itself. See{' '}
        <AppPage href="/settings#account">Settings › Account</AppPage> for your own numbers, and{' '}
        <See to="mcp-limits">Limits, privacy and tokens</See> for your AI.
      </P>
    </>
  );
}

export const PLANS_SECTION: GuideSection = {
  id: 'plans',
  title: 'Plans and limits',
  icon: GaugeIcon,
  keywords: ['plan', 'free', 'paid', 'limits', 'credit', 'usage', 'subscribe'],
  topics: [{ id: 'plans-limits', title: 'Free and Paid', keywords: ['ai use', 'extra credit', 'reset', 'auto-applies'], Body: Plans }],
};
