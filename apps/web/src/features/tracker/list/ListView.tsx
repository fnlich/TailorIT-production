'use client';

import { clsx } from 'clsx';
import { useEffect, useRef, type CSSProperties } from 'react';
import { APPLICATION_STATUSES, STATUS_INFO, type ApplicationStatus, type ApplicationSummary } from '@tailorit/shared';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { CaretDownIcon, KanbanIcon, PlusIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { ClosedBadge, isClosed } from '@/features/jobs/closed/ClosedBadge'; // v30 FIX-WEB (UX-10)
import { VerificationBadge } from '@/features/jobs/verification/VerificationBadge'; // v31 JOBSWEB
import { RowCredit } from '@/features/jobs/credits/JobCredit'; // v30 FIX-WEB (REQ-1)
import { creditOf } from '@/features/jobs/credits/credit';
import { FavoriteButton, MarkerBadge, NextStepTag, SelectionBox, StageTime, type CardHandlers } from '../board/ApplicationCard';
import { CompanyLogo } from '../CompanyLogo';
import { ProfileBadge } from '../profiles/ProfileBadge';
import type { LoadMoreItem } from '../profiles/scope';
import { stageMeter, stageMeterText } from '../stage';
import { StatusIcon } from '../status';
import { StageMeter } from './StageMeter';

/** The stage button's look: an outline control naming the stage it is at, with a caret. */
const STAGE_TRIGGER =
  'inline-flex h-9 w-full min-w-0 items-center justify-between gap-1.5 rounded-control border border-border-strong bg-surface pr-2 pl-2.5 ' +
  'text-sm font-medium text-foreground shadow-control transition-[border-color,background-color] duration-150 hover:border-control-hover ' +
  'hover:bg-surface-low data-popup-open:border-primary data-popup-open:shadow-focus';

/**
 * A row's stage button (v31 FIX-DOCS: it shows the stage the application is at, "Applied ⌄", named "Stage: Applied";
 * v33 TRACKER, F1: a Saved entry in the queue shows Saved, its Draft mark is a badge on the row): every status, the
 * current one ticked.
 */
export function StatusMenuButton({
  application,
  onMove,
}: {
  application: ApplicationSummary;
  onMove: (application: ApplicationSummary, status: ApplicationStatus) => void;
}) {
  const { t } = usePublicConstants();
  const shown = application.currentStatus;
  const label = STATUS_INFO[shown].label;
  return (
    <Menu>
      <MenuTrigger
        aria-label={t('LABEL_TRACKER_STAGE_MENU', { stage: label })}
        className={STAGE_TRIGGER}
        onClick={(event) => event.stopPropagation()}
        data-shown-status={shown}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusIcon status={shown} size={15} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </span>
        <CaretDownIcon size={14} className="shrink-0 text-muted-foreground" />
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

/**
 * v33 SHARE-9: a row's stage where its profile is shared to see only: the stage's name, nothing to press (the button's
 * shape, so the column lines up).
 */
export function StageLabel({ application }: { application: ApplicationSummary }) {
  const label = STATUS_INFO[application.currentStatus].label;
  return (
    <span className="inline-flex h-9 w-full min-w-0 items-center gap-1.5 px-2.5 text-sm font-medium text-foreground" data-stage-label="">
      <StatusIcon status={application.currentStatus} size={15} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * The table's columns, one template for the header and every row: (the selection box,) the heart, Role, Progress
 * (from 1024 px), In stage (from 640 px) and Stage. On a phone the stage button goes under the title, which keeps the
 * row's width.
 */
function columnsStyle(selectMode: boolean): CSSProperties {
  const lead = selectMode ? '1.125rem 2rem' : '2rem';
  return {
    '--tracker-cols': `${lead} minmax(0,1fr)`,
    '--tracker-cols-sm': `${lead} minmax(0,1fr) 5.5rem 9.5rem`,
    '--tracker-cols-lg': `${lead} minmax(13rem,1.1fr) minmax(16rem,1.5fr) 5.5rem 9.5rem`,
  } as CSSProperties;
}

const ROW_GRID =
  'grid items-center gap-x-4 [grid-template-columns:var(--tracker-cols)] sm:[grid-template-columns:var(--tracker-cols-sm)] lg:[grid-template-columns:var(--tracker-cols-lg)]';

const HEAD = 'text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase';

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
  const { t } = usePublicConstants();
  const model = stageMeter(application.events);
  const shown = application.currentStatus;
  const shownLabel = STATUS_INFO[shown].label;
  const marker = handlers.markerOf?.(application) ?? null;
  // v33 SHARE-9: the All profiles view's badge, and nothing that changes a profile shared to see only.
  const profile = handlers.profileOf?.(application) ?? null;
  const editable = handlers.canEdit?.(application) ?? true;
  const activate = () => {
    if (!selectMode) handlers.onOpen(application);
    else if (!handlers.selectBlocked?.(application)) handlers.onToggleSelected(application, !checked);
  };
  return (
    <div
      role="row"
      data-application-row={application.id}
      onClick={activate}
      className={clsx(
        ROW_GRID,
        'min-h-16 cursor-pointer gap-y-2 border-b border-divider-soft py-3 pr-4 pl-3 transition-colors duration-150 last:border-b-0 sm:pl-4',
        selected || checked ? 'bg-primary-soft shadow-[inset_3px_0_0_var(--color-primary)]' : 'bg-surface hover:bg-surface-low',
      )}
    >
      {selectMode && (
        <span role="cell" className="flex self-start pt-2 sm:self-auto sm:pt-0" onClick={(event) => event.stopPropagation()}>
          <SelectionBox application={application} checked={checked} handlers={handlers} />
        </span>
      )}
      <span role="cell" className="flex self-start sm:self-auto" onClick={(event) => event.stopPropagation()}>
        <FavoriteButton application={application} onToggle={handlers.onToggleFavorite} size="sm" readOnly={!editable} />
      </span>
      <div role="cell" className="flex min-w-0 items-start gap-3">
        <CompanyLogo name={application.companyName} logoUrl={application.logoUrl} size={36} className="mt-0.5 max-sm:hidden" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              activate();
            }}
            className="min-w-0 rounded-tag text-left text-[15px] leading-5 font-semibold text-foreground hover:text-primary"
          >
            <span className="block break-words max-sm:line-clamp-2 sm:truncate">{application.title}</span>
          </button>
          <span className="truncate text-[13px] leading-5 text-muted-foreground">
            {[application.companyName, application.location].filter((part) => part && part.trim()).join(' · ')}
          </span>
          {/* v30 FIX-WEB (REQ-1): the credit its source asks for. */}
          <RowCredit credit={creditOf(application)} />
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {profile && <ProfileBadge profile={profile} />}
            {/* Below 1024 px the next step stands in for the stage meter. */}
            <span className="flex lg:hidden">
              <NextStepTag status={shown} />
            </span>
            {/* v33 TRACKER (F1): every marker, Draft included (the row's stage says Saved). */}
            {marker && <MarkerBadge marker={marker} />}
            {/* v31 JOBSWEB: "From your browser, not verified" (or "Waiting for approval") for the job only its adder sees. */}
            <VerificationBadge held={application.held} verification={application.verification} />
            <ClosedBadge closed={isClosed(application)} />
          </span>
        </div>
      </div>
      <div role="cell" className="min-w-0 max-lg:hidden">
        <StageMeter model={model} label={`Progress of ${application.title}`} valueText={stageMeterText(model, shownLabel, t)} />
      </div>
      <div role="cell" className="max-sm:hidden">
        <StageTime application={application} />
      </div>
      <span
        role="cell"
        className={clsx('flex min-w-0 max-sm:w-40 max-sm:row-start-2', selectMode ? 'max-sm:col-start-3' : 'max-sm:col-start-2')}
        onClick={(event) => event.stopPropagation()}
      >
        {editable ? <StatusMenuButton application={application} onMove={handlers.onMove} /> : <StageLabel application={application} />}
      </span>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div aria-hidden="true" className="flex items-center gap-4 border-b border-divider-soft py-4 pr-4 pl-4 last:border-b-0">
      <Skeleton className="size-8" rounded="control" />
      <Skeleton className="size-9 max-sm:hidden" rounded="control" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-40 max-w-full" />
      </div>
      <Skeleton className="hidden h-8 w-[360px] lg:block" />
      <Skeleton className="h-9 w-36" />
    </div>
  );
}

export type ListEmptyKind = 'first' | 'no-match' | 'archived';

/**
 * v31 FIX-DOCS (REV-UX UX-1): the Tracker's list as a table: a header row of Role | Progress | In stage | Stage in the
 * group-label style, then one row per application: the heart, the company's monogram, the title (a button that opens
 * it) over "company · location", the stage meter with each stage's name and date, the time in the stage, and the stage
 * button. A row opens its application on a click anywhere; in select mode it ticks instead. Below 1024 px the meter
 * gives way to the next step under the title, below 640 px the time in the stage too.
 */
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
  more,
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
  /** Add application (null: not offered here, v33 SHARE-9's All profiles view). */
  onAdd: (() => void) | null;
  /** v33 SHARE-9: one "Load more" per profile that has more (the All profiles view), in place of the one button. */
  more?: readonly LoadMoreItem[];
}) {
  const { t } = usePublicConstants();
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
      <div aria-label="Loading applications" aria-busy="true" className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface shadow-card">
        {empty === 'no-match' ? (
          <EmptyState title={t('MSG_TRACKER_NO_MATCH_TITLE')} description={t('MSG_TRACKER_NO_MATCH_TEXT')} />
        ) : empty === 'archived' ? (
          <EmptyState title="No archived applications" description="Applications you archive show up here." />
        ) : (
          <EmptyState
            variant="dashed"
            icon={<KanbanIcon size={24} />}
            title={t('MSG_TRACKER_EMPTY_TITLE')}
            description={t('MSG_TRACKER_EMPTY_TEXT')}
            action={
              onAdd ? (
                <Button icon={<PlusIcon size={16} />} onClick={onAdd} data-add-application="">
                  Add application
                </Button>
              ) : undefined
            }
            className="m-3"
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div
        role="table"
        aria-label="Applications"
        style={columnsStyle(selectMode)}
        className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
      >
        <div role="rowgroup">
          <div role="row" className={clsx(ROW_GRID, 'h-11 border-b border-border bg-surface-low pr-4 pl-3 sm:pl-4')}>
            {/* Visually empty heads keep their grid cells (an sr-only box would leave the grid). */}
            {selectMode && (
              <span role="columnheader">
                <span className="sr-only">Select</span>
              </span>
            )}
            <span role="columnheader">
              <span className="sr-only">Favorite</span>
            </span>
            <span role="columnheader" className={HEAD}>
              {t('LABEL_TRACKER_COL_ROLE')}
            </span>
            <span role="columnheader" className={clsx(HEAD, 'max-lg:hidden')}>
              {t('LABEL_TRACKER_COL_PROGRESS')}
            </span>
            <span role="columnheader" className={clsx(HEAD, 'max-sm:hidden')}>
              {t('LABEL_TRACKER_COL_TIME')}
            </span>
            {/* On a phone the stage button sits under the role, so its head is for screen readers only. */}
            <span role="columnheader" className={clsx(HEAD, 'max-sm:sr-only')}>
              {t('LABEL_TRACKER_COL_STAGE')}
            </span>
          </div>
        </div>
        <div role="rowgroup">
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
        </div>
      </div>
      {more ? (
        more.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 pt-5" data-list-more="">
            {more.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                onClick={item.onLoad}
                loading={item.loading}
                aria-label={item.ariaLabel}
                data-load-more-profile={item.id}
              >
                {item.label}
              </Button>
            ))}
          </div>
        )
      ) : (
        hasMore && (
          <div ref={sentinel} className="flex justify-center pt-5">
            <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loadingMore}>
              Load more applications
            </Button>
          </div>
        )
      )}
    </>
  );
}
