'use client';

import { JOB_SOURCE_KIND_LABEL, type SourcingDailyReport } from '@tailorit/shared/sourcing';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState, type ReactNode } from 'react';
import { ScrollRegion } from '@/components/admin';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { ChartLineIcon, CheckCircleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { formatCount } from '../sources/sources';
import { fetchSourcingReport, runKeys } from './api';
import { activeKinds, alarmCount, alarmText, changeText, dayLabel, failingHosts, percentText, reportDays, reportTotals } from './report';

// v30 S1-WEB: the daily report (12 §9.8): runs and the 304 share, new, changed and closed jobs by kind, open jobs by
// kind with the day's change, failures by host, candidates found and validated, and the alarms first. A KPI row of
// stat tiles (the numbers are the figure) and two tables; no chart.

/** A stat tile: its label, its value, and a line under it. */
function Stat({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 shadow-card" data-stat={label}>
      <p className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">{label}</p>
      <p className="num mt-1.5 text-2xl leading-8 text-foreground">{value}</p>
      {note && <p className="mt-0.5 text-[13px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function TableCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    // v30 FIX-WEB (REV-UX UX-7): a focusable, named region (a keyboard scrolls "By kind" at a phone's width).
    <ScrollRegion label={label} className="rounded-card border border-border bg-surface shadow-card">
      <table aria-label={label} className="w-full min-w-[560px] border-collapse text-left text-sm">
        {children}
      </table>
    </ScrollRegion>
  );
}

// v31 ADMINWEB: the guide's table (20-visual-identity.md §8): spaced-capital heads on surface-low, soft row dividers,
// numbers right-aligned in the measurement face.
const TH = 'h-11 px-4 text-[11px] leading-4 font-semibold tracking-[0.06em] whitespace-nowrap text-subtle-foreground uppercase';
const TD = 'border-t border-divider-soft px-4 py-2.5';
const NUM = 'num text-right';

/** One day's report (drawn without a server in the web tests). */
export function ReportView({ report, onShowHost }: { report: SourcingDailyReport; onShowHost?: (host: string) => void }) {
  const totals = reportTotals(report);
  const kinds = activeKinds(report);
  const hosts = failingHosts(report);
  return (
    <div className="flex flex-col gap-6" data-sourcing-report={report.day}>
      {report.alarms.length > 0 ? (
        <Notice tone="warning" title={alarmCount(report.alarms.length)}>
          <ul className="list-disc pl-5" aria-label="Alarms">
            {report.alarms.map((alarm, index) => (
              <li key={index}>{alarmText(alarm)}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        <p className="flex items-center gap-1.5 text-sm leading-5 font-medium text-success" data-report-calm="">
          <CheckCircleIcon size={16} weight="fill" aria-hidden="true" />
          No alarms
          <HelpTip label="No alarms">No host failed too many requests, and every kind kept and found jobs.</HelpTip>
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" role="group" aria-label="The day in numbers">
        <Stat label="Runs" value={formatCount(report.runs)} note={`${formatCount(report.failedRuns)} failed`} />
        <Stat label="Not modified (304)" value={percentText(totals.notModifiedShare)} note={`${formatCount(report.notModifiedRuns)} of the runs`} />
        <Stat label="New jobs" value={formatCount(totals.created)} note={`${formatCount(totals.updated)} changed`} />
        <Stat label="Closed jobs" value={formatCount(totals.closed)} note={`${formatCount(totals.reopened)} reopened`} />
        <Stat label="Open jobs" value={formatCount(totals.openJobs)} note={`${changeText(totals.openJobsChange)} since the day before`} />
        <Stat label="Boards found" value={formatCount(report.candidates.found)} note={`${formatCount(report.candidates.validated)} validated`} />
        <Stat label="Hosts with failures" value={formatCount(hosts.length)} />
      </div>

      <section aria-labelledby="report-kinds">
        <h3 id="report-kinds" className="mb-2 text-[15px] leading-5 font-semibold text-foreground">
          By kind
        </h3>
        {kinds.length === 0 ? (
          <p className="text-sm text-muted-foreground">No kind ran or held open jobs this day.</p>
        ) : (
          <TableCard label="Jobs by kind">
            <thead>
              <tr className="border-b border-border bg-surface-low">
                <th scope="col" className={TH}>
                  Kind
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Runs
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  304s
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  New
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Changed
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Closed
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Reopened
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Open jobs
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((row) => (
                <tr key={row.kind} data-report-kind={row.kind}>
                  <th scope="row" className={clsx(TD, 'text-left font-medium')}>
                    {JOB_SOURCE_KIND_LABEL[row.kind]}
                  </th>
                  <td className={clsx(TD, NUM)}>{formatCount(row.runs)}</td>
                  <td className={clsx(TD, NUM)}>{formatCount(row.notModified)}</td>
                  <td className={clsx(TD, NUM)}>{formatCount(row.created)}</td>
                  <td className={clsx(TD, NUM)}>{formatCount(row.updated)}</td>
                  <td className={clsx(TD, NUM)}>{formatCount(row.closed)}</td>
                  <td className={clsx(TD, NUM)}>{formatCount(row.reopened)}</td>
                  <td className={clsx(TD, NUM)}>{formatCount(row.openJobs)}</td>
                  <td className={clsx(TD, NUM, row.openJobsChange < 0 && 'text-danger')}>{changeText(row.openJobsChange)}</td>
                </tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>

      <section aria-labelledby="report-hosts">
        <h3 id="report-hosts" className="mb-2 text-[15px] leading-5 font-semibold text-foreground">
          Hosts with failures
        </h3>
        {hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No host failed a request this day.</p>
        ) : (
          <TableCard label="Hosts with failures">
            <thead>
              <tr className="border-b border-border bg-surface-low">
                <th scope="col" className={TH}>
                  Host
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Requests
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Failures
                </th>
                <th scope="col" className={clsx(TH, 'text-right')}>
                  Share failed
                </th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((row) => (
                <tr key={row.host} data-report-host={row.host}>
                  <th scope="row" className={clsx(TD, 'text-left font-medium')}>
                    {onShowHost ? (
                      <Button variant="link" onClick={() => onShowHost(row.host)}>
                        {row.host}
                      </Button>
                    ) : (
                      row.host
                    )}
                  </th>
                  <td className={clsx(TD, NUM)}>{formatCount(row.requests)}</td>
                  <td className={clsx(TD, NUM)}>{formatCount(row.failures)}</td>
                  <td className={clsx(TD, NUM)}>{percentText(row.share)}</td>
                </tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>
    </div>
  );
}

/** The report with its day picker: today (the server's day) and the six days before it. */
export function DailyReport({ onShowHost }: { onShowHost: (host: string) => void }) {
  const [day, setDay] = useState<string | null>(null);
  const today = useQuery({ queryKey: runKeys.report(null), queryFn: ({ signal }) => fetchSourcingReport(null, signal), retry: false });
  const chosen = useQuery({
    queryKey: runKeys.report(day),
    queryFn: ({ signal }) => fetchSourcingReport(day, signal),
    enabled: day !== null,
    retry: false,
  });
  const report = day === null ? today : chosen;
  const todayDay = today.data?.day ?? null;
  const dayOptions = todayDay ? reportDays(todayDay).map((value) => ({ value, label: dayLabel(value, todayDay) })) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {todayDay && (
          <Select
            aria-label="Day"
            options={dayOptions}
            value={day ?? todayDay}
            onValueChange={(value) => setDay(value === todayDay ? null : value)}
            className="w-48"
          />
        )}
      </div>
      {report.error ? (
        <Notice
          tone="error"
          title="The daily report didn't load."
          action={
            <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(report.error)}
        </Notice>
      ) : report.data ? (
        <ReportView report={report.data} onShowHost={onShowHost} />
      ) : report.isPending && (day === null || chosen.fetchStatus !== 'idle') ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <EmptyState size="sm" icon={<ChartLineIcon size={22} />} title="No report" description="This day has no sourcing report." />
      )}
    </div>
  );
}
