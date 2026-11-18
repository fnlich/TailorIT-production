'use client';

import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConstantSwitch, type ConstantItem } from './review/AutoApprove';
import { PUBLISHING_INTRO, PUBLISHING_KEYS, PUBLISHING_LANE, PUBLISHING_WORDS, publishingNow } from './publishing';

// v31 ADMINWEB: the top of Admin › Constants: how a job someone added becomes public (D1-D3), with its switches
// (ADD_JOB_PAGE_READ, v31 FIX-WEB's PAGE_JOBS_AUTO_PUBLISH of D12, NEW_JOBS_ADMIN_APPROVAL, EXT_NEW_PAGE_JOBS_REVIEW), each written at once like Review's
// auto-approve switches, with what it does now and a way to its Review lane. The rows stay in the Jobs group as well.

export function PublishingCard({ rows }: { rows: readonly ConstantItem[] }) {
  const shown = PUBLISHING_KEYS.flatMap((key) => {
    const row = rows.find((item) => item.key === key);
    return row ? [{ key, row }] : [];
  });
  if (shown.length === 0) return null;
  return (
    <Card as="section" padding="lg" aria-labelledby="constants-publishing" data-publishing="">
      <h3 id="constants-publishing" className="text-heading font-semibold text-foreground">
        How new jobs are published
      </h3>
      <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-muted-foreground">{PUBLISHING_INTRO}</p>
      <ul className="mt-4 divide-y divide-divider-soft">
        {shown.map(({ key, row }) => {
          const lane = PUBLISHING_LANE[key];
          return (
            <li key={key} className="flex flex-col gap-2 py-3.5 first:pt-0 last:pb-0 md:flex-row md:items-start md:justify-between md:gap-6" data-publishing-key={key}>
              <div className="min-w-0 flex-1">
                <ConstantSwitch row={row} rule={row.help} words={PUBLISHING_WORDS} />
                <p className="mt-1 pl-[46px] text-[13px] leading-5 font-medium text-foreground" data-publishing-now="">
                  {publishingNow(key, row.value === true)}
                </p>
                <p className="mt-0.5 pl-[46px] font-mono text-xs leading-4 break-all text-muted-foreground">{key}</p>
              </div>
              {lane && (
                <Link href={lane.href} className={buttonClasses({ variant: 'outline', size: 'sm', className: 'shrink-0 self-start max-md:ml-[46px]' })}>
                  {lane.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
