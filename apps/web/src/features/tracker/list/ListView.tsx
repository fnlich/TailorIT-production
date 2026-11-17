'use client';

import { clsx } from 'clsx';
import { useEffect, useRef } from 'react';
import { BuildingIcon } from '@phosphor-icons/react/Building';
import {
  APPLICATION_STATUSES,
  STATUS_INFO,
  displayStatusLabel,
  stepperModel,
  type ApplicationStatus,
  type ApplicationSummary,
} from '@tailorit/shared';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { CaretDownIcon, MapPinIcon, PlusIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { HeldBadge } from '@/features/jobs/detail/held/HeldNotice'; // v30 INT-3: decision 1
import { isHeld } from '@/features/jobs/detail/held/copy'; // v30 FIX-WEB (UX-2)
import { ClosedBadge, isClosed } from '@/features/jobs/closed/ClosedBadge'; // v30 FIX-WEB (UX-10)
import { RowCredit } from '@/features/jobs/credits/JobCredit'; // v30 FIX-WEB (REQ-1)
import { creditOf } from '@/features/jobs/credits/credit';
import { FavoriteButton, MarkerBadge, SelectionBox, type CardHandlers } from '../board/ApplicationCard';
import { CompanyLogo } from '../CompanyLogo';
import { shownStatusOf } from '../draft';
import { NO_MATCH_TEXT, NO_MATCH_TITLE } from '../state';
import { DisplayStatusIcon, StatusIcon } from '../status';
import { ProgressStepper } from './ProgressStepper';

/** Simplify's white "Status ⌄" select button at the end of a row. */
const STATUS_TRIGGER =
  'inline-flex h-9 w-24 shrink-0 items-center justify-between gap-1 rounded-control border border-control-outline bg-surface px-3 ' +
  'text-sm text-foreground shadow-control transition-[border-color,background-color] duration-150 hover:border-control-hover ' +
  'hover:bg-[#fafafa] data-popup-open:border-control-focus';

/** The list row's "Status ⌄": every status, the current one ticked. */
export function StatusMenuButton({
  application,
  onMove,
}: {
  application: ApplicationSummary;
  onMove: (application: ApplicationSummary, status: ApplicationStatus) => void;
}) {
  const { t } = usePublicConstants();
  return (
    <Menu>
      <MenuTrigger
        // v20 A30: a Saved entry in the queue reads Draft.
        aria-label={`Status: ${displayStatusLabel(shownStatusOf(application), t('STATUS_DRAFT_LABEL'))}`}
        className={STATUS_TRIGGER}
        onClick={(event) => event.stopPropagation()}
      >
        Status
        <CaretDownIcon size={14} className="text-muted-foreground" />
      </MenuTrigger>
      <MenuContent align="end" width="w-52">
        <MenuRadioGroup
          value={String(application.currentStatus)}
          onValueChange={(value) => {
            const status = Number(value) as ApplicationStatus;
            if (status !== application.currentStatus) onMove(application, status);
          }}
        >
          {APPLICATION_STATUSES.map((status) => (
            <MenuRadioItem key={status} value={String(status)} icon={<StatusIcon status={status} size={16} />} closeOnClick>
              {STATUS_INFO[status].label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function ListRow({
  application,
  handlers,
  selected,
  selectMode,
  checked,
}: {
  application: ApplicationSummary;
  handlers: CardHandlers;
  selected: boolean;
  selectMode: boolean;
  checked: boolean;
}) {
  const model = stepperModel(application.events);
  const { t } = usePublicConstants();
  const shown = shownStatusOf(application);
  const marker = handlers.markerOf?.(application) ?? null;
  const activate = () => {
    if (!selectMode) handlers.onOpen(application);
    else if (!handlers.selectBlocked?.(application)) handlers.onToggleSelected(application, !checked);
  };
  return (
    <li
      data-application-row={application.id}
      onClick={activate}
      className={clsx(
        // Phones: a grid with the title across the row and the status chip and "Status ⌄" under it; from sm, one row.
        'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-surface border bg-surface',
        'py-4 pr-4 pl-4 shadow-soft transition-colors duration-150 sm:flex sm:gap-4 sm:pl-5',
        selected || checked ? 'border-primary-ink bg-primary/5' : 'border-border hover:bg-[#fafafa]',
      )}
    >
      <span className="flex items-center gap-3 self-start max-sm:-mt-1 sm:gap-4 sm:self-auto">
        {selectMode && <SelectionBox application={application} checked={checked} handlers={handlers} />}
        <span onClick={(event) => event.stopPropagation()} className="flex">
          <FavoriteButton application={application} onToggle={handlers.onToggleFavorite} size="sm" />
        </span>
      </span>
      <CompanyLogo name={application.companyName} logoUrl={application.logoUrl} size={64} className="ml-2 max-sm:hidden" />
      <div className="col-span-2 flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            activate();
          }}
          className="min-w-0 text-left text-base leading-6 font-semibold text-foreground"
        >
          <span className="block break-words max-sm:line-clamp-2 sm:truncate">{application.title}</span>
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <BuildingIcon size={14} className="shrink-0" />
          <span className="truncate">{application.companyName}</span>
        </span>
        {application.location && (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <MapPinIcon size={14} className="shrink-0" />
            <span className="truncate">{application.location}</span>
          </span>
        )}
        {/* v30 FIX-WEB (REQ-1): the credit its source asks for. */}
        <RowCredit credit={creditOf(application)} />
      </div>
      <ProgressStepper
        label={`Progress of ${application.title}`}
        model={model}
        className={clsx('hidden shrink-0 lg:flex', model.steps.length > 5 ? 'w-[520px] xl:w-[740px]' : 'w-[460px] xl:w-[641px]')}
      />
      <span className="col-start-2 row-start-2 flex flex-wrap items-center gap-1.5 justify-self-start lg:hidden">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-xs font-medium" data-shown-status={shown}>
          <DisplayStatusIcon status={shown} size={14} />
          {displayStatusLabel(shown, t('STATUS_DRAFT_LABEL'))}
        </span>
        {marker && shown !== 'draft' && <MarkerBadge marker={marker} />}
        <HeldBadge held={application.held} className="lg:hidden" />
        <ClosedBadge closed={isClosed(application)} className="lg:hidden" />
      </span>
      {/* v2.0: the auto-apply marker beside the stepper on wide screens (Draft, Preparing, Filtered: …). */}
      {marker && (
        <span className="hidden shrink-0 lg:flex">
          <MarkerBadge marker={marker} />
        </span>
      )}
      {/* v30 INT-3: a job held for review (14 §4.3) says so beside the stepper. v30 FIX-WEB (REV-UX UX-2): in a wrapper that
          hides it below 1024 px, as the marker's is (the Badge's own inline-flex beat a `hidden` passed to it, so narrower
          rows showed the mark twice). */}
      {isHeld(application) && (
        <span className="hidden shrink-0 lg:flex" data-held-wide="">
          <HeldBadge held />
        </span>
      )}
      {/* v30 FIX-WEB (UX-10): a job that closed says so beside the stepper too. */}
      {isClosed(application) && (
        <span className="hidden shrink-0 lg:flex">
          <ClosedBadge closed />
        </span>
      )}
      <span onClick={(event) => event.stopPropagation()} className="col-start-3 row-start-2 flex">
        <StatusMenuButton application={application} onMove={handlers.onMove} />
      </span>
    </li>
  );
}

function RowSkeleton() {
  return (
    <li
      aria-hidden="true"
      className="flex items-center gap-4 rounded-surface border border-border bg-surface py-5 pr-4 pl-4 shadow-soft sm:gap-6 sm:pl-5"
    >
      <Skeleton className="size-8" rounded="full" />
      <Skeleton className="size-16 max-sm:hidden" rounded="control" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-40 max-w-full" />
        <Skeleton className="h-3.5 w-32 max-w-full" />
      </div>
      <Skeleton className="hidden h-6 w-[500px] lg:block" />
    </li>
  );
}

export type ListEmptyKind = 'first' | 'no-match' | 'archived';

export function ListView({
  items,
  loading,
  empty,
  handlers,
  openId,
  selectMode,
  selected,
  hasMore,
  loadingMore,
  failed,
  onLoadMore,
  onAdd,
}: {
  items: ApplicationSummary[] | null;
  loading: boolean;
  empty: ListEmptyKind;
  handlers: CardHandlers;
  openId: string | null;
  selectMode: boolean;
  selected: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  /** The last "Load more" failed: the button retries, scrolling does not. */
  failed: boolean;
  onLoadMore: () => void;
  onAdd: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loadingMore || failed) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
    }, { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, failed, onLoadMore]);

  if (loading || items === null) {
    return (
      <ul aria-label="Loading applications" className="flex flex-col gap-4">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </ul>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-surface border border-border bg-surface shadow-soft">
        {empty === 'no-match' ? (
          <EmptyState title={NO_MATCH_TITLE} description={NO_MATCH_TEXT} />
        ) : empty === 'archived' ? (
          <EmptyState title="No archived applications" description="Applications you archive show up here." />
        ) : (
          <EmptyState
            title="Add your first job application!"
            description="No more endless spreadsheets, keep track of everything in one place."
            action={
              <Button icon={<PlusIcon size={16} />} onClick={onAdd}>
                Add application
              </Button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <>
      <ul aria-label="Applications" className="flex flex-col gap-[18px]">
        {items.map((application) => (
          <ListRow
            key={application.id}
            application={application}
            handlers={handlers}
            selected={openId === application.id}
            selectMode={selectMode}
            checked={selected.has(application.id)}
          />
        ))}
      </ul>
      {hasMore && (
        <div ref={sentinel} className="flex justify-center pt-5">
          <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loadingMore}>
            Load more applications
          </Button>
        </div>
      )}
    </>
  );
}
