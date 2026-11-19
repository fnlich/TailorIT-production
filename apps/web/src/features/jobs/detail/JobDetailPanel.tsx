'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { EMPLOYMENT_TYPE_LABEL, appliedChipLabel, formatMediumDate, liveChip, type JobDetail } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import {
  ArrowSquareOutIcon,
  BookmarkSimpleIcon,
  BriefcaseIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  ClockIcon,
  EyeIcon,
  EyeSlashIcon,
  WarningCircleIcon,
} from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { isApiError, userMessage } from '@/lib/api';
import { companyHref } from '@/features/companies/routes'; // v30 WEB-JOBS
import { usePublicConstants, type PublicMessageKey } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import { CompanyLogo } from '../CompanyLogo';
import { useHideCompany, useHideJob, useJobDetail, useJobInsights, useMarkApplied, useSaveToggle } from '../hooks';
import { ArrowLeftIcon, ExportIcon, FlagIcon } from '../icons';
import { cardCompanyFacts, jobLevelsOf } from '../format';
import { jobShareUrl } from '../url';
import { AboutJob } from './AboutJob';
import { AddedFromChip } from './AddedFrom';
import { ApplyDialog } from './ApplyDialog';
import { CompanySection } from './company/CompanySection';
import { FactsGrid } from './FactsGrid';
import { MatchSection, TailorSection } from './MatchSection';
import { ReportDialog } from '../report/ReportDialog';
import { HeldNotice } from './held/HeldNotice'; // v30 X1-WEB
import { DetailCredit } from '../credits/JobCredit'; // v30 S4
import { VerificationNotice } from '../verification/VerificationNotice'; // v31 JOBSWEB

/** v31 FIX-JOBS: the job's place in the list and its Previous / Next (null at either end, or for a job the list lacks). */
export interface DrawerNav {
  /** "Job 3 of 133": the job's place in the loaded list and the list's count in words; null when it is not in the list. */
  position: { index: number; total: string } | null;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}

/**
 * v32 JOBS2 (E3): where the detail is drawn. `pane`: beside the list (from 1024 px), always there, its title an h2 of
 * the page. `sheet`: full screen over the list (below 1024 px), a modal dialog named by the job's title, with Back.
 */
export type DetailVariant = 'pane' | 'sheet';

export interface JobDetailPanelProps {
  jobId: number;
  variant: DetailVariant;
  nav: DrawerNav;
  /**
   * The sheet: closes it (the back arrow, "Back to jobs" for a job that is gone). The pane: back to the job's row in
   * the list (Escape inside the pane, the "Back to the job list" link a keyboard reaches first).
   */
  onClose: () => void;
  /** A job that no longer exists: "Back to jobs" (the sheet closes; the pane goes back to the list's first job). */
  onGone?: () => void;
  /** Called after jobs left the list (this one, or its company's): the page shows the next one. */
  onJobsHidden: (hidden: { jobId?: number; companyId?: number }) => void;
  /** The row's quick Apply: open the posting (and "Applied to this job?") once the job is read. */
  applyIntent?: boolean;
  onApplyIntentHandled?: () => void;
  /** The pane: the job's title takes focus once it is shown (a row opened with the keyboard, the next job after a hide). */
  focusTitle?: boolean;
  onTitleFocused?: () => void;
}

/**
 * The jumps of the section bar: Your match (the line under the job's facts), About the role (with Tailor for this job
 * after it), the company.
 */
const SECTIONS: ReadonlyArray<{ id: string; label: PublicMessageKey }> = [
  { id: 'job-match', label: 'LABEL_JOB_NAV_MATCH' },
  { id: 'job-role', label: 'LABEL_JOB_NAV_ROLE' },
  { id: 'job-company', label: 'LABEL_JOB_NAV_COMPANY' },
];

/** The detail's padding at the sides (20 px, 28 px from 640 px). */
const GUTTER = 'px-5 sm:px-7';

/** The words of the way back to the list (the sheet's back arrow, the pane's skip link). */
const BACK_TO_LIST = 'Back to the job list';

/**
 * The detail's top bar: the sheet's back arrow (the sheet is the whole window), Previous / Next with the job's place in
 * the list (said when it changes), and the job's tools (hide, share, report: the job's body puts them in `toolsRef`'s
 * slot). The pane has no arrow: a keyboard's first stop in it is a "Back to the job list" link, shown on focus. It stays
 * mounted while Previous / Next change the job, so the button pressed keeps focus.
 */
function DetailBar({
  variant,
  nav,
  onClose,
  toolsRef,
}: {
  variant: DetailVariant;
  nav: DrawerNav;
  onClose: () => void;
  toolsRef: (element: HTMLDivElement | null) => void;
}) {
  const { t } = usePublicConstants();
  return (
    <div className="relative flex h-14 shrink-0 items-center gap-1 border-b border-border px-3 sm:px-5" data-drawer-bar="">
      {variant === 'sheet' ? (
        <IconButton label={BACK_TO_LIST} icon={<ArrowLeftIcon size={18} weight="bold" />} onClick={onClose} tooltip={false} className="-ml-1" data-detail-back="" />
      ) : (
        <button
          type="button"
          onClick={onClose}
          className={clsx(
            'absolute top-2 left-3 z-10 inline-flex h-10 items-center gap-1.5 rounded-control bg-surface px-3 text-sm font-medium text-foreground shadow-popover',
            'not-focus-visible:sr-only',
          )}
          data-detail-back=""
        >
          <ArrowLeftIcon size={16} weight="bold" aria-hidden="true" />
          {BACK_TO_LIST}
        </button>
      )}
      {nav.position && (
        <div className="flex min-w-0 items-center gap-0.5" data-drawer-nav="">
          <IconButton
            label={t('LABEL_JOB_PREVIOUS')}
            icon={<CaretUpIcon size={18} weight="bold" />}
            onClick={() => nav.onPrevious?.()}
            disabled={!nav.onPrevious}
            focusableWhenDisabled
          />
          <IconButton
            label={t('LABEL_JOB_NEXT')}
            icon={<CaretDownIcon size={18} weight="bold" />}
            onClick={() => nav.onNext?.()}
            disabled={!nav.onNext}
            focusableWhenDisabled
          />
          <span className="ml-1.5 truncate text-[13px] leading-5 text-muted-foreground max-[400px]:sr-only" aria-live="polite" data-drawer-position="">
            {t('MSG_JOB_POSITION', { index: nav.position.index.toLocaleString('en-US'), total: nav.position.total })}
          </span>
        </div>
      )}
      <div ref={toolsRef} className="ml-auto flex shrink-0 items-center gap-0.5" data-drawer-tools="" />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-hidden="true" className={clsx('pt-6 pb-10', GUTTER)}>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10" rounded="control" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3.5 w-56" />
        </div>
      </div>
      <Skeleton className="mt-5 h-7 w-4/5" />
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-6 w-20" rounded="control" />
        <Skeleton className="h-6 w-48" rounded="control" />
      </div>
      <Skeleton className="mt-6 h-28 w-full" rounded="surface" />
      <SkeletonText lines={5} className="mt-8" />
    </div>
  );
}

/** The pane's look before any job is shown (the list is loading): the bar and the job's skeleton. */
export function DetailPaneSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-hidden="true" data-detail-skeleton="">
      <div className="h-14 shrink-0 border-b border-border" />
      <div className="min-h-0 flex-1 overflow-hidden">
        <DetailSkeleton />
      </div>
    </div>
  );
}

/** The job's title: the sheet's dialog title (its name), or an h2 of the page in the pane. Both take focus by script. */
function DetailTitle({
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

/**
 * The job's detail (the region "Job details"): its bar, then the job, scrolling on its own under the bar and the
 * actions. v32 FIX-UX (UXREQ-1, coordinator: the role in the first screen): the job reads top down as the header
 * (company with its industry and size, the title, its tags and states: held, only you, hidden), a compact card of
 * facts, Your match on one line (its keywords on demand), a sticky bar of jumps (Match, Role, Company: the one in view
 * is marked), About the role, Tailor for this job and About {company}. The actions sit under the bar: Mark as applied
 * (or the Applied date, a link to the tracker), Save, Apply.
 */
export function JobDetailPanel({
  jobId,
  variant,
  nav,
  onClose,
  onGone,
  onJobsHidden,
  applyIntent = false,
  onApplyIntentHandled,
  focusTitle = false,
  onTitleFocused,
}: JobDetailPanelProps) {
  const { t } = usePublicConstants();
  const detail = useJobDetail(jobId);
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);

  let content: ReactNode;
  if (detail.isPending) {
    content = (
      <>
        {variant === 'sheet' && <BaseDialog.Title className="sr-only">Job details</BaseDialog.Title>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DetailSkeleton />
        </div>
      </>
    );
  } else if (detail.isError) {
    const gone = isApiError(detail.error) && detail.error.code === 'not_found';
    const title = gone ? t('MSG_JOB_GONE') : 'This job could not be opened';
    content = (
      <>
        {variant === 'sheet' && <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>}
        <div className={clsx('min-h-0 flex-1 overflow-y-auto py-6', GUTTER)}>
          {/* v32 JOBS2 (E4): the pane's state, not a banner; trying again cannot bring back a job that is gone. */}
          <EmptyState
            icon={gone ? <BriefcaseIcon size={22} /> : <WarningCircleIcon size={22} />}
            title={title}
            description={gone ? t('MSG_JOB_GONE_DETAIL') : userMessage(detail.error)}
            action={
              gone ? (
                <Button variant="outline" size="sm" onClick={onGone ?? onClose}>
                  Back to jobs
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
                  Try again
                </Button>
              )
            }
          />
        </div>
      </>
    );
  } else {
    content = (
      <JobDetailBody
        key={detail.data.id}
        job={detail.data}
        variant={variant}
        toolsSlot={toolsSlot}
        onJobsHidden={onJobsHidden}
        applyIntent={applyIntent}
        onApplyIntentHandled={onApplyIntentHandled}
        focusTitle={focusTitle}
        onTitleFocused={onTitleFocused}
      />
    );
  }

  // The pane: Escape inside it (not in a menu or a dialog of its own, which are drawn elsewhere) goes back to the row;
  // on a control whose tooltip is open (a "?", a tool's name) it closes that tooltip only.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (variant !== 'pane' || event.key !== 'Escape' || event.defaultPrevented) return;
    if (!(event.target instanceof Element) || !regionRef.current?.contains(event.target)) return;
    if (event.target.closest('[data-popup-open]')) return;
    event.preventDefault();
    onClose();
  };

  return (
    <div
      ref={regionRef}
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Job details"
      role="region"
      aria-busy={detail.isFetching || undefined}
      onKeyDown={onKeyDown}
      data-job-detail={variant}
    >
      <DetailBar variant={variant} nav={nav} onClose={onClose} toolsRef={setToolsSlot} />
      {content}
    </div>
  );
}

/** One tag under the title (the kit's Badge): the job type in denim-soft, the live line neutral; a tooltip makes it focusable. */
function Tag({
  tone,
  icon,
  children,
  tooltip,
  dataAttrs,
}: {
  tone: 'tint' | 'neutral';
  icon?: ReactNode;
  children: ReactNode;
  tooltip?: string;
  dataAttrs?: Record<`data-${string}`, string>;
}) {
  const tag = (
    <Badge tone={tone} icon={icon} tabIndex={tooltip ? 0 : undefined} {...dataAttrs}>
      {children}
    </Badge>
  );
  return tooltip ? <Tooltip content={tooltip}>{tag}</Tooltip> : tag;
}

/**
 * The section in view: the last one whose top has passed under the jump bar (the first one at the very top, the last
 * one at the very bottom).
 */
function useSectionInView(scrollRef: RefObject<HTMLDivElement | null>, navRef: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(SECTIONS[0]!.id);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onScroll = () => {
      const line = (navRef.current?.getBoundingClientRect().bottom ?? container.getBoundingClientRect().top) + 24;
      const atBottom = container.scrollTop > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
      let current = SECTIONS[0]!.id;
      for (const section of SECTIONS) {
        const element = container.querySelector(`#${section.id}`);
        if (element && element.getBoundingClientRect().top <= line) current = section.id;
      }
      // v32 FIX-UX: at the top the job's header is in view (Your match sits in it), even with the role's start below it.
      const atTop = container.scrollTop < 8;
      setActive(atTop ? SECTIONS[0]!.id : atBottom ? SECTIONS[SECTIONS.length - 1]!.id : current);
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [scrollRef, navRef]);
  return [active, setActive] as const;
}

function JobDetailBody({
  job,
  variant,
  toolsSlot,
  onJobsHidden,
  applyIntent,
  onApplyIntentHandled,
  focusTitle,
  onTitleFocused,
}: {
  job: JobDetail;
  variant: DetailVariant;
  /** The bar's slot for the job's tools. */
  toolsSlot: HTMLDivElement | null;
  onJobsHidden: JobDetailPanelProps['onJobsHidden'];
  applyIntent: boolean;
  onApplyIntentHandled?: () => void;
  focusTitle: boolean;
  onTitleFocused?: () => void;
}) {
  const toast = useToast();
  const now = useNow();
  const { t } = usePublicConstants();
  // "About the role" and Your match come from one answer, so they always change together.
  const insights = useJobInsights(job.id);
  const analysis = insights.data?.analysis;
  const match = insights.data?.match ?? undefined;
  const saveToggle = useSaveToggle();
  const markApplied = useMarkApplied();
  const hideJob = useHideJob();
  const hideCompany = useHideCompany();
  // The row's quick Apply: "Applied to this job?" asks as the job opens (its posting opens in the effect below).
  const quickApply = applyIntent && job.active && Boolean(job.applyUrl) && !job.userState.appliedOn;
  const [applyOpen, setApplyOpen] = useState(quickApply);
  const [reportOpen, setReportOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [section, setSection] = useSectionInView(scrollRef, navRef);

  // The sheet opened before the job was read (focus went to the sheet itself): the title takes it now. The pane's title
  // takes it when the page asks (a row opened with the keyboard). A job reached with Previous / Next leaves focus on the
  // button pressed.
  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    if (variant === 'pane') {
      if (!focusTitle) return;
      title.focus({ preventScroll: true });
      onTitleFocused?.();
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && active !== title.closest('[data-job-drawer]')) return;
    title.focus({ preventScroll: true });
    // Only the first job shown asks: the effect runs once per job (the body is keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { saved, appliedOn, applicationId, hidden, companyHidden } = job.userState;
  const chip = liveChip({ active: job.active, postedAt: job.postedAt, updatedAt: job.updatedAt }, now, t);
  const companyFacts = cardCompanyFacts(job.company);
  const levels = jobLevelsOf(job.experienceLevels, analysis);

  // Your match scores the resume linked to the job's application while the job is tracked (saved, or applied), else
  // the default resume. Saving, un-saving or applying, here or from the list, can change which: read it again.
  const trackedState = `${applicationId ?? ''}|${saved}|${appliedOn ?? ''}`;
  const scoredFor = useRef(trackedState);
  const refetchInsights = insights.refetch;
  useEffect(() => {
    if (scoredFor.current === trackedState) return;
    scoredFor.current = trackedState;
    void refetchInsights();
  }, [trackedState, refetchInsights]);

  const jumpTo = useCallback(
    (id: string) => {
      const container = scrollRef.current;
      const target = container?.querySelector<HTMLElement>(`#${id}`);
      if (!container || !target) return;
      setSection(id);
      const navHeight = navRef.current?.offsetHeight ?? 0;
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - navHeight - 16;
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    },
    [setSection],
  );

  const toggleSave = () => saveToggle.toggle({ jobId: job.id, saved, appliedOn, applicationId }, { confirmSave: true });

  const openPosting = useCallback(() => {
    if (job.applyUrl) window.open(job.applyUrl, '_blank', 'noopener,noreferrer');
    markApplied.reset();
    setApplyOpen(true);
  }, [job.applyUrl, markApplied]);

  // The row's quick Apply: the posting opens as soon as the job is read (once, even when effects run twice); a job
  // that cannot be applied to from here puts focus on its Apply (or its closed mark's row) instead.
  const applyHandled = useRef(false);
  const postingUrl = job.applyUrl;
  useEffect(() => {
    if (!applyIntent || applyHandled.current) return;
    applyHandled.current = true;
    onApplyIntentHandled?.();
    if (quickApply && postingUrl) window.open(postingUrl, '_blank', 'noopener,noreferrer');
    else applyRef.current?.focus();
  }, [applyIntent, onApplyIntentHandled, quickApply, postingUrl]);

  const recordApplied = (fromDialog: boolean) => {
    markApplied.mutate(
      { jobId: job.id },
      {
        onSuccess: () => {
          if (fromDialog) setApplyOpen(false);
          toast.success('Marked as applied', 'Added to your Job Tracker.');
        },
        onError: (error) => {
          if (!fromDialog) toast.error('The job could not be marked as applied', userMessage(error));
        },
      },
    );
  };

  const copyLink = async () => {
    const url = jobShareUrl(window.location.origin, job.id);
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied', 'Anyone signed in to TailorIT can open it.');
    } catch {
      toast.info('Copy this link', url);
    }
  };

  const unhide = () =>
    hidden ? hideJob.mutate({ jobId: job.id, hidden: false }) : hideCompany.mutate({ companyId: job.company.id, hidden: false });

  const hide = (kind: 'job' | 'company') => {
    const undo = () =>
      kind === 'job'
        ? hideJob.mutate({ jobId: job.id, hidden: false })
        : hideCompany.mutate({ companyId: job.company.id, hidden: false });
    const onSuccess = () => {
      toast.toast({
        type: 'info',
        title: kind === 'job' ? 'Job hidden' : `Jobs from ${job.company.name} hidden`,
        description: "It won't show in your search.",
        action: { label: 'Undo', onClick: undo },
      });
      onJobsHidden(kind === 'job' ? { jobId: job.id } : { companyId: job.company.id });
    };
    const onError = (error: unknown) => toast.error('That could not be hidden', userMessage(error));
    if (kind === 'job') hideJob.mutate({ jobId: job.id, hidden: true }, { onSuccess, onError });
    else hideCompany.mutate({ companyId: job.company.id, hidden: true }, { onSuccess, onError });
  };

  const trackerHref = applicationId ? `/tracker?app=${encodeURIComponent(applicationId)}` : '/tracker';
  const showTailor = !insights.isPending && match !== undefined && match.state !== 'no_resume';

  const tools = (
    <>
      <Menu>
        <Tooltip content="Hide">
          <MenuTrigger
            aria-label="Hide options"
            className="inline-flex h-9 items-center gap-1 rounded-control px-2 text-muted-foreground hover:bg-hover hover:text-foreground data-popup-open:bg-hover data-popup-open:text-foreground"
          >
            <EyeSlashIcon size={18} weight="bold" />
            <CaretDownIcon size={12} weight="bold" />
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="end" width="w-64" aria-label="Hide options">
          <MenuItem icon={<EyeSlashIcon size={16} />} onClick={() => hide('job')} disabled={hidden}>
            Hide this job
          </MenuItem>
          <MenuItem icon={<EyeSlashIcon size={16} />} onClick={() => hide('company')} disabled={companyHidden}>
            Hide jobs from {job.company.name}
          </MenuItem>
        </MenuContent>
      </Menu>
      <IconButton label="Share: copy a link to this job" tooltip="Copy link" icon={<ExportIcon size={18} weight="bold" />} onClick={() => void copyLink()} />
      <IconButton label="Report this job" tooltip="Report" icon={<FlagIcon size={18} weight="bold" />} onClick={() => setReportOpen(true)} />
    </>
  );

  // The actions: at the top, under the bar (the toasts they raise stack at the window's bottom right, over a footer).
  const actions = (
    <div className={clsx('flex shrink-0 items-center gap-2 border-b border-border bg-surface-low py-2.5', GUTTER)} data-drawer-actions="">
      {appliedOn ? (
        <Link
          href={trackerHref}
          className={buttonClasses({ variant: 'ghost', className: '-ml-3 text-success-ink max-sm:px-3' })}
          data-applied-chip=""
        >
          <CheckCircleIcon size={16} weight="fill" aria-hidden="true" />
          {appliedChipLabel(appliedOn)}
        </Link>
      ) : job.active ? (
        <Button
          variant="ghost"
          icon={<CheckCircleIcon size={16} />}
          onClick={() => recordApplied(false)}
          loading={markApplied.isPending && !applyOpen}
          className="-ml-3 max-sm:px-3"
          data-mark-applied=""
        >
          {t('LABEL_JOB_MARK_APPLIED')}
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          aria-pressed={saved}
          icon={<BookmarkSimpleIcon size={16} weight={saved ? 'fill' : 'bold'} />}
          onClick={toggleSave}
          disabled={saveToggle.pending}
        >
          {saved ? 'Saved' : 'Save'}
        </Button>
        {job.active ? (
          <Button
            ref={applyRef}
            onClick={openPosting}
            className="sm:min-w-24"
            disabled={!job.applyUrl}
            trailingIcon={<ArrowSquareOutIcon size={15} aria-hidden="true" className="max-sm:hidden" />}
          >
            Apply
          </Button>
        ) : (
          <span className="inline-flex h-9 items-center rounded-control bg-surface-muted px-3 text-[13px] font-medium text-muted-foreground" data-inactive-mark="">
            {t('LABEL_JOB_CLOSED')}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <>
      {toolsSlot && createPortal(tools, toolsSlot)}
      {actions}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" data-drawer-scroll="">
        <div id="job-match" className={clsx('pt-4 pb-4', GUTTER)} data-detail-header="">
          <div className="flex items-center gap-3">
            <CompanyLogo name={job.company.name} url={job.company.logoUrl} size={36} />
            <div className="min-w-0">
              {/* v30 WEB-JOBS: the company's name opens its page (/companies/:id). */}
              <p className="truncate text-sm leading-5 font-semibold text-foreground">
                <Link
                  href={companyHref(job.company.id)}
                  className="rounded-tag hover:text-primary hover:underline hover:underline-offset-2"
                  data-company-page-link=""
                >
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

          <div className="mt-2.5 flex flex-wrap items-center gap-2" data-detail-tags="">
            {job.employmentType && (
              <Tag tone="tint" dataAttrs={{ 'data-job-type-tag': '' }}>
                {EMPLOYMENT_TYPE_LABEL[job.employmentType]}
              </Tag>
            )}
            <Tag
              tone="neutral"
              icon={<ClockIcon size={12} aria-hidden="true" />}
              tooltip={chip.kind === 'live' && job.postedAt ? `Posted on ${formatMediumDate(job.postedAt)}` : undefined}
              dataAttrs={{ 'data-live-chip': chip.kind }}
            >
              {chip.label}
            </Tag>
            {/* A job added from its page (a LinkedIn job, a careers page): Apply opens the employer's link it was saved with. */}
            <AddedFromChip addedFrom={job.addedFrom} />
            {/* v32 JOBS2 (E4): the job's states are chips with a "?" (no banners): held for an admin (v30 X1-WEB), only
                you (v31 JOBSWEB, with Retry read), hidden (with its way back). */}
            <HeldNotice held={job.held} />
            <VerificationNotice jobId={job.id} verification={job.verification} />
            {(hidden || companyHidden) && (
              <span className="inline-flex flex-wrap items-center gap-1.5" data-hidden-state="">
                <Badge tone="neutral" icon={<EyeSlashIcon size={12} weight="bold" aria-hidden="true" />}>
                  {hidden ? 'You hid this job' : `You hid ${job.company.name}`}
                </Badge>
                <Button variant="outline" size="sm" icon={<EyeIcon size={14} />} onClick={unhide} className="h-7 px-2.5">
                  {hidden ? 'Unhide' : 'Show its jobs'}
                </Button>
              </span>
            )}
          </div>
          {/* v30 S4: the credit line its source asks for ("Source: Himalayas"). */}
          <DetailCredit credit={job.credit} className="mt-3" />

          <FactsGrid job={job} levels={levels} levelMatch={match?.levelMatch} requiredYears={analysis?.requiredYears} className="mt-3" />
          {/* A failed poll keeps what is shown; only a first load that fails shows the error. */}
          <MatchSection
            match={match}
            pending={insights.isPending}
            error={insights.data ? null : insights.error}
            onRetry={() => void insights.refetch()}
            className="mt-3"
          />
        </div>

        <nav
          ref={navRef}
          aria-label="Job sections"
          className={clsx('sticky top-0 z-10 border-y border-border bg-surface/95 backdrop-blur-sm', GUTTER)}
          data-section-nav=""
        >
          <ul className="-mx-2.5 flex">
            {SECTIONS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={section === item.id ? 'true' : undefined}
                  onClick={() => jumpTo(item.id)}
                  className={clsx(
                    'relative inline-flex h-11 items-center px-2.5 text-sm font-medium transition-colors duration-150',
                    'after:absolute after:inset-x-2.5 after:bottom-0 after:h-[3px] after:rounded-t-full',
                    section === item.id ? 'text-foreground after:bg-tape' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(item.label)}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className={clsx('flex flex-col gap-10 pt-6 pb-12', GUTTER)}>
          <div id="job-role" className="flex flex-col gap-8">
            <AboutJob
              analysis={analysis}
              analysisPending={insights.isPending}
              analysisFailed={insights.isError && !insights.data}
              descriptionHtml={job.descriptionHtml}
            />
            {showTailor && <TailorSection tailor={{ jobId: job.id, company: job.company.name, title: job.title }} />}
          </div>
          <div id="job-company" className="border-t border-divider-soft pt-8">
            {/* v30 E0-WEB: the job's id, for the section's "Report company information" */}
            <CompanySection company={job.company} jobId={job.id} />
          </div>
        </div>
      </div>

      <ApplyDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        company={job.company.name}
        title={job.title}
        pending={markApplied.isPending}
        error={markApplied.error}
        onConfirm={() => recordApplied(true)}
      />
      <ReportDialog jobId={job.id} jobTitle={job.title} open={reportOpen} onOpenChange={setReportOpen} />
    </>
  );
}
