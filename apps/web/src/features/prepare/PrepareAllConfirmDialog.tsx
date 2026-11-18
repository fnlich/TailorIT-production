'use client';

import type { PrepareAllPlan } from '@tailorit/shared/prepare';
import { formatUsd } from '@tailorit/shared/constants';
// Relative, not '@/': the web tests draw this view.
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Notice } from '../../components/ui/Notice';
import { TapeMeter, type TapeMeterTone } from '../../components/ui/TapeMeter';
import { usePublicConstants } from '../../lib/constants';
import { PREPARE_ALL_BUDGET, prepareAllConfirmLabel, prepareAllSummary, prepareAllTitle } from './copy';

// v31 AUTO (decision D10): Prepare All's confirm, always shown (it can start many Prepares at once): how many saved
// jobs in To prepare pass the filters and how many it takes now (with the server's words for what the caps leave), the
// AI note (MSG_PREPARE_CONFIRM, the Prepare & Queue confirm's own words), and today's AI use as a tape meter against
// the daily budget with the extra usage left, or that the plan has no daily limit. Continue runs `onConfirm`: reject
// to keep the dialog open with the error's words.

/** The meter's tone: the budget nearly used (80 %) is a warning, used up is danger. */
export function budgetTone(used: number, budget: number): TapeMeterTone {
  if (budget <= 0 || used >= budget) return 'danger';
  return used / budget >= 0.8 ? 'warning' : 'primary';
}

export interface PrepareAllConfirmDialogProps {
  /** The plan the confirm shows (null: closed). */
  plan: PrepareAllPlan | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
  /** Where focus goes when it closes (Prepare All, or the Filters button for Filter and Prepare). */
  finalFocus?: () => HTMLElement | boolean | null;
}

export function PrepareAllConfirmDialog({ plan, onOpenChange, onConfirm, finalFocus }: PrepareAllConfirmDialogProps) {
  const { t } = usePublicConstants();
  const taking = plan?.taking ?? 0;
  return (
    <ConfirmDialog
      open={plan !== null}
      onOpenChange={onOpenChange}
      tone="primary"
      title={prepareAllTitle(taking)}
      description={plan ? prepareAllSummary(plan) : undefined}
      confirmLabel={prepareAllConfirmLabel(taking)}
      busyLabel="Starting..."
      onConfirm={onConfirm}
      focusConfirm
      finalFocus={finalFocus}
    >
      {plan && (
        <div className="flex flex-col gap-3" data-prepare-all-confirm="">
          {plan.held && (
            <div data-prepare-all-held={plan.held.reason}>
              <Notice tone="info">{plan.held.message}</Notice>
            </div>
          )}
          <p className="text-sm leading-5 text-foreground">{t('MSG_PREPARE_CONFIRM')}</p>
          <BudgetNote ai={plan.ai} />
        </div>
      )}
    </ConfirmDialog>
  );
}

/** Today's AI use against the daily budget (a tape meter), the extra usage left, and how a budget that runs out ends. */
export function BudgetNote({ ai }: { ai: PrepareAllPlan['ai'] }) {
  return (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-surface-low p-3" data-prepare-all-budget="">
      {ai.budgetMicros === null ? (
        <p className="text-[13px] leading-5 text-muted-foreground">{PREPARE_ALL_BUDGET.noLimit}</p>
      ) : (
        <>
          <TapeMeter
            label={PREPARE_ALL_BUDGET.meterLabel}
            showLabel
            value={ai.usedMicros}
            max={ai.budgetMicros}
            valueText={PREPARE_ALL_BUDGET.used(formatUsd(ai.usedMicros), formatUsd(ai.budgetMicros))}
            tone={budgetTone(ai.usedMicros, ai.budgetMicros)}
          />
          <p className="num text-xs text-muted-foreground">{PREPARE_ALL_BUDGET.extra(formatUsd(ai.creditMicros))}</p>
        </>
      )}
      <p className="text-[13px] leading-5 text-muted-foreground">{PREPARE_ALL_BUDGET.runsOut}</p>
    </div>
  );
}
