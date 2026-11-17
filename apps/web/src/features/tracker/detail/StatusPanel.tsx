'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  STATUS,
  STATUS_INFO,
  formatMediumDate,
  timelineModel,
  toDate,
  toIsoDate,
  type ApplicationDetail,
  type ApplicationStatus,
  type StatusChangeResponse,
  type StepperTone,
} from '@tailorit/shared';
import { Badge } from '@/components/ui/Badge';
import { DatePickerPopover } from '@/components/ui/DatePickerPopover';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { PencilSimpleIcon } from '@/components/ui/icons';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import { celebrateIfReached } from '../confetti';
import { invalidateApplications, patchCachedApplication, trackerApi, useMoveStatus } from '../data';
import { DRAFT_TIMELINE_TEXT, shownStatusOf } from '../draft';
import { DisplayStatusIcon, statusOptions } from '../status';

const TONE: Record<StepperTone, { ring: string; dot: string; line: string }> = {
  default: { ring: 'bg-primary-container', dot: 'bg-primary-ink', line: 'bg-primary-container' },
  success: { ring: 'bg-success-container', dot: 'bg-success', line: 'bg-success-container' },
  muted: { ring: 'bg-muted', dot: 'bg-subtle-foreground', line: 'bg-muted' },
};

/**
 * The detail's right column, "Application Status": the status select and the vertical timeline (Saved, Applied,
 * Screen, Interviewing, Offer, plus an ending that happened). A reached step shows its date with a pencil; the others
 * "Add date". Both open a calendar with Clear / Save, future days disabled.
 */
export function StatusPanel({ application }: { application: ApplicationDetail }) {
  const client = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const today = new Date(now);
  const model = timelineModel(application.events);
  const colors = TONE[model.tone];
  // v20 A30: a Saved entry in the auto-apply queue shows Draft, dated by its queue row (never stored as a status).
  const { t } = usePublicConstants();
  const isDraft = shownStatusOf(application) === 'draft';
  const draftLabel = t('STATUS_DRAFT_LABEL');

  const move = useMoveStatus({
    onMoved: (result, previous) => celebrateIfReached(result.currentStatus, previous),
  });

  const dates = useMutation({
    mutationFn: ({ status, date }: { status: ApplicationStatus; date: string | null }) =>
      date ? trackerApi.setDate(application.id, status, date) : trackerApi.clearDate(application.id, status),
    onSuccess: (result: StatusChangeResponse, { status, date }) => {
      patchCachedApplication(client, result.id, (summary) => ({
        ...summary,
        currentStatus: result.currentStatus,
        events: result.events,
        updatedAt: result.updatedAt,
      }));
      if (date && status === result.currentStatus) celebrateIfReached(result.currentStatus, application.currentStatus);
    },
    onError: (error) => toast.error(userMessage(error, "We couldn't change that date. Please try again.")),
    onSettled: () => invalidateApplications(client),
  });

  return (
    <section aria-labelledby="status-heading" className="rounded-surface border border-border bg-surface p-5 shadow-soft">
      <h3 id="status-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
        Application Status
        {isDraft && (
          <Badge tone="success" icon={<DisplayStatusIcon status="draft" size={12} />} data-detail-draft="">
            {draftLabel}
          </Badge>
        )}
      </h3>
      <Select
        aria-label="Application status"
        className="mt-3 w-full"
        options={statusOptions()}
        value={String(application.currentStatus)}
        onValueChange={(value) => {
          const status = Number(value) as ApplicationStatus;
          if (status !== application.currentStatus) {
            move.mutate(
              { id: application.id, status, from: application.currentStatus },
              { onError: (error) => toast.error(userMessage(error, "We couldn't change the status. Please try again.")) },
            );
          }
        }}
      />
      {isDraft && (
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
          Shown as {draftLabel}: it is in your auto-apply queue. It moves to Applied once it is applied to.
        </p>
      )}
      <ol aria-label="Status timeline" className="mt-5 flex flex-col">
        {model.steps.flatMap((step, index) => {
          const next = model.steps[index + 1];
          const label = STATUS_INFO[step.status].label;
          const trigger = step.reached ? (
            <button
              type="button"
              aria-label={`Change the date of ${label}, ${formatMediumDate(step.date)}`}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              {formatMediumDate(step.date)}
              <PencilSimpleIcon size={14} />
            </button>
          ) : (
            <button
              type="button"
              // The name starts with the visible words, so "click Add date" (voice control) finds it.
              aria-label={`Add date for ${label}`}
              className="rounded-md px-1.5 py-0.5 text-sm font-medium text-primary-ink hover:bg-primary/5"
            >
              Add date
            </button>
          );
          const row = (
            <li key={step.status} className={clsx('relative flex items-start gap-3', next && 'pb-5')}>
              {next && (
                <span
                  aria-hidden="true"
                  className={clsx(
                    'absolute top-6 bottom-0 left-[11px] w-0.5',
                    step.reached && next.reached ? colors.line : 'bg-border',
                  )}
                />
              )}
              <span
                aria-hidden="true"
                className={clsx(
                  'relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full',
                  step.reached ? colors.ring : 'border-2 border-control-strong bg-surface',
                )}
              >
                {step.reached && <span className={clsx('size-3.5 rounded-full', colors.dot)} />}
              </span>
              <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center justify-between gap-x-2">
                <span className={clsx('text-sm', step.current ? 'font-semibold text-foreground' : 'text-foreground')}>
                  {label}
                  <span className="sr-only">{step.reached ? ', reached' : ', not reached'}</span>
                </span>
                <DatePickerPopover
                  value={toDate(step.date)}
                  maxDate={today}
                  withActions
                  align="end"
                  aria-label={`Date for ${label}`}
                  onValueChange={(date) => dates.mutate({ status: step.status, date: date ? toIsoDate(date) : null })}
                >
                  {trigger}
                </DatePickerPopover>
              </div>
            </li>
          );
          if (!isDraft || step.status !== STATUS.saved) return [row];
          // v20 A30: Draft right after Saved, dated by the queue row (its date is not edited here).
          return [
            row,
            <li key="draft" className="relative flex items-start gap-3 pb-5" data-timeline-draft="">
              <span aria-hidden="true" className={clsx('absolute top-6 bottom-0 left-[11px] w-0.5', 'bg-border')} />
              <span
                aria-hidden="true"
                className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full bg-success-container"
              >
                <span className="size-3.5 rounded-full bg-success" />
              </span>
              <div className="flex min-h-6 min-w-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-x-2">
                  <span className="text-sm font-semibold text-foreground">
                    {draftLabel}
                    <span className="sr-only">, reached</span>
                  </span>
                  {application.queuedAt && (
                    <time dateTime={application.queuedAt} className="px-1.5 text-sm text-muted-foreground">
                      {formatMediumDate(application.queuedAt)}
                    </time>
                  )}
                </div>
                <span className="text-[13px] leading-5 text-muted-foreground">{DRAFT_TIMELINE_TEXT}</span>
              </div>
            </li>,
          ];
        })}
      </ol>
    </section>
  );
}
