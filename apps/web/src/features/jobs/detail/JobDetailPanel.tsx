'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { appliedChipLabel, type JobDetail } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
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
  EyeSlashIcon,
  WarningCircleIcon,
} from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { isApiError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import { failure, useHideCompany, useHideJob, useJobDetail, useJobInsights, useMarkApplied, useSaveToggle } from '../hooks';
import { ArrowLeftIcon, ExportIcon, FlagIcon } from '../icons';
import { jobLevelsOf } from '../format';
import { jobShareUrl } from '../url';
import { AboutJob } from './AboutJob';
import { ApplyDialog } from './ApplyDialog';
import { CompanySection } from './company/CompanySection';
import { GlanceCard } from './GlanceCard'; // v33 JOBDETAIL
import { JobHeader, type DetailVariant } from './JobHeader'; // v33 JOBDETAIL
import { SkillsCard } from './SkillsCard'; // v33 JOBDETAIL
import { BenefitsCard, TailorCard } from './TailorCard'; // v33 JOBDETAIL
import { tabCan, useTabProfile, type TabProfile } from '../../sharing/access'; // v33 FIX-1
import { ReportDialog } from '../report/ReportDialog';
import { FANOUT_COPY } from '../../sharing/fanout/copy'; // v34 FANWEB
import { ProfilesDialog, SaveToMenu } from '../../sharing/fanout/parts'; // v34 FANWEB
import { useSavedOn } from '../../sharing/fanout/useFanout'; // v34 FANWEB
import { useSaveToProfiles } from '../../sharing/fanout/useSaveTo'; // v34 FANWEB

export type { DetailVariant } from './JobHeader';

/** v31 FIX-JOBS: the job's place in the list and its Previous / Next (null at either end, or for a job the list lacks). */
export interface DrawerNav {
  /** "Job 3 of 133": the job's place in the loaded list and the list's count in words; null when it is not in the list. */
  position: { index: number; total: string } | null;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}

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
 * The detail's padding at the sides (20 px, 24 px from 640 px). v33 JOBDETAIL: 24 px (was 28) so the two columns fit
 * a 1280 px window with a scrollbar (BODY_COLUMNS).
 */
const GUTTER = 'px-5 sm:px-6';

/**
 * v33 JOBDETAIL (F2): the body's two columns. They need 43 rem inside the gutters (the left at least 24 rem, the
 * right 18 to 20 rem, 1 rem between), measured on the body (a size container); narrower, one column, the right one's
 * cards first. The page's list narrows to leave the pane that room at 1280 px (JobsPage's grid).
 */
export const BODY_COLUMNS =
  '@[43rem]/job-detail:grid-cols-[minmax(24rem,1fr)_minmax(18rem,20rem)] @[43rem]/job-detail:grid-rows-[auto_1fr]';

/**
 * v33 FIX-1 (the owner's "see job details at once"): the header's place. In two columns it is the left column's first
 * row (the right column spans both rows, so it starts at the top of the scroll area, beside the title: Requirements at
 * a glance, Skills and Tailor my resume in the first screen at 1440 x 900); in one column it is the band above the
 * cards, edge to edge, as before.
 */
const HEADER_PLACE = clsx(
  '-mx-5 -mt-4 border-b border-border bg-surface px-5 pt-4 pb-4 sm:-mx-6 sm:px-6',
  '@[43rem]/job-detail:col-start-1 @[43rem]/job-detail:row-start-1 @[43rem]/job-detail:mx-0 @[43rem]/job-detail:mt-0',
  '@[43rem]/job-detail:border-b-0 @[43rem]/job-detail:bg-transparent @[43rem]/job-detail:px-0 @[43rem]/job-detail:pt-0 @[43rem]/job-detail:pb-1',
);

/**
 * v33 FIX-1 (PLAN-sharing §9: write controls hidden or off without the Change box): what a job's details offer on the
 * tab's profile. Mark as applied, Save and Hide need the Job Tracker's Change, Tailor my resume Documents' Change; a
 * report (the job's and its company's) is made from the person's own profile only. Everything on their own profile.
 */
export function jobControlsOf(tab: Pick<TabProfile, 'key' | 'profile'>): { acting: boolean; trackerEdit: boolean; documentsEdit: boolean } {
  return { acting: tab.key !== null, trackerEdit: tabCan(tab, 'tracker:edit'), documentsEdit: tabCan(tab, 'documents:edit') };
}

/** The words of the way back to the list (the sheet's back arrow, the pane's skip link). */
const BACK_TO_LIST = 'Back to the job list';

/**
 * The detail's top bar: the sheet's back arrow (the sheet is the whole window), Previous / Next with the job's place in
 * the list (said when it changes), the job's tools (hide, share, report: the job's body puts them in `toolsRef`'s
 * slot) and, v33 FIX-1, its actions (Mark as applied, Save, Apply: in `actionsRef`'s slot). From 46 rem (the region, a
 * size container) the actions sit in the bar's own row after the tools; narrower, they are a row of their own under it.
 * The pane has no arrow: a keyboard's first stop in it is a "Back to the job list" link, shown on focus. It stays
 * mounted while Previous / Next change the job, so the button pressed keeps focus.
 */
function DetailBar({
  variant,
  nav,
  onClose,
  toolsRef,
  actionsRef,
}: {
  variant: DetailVariant;
  nav: DrawerNav;
  onClose: () => void;
  toolsRef: (element: HTMLDivElement | null) => void;
  actionsRef: (element: HTMLDivElement | null) => void;
}) {
  const { t } = usePublicConstants();
  return (
    <div className="relative flex shrink-0 flex-wrap items-center border-b border-border" data-drawer-bar="">
      {/* 55 px rows and the bar's line: 56 px, as before. */}
      <div className="flex h-[55px] min-w-0 flex-1 items-center gap-1 pl-3 sm:pl-5">
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
      </div>
      <div ref={toolsRef} className="flex h-[55px] shrink-0 items-center gap-0.5 pr-3 sm:pr-5 @[46rem]/job-pane:pr-2" data-drawer-tools="" />
      <div
        ref={actionsRef}
        className={clsx(
          'basis-full border-t border-border bg-surface-low empty:hidden',
          '@[46rem]/job-pane:basis-auto @[46rem]/job-pane:border-t-0 @[46rem]/job-pane:bg-transparent',
        )}
        data-drawer-actions-slot=""
      />
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

/**
 * The job's detail (the region "Job details"): its bar, then the job, scrolling on its own under the bar and the
 * actions (Mark as applied, or the Applied date, a link to the tracker; Save; Apply). v33 JOBDETAIL (F2, the owner's
 * "see job details at once"): the header (company, title, the category and live line, the facts as pills, the job's
 * states), then two columns of cards on the canvas: About the job (Summary | Full posting) and the company on the
 * left; Requirements at a glance, Skills, Tailor for this job and Benefits on the right (first in reading order, so a
 * phone's one column shows them first; it stays in view while the left scrolls, when it fits the pane's height).
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
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null); // v33 FIX-1
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
        actionsSlot={actionsSlot}
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
      className="@container/job-pane flex min-h-0 flex-1 flex-col"
      aria-label="Job details"
      role="region"
      aria-busy={detail.isFetching || undefined}
      onKeyDown={onKeyDown}
      data-job-detail={variant}
    >
      <DetailBar variant={variant} nav={nav} onClose={onClose} toolsRef={setToolsSlot} actionsRef={setActionsSlot} />
      {content}
    </div>
  );
}

/**
 * v33 JOBDETAIL: whether the right column fits the pane's height (with 16 px above and below): it stays in view while
 * the left one scrolls only then (else it would hide its own end); measured again as either resizes.
 */
function useFitsHeight(sideRef: RefObject<HTMLElement | null>, scrollRef: RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const side = sideRef.current;
    const scroll = scrollRef.current;
    if (!side || !scroll) return;
    const measure = () => setFits(side.offsetHeight + 32 <= scroll.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(side);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [sideRef, scrollRef]);
  return fits;
}

function JobDetailBody({
  job,
  variant,
  toolsSlot,
  actionsSlot,
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
  /** v33 FIX-1: the bar's slot for the job's actions (in the bar's row on a wide detail, a row under it otherwise). */
  actionsSlot: HTMLDivElement | null;
  onJobsHidden: JobDetailPanelProps['onJobsHidden'];
  applyIntent: boolean;
  onApplyIntentHandled?: () => void;
  focusTitle: boolean;
  onTitleFocused?: () => void;
}) {
  const toast = useToast();
  const now = useNow();
  const { t } = usePublicConstants();
  // About the job, Skills and Requirements at a glance come from one answer, so they always change together.
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
  const sideRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sideFits = useFitsHeight(sideRef, scrollRef);
  // v33 FIX-1 (PLAN-sharing §9): on a profile shared with the person, the controls its owner did not share are not
  // offered (each was refused): Mark as applied, Save and Hide need the Job Tracker's Change, Tailor my resume Documents'
  // Change; a report is always made from the person's own profile (never while acting).
  const { acting, trackerEdit, documentsEdit } = jobControlsOf(useTabProfile());
  // v34 FANWEB (PLAN G2, G4): with a shared profile, Save is a split button: its arrow saves the job on other profiles
  // too (Save to…), and the header says which other profiles have it ("Saved on").
  const saveTo = useSaveToProfiles();
  const savedOn = useSavedOn(useMemo(() => [job.id], [job.id])).get(job.id);
  const [choosingProfiles, setChoosingProfiles] = useState(false);
  const saveOn = (targets: Parameters<typeof saveTo.save>[0]) =>
    saveTo.save(targets, [job.id]).then(
      () => undefined,
      (error: unknown) => failure(toast, 'The job could not be saved', error),
    );

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
  const levels = jobLevelsOf(job.experienceLevels, analysis);

  // Skills scores the resume linked to the job's application while the job is tracked (saved, or applied), else
  // the default resume. Saving, un-saving or applying, here or from the list, can change which: read it again.
  const trackedState = `${applicationId ?? ''}|${saved}|${appliedOn ?? ''}`;
  const scoredFor = useRef(trackedState);
  const refetchInsights = insights.refetch;
  useEffect(() => {
    if (scoredFor.current === trackedState) return;
    scoredFor.current = trackedState;
    void refetchInsights();
  }, [trackedState, refetchInsights]);

  const toggleSave = () => saveToggle.toggle({ jobId: job.id, saved, appliedOn, applicationId }, { confirmSave: true });

  const openPosting = useCallback(() => {
    if (job.applyUrl) window.open(job.applyUrl, '_blank', 'noopener,noreferrer');
    // v33 FIX-1: without the Job Tracker's Change "Applied to this job?" could only be refused: the posting opens.
    if (!trackerEdit) return;
    markApplied.reset();
    setApplyOpen(true);
  }, [job.applyUrl, markApplied, trackerEdit]);

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
          if (!fromDialog) failure(toast, 'The job could not be marked as applied', error);
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
    const onError = (error: unknown) => failure(toast, 'That could not be hidden', error);
    if (kind === 'job') hideJob.mutate({ jobId: job.id, hidden: true }, { onSuccess, onError });
    else hideCompany.mutate({ companyId: job.company.id, hidden: true }, { onSuccess, onError });
  };

  const trackerHref = applicationId ? `/tracker?app=${encodeURIComponent(applicationId)}` : '/tracker';
  const showTailor = documentsEdit && !insights.isPending && match !== undefined && match.state !== 'no_resume';

  const tools = (
    <>
      {trackerEdit && (
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
      )}
      <IconButton label="Share: copy a link to this job" tooltip="Copy link" icon={<ExportIcon size={18} weight="bold" />} onClick={() => void copyLink()} />
      {!acting && (
        <IconButton label="Report this job" tooltip="Report" icon={<FlagIcon size={18} weight="bold" />} onClick={() => setReportOpen(true)} />
      )}
    </>
  );

  // The actions: at the top (the toasts they raise stack at the window's bottom right, over a footer). v33 FIX-1: in the
  // bar's own row after the tools on a wide detail (a line between them), a row under the bar otherwise (DetailBar's
  // slot): the 57 px row no longer pushes the job down where room counts.
  const actions = (
    <div
      className={clsx(
        'flex shrink-0 items-center gap-2 py-2.5',
        GUTTER,
        '@[46rem]/job-pane:h-9 @[46rem]/job-pane:border-l @[46rem]/job-pane:border-border @[46rem]/job-pane:py-0 @[46rem]/job-pane:pr-5 @[46rem]/job-pane:pl-3',
      )}
      data-drawer-actions=""
    >
      {appliedOn ? (
        <Link
          href={trackerHref}
          className={buttonClasses({ variant: 'ghost', className: '-ml-3 text-success-ink max-sm:px-3 @[46rem]/job-pane:ml-0' })}
          data-applied-chip=""
        >
          <CheckCircleIcon size={16} weight="fill" aria-hidden="true" />
          {appliedChipLabel(appliedOn)}
        </Link>
      ) : job.active && trackerEdit ? (
        <Button
          variant="ghost"
          icon={<CheckCircleIcon size={16} />}
          onClick={() => recordApplied(false)}
          loading={markApplied.isPending && !applyOpen}
          className="-ml-3 max-sm:px-3 @[46rem]/job-pane:ml-0"
          data-mark-applied=""
        >
          {t('LABEL_JOB_MARK_APPLIED')}
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {/* v34 FANWEB: Save | ▾ Save to… once the person has a shared profile (one button otherwise, as before). */}
        <span className="inline-flex items-center" data-save-split={saveTo.available ? '' : undefined}>
          <Button
            variant="outline"
            aria-pressed={saved}
            icon={<BookmarkSimpleIcon size={16} weight={saved ? 'fill' : 'bold'} />}
            onClick={toggleSave}
            disabled={saveToggle.pending || !trackerEdit}
            className={saveTo.available ? 'rounded-r-none' : undefined}
            data-detail-save=""
          >
            {/* On a phone the split keeps the row on one line: Save's word is said, its bookmark drawn. */}
            <span className={saveTo.available ? 'max-sm:sr-only' : undefined}>{saved ? 'Saved' : 'Save'}</span>
          </Button>
          {saveTo.available && (
            <SaveToMenu
              triggerLabel={FANOUT_COPY.saveToLabel(job.title)}
              profiles={saveTo.profiles}
              label={saveTo.label}
              savedOn={savedOn?.choices}
              onPick={(targets) => void saveOn(targets)}
              onChoose={() => setChoosingProfiles(true)}
            />
          )}
        </span>
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
      {actionsSlot && createPortal(actions, actionsSlot)}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-canvas" data-drawer-scroll="">
        {/* v33 JOBDETAIL (F2): the body is a size container; its columns follow its own width (BODY_COLUMNS). */}
        <div className={clsx('@container/job-detail pt-4 pb-12', GUTTER)} data-detail-body="">
          <div className={clsx('grid grid-cols-1 items-start gap-4', BODY_COLUMNS)} data-detail-columns="">
            {/* v33 FIX-1: the header is the left column's top on a wide detail (the right column starts at the top of
                the scroll area), the band above the cards otherwise (HEADER_PLACE). */}
            <JobHeader
              job={job}
              variant={variant}
              titleRef={titleRef}
              now={now}
              onUnhide={unhide}
              savedOn={savedOn?.others}
              className={HEADER_PLACE}
            />
            <div
              ref={sideRef}
              className={clsx(
                'flex min-w-0 flex-col gap-4 @[43rem]/job-detail:col-start-2 @[43rem]/job-detail:gap-3 @[43rem]/job-detail:row-span-2 @[43rem]/job-detail:row-start-1',
                sideFits && '@[43rem]/job-detail:sticky @[43rem]/job-detail:top-4',
              )}
              data-detail-side=""
              data-sticky={sideFits ? 'true' : 'false'}
            >
              <GlanceCard
                glance={insights.data?.glance}
                pending={insights.isPending}
                levelMatch={match?.levelMatch}
                fallback={{ levels, requiredYears: analysis?.requiredYears, degree: job.degree }}
                sponsorsH1b={job.sponsorsH1b}
                requiresClearance={job.requiresClearance}
              />
              {/* A failed poll keeps what is shown; only a first load that fails shows the error. */}
              <SkillsCard match={match} pending={insights.isPending} error={insights.data ? null : insights.error} onRetry={() => void insights.refetch()} />
              {showTailor && <TailorCard tailor={{ jobId: job.id, company: job.company.name, title: job.title }} />}
              <BenefitsCard benefits={job.benefits} />
            </div>
            <div className="flex min-w-0 flex-col gap-4 @[43rem]/job-detail:col-start-1 @[43rem]/job-detail:row-start-2" data-detail-main="">
              <AboutJob
                analysis={analysis}
                analysisPending={insights.isPending}
                analysisFailed={insights.isError && !insights.data}
                descriptionHtml={job.descriptionHtml}
              />
              {/* v30 E0-WEB: the job's id, for the section's "Report company information" */}
              <CompanySection company={job.company} jobId={acting ? undefined : job.id} />
            </div>
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
      {saveTo.available && (
        <ProfilesDialog
          open={choosingProfiles}
          onOpenChange={setChoosingProfiles}
          title={FANOUT_COPY.saveToTitle}
          help={FANOUT_COPY.saveToHelp}
          profiles={saveTo.profiles}
          label={saveTo.label}
          savedOn={savedOn?.choices}
          confirmLabel={FANOUT_COPY.saveToConfirm}
          onConfirm={async (targets) => {
            await saveTo.save(targets, [job.id]);
          }}
        />
      )}
      {saveTo.element}
    </>
  );
}
