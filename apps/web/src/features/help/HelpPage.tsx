'use client';

import { clsx } from 'clsx';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuth } from '@/lib/auth';
import { usePublicConstants } from '@/lib/constants';
import { Guide } from './Guide';

/**
 * v34 HELP (PLAN G6): the User Guide inside the app (/help: the account menu's Help, the phone's menu sheet), on every
 * profile. The numbers are the server's public constants; Admin shows to administrators.
 */
export function HelpPage() {
  const { values } = usePublicConstants();
  const { account } = useAuth();
  return (
    <div className={clsx('mx-auto w-full max-w-[1280px] pt-7 pb-20', PAGE_GUTTER)}>
      <PageHeader title="Help" description="How TailorIT works, page by page, and how to use it from your AI." />
      <Guide frame="app" values={values} isAdmin={account?.role === 'admin'} className="mt-6" />
    </div>
  );
}
