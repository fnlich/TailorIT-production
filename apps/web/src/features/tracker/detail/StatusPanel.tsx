'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
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
import { HelpTip } from '@/components/ui/HelpTip';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { PencilSimpleIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import { celebrateIfReached } from '../confetti';
import { invalidateApplications, patchCachedApplication, trackerApi, useMoveStatus } from '../data';
import { DRAFT_MARK_TEXT, isDraft as isDraftEntry } from '../draft';
import { toastFailure } from '../failure';
import { DraftIcon, statusOptions } from '../status';
import { useTrackerEditable } from './editable';

const TONE: Record<StepperTone, { ring: string; dot: string; line: string }> = {
  default: { ring: 'bg-primary-soft', dot: 'bg-primary', line: 'bg-primary' },
  success: { ring: 'bg-success-soft', dot: 'bg-success', line: 'bg-success' },
  muted: { ring: 'bg-surface-muted', dot: 'bg-control-strong', line: 'bg-control-strong' },
};

/**
 * The detail's right column, "Stage and dates" (v31 INT-3; was the copied "Application Status"): the status select and the vertical timeline (Saved, Applied,
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
  // v20 A30: a Saved entry in the auto-apply queue shows Draft (never stored as a status). v33 TRACKER (F1): a mark by
  // the panel's title; the stage stays Saved and the timeline has no Draft step.
  const { t } = usePublicConstants();
  const isDraft = isDraftEntry(application);
  const draftLabel = t('STATUS_DRAFT_LABEL');
  // v33 SHARE-9: a profile shared to see only shows the stage and its dates, nothing to change.
  const editable = useTrackerEditable();

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
    onError: (error) => toastFailure(toast, error, "We couldn't change that date. Please try again."),
    onSettled: () => invalidateApplications(client),
  });

  return (
    <section aria-labelledby="status-heading" className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 id="status-heading" className="flex items-center gap-2 text-[15px] leading-5 font-semibold text-foreground">
        Stage and dates
        {isDraft && (
          <Badge tone="success" icon={<DraftIcon size={12} />} data-detail-draft="">
            {draftLabel}
          </Badge>
        )}
        {isDraft && <HelpTip label={draftLabel}>{DRAFT_MARK_TEXT}</HelpTip>}
      </h3>
      <Select
        aria-label="Current stage"
        disabled={!editable}
        className="mt-3 w-full"
        options={statusOptions()}
        value={String(application.currentStatus)}
        onValueChange={(value) => {
          const status = Number(value) as ApplicationStatus;
          if (status !== application.currentStatus) {
            move.mutate(
              { id: application.id, status, from: application.currentStatus },
              { onError: (error) => toastFailure(toast, error, "We couldn't change the status. Please try again.") },
            );
          }
        }}
      />
      <ol aria-label="Status timeline" className="mt-5 flex flex-col">
        {model.steps.map((step, index) => {
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
          // v33 TRACKER (F1): no Draft step after Saved (it was v3.2's A30 timeline node).
          return (
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
                  step.reached ? colors.ring : 'border-2 border-border-strong bg-surface',
                )}
              >
                {step.reached && <span className={clsx('size-3 rounded-full', colors.dot)} />}
              </span>
              <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center justify-between gap-x-2">
                <span className={clsx('text-sm', step.current ? 'font-semibold text-foreground' : 'text-foreground')}>
                  {label}
                  <span className="sr-only">{step.reached ? ', reached' : ', not reached'}</span>
                </span>
                {editable ? (
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
                ) : (
                  // v33 SHARE-9: a reached stage's date, as text.
                  step.reached && (
                    <span className="px-1.5 py-0.5 text-sm text-muted-foreground" data-stage-date="">
                      {formatMediumDate(step.date)}
                    </span>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
