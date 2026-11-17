'use client';

import type { JobSort } from '@tailorit/shared';
import { clsx } from 'clsx';
import { memo, type MouseEvent } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { BookmarkSimpleIcon } from '@/components/ui/icons';
import { Tooltip } from '@/components/ui/Tooltip';
import type { JobListItem } from '../api';
import { CompanyLogo } from '../CompanyLogo';
import { CardCredit } from '../credits/JobCredit'; // v30 S4
import { cardCompanyFacts, cardLocationLine, cardMetaLine } from '../format'; // v30 WEB-JOBS: cardCompanyFacts
import { saveBlockReason } from './useSaveSelected';

export interface JobCardProps {
  job: JobListItem;
  href: string;
  selected: boolean;
  sort: JobSort;
  now: number;
  onSelect: (jobId: number) => void;
  onToggleSave: (job: JobListItem) => void;
  /** Choosing jobs to save (v2.0): the card shows its box. */
  selectable?: boolean;
  checked?: boolean;
  onToggleChecked?: (job: JobListItem, checked: boolean) => void;
}

/** A plain click opens the job here; modified clicks (new tab, new window) keep the browser's own behaviour. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * One job of the list (Simplify's card, ~135 px): 40 px logo, title (16 px, two lines at most), company and place
 * (14 px muted), salary and age (12 px muted), and an outline bookmark at the top right. The selected card is
 * #ccf6ff edge to edge. While jobs are chosen to save, a box sits before the logo; the card still opens the job.
 */
export const JobCard = memo(function JobCard({
  job,
  href,
  selected,
  sort,
  now,
  onSelect,
  onToggleSave,
  selectable = false,
  checked = false,
  onToggleChecked,
}: JobCardProps) {
  const place = cardLocationLine(job);
  const meta = cardMetaLine(job, sort, now);
  const companyFacts = cardCompanyFacts(job.company); // v30 WEB-JOBS: "Energy & Utilities · 1,001-5,000 employees"
  const saveLabel = job.saved ? `Remove ${job.title} from saved jobs` : `Save ${job.title}`;
  const blocked = selectable ? saveBlockReason(job) : null;
  return (
    <li
      data-job-card={job.id}
      className={clsx(
        'relative transition-colors duration-100',
        selected ? 'bg-primary-container' : 'bg-surface hover:bg-[#fafafa]',
      )}
    >
      {selectable &&
        (blocked === null ? (
          <span className="absolute top-[27px] left-4 flex">
            <Checkbox
              checked={checked}
              aria-label={`Select ${job.title} at ${job.company.name}`}
              onCheckedChange={(next) => onToggleChecked?.(job, next)}
            />
          </span>
        ) : (
          // Saved or applied to already: the box cannot be ticked, and says why.
          <Tooltip content={blocked}>
            <span className="absolute top-[27px] left-4 flex" data-not-selectable="">
              <Checkbox
                checked={false}
                disabled
                aria-label={`${job.title} at ${job.company.name}: ${blocked}`}
                onCheckedChange={() => undefined}
              />
            </span>
          </Tooltip>
        ))}
      <a
        href={href}
        aria-current={selected ? 'true' : undefined}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onSelect(job.id);
        }}
        className={clsx('flex gap-3 py-4 pr-14 outline-offset-[-2px]', selectable ? 'pl-12' : 'pl-4')}
      >
        <CompanyLogo name={job.company.name} url={job.company.logoUrl} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-base leading-5 font-semibold text-foreground">{job.title}</h3>
          <p className="truncate text-sm leading-[21px] text-muted-foreground" data-card-company="">{job.company.name}</p>
          {/* v30 WEB-JOBS: the company's industry and size under its name (features/companies/format.ts' words). */}
          {companyFacts && <p className="truncate text-xs leading-4 text-muted-foreground" data-card-company-facts="">{companyFacts}</p>}
          {place && <p className="truncate text-sm leading-[21px] text-muted-foreground">{place}</p>}
          {meta && <p className="mt-[5px] truncate text-xs leading-4 text-muted-foreground">{meta}</p>}
        </div>
      </a>
      {/* v30 S4: the credit line its source asks for ("Source: Himalayas"), under the link. */}
      <CardCredit credit={job.credit} inset={selectable ? 'box' : 'logo'} />
      <Tooltip content={job.saved ? 'Saved' : 'Save'}>
        <button
          type="button"
          aria-label={saveLabel}
          aria-pressed={job.saved}
          onClick={() => onToggleSave(job)}
          className={clsx(
            'absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-control',
            'transition-colors duration-150 hover:bg-black/[0.06]',
            job.saved ? 'text-primary-ink' : 'text-foreground',
          )}
        >
          <BookmarkSimpleIcon size={16} weight={job.saved ? 'fill' : 'bold'} />
        </button>
      </Tooltip>
    </li>
  );
});
