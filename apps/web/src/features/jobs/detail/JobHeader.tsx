'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { EMPLOYMENT_TYPE_LABEL, WORK_ARRANGEMENT_LABEL, categoryFact, repostedText, salaryLabel, type JobDetail } from '@tailorit/shared';
import Link from 'next/link';
import type { ReactNode, RefObject } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { BriefcaseIcon, EyeIcon, EyeSlashIcon, MapPinIcon } from '@/components/ui/icons';
import { Tooltip } from '@/components/ui/Tooltip';
import { companyHref } from '@/features/companies/routes';
import { usePublicConstants } from '@/lib/constants';
import { CompanyLogo } from '../CompanyLogo';
import { DetailCredit } from '../credits/JobCredit';
import { cardCompanyFacts, placesOf } from '../format';
import { BuildingIcon, HouseLineIcon, LaptopIcon, MoneyIcon } from '../icons';
import { VerificationNotice } from '../verification/VerificationNotice';
import { AddedFromChip } from './AddedFrom';
import { checkedLiveWhen, postedText } from './glance';
import { HeldNotice } from './held/HeldNotice';
import { SavedOnChips } from '../../sharing/fanout/parts'; // v34 FANWEB

/**
 * v32 JOBS2 (E3): where the detail is drawn. `pane`: beside the list (from 1024 px), always there, its title an h2 of
 * the page. `sheet`: full screen over the list (below 1024 px), a modal dialog named by the job's title, with Back.
 */
export type DetailVariant = 'pane' | 'sheet';

/** The job's title: the sheet's dialog title (its name), or an h2 of the page in the pane. Both take focus by script. */
export function DetailTitle({
  variant,
  titleRef,
  className,
  children,
}: {
  variant: DetailVariant;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  className?: string;
  children: ReactNode;
}) {
  if (variant === 'sheet') {
    return (
      <BaseDialog.Title ref={titleRef} tabIndex={-1} className={className} data-drawer-title="">
        {children}
      </BaseDialog.Title>
    );
  }
  return (
    <h2 ref={titleRef} tabIndex={-1} className={className} data-drawer-title="">
      {children}
    </h2>
  );
}

const ARRANGEMENT_ICON = {
  onsite: <BuildingIcon size={14} />,
  hybrid: <LaptopIcon size={14} />,
  remote: <HouseLineIcon size={14} />,
} as const;

/**
 * v33 JOBDETAIL (F2): one of the header's facts, a pill: its icon and its value, its name said to screen readers
 * first ("Salary: No salary listed").
 */
function FactPill({ icon, name, fact, children }: { icon: ReactNode; name: string; fact: string; children: ReactNode }) {
  return (
    <li
      className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface-low px-3 text-[13px] leading-5 font-medium text-foreground"
      data-fact={fact}
    >
      <span className="flex shrink-0 text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <span className="sr-only">{name}: </span>
      {children}
    </li>
  );
}

/**
 * v33 JOBDETAIL (F2): the job's header. The company (its name opens its page; its industry and size, else its line),
 * the title, then one line: the category · "Checked live today" (when TailorIT last found the posting live; hidden when
 * unknown or closed) · "Posted 3 days ago" · v35 OPSWEB "Reposted today". Then the facts as pills (type, where, pay or "No salary listed", work mode)
 * and the job's states (added from, held, only you, hidden with its way back) and its credit line.
 */
export function JobHeader({
  job,
  variant,
  titleRef,
  now,
  onUnhide,
  savedOn = [],
  className,
}: {
  job: JobDetail;
  variant: DetailVariant;
  titleRef: RefObject<HTMLHeadingElement | null>;
  now: number;
  onUnhide: () => void;
  /** v34 FANWEB: the other profiles that have the job in their Job Tracker ("Saved on Ana · Ben"). */
  savedOn?: readonly string[];
  className?: string;
}) {
  const { t } = usePublicConstants();
  const { hidden, companyHidden } = job.userState;
  const companyFacts = cardCompanyFacts(job.company);
  const category = categoryFact(job.categoryId, job.subcategoryIds);
  const checked = job.active ? checkedLiveWhen(job.lastVerifiedAt, now) : null;
  const posted = postedText(job.postedAt, now);
  const reposted = repostedText(job, now); // v35 OPSWEB (PLAN H5): "Reposted today" beside "Posted 3 weeks ago"
  const { first, others } = placesOf(job.primaryLocation, job.locations);

  const meta: Array<{ key: string; node: ReactNode }> = [];
  if (category) {
    meta.push({
      key: 'category',
      node: (
        <span data-detail-category="" title={category.detail || undefined}>
          {category.label}
        </span>
      ),
    });
  }
  if (checked) meta.push({ key: 'checked', node: <span data-checked-live="">{t('LABEL_JOB_CHECKED_LIVE', { when: checked })}</span> });
  if (posted) meta.push({ key: 'posted', node: <span data-posted="">{posted}</span> });
  if (reposted) meta.push({ key: 'reposted', node: <span data-reposted="">{reposted}</span> });

  const states = Boolean(job.addedFrom || job.held || job.verification || hidden || companyHidden || savedOn.length > 0);

  return (
    // v33 FIX-1: its place and look (a band above the cards, or the left column's top) are the panel's (HEADER_PLACE).
    <div className={className} data-detail-header="">
      <div className="flex items-center gap-3">
        <CompanyLogo name={job.company.name} url={job.company.logoUrl} size={40} />
        <div className="min-w-0">
          {/* v30 WEB-JOBS: the company's name opens its page (/companies/:id). */}
          <p className="truncate text-sm leading-5 font-semibold text-foreground">
            <Link href={companyHref(job.company.id)} className="rounded-tag hover:text-primary hover:underline hover:underline-offset-2" data-company-page-link="">
              {job.company.name}
            </Link>
          </p>
          {/* v32 FIX-UX: the company's industry and size (the list's rows leave them to the pane), else its line. */}
          {companyFacts ? (
            <p className="truncate text-[13px] leading-5 text-muted-foreground" data-card-company-facts="">
              {companyFacts}
            </p>
          ) : (
            job.company.tagline && <p className="truncate text-[13px] leading-5 text-muted-foreground">{job.company.tagline}</p>
          )}
        </div>
      </div>

      <DetailTitle
        variant={variant}
        titleRef={titleRef}
        className="mt-3 font-display text-[22px] leading-7 font-semibold tracking-[-0.01em] text-foreground outline-none sm:text-2xl sm:leading-[30px]"
      >
        {job.title}
      </DetailTitle>

      {meta.length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] leading-5 text-muted-foreground" data-detail-meta="">
          {/* The dot goes with the part after it, so a wrapped line never ends on one. */}
          {meta.map((item, index) => (
            <span key={item.key} className="inline-flex items-center gap-1.5">
              {index > 0 && <span aria-hidden="true">·</span>}
              {item.node}
            </span>
          ))}
        </p>
      )}

      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Job facts" data-detail-chips="">
        {job.employmentType && (
          <FactPill icon={<BriefcaseIcon size={14} />} name="Job type" fact="type">
            {EMPLOYMENT_TYPE_LABEL[job.employmentType]}
          </FactPill>
        )}
        {first && (
          <FactPill icon={<MapPinIcon size={14} />} name="Location" fact="location">
            <span className="truncate">{first}</span>
            {others.length > 0 && (
              <Tooltip content={`More locations: ${others.join(' | ')}`}>
                <span tabIndex={0} className="shrink-0 rounded-tag font-normal text-muted-foreground underline-offset-2 hover:underline">
                  +{others.length}
                </span>
              </Tooltip>
            )}
          </FactPill>
        )}
        <FactPill icon={<MoneyIcon size={14} />} name="Salary" fact="salary">
          <span className="truncate">{salaryLabel(job.salary)}</span>
        </FactPill>
        {job.workArrangement && (
          <FactPill icon={ARRANGEMENT_ICON[job.workArrangement]} name="Work arrangement" fact="arrangement">
            {WORK_ARRANGEMENT_LABEL[job.workArrangement]}
          </FactPill>
        )}
      </ul>

      {states && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-detail-tags="">
          {/* A job added from its page (a LinkedIn job, a careers page): Apply opens the employer's link it was saved with. */}
          <AddedFromChip addedFrom={job.addedFrom} />
          {/* v34 FANWEB: the other profiles that have this job saved. */}
          <SavedOnChips names={savedOn} />
          {/* v32 JOBS2 (E4): the job's states are chips with a "?" (no banners): held for an admin (v30 X1-WEB), only
              you (v31 JOBSWEB, with Retry read), hidden (with its way back). */}
          <HeldNotice held={job.held} />
          <VerificationNotice jobId={job.id} verification={job.verification} />
          {(hidden || companyHidden) && (
            <span className="inline-flex flex-wrap items-center gap-1.5" data-hidden-state="">
              <Badge tone="neutral" icon={<EyeSlashIcon size={12} weight="bold" aria-hidden="true" />}>
                {hidden ? 'You hid this job' : `You hid ${job.company.name}`}
              </Badge>
              <Button variant="outline" size="sm" icon={<EyeIcon size={14} />} onClick={onUnhide} className="h-7 px-2.5">
                {hidden ? 'Unhide' : 'Show its jobs'}
              </Button>
            </span>
          )}
        </div>
      )}
      {/* v30 S4: the credit line its source asks for ("Source: Himalayas"). */}
      <DetailCredit credit={job.credit} className="mt-3" />
    </div>
  );
}
