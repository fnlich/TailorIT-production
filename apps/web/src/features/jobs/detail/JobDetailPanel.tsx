'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { EMPLOYMENT_TYPE_LABEL, appliedChipLabel, formatMediumDate, liveChip, type JobDetail } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  ArrowSquareOutIcon,
  BookmarkSimpleIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  ClockIcon,
  EyeIcon,
  EyeSlashIcon,
  XIcon,
} from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import { Notice } from '@/components/ui/Notice';
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
import { jobLevelsOf } from '../format';
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

/** v31 FIX-JOBS: the drawer's place in the feed and its Previous / Next (null at either end, or for a job the feed lacks). */
export interface DrawerNav {
  /** "Job 3 of 133": the job's place in the loaded feed and the feed's count in words; null when it is not in the feed. */
  position: { index: number; total: string } | null;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}

export interface JobDetailPanelProps {
  jobId: number;
  nav: DrawerNav;
  /** Closes the drawer (×, the phone's back arrow, "Back to jobs" for a job that is gone). */
  onClose: () => void;
  /** Called after jobs left the list (this one, or its company's): the page closes the drawer, focus on the next row. */
  onJobsHidden: (hidden: { jobId?: number; companyId?: number }) => void;
  /** The row's quick Apply: open the posting (and "Applied to this job?") once the job is read. */
  applyIntent?: boolean;
  onApplyIntentHandled?: () => void;
}

/** The jumps of the section bar: Your match (with Tailor for this job), About the role, the company. */
const SECTIONS: ReadonlyArray<{ id: string; label: PublicMessageKey }> = [
  { id: 'job-match', label: 'LABEL_JOB_NAV_MATCH' },
  { id: 'job-role', label: 'LABEL_JOB_NAV_ROLE' },
  { id: 'job-company', label: 'LABEL_JOB_NAV_COMPANY' },
];

/** The drawer's padding at the sides (20 px, 28 px from 640 px). */
const GUTTER = 'px-5 sm:px-7';

/**
 * The drawer's top bar: on a phone the back arrow (the drawer is the whole window), then Previous / Next with the job's
 * place in the feed (said when it changes), the job's tools (hide, share, report: the job's body puts them in
 * `toolsRef`'s slot) and, from 640 px, Close. It stays mounted while Previous / Next change the job, so the button
 * pressed keeps focus.
 */
function DrawerBar({ nav, onClose, toolsRef }: { nav: DrawerNav; onClose: () => void; toolsRef: (element: HTMLDivElement | null) => void }) {
  const { t } = usePublicConstants();
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3 sm:px-5" data-drawer-bar="">
      <IconButton
        label="Back to the job list"
        icon={<ArrowLeftIcon size={18} weight="bold" />}
        onClick={onClose}
        tooltip={false}
        className="-ml-1 sm:hidden"
      />
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
      <span aria-hidden="true" className="mx-1.5 h-6 w-px bg-border max-sm:hidden" />
      <IconButton label="Close" icon={<XIcon size={18} />} onClick={onClose} tooltip={false} className="max-sm:hidden" data-drawer-close="" />
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

/**
 * v31 FIX-JOBS: the drawer's content (the region "Job details"): its bar, then the job, scrolling on its own between
 * the bar and the actions. The job reads top down in TailorIT's sections: the header (company, the title as the
 * drawer's h2, its tags), the notices (held, only you, hidden), the spec sheet of facts, a sticky bar of jumps (Match,
 * Role, Company: the one that is in view is marked), Your match, Tailor for this job, About the role and About
 * {company}. The actions sit in a bar under the top bar: Mark as applied (or the Applied date, a link to the
 * tracker), Save, Apply.
 */
export function JobDetailPanel({ jobId, nav, onClose, onJobsHidden, applyIntent = false, onApplyIntentHandled }: JobDetailPanelProps) {
  const { t } = usePublicConstants();
  const detail = useJobDetail(jobId);
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);

  let content: ReactNode;
  if (detail.isPending) {
    content = (
      <>
        <BaseDialog.Title className="sr-only">Job details</BaseDialog.Title>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DetailSkeleton />
        </div>
      </>
    );
  } else if (detail.isError) {
    const gone = isApiError(detail.error) && detail.error.code === 'not_found';
    content = (
      <>
        <BaseDialog.Title className="sr-only">{gone ? t('MSG_JOB_GONE') : 'This job could not be opened'}</BaseDialog.Title>
        <div className={clsx('min-h-0 flex-1 overflow-y-auto py-6', GUTTER)}>
          {gone ? (
            // Trying again cannot bring back a job that is gone.
            <Notice
              tone="info"
              title={t('MSG_JOB_GONE')}
              action={
                <Button variant="outline" size="sm" onClick={onClose}>
                  Back to jobs
                </Button>
              }
            >
              {t('MSG_JOB_GONE_DETAIL')}
            </Notice>
          ) : (
            <Notice
              tone="error"
              title="This job could not be opened"
              action={
                <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
                  Try again
                </Button>
              }
            >
              {userMessage(detail.error)}
            </Notice>
          )}
        </div>
      </>
    );
  } else {
    content = (
      <JobDetailBody
        key={detail.data.id}
        job={detail.data}
        toolsSlot={toolsSlot}
        onJobsHidden={onJobsHidden}
        applyIntent={applyIntent}
        onApplyIntentHandled={onApplyIntentHandled}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Job details"
      role="region"
      aria-busy={detail.isFetching || undefined}
      data-job-detail=""
    >
      <DrawerBar nav={nav} onClose={onClose} toolsRef={setToolsSlot} />
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

/** The section in view: the last one whose top has passed under the jump bar (the last one at the very bottom). */
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
      setActive(atBottom ? SECTIONS[SECTIONS.length - 1]!.id : current);
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [scrollRef, navRef]);
  return [active, setActive] as const;
}

function JobDetailBody({
  job,
  toolsSlot,
  onJobsHidden,
  applyIntent,
  onApplyIntentHandled,
}: {
  job: JobDetail;
  /** The drawer bar's slot for the job's tools. */
  toolsSlot: HTMLDivElement | null;
  onJobsHidden: JobDetailPanelProps['onJobsHidden'];
  applyIntent: boolean;
  onApplyIntentHandled?: () => void;
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

  // The drawer opened before the job was read (focus went to the drawer itself): the title takes it now. A job
  // reached with Previous / Next leaves focus on the button pressed.
  useEffect(() => {
    const title = titleRef.current;
    const active = document.activeElement;
    if (!title || (active && active !== document.body && active !== title.closest('[data-job-drawer]'))) return;
    title.focus({ preventScroll: true });
  }, []);

  const { saved, appliedOn, applicationId, hidden, companyHidden } = job.userState;
  const chip = liveChip({ active: job.active, postedAt: job.postedAt, updatedAt: job.updatedAt }, now, t);
  const levels = jobLevelsOf(job.experienceLevels, analysis);

  // Your match scores the resume linked to the job's application while the job is tracked (saved, or applied), else
  // the default resume. Saving, un-saving or applying, here or from the feed, can change which: read it again.
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
          toast.success('Marked as applied', 'We added it to your Job Tracker.');
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
      toast.success('Link copied', 'Anyone signed in to TailorIT can open this job with it.');
    } catch {
      toast.info('Copy this link', url);
    }
  };

  const hide = (kind: 'job' | 'company') => {
    const undo = () =>
      kind === 'job'
        ? hideJob.mutate({ jobId: job.id, hidden: false })
        : hideCompany.mutate({ companyId: job.company.id, hidden: false });
    const onSuccess = () => {
      toast.toast({
        type: 'info',
        title: kind === 'job' ? 'Job hidden' : `Jobs from ${job.company.name} hidden`,
        description: kind === 'job' ? "You won't see it in your search results." : "You won't see their jobs in your search results.",
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
        <div className={clsx('pt-6 pb-6', GUTTER)} data-detail-header="">
          <div className="flex items-center gap-3">
            <CompanyLogo name={job.company.name} url={job.company.logoUrl} size={40} />
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
              {job.company.tagline && <p className="truncate text-[13px] leading-5 text-muted-foreground">{job.company.tagline}</p>}
            </div>
          </div>

          <BaseDialog.Title
            ref={titleRef}
            tabIndex={-1}
            className="mt-4 font-display text-[22px] leading-7 font-semibold tracking-[-0.01em] text-foreground outline-none sm:text-2xl sm:leading-[30px]"
            data-drawer-title=""
          >
            {job.title}
          </BaseDialog.Title>

          <div className="mt-3 flex flex-wrap items-center gap-2">
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
          </div>
          {/* v30 S4: the credit line its source asks for ("Source: Himalayas"). */}
          <DetailCredit credit={job.credit} className="mt-3" />

          <div className="mt-5 flex flex-col gap-3 empty:hidden">
            {/* v30 X1-WEB: the held line (14 §4.3): a job the person added waits for an admin's approval. */}
            <HeldNotice held={job.held} />
            {/* v31 JOBSWEB: the person's own job TailorIT could not read: only they see it; Retry read. */}
            <VerificationNotice jobId={job.id} verification={job.verification} />
            {(hidden || companyHidden) && (
              <Notice
                tone="info"
                title={hidden ? 'You hid this job' : `You hid jobs from ${job.company.name}`}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<EyeIcon size={14} />}
                    onClick={() =>
                      hidden
                        ? hideJob.mutate({ jobId: job.id, hidden: false })
                        : hideCompany.mutate({ companyId: job.company.id, hidden: false })
                    }
                  >
                    {hidden ? 'Unhide this job' : `Show jobs from ${job.company.name}`}
                  </Button>
                }
              >
                It won&apos;t appear in your search results.
              </Notice>
            )}
          </div>

          <FactsGrid job={job} levels={levels} levelMatch={match?.levelMatch} requiredYears={analysis?.requiredYears} className="mt-5" />
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

        <div className={clsx('flex flex-col gap-10 pt-7 pb-12', GUTTER)}>
          <div id="job-match" className="flex flex-col gap-6">
            {/* A failed poll keeps what is shown; only a first load that fails shows the error. */}
            <MatchSection
              match={match}
              pending={insights.isPending}
              error={insights.data ? null : insights.error}
              onRetry={() => void insights.refetch()}
            />
            {showTailor && <TailorSection tailor={{ jobId: job.id, company: job.company.name, title: job.title }} />}
          </div>
          <div id="job-role">
            <AboutJob
              analysis={analysis}
              analysisPending={insights.isPending}
              analysisFailed={insights.isError && !insights.data}
              descriptionHtml={job.descriptionHtml}
            />
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
