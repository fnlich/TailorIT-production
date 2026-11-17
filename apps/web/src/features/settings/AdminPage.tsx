'use client';

import { clsx } from 'clsx';
import { createElement } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Notice } from '@/components/ui/Notice';
import { PageSpinner } from '@/components/ui/Spinner';
import { TabPanel } from '@/components/ui/SegmentedControl';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { useAuth } from '@/lib/auth';
import { ADMIN_TABS, readAdminTab } from './admin/registry';

/**
 * Admin (/settings/admin?tab=sources|runs|import|reports|ai|ai-usage|users|constants|announcements): job sources and
 * their runs, job imports, reports on postings, AI health and usage, accounts and their plans, the constants, and the
 * announcements. Administrators only; the API refuses everyone else as well.
 */
export function AdminPage() {
  const { isAdmin, status } = useAuth();
  return (
    <div className={clsx('mx-auto w-full max-w-[1400px] pt-9 pb-20', PAGE_GUTTER)}>
      <h1 className="text-[30px] leading-10 font-bold tracking-[-0.01em] text-foreground">Admin</h1>
      <p className="mt-2 text-base text-muted-foreground">
        Job sources, imports, reports, AI, accounts, constants and announcements for this installation.
      </p>
      {status === 'loading' ? (
        <PageSpinner />
      ) : isAdmin ? (
        <AdminConsole />
      ) : (
        <Notice tone="warning" className="mt-8">
          That is an administrator-only part of this installation.
        </Notice>
      )}
    </div>
  );
}

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
      className="mt-8"
    >
      {ADMIN_TABS.map((entry) => (
        <TabPanel key={entry.value} value={entry.value} className="mt-8">
          {entry.render({ tab, sourceId, go })}
        </TabPanel>
      ))}
    </UnderlineTabs>
  );
}
