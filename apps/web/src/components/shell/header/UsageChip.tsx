'use client';

import { GaugeIcon } from '@phosphor-icons/react/Gauge';
import { resetText as resetTextOf } from '@tailorit/shared/constants';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { useAccount } from '../../../lib/account';
import { useAuth } from '../../../lib/auth';
import { usePublicConstants } from '../../../lib/constants';
import { useNow } from '../../../lib/useNow';
import { BuyCreditDialog } from '../../limits/BuyCreditDialog';
import { SubscribeDialog } from '../../limits/SubscribeDialog';
import { Badge } from '../../ui/Badge';
import { ArrowRightIcon, WarningCircleIcon } from '../../ui/icons';
import { Button, buttonClasses } from '../../ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover';
import { Skeleton } from '../../ui/Skeleton';
import { TapeMeter } from '../../ui/TapeMeter';
import { useHeaderSummary } from './api';
import { USAGE_COPY } from './copy';
import { HelpTip } from '../../ui/HelpTip';
import { useHeaderPreview } from './preview';
import { TEXT_TONE, TRIGGER_TONE, useHeaderTone, type HeaderTone } from './tone';
import { resetLine, usageView, type UsageSummary, type UsageView } from './view';

// v3.1 HEADER (D9; docs/design/v3.1/24-notifications-usage.md §6, §8; 20-visual-identity.md "Header slots"): the top
// bar's usage chip. Today's AI use against the person's daily limit as a small tape meter (amber from
// AI_USE_WARNING_PERCENT, red once the limit is used), the share used (v31 FIX-WEB: at every width) and, from 640 px,
// "Extra usage $x.xx" (the extra credit left). Its popover says the plan, today's share, when the day resets, the
// extra usage, today's auto-applies, and offers Subscribe (Free), Buy credit and Settings › Account. v32 SHELL (E7):
// today's use is a share only, never an amount of the daily limit (the API sends a non-admin no amount); extra usage
// keeps its amount. The numbers come from GET /api/me/header (read every 60 s while the page is shown); the
// auto-applies from GET /api/account when the popover opens.

/** Settings › Account. */
export const ACCOUNT_SETTINGS_HREF = '/settings#account';

type Dialog = 'credit' | 'subscribe' | null;

/** Where the chip's extra usage words start: 640 px (the header bar), 1280 or 1536 px (the editors' bar). */
export type ExtraFrom = 'sm' | 'xl' | '2xl';
const EXTRA_HIDDEN: Record<ExtraFrom, string> = { sm: 'max-sm:hidden', xl: 'max-xl:hidden', '2xl': 'max-2xl:hidden' };

/**
 * The chip. `extraFrom` (v31 FIX-WEB, REV-REQ REQ-4) is where the extra usage words start: 640 px on the header bar; 1280
 * or 1536 px on the editors' bar, whose actions need the room. The meter and the share show at every width.
 */
export function UsageChip({ extraFrom = 'sm' }: { extraFrom?: ExtraFrom } = {}) {
  const preview = useHeaderPreview();
  const { account } = useAuth();
  if (preview) {
    return (
      <UsageChipFrame
        extraFrom={extraFrom}
        summary={preview.summary}
        warningPercent={preview.warningPercent}
        resetText={preview.resetText}
        autoApply={<AutoApplyMeter used={preview.autoApply.used} limit={preview.autoApply.limit} />}
        onDialog={() => undefined}
      />
    );
  }
  return account ? <LiveUsageChip extraFrom={extraFrom} /> : null;
}

function LiveUsageChip({ extraFrom }: { extraFrom: ExtraFrom }) {
  const summary = useHeaderSummary();
  const { values } = usePublicConstants();
  const [dialog, setDialog] = useState<Dialog>(null);
  if (!summary.data) {
    // Until the first read (and while it fails: the next read tries again) the chip keeps its room quietly.
    return summary.isError ? null : <ChipSkeleton />;
  }
  return (
    <>
      <UsageChipFrame
        extraFrom={extraFrom}
        summary={summary.data}
        warningPercent={values.AI_USE_WARNING_PERCENT}
        resetText={resetTextOf(values.DAY_RESET_TIME, values.DAY_RESET_ZONE_LABEL)}
        autoApply={<LiveAutoApply />}
        onDialog={setDialog}
      />
      {/* Mounted when asked for: each reads the account and the constants. */}
      {dialog === 'credit' && <BuyCreditDialog open onOpenChange={(next) => !next && setDialog(null)} />}
      {dialog === 'subscribe' && <SubscribeDialog open onOpenChange={(next) => !next && setDialog(null)} />}
    </>
  );
}

function ChipSkeleton() {
  const tone = useHeaderTone();
  return (
    <span className="flex h-9 items-center px-2" aria-hidden="true" data-header-usage="loading">
      <Skeleton className={clsx('h-1.5 w-10 sm:w-16', tone === 'dark' && 'opacity-30')} rounded="full" />
    </span>
  );
}

export interface UsageChipFrameProps {
  summary: UsageSummary;
  warningPercent: number;
  /** "12:00 AM Pacific Time". */
  resetText: string;
  /** Today's auto-applies (read when the popover opens). */
  autoApply: ReactNode;
  onDialog: (dialog: Exclude<Dialog, null>) => void;
  /** Where the extra usage words start (the editors' bar: 1280 or 1536 px). */
  extraFrom?: ExtraFrom;
}

/** The chip and its popover for one summary. */
export function UsageChipFrame({ summary, warningPercent, resetText, autoApply, onDialog, extraFrom = 'sm' }: UsageChipFrameProps) {
  const [open, setOpen] = useState(false);
  const tone = useHeaderTone();
  const view = usageView(summary, warningPercent);
  const ask = (dialog: Exclude<Dialog, null>) => {
    setOpen(false);
    onDialog(dialog);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={view.triggerLabel}
        data-header-usage={view.tone}
        className={clsx('flex h-9 shrink-0 items-center gap-2 rounded-control px-2 transition-colors duration-150', TRIGGER_TONE[tone])}
      >
        <UsageChipFace view={view} extraFrom={extraFrom} tone={tone} />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={USAGE_COPY.popoverLabel} className="w-[min(23rem,calc(100vw-1rem))]">
        {open && <UsagePanel view={view} summary={summary} resetText={resetText} autoApply={autoApply} onDialog={ask} onClose={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

/**
 * What the trigger draws: the meter and the share, then from 640 px the extra usage. Its name says it all. v31 FIX-WEB
 * (REV-UX UX-14): the share at every width, so on a phone the bar is never a lone grey strip (at 0 % it read as a
 * loading skeleton). On the dark header bar the words take its colours and the meter's track is a lighter band.
 */
export function UsageChipFace({ view, extraFrom = 'sm', tone = 'light' }: { view: UsageView; extraFrom?: ExtraFrom; tone?: HeaderTone }) {
  const wide = EXTRA_HIDDEN[extraFrom];
  const words = TEXT_TONE[tone];
  // On the editors' bar (its extra usage words later) a phone shows the share alone: the document's name needs the room.
  const meter = extraFrom === 'sm' ? 'flex' : 'flex max-sm:hidden';
  return (
    <>
      {view.kind === 'budget' ? (
        <span
          aria-hidden="true"
          className={clsx(
            meter,
            'w-8 items-center sm:w-14',
            tone === 'dark' && '[&_[role=meter]]:bg-sidebar-active [&_[role=meter]]:ring-sidebar-border',
          )}
        >
          <TapeMeter label={USAGE_COPY.meterLabel} value={view.percent} tone={view.tone} size="sm" layout="inline" showValue={false} className="w-full" />
        </span>
      ) : (
        <GaugeIcon size={20} aria-hidden="true" className={words.quiet} />
      )}
      <span className={clsx('num text-xs leading-4', words.strong)} data-usage-value="">
        {view.kind === 'budget' ? view.percentText : USAGE_COPY.unlimitedShort}
      </span>
      {/* The spaces keep the drawn words apart as the name says them (WCAG 2.5.3: "42% Extra usage $1.50"); a flex
          row draws none of them. */}{' '}
      <span aria-hidden="true" className={clsx('h-4 w-px', words.rule, wide)} />{' '}
      <span className={clsx('text-xs leading-4 whitespace-nowrap', words.quiet, wide)} data-usage-extra="">
        {USAGE_COPY.extraTitle} <span className={clsx('num', words.strong)}>{view.extraAmount}</span>
      </span>
    </>
  );
}

export interface UsagePanelProps {
  view: UsageView;
  summary: UsageSummary;
  resetText: string;
  autoApply: ReactNode;
  onDialog: (dialog: Exclude<Dialog, null>) => void;
  onClose: () => void;
}

/** The popover's inside (drawn statically by the tests). */
export function UsagePanel({ view, summary, resetText, autoApply, onDialog, onClose }: UsagePanelProps) {
  const now = useNow();
  const free = summary.plan === 'free';
  return (
    <div className="flex flex-col gap-4" data-usage-panel="">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] leading-5 font-semibold text-foreground">{USAGE_COPY.title}</h2>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="flex items-center gap-1">
            {free && <HelpTip label={USAGE_COPY.freePlan}>{USAGE_COPY.freeLine}</HelpTip>}
            <Badge tone={free ? 'neutral' : 'tint'} data-plan={summary.plan}>
              {view.planLabel}
            </Badge>
          </span>
          {view.planUntil && <span className="text-xs leading-4 text-muted-foreground">{view.planUntil}</span>}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {view.kind === 'budget' ? (
          <TapeMeter label={USAGE_COPY.meterLabel} value={view.percent} valueText={view.valueText} tone={view.tone} />
        ) : (
          <p className="text-sm text-foreground" data-usage-unlimited="">
            {USAGE_COPY.unlimited}
          </p>
        )}
        <p className="text-xs leading-4 text-muted-foreground" data-usage-reset="">
          {resetLine(summary.ai.resetsAt, now, resetText)}
        </p>
      </div>
      {view.reached && (
        // v32 SHELL (E4, E5): a short state line, not a notice box: what happens now that the limit is used.
        <p className="flex items-center gap-1.5 text-[13px] leading-5 text-foreground" data-usage-state={view.waiting ? 'waiting' : 'reached'}>
          <WarningCircleIcon size={16} weight="fill" aria-hidden="true" className={view.waiting ? 'shrink-0 text-danger' : 'shrink-0 text-warning'} />
          {view.waiting ? USAGE_COPY.waiting : USAGE_COPY.reached}
        </p>
      )}
      <dl className="flex flex-col divide-y divide-divider-soft border-y border-divider-soft">
        <div className="flex items-center justify-between gap-4 py-2.5">
          <dt className="flex items-center gap-1">
            <span className="text-sm font-medium text-foreground">{USAGE_COPY.extraTitle}</span>
            <HelpTip label={USAGE_COPY.extraTitle}>{USAGE_COPY.extraHint}</HelpTip>
          </dt>
          <dd className="num text-sm text-foreground" data-usage-credit="">
            {view.extraAmount}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-2.5">
          <dt className="shrink-0 text-sm font-medium text-foreground">{USAGE_COPY.autoApplies}</dt>
          <dd className="flex min-w-0 flex-1 justify-end">{autoApply}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        {free && (
          <Button size="sm" onClick={() => onDialog('subscribe')} className="max-sm:min-h-11">
            {USAGE_COPY.subscribe}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => onDialog('credit')} className="max-sm:min-h-11">
          {USAGE_COPY.buyCredit}
        </Button>
        <Link
          href={ACCOUNT_SETTINGS_HREF}
          onClick={onClose}
          className={buttonClasses({ variant: 'link', size: 'sm', className: 'ml-auto gap-1 max-sm:min-h-11' })}
        >
          {USAGE_COPY.account}
          <ArrowRightIcon size={14} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

/** Today's auto-applies as a small denim meter ("3 of 10"), or "Unlimited". */
export function AutoApplyMeter({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null) return <span className="text-sm text-foreground">{USAGE_COPY.autoAppliesUnlimited}</span>;
  return (
    <TapeMeter
      label={USAGE_COPY.autoAppliesLabel}
      value={used}
      max={Math.max(limit, 1)}
      valueText={USAGE_COPY.autoAppliesOf(used, limit)}
      tone={used >= limit ? 'warning' : 'primary'}
      size="sm"
      layout="inline"
      className="w-40"
    />
  );
}

/** The auto-applies from GET /api/account (read when the popover opens; Settings › Account's numbers). */
function LiveAutoApply() {
  const account = useAccount();
  if (!account.data) {
    return account.isError ? <span className="text-sm text-muted-foreground">-</span> : <Skeleton className="h-3 w-24" />;
  }
  return <AutoApplyMeter used={account.data.autoApply.used} limit={account.data.autoApply.limit} />;
}
