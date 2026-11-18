'use client';

import type { AdminFlag, AdminReviewRow, ReviewDecision } from '@tailorit/shared/reviews';
import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ArrowCounterClockwiseIcon, CheckIcon, XIcon } from '@/components/ui/icons';
import { relativeTime } from '@/lib/format';
import { ROW_ACTION, StateLine, useRowFocus } from '../../../../components/queue';
import { evidenceLine, flagStateLine, originLine, reviewStateLine, rowName } from './copy';
import { ReportersDisclosure } from './Reporters';

// v30 X1-WEB: Admin › Review's rows (14 §6.2), drawn like the Auto-apply page's Queue rows (components/queue's state
// line and row focus): the job and its company, a new job's origin, how many people and the strongest signal, TailorIT's
// check, the newest report's age, and Approve and Reject (labelled, with their icons). In select mode a checkbox leads
// each row that can still be decided.

/** A row's accent bar: needs a decision (denim), TailorIT says live (warning), otherwise quiet. */
export function AccentBar({ tone }: { tone: 'decide' | 'warning' | 'quiet' }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('absolute inset-y-0 left-0 w-[3px]', tone === 'decide' ? 'bg-primary' : tone === 'warning' ? 'bg-warning/60' : 'bg-border')}
    />
  );
}

/**
 * The job's title: a link to its page, or plain text for a held job (nobody but its adders may open it yet). v30 FIX-WEB
 * (REV-UX UX-16): it wraps rather than being cut to one line, so two titles that share a long start still read apart
 * on a phone, where no hover shows the rest.
 */
function JobTitle({ job }: { job: { id: number; title: string; held: boolean } }) {
  const classes = 'text-sm leading-5 font-semibold text-foreground';
  return (
    <p className="break-words" title={job.title} data-review-title="">
      {job.held ? (
        <span className={classes}>{job.title}</span>
      ) : (
        <Link href={`/jobs?jobId=${job.id}`} className={clsx(classes, 'hover:underline')}>
          {job.title}
        </Link>
      )}
    </p>
  );
}

/** The select mode's checkbox: one for a row that can be decided, a disabled one (named why) for a decided row. */
function RowCheckbox({ selectMode, decidable, checked, onChecked, name }: {
  selectMode: boolean;
  decidable: boolean;
  checked: boolean;
  onChecked: (on: boolean) => void;
  name: string;
}) {
  if (!selectMode) return null;
  return (
    <span className="mt-0.5 flex shrink-0 max-sm:min-h-11 max-sm:items-start">
      {decidable ? (
        <Checkbox checked={checked} onCheckedChange={(on) => onChecked(on)} aria-label={`Select ${name}`} />
      ) : (
        <Checkbox checked={false} disabled onCheckedChange={() => undefined} aria-label={`${name}: decided already`} />
      )}
    </span>
  );
}

/** What a bulk action did to this row ("Skipped: decided already"), until the next read. */
function OutcomeLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-1 text-[13px] leading-5 font-medium text-warning" data-row-outcome="">
      {text}
    </p>
  );
}

/** The row's buttons, beside the text when the pane is wide enough, under it otherwise. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5" data-review-actions="">
      {children}
    </div>
  );
}

/** A row button's 44 px touch target on a phone. */
export const TOUCH = 'max-sm:h-11';

export interface ReviewRowViewProps {
  row: AdminReviewRow;
  now: number;
  selectMode: boolean;
  checked: boolean;
  onChecked: (on: boolean) => void;
  busy: boolean;
  outcome: string | null;
  onDecide: (decision: ReviewDecision) => void;
  onOpen: () => void;
}

export function ReviewRowView({ row, now, selectMode, checked, onChecked, busy, outcome, onDecide, onOpen }: ReviewRowViewProps) {
  const name = rowName(row.job);
  const pending = row.state === 'pending';
  const [rowRef, rowFocus] = useRowFocus<HTMLLIElement>(`${row.state}:${selectMode}`);
  const line = reviewStateLine(row);
  const origin = originLine(row);
  return (
    <li
      ref={rowRef}
      {...rowFocus}
      data-review-row={row.id}
      data-group={row.group}
      data-state={row.state}
      className="relative flex items-start gap-3 py-3 pr-4 pl-5 @lg/pane:pr-5 @lg/pane:pl-6"
    >
      <AccentBar tone={!pending ? 'quiet' : row.group === 'server_live' ? 'warning' : 'decide'} />
      <RowCheckbox selectMode={selectMode} decidable={pending} checked={checked} onChecked={onChecked} name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 @2xl/pane:flex-row @2xl/pane:items-start @2xl/pane:gap-3">
        <div className="min-w-0 flex-1" data-review-text="">
          <JobTitle job={row.job} />
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            {row.job.companyName}
            {origin && <span data-review-origin=""> · {origin}</span>}
            {!row.job.active && (
              <Badge tone="neutral" className="ml-2 align-middle">
                Closed
              </Badge>
            )}
          </p>
          <p className="text-[13px] leading-5 text-foreground" data-review-evidence="">
            {evidenceLine(row)}{' '}
            <time className="text-muted-foreground" dateTime={row.lastReportedAt} title={new Date(row.lastReportedAt).toLocaleString('en-US')}>
              · {relativeTime(row.lastReportedAt, now)}
            </time>
          </p>
          <StateLine icon={line.icon} text={line.text} detail={line.detail} tone={line.tone} />
          <OutcomeLine text={outcome} />
          <ReportersDisclosure reviewId={row.id} count={row.reporters} name={name} />
        </div>
        <RowActions>
          {pending ? (
            <>
              <Button
                size="sm"
                className={TOUCH}
                icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
                loading={busy}
                focusableWhenDisabled
                aria-label={`Approve: ${name}`}
                onClick={() => onDecide('approve')}
                {...ROW_ACTION}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={TOUCH}
                icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
                disabled={busy}
                focusableWhenDisabled
                aria-label={`Reject: ${name}`}
                onClick={() => onDecide('reject')}
              >
                Reject
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className={TOUCH}
              icon={<ArrowCounterClockwiseIcon size={14} aria-hidden="true" />}
              loading={busy}
              focusableWhenDisabled
              aria-label={`Reopen: ${name}`}
              onClick={() => onDecide('reopen')}
              {...ROW_ACTION}
            >
              Reopen
            </Button>
          )}
          <Button size="sm" variant="ghost" className={TOUCH} aria-label={`Evidence: ${name}`} aria-haspopup="dialog" onClick={onOpen}>
            Evidence
          </Button>
        </RowActions>
      </div>
    </li>
  );
}

/** A flag's change: reopen, resolve (closing the job too, for a closed-posting flag) or dismiss. */
export interface FlagChange {
  status: AdminFlag['status'];
  closeJob?: boolean;
}

export interface FlagRowViewProps {
  flag: AdminFlag;
  now: number;
  selectMode: boolean;
  checked: boolean;
  onChecked: (on: boolean) => void;
  busy: boolean;
  outcome: string | null;
  onChange: (change: FlagChange) => void;
}

export function FlagRowView({ flag, now, selectMode, checked, onChecked, busy, outcome, onChange }: FlagRowViewProps) {
  const name = rowName(flag.job);
  const open = flag.status === 'open';
  const [rowRef, rowFocus] = useRowFocus<HTMLLIElement>(`${flag.status}:${selectMode}`);
  const line = flagStateLine(flag);
  const closes = flag.reason === 'inactive' && flag.job.active;
  return (
    <li
      ref={rowRef}
      {...rowFocus}
      data-flag-row={flag.id}
      data-state={flag.status}
      className="relative flex items-start gap-3 py-3 pr-4 pl-5 @lg/pane:pr-5 @lg/pane:pl-6"
    >
      <AccentBar tone={open ? 'decide' : 'quiet'} />
      <RowCheckbox selectMode={selectMode} decidable={open} checked={checked} onChecked={onChecked} name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 @2xl/pane:flex-row @2xl/pane:items-start @2xl/pane:gap-3">
        <div className="min-w-0 flex-1" data-review-text="">
          <JobTitle job={flag.job} />
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            {flag.job.companyName}
            {!flag.job.active && (
              <Badge tone="neutral" className="ml-2 align-middle">
                Closed
              </Badge>
            )}
          </p>
          <p className="text-[13px] leading-5 font-medium text-foreground" data-flag-reason={flag.reason}>
            {/* v30 INT-3 (E0-WEB's note): a company report opens that company in Admin › Companies' editor. */}
            {flag.reason === 'company_info_wrong' ? (
              <>
                {flag.reasonLabel}:{' '}
                <Link
                  href={`/settings/admin?tab=companies&company=${encodeURIComponent(String(flag.job.companyId))}`}
                  className="underline decoration-1 underline-offset-2"
                  data-flag-company={flag.job.companyId}
                >
                  {flag.job.companyName}
                </Link>
              </>
            ) : (
              flag.reasonLabel
            )}
          </p>
          {flag.details && <p className="line-clamp-3 text-[13px] leading-5 break-words text-muted-foreground">{flag.details}</p>}
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            Reported by {flag.reporter.name || flag.reporter.email} · {relativeTime(flag.createdAt, now)}
          </p>
          <StateLine icon={line.icon} text={line.text} detail={line.detail} tone={line.tone} />
          <OutcomeLine text={outcome} />
        </div>
        <RowActions>
          {open ? (
            <>
              <Button
                size="sm"
                className={TOUCH}
                icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
                loading={busy}
                focusableWhenDisabled
                // v30 FIX-WEB (UX-9): the visible words first (Label in Name).
                aria-label={`${closes ? 'Close job' : 'Resolve'}: ${name}`}
                onClick={() => onChange(closes ? { status: 'resolved', closeJob: true } : { status: 'resolved' })}
                {...ROW_ACTION}
              >
                {closes ? 'Close job' : 'Resolve'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={TOUCH}
                icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
                disabled={busy}
                focusableWhenDisabled
                aria-label={`Dismiss: ${name}`}
                onClick={() => onChange({ status: 'dismissed' })}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className={TOUCH}
              icon={<ArrowCounterClockwiseIcon size={14} aria-hidden="true" />}
              loading={busy}
              focusableWhenDisabled
              aria-label={`Reopen: ${name}`}
              onClick={() => onChange({ status: 'open' })}
              {...ROW_ACTION}
            >
              Reopen
            </Button>
          )}
        </RowActions>
      </div>
    </li>
  );
}
