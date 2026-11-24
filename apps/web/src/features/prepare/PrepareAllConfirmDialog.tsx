'use client';

import type { PrepareAllPlan } from '@tailorit/shared/prepare';
import { formatUsd } from '@tailorit/shared/constants';
// Relative, not '@/': the web tests draw this view.
import { aiUseOf, aiUseTone, type AiUseInput } from '../../components/limits/aiUse';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { TapeMeter } from '../../components/ui/TapeMeter';
import { usePublicConstants } from '../../lib/constants';
import { PREPARE_ALL_BUDGET, prepareAllConfirmLabel, prepareAllSummary, prepareAllTitle } from './copy';

// v31 AUTO (decision D10): Prepare All's confirm, always shown (it can start many Prepares at once): how many saved
// jobs in To prepare pass the filters and how many it takes now (with the server's words for what the caps leave), the
// AI note (MSG_PREPARE_CONFIRM, the Prepare confirm's own words), and today's AI use as a tape meter against
// the daily budget with the extra usage left, or that the plan has no daily limit. Continue runs `onConfirm`: reject
// to keep the dialog open with the error's words.
// v32 COPY (E7): today's AI use is its share only ("40%"), never the budget's amounts; the extra usage keeps its amount.
// (E4/E5): what the caps hold back is a plain line, and how a used budget ends is the "?" beside the meter.

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
      // v32 FIX-UX (UXREQ-12): it spends AI on many jobs at once, so it opens on Cancel (a quick Enter never starts it).
      focusCancel
      finalFocus={finalFocus}
    >
      {plan && (
        <div className="flex flex-col gap-3" data-prepare-all-confirm="">
          {plan.held && (
            <p className="text-[13px] leading-5 text-muted-foreground" data-prepare-all-held={plan.held.reason}>
              {plan.held.message}
            </p>
          )}
          <p className="text-sm leading-5 text-foreground">{t('MSG_PREPARE_CONFIRM')}</p>
          <BudgetNote ai={plan.ai} />
        </div>
      )}
    </ConfirmDialog>
  );
}

/** The confirm's AI note: what the answer carries of today's use (the share, or the amounts) and the extra usage. */
export type BudgetNoteAi = AiUseInput & { creditMicros: number };

/** Today's AI use as a share of the daily budget (a tape meter), the extra usage left, and a "?" on how it ends. */
export function BudgetNote({ ai }: { ai: BudgetNoteAi }) {
  const { values } = usePublicConstants();
  const use = aiUseOf(ai);
  return (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-surface-low p-3" data-prepare-all-budget="">
      {use.kind === 'unlimited' ? (
        <p className="flex items-center gap-1.5 text-[13px] leading-5 text-muted-foreground">
          {PREPARE_ALL_BUDGET.noLimit}
          <HelpTip label={PREPARE_ALL_BUDGET.meterLabel}>{PREPARE_ALL_BUDGET.runsOut}</HelpTip>
        </p>
      ) : (
        <>
          <div className="flex items-end gap-1.5">
            <TapeMeter
              label={PREPARE_ALL_BUDGET.meterLabel}
              showLabel
              value={use.percent}
              max={100}
              valueText={use.percentText}
              tone={aiUseTone(use.percent, values.AI_USE_WARNING_PERCENT)}
              className="min-w-0 flex-1"
            />
            <HelpTip label={PREPARE_ALL_BUDGET.meterLabel}>{PREPARE_ALL_BUDGET.runsOut}</HelpTip>
          </div>
          <p className="num text-xs text-muted-foreground">{PREPARE_ALL_BUDGET.extra(formatUsd(ai.creditMicros))}</p>
        </>
      )}
    </div>
  );
}
