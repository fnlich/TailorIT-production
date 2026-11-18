'use client';

import { ChartBarIcon } from '@phosphor-icons/react/ChartBar';
import { FunnelSimpleIcon } from '@phosphor-icons/react/FunnelSimple';
import { HourglassMediumIcon } from '@phosphor-icons/react/HourglassMedium';
import { clsx } from 'clsx';
import { useRef, useState, type ReactNode } from 'react';
import {
  CHART_EMPTY_TEXT,
  CHART_EMPTY_TITLE,
  formatDays,
  pluralize,
  type InsightsResponse,
  type SankeyResponse,
} from '@tailorit/shared';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { useToast } from '@/components/ui/Toast';
import { ArrowCounterClockwiseIcon, ChartLineIcon, DownloadSimpleIcon } from '@/components/ui/icons';
import { userMessage } from '@/lib/api';
import { FlowChart, useChartPositions } from './FlowChart';

const CARD = 'rounded-card border border-border bg-surface shadow-card';

function InsightCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className={clsx(CARD, 'flex flex-col gap-4 p-5')} aria-label={title}>
      <header className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-control bg-primary-soft text-primary">{icon}</span>
        <h3 className="text-[15px] leading-5 font-semibold text-foreground">{title}</h3>
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="num text-xl leading-7 text-foreground">{value}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** One step of the funnel: its rate on a tape meter (denim), "42% (5 of 12)" beside the step's name. */
function FunnelBar({ label, rate }: { label: string; rate: { percent: number; from: number; to: number } }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-foreground">{label}</span>
        <span className="num text-foreground" aria-hidden="true">
          {rate.percent}%
          <span className="ml-1.5 text-xs text-muted-foreground">
            ({rate.to} of {rate.from})
          </span>
        </span>
      </div>
      <TapeMeter label={label} value={rate.percent} valueText={`${rate.percent}%, ${rate.to} of ${rate.from}`} showValue={false} tone="primary" />
    </div>
  );
}

function InsightsCards({ insights }: { insights: InsightsResponse }) {
  const { activity, funnel, response } = insights;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <InsightCard title="Application activity" icon={<ChartBarIcon size={18} />}>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Total applications" value={activity.total} />
          <Stat label="Most active day" value={
              <span className="text-base">
                {activity.mostActiveDay
                  ? `${activity.mostActiveDay.weekday} (${pluralize(activity.mostActiveDay.count, 'app')})`
                  : '-'}
              </span>
            } />
        </div>
        <div className="grid grid-cols-3 gap-3 border-t border-divider-soft pt-4">
          <Stat label="Per day" value={activity.perDay} />
          <Stat label="Per week" value={activity.perWeek} />
          <Stat label="Per month" value={activity.perMonth} />
        </div>
      </InsightCard>
      <InsightCard title="Conversion funnel" icon={<FunnelSimpleIcon size={18} />}>
        <FunnelBar label="Applied → Screening" rate={funnel.appliedToScreening} />
        <FunnelBar label="Screening → Interview" rate={funnel.screeningToInterview} />
        <FunnelBar label="Interview → Offer" rate={funnel.interviewToOffer} />
      </InsightCard>
      <InsightCard title="Response & follow-up" icon={<HourglassMediumIcon size={18} />}>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Average response time" value={formatDays(response.averageResponseDays)} />
          <Stat label="Ghost rate" value={`${response.ghostRate}%`} />
        </div>
        <div className="border-t border-divider-soft pt-4">
          <Stat
            label="Longest wait"
            value={response.longestWait ? formatDays(response.longestWait.days) : '-'}
            hint={
              response.longestWait
                ? [response.longestWait.title, response.longestWait.companyName].filter(Boolean).join(' at ')
                : 'No application is waiting for an answer.'
            }
          />
        </div>
      </InsightCard>
    </div>
  );
}

async function downloadPng(node: HTMLElement): Promise<void> {
  const { toPng } = await import('html-to-image');
  // The page's surface colour (the token), so the picture's background is the card's.
  const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim() || undefined;
  const url = await toPng(node, { backgroundColor, pixelRatio: 2, cacheBust: true });
  const link = document.createElement('a');
  link.href = url;
  link.download = 'application-flow.png';
  document.body.append(link);
  link.click();
  link.remove();
}

export function ChartView({
  sankey,
  insights,
  loading,
  error,
}: {
  sankey: SankeyResponse | undefined;
  insights: InsightsResponse | undefined;
  loading: boolean;
  error: unknown;
}) {
  const toast = useToast();
  const chart = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [, setPositions] = useChartPositions();

  if (error) {
    return <Notice tone="error">{userMessage(error, "We couldn't load the chart. Please try again.")}</Notice>;
  }

  const empty = !loading && sankey !== undefined && sankey.total === 0;

  return (
    <div className="flex flex-col gap-6 pb-12">
      <section className={clsx(CARD, 'p-5')} aria-labelledby="flow-heading">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="flow-heading" className="text-heading font-semibold text-foreground">
              Application flow
            </h2>
            <p className="text-sm text-muted-foreground">Drag stages to rearrange your chart. Reset positions to restore the default layout.</p>
          </div>
          {!empty && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" icon={<ArrowCounterClockwiseIcon size={14} />} onClick={() => setPositions(null)}>
                Reset chart positions
              </Button>
              <Button
                variant="outline"
                size="sm"
                icon={<DownloadSimpleIcon size={14} />}
                loading={exporting}
                disabled={!sankey}
                onClick={async () => {
                  if (!chart.current) return;
                  setExporting(true);
                  try {
                    await downloadPng(chart.current);
                  } catch {
                    toast.error("We couldn't export the chart.", 'Please try again.');
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                Export chart as PNG
              </Button>
            </div>
          )}
        </header>
        <div className="mt-4">
          {loading || !sankey ? (
            <Skeleton className="h-[420px] w-full" rounded="control" />
          ) : empty ? (
            <EmptyState icon={<ChartLineIcon size={22} />} title={CHART_EMPTY_TITLE} description={CHART_EMPTY_TEXT} />
          ) : (
            <div ref={chart} className="rounded-control border border-divider-soft bg-surface" data-chart="application-flow">
              <FlowChart data={sankey} />
            </div>
          )}
        </div>
      </section>
      <section aria-labelledby="insights-heading" className="flex flex-col gap-3">
        <h2 id="insights-heading" className="text-heading font-semibold text-foreground">
          Insights
        </h2>
        {insights ? (
          <InsightsCards insights={insights} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-[210px]" rounded="surface" />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
