'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import { createElement } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Badge } from '@/components/ui/Badge';
import { HelpTip } from '@/components/ui/HelpTip';
import { WarningCircleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageSpinner } from '@/components/ui/Spinner';
import { TabPanel } from '@/components/ui/SegmentedControl';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { useAuth } from '@/lib/auth';
import { usePublicConstants } from '@/lib/constants';
import { LinkSimpleIcon } from '@phosphor-icons/react/LinkSimple';
import { buttonClasses } from '@/components/ui/Button';
import { ADMIN_TABS, readAdminTab } from './admin/registry';
import { ADD_LINKS_HREF } from './admin/sources/links'; // v35 FIX-WEB (decision 7)

/**
 * Admin (/settings/admin?tab=sources|runs|import|reports|ai|ai-usage|users|constants|announcements): job sources and
 * their runs, imports of job links, reports on postings, AI health and usage, accounts and their plans, the constants,
 * and the announcements. Administrators only; the API refuses everyone else as well. v31 ADMINWEB: the page header
 * (PageHeader) carries Add links (job links queued for TailorIT's own read) on every tab. v35 FIX-WEB (the coordinator's
 * decision 7): Add links opens Admin › Import on Many links, the one place to import (results, Reposted, To review,
 * Download these rows); the v3.1 dialog and its progress are gone.
 */
export function AdminPage() {
  const { isAdmin, status } = useAuth();
  return (
    <div className={clsx('mx-auto w-full max-w-[1400px] pt-7 pb-20', PAGE_GUTTER)}>
      <PageHeader
        title="Admin"
        description="Sources, links, reviews, AI, accounts and settings."
        actions={
          isAdmin ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <ContactEmailReminder />
              {/* Outline: each tab has its own main (primary) action below the page header. */}
              <Link href={ADD_LINKS_HREF} className={buttonClasses({ variant: 'outline' })} data-admin-add-links="">
                <LinkSimpleIcon size={16} aria-hidden="true" />
                Add links
              </Link>
            </div>
          ) : undefined
        }
      />
      {status === 'loading' ? (
        <PageSpinner />
      ) : isAdmin ? (
        <AdminConsole />
      ) : (
        <Notice tone="warning" className="mt-6">
          Admins only.
        </Notice>
      )}
    </div>
  );
}

/** The Constants entry a reminder points at. */
const CONTACT_CONSTANT_HREF = '/settings/admin?tab=constants';

/**
 * v32 FIX-UX (UXREQ-14): with no admin contact email set, Subscribe and Get extra credit lead nowhere, so the limit
 * alerts leave them out; the admin is reminded here, a small chip with its "?" and a link to Constants.
 */
function ContactEmailReminder() {
  const { values } = usePublicConstants();
  if (values.ADMIN_CONTACT_EMAIL?.trim()) return null;
  return (
    <span className="inline-flex items-center gap-1.5" data-contact-reminder="">
      <Badge tone="warning" icon={<WarningCircleIcon size={13} weight="fill" aria-hidden="true" />}>
        {CONTACT_REMINDER.title}
      </Badge>
      <HelpTip label={CONTACT_REMINDER.title}>{CONTACT_REMINDER.tip}</HelpTip>
      <Link href={CONTACT_CONSTANT_HREF} className="text-[13px] font-medium text-primary underline-offset-2 hover:underline">
        {CONTACT_REMINDER.link}
      </Link>
    </span>
  );
}

const CONTACT_REMINDER = {
  title: 'No contact email',
  tip: 'People cannot subscribe or buy credit until Admin contact email is set in Constants.',
  link: 'Set it',
} as const;

function AdminConsole() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = readAdminTab(searchParams.get('tab'));
  const sourceParam = Number(searchParams.get('source'));
  const sourceId = Number.isInteger(sourceParam) && sourceParam > 0 ? sourceParam : null;

  const go = (next: string, source: number | null = null) => {
    const params = new URLSearchParams();
    params.set('tab', next);
    if (source !== null) params.set('source', String(source));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // v30 ST0: one panel per entry of the admin tab registry (admin/registry.ts), in its order.
  return (
    <UnderlineTabs
      aria-label="Admin sections"
      // v30 FIX-WEB (REQ-8): a tab with a live count draws its own name ("Review (3)").
      items={ADMIN_TABS.map(({ value, label, countLabel }) => ({ value, label: countLabel ? createElement(countLabel, { label }) : label }))}
      value={tab}
      onValueChange={(next) => go(next)}
      size="md"
      wrap // v31 FIX-WEB (REV-UX UX-2): every section's tab in view at 1024-1440 px (rows, not a hidden scroll)
      className="mt-6"
    >
      {ADMIN_TABS.map((entry) => (
        <TabPanel key={entry.value} value={entry.value} className="mt-7">
          {entry.render({ tab, sourceId, go })}
        </TabPanel>
      ))}
    </UnderlineTabs>
  );
}
