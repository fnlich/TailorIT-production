'use client';

import { type AdminHost, type AdminHostRow } from '@tailorit/shared/sourcing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { RowDetailSheet } from '@/components/queue';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { fetchHost, holdHost, hostKeys } from './api';
import {
  HOLD_CHOICES,
  ROBOTS_STATUS_LABEL,
  aiInputText,
  breakerText,
  clockText,
  crawlDelayText,
  failuresLabel,
  gapText,
  holdReasonText,
  holdText,
  hostName,
  isHeld,
  isLaneRow,
  lanePaused,
  lastStatusText,
  nextSlotText,
  paceText,
  platformOf,
  releaseNeedsWarning,
  rowSourcesText,
} from './hosts';

// v30 S1-WEB: one host's sheet (12 §9.4, §9.8): its pace (shared by every process through crawl_hosts), its hold and
// failures, its sources, and its robots.txt as the reader keeps it (status, Crawl-delay, the content signals and their
// ai-input, the sitemaps, the file itself). An admin holds it for some hours or releases its hold.
// v37 LANE (SP v37 PLAN W10): the Workday lane's sheet ("Workday (all sites)"): its gap, its pause and end, its 429s in
// a row, its last answer and its Workday sources; holding it holds every Workday site. A Workday site's sheet names the
// lane its requests take their turns on; its own row keeps its bot checks and an admin's hold of that site alone.
// v37 FIX-LANE (SP v37 FIXES-361 D2, D3, F6; the ux review's M3, M4): the lane's gap as it adapts and when it eases
// back, its 429s in the window, its breaker; while paused its next free slot is after the pause; a Workday site paused
// with all of Workday says so. Releasing a pause Workday asked for asks first (it can get this address blocked; the
// 429s still count). v37 FIX-LANE (the generic lane): every word names the lane's platform (platformOf: "Workday").

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm max-sm:grid-cols-1 max-sm:gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

/** A host's facts and its robots.txt (drawn without a server in the web tests). */
export function HostDetails({ host, now, onShowSources }: { host: AdminHost; now: number; onShowSources?: (host: string) => void }) {
  const hold = holdText(host, now);
  const robots = host.robots;
  const lane = isLaneRow(host);
  const paused = lanePaused(host, now);
  return (
    <div className="flex flex-col gap-6" data-host-details={host.host}>
      <section aria-labelledby="host-pace">
        <h3 id="host-pace" className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          Pace and holds
        </h3>
        <dl className="mt-1 divide-y divide-divider-soft">
          <Fact label={lane ? 'Gap' : 'Pace'}>{lane ? gapText(host, now) : paceText(host.minIntervalMs)}</Fact>
          {host.lane && <Fact label="Lane">{`${host.lane}: one request at a time for every ${platformOf(host)} site`}</Fact>}
          <Fact label="Next free slot">{nextSlotText(host, now)}</Fact>
          <Fact label={lane ? 'Pause' : 'Hold'}>
            {hold ??
              (paused && host.laneHoldUntil ? (
                `Paused with all of ${platformOf(host)} until ${clockText(host.laneHoldUntil, now)}`
              ) : (
                <span className="text-muted-foreground">{lane ? 'Not paused' : 'Not held'}</span>
              ))}
          </Fact>
          <Fact label={failuresLabel(host)}>{host.consecutiveFailures.toLocaleString('en-US')}</Fact>
          {lane && <Fact label="Breaker">{breakerText(host, now)}</Fact>}
          <Fact label="Last answer">{lastStatusText(host.lastStatus)}</Fact>
          <Fact label="Sources">
            <span className="flex flex-wrap items-center gap-2">
              {rowSourcesText(host)}
              {onShowSources && host.sources > 0 && !lane && (
                <Button variant="link" onClick={() => onShowSources(host.host)}>
                  See its sources
                </Button>
              )}
            </span>
          </Fact>
          {host.optedOut && (
            <Fact label="Opt-out">
              <Badge tone="warning">Opted out: never read</Badge>
            </Fact>
          )}
          <Fact label="Updated">{relativeTime(host.updatedAt, now)}</Fact>
        </dl>
      </section>
      <section aria-labelledby="host-robots">
        <h3 id="host-robots" className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          robots.txt
        </h3>
        {lane ? (
          <p className="mt-2 text-sm text-muted-foreground">{`Each ${platformOf(host)} site keeps its own robots.txt: open the site's row.`}</p>
        ) : robots ? (
          <>
            <dl className="mt-1 divide-y divide-divider-soft">
              <Fact label="Status">
                {ROBOTS_STATUS_LABEL[robots.status]}
                {robots.httpStatus !== null && <span className="text-muted-foreground"> (HTTP {robots.httpStatus})</span>}
              </Fact>
              <Fact label="Read">{relativeTime(robots.fetchedAt, now)}</Fact>
              <Fact label="Crawl-delay">{crawlDelayText(robots.crawlDelaySeconds)}</Fact>
              <Fact label="AI">{aiInputText(robots)}</Fact>
              <Fact label="Content signals">
                {robots.contentSignals ? <code className="font-mono text-xs break-all">{robots.contentSignals}</code> : <span className="text-muted-foreground">None</span>}
              </Fact>
              <Fact label="Sitemaps">
                {robots.sitemaps.length ? (
                  <ul className="flex flex-col gap-0.5">
                    {robots.sitemaps.map((sitemap) => (
                      <li key={sitemap} className="font-mono text-xs break-all">
                        {sitemap}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </Fact>
            </dl>
            {robots.rules !== null && (
              <pre
                aria-label={`robots.txt of ${host.host}`}
                tabIndex={0}
                className="mt-3 max-h-80 overflow-auto rounded-control border border-border bg-surface-low px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground"
              >
                {robots.rules || '(empty file)'}
              </pre>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Not read yet.</p>
        )}
      </section>
    </div>
  );
}

export function HostSheet({
  row,
  open,
  onOpenChange,
  now,
  onShowSources,
  onChanged,
}: {
  /** The row it was opened from (or a host named by the address, with no row yet). */
  row: AdminHostRow | { host: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now: number;
  onShowSources: (host: string) => void;
  onChanged: (host: AdminHost) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [hours, setHours] = useState('6');
  // v37 FIX-LANE (D2): the warning before a release of a pause the platform asked for; focus goes back to the footer.
  const [warning, setWarning] = useState(false);
  const releaseRef = useRef<HTMLButtonElement>(null);
  const holdRef = useRef<HTMLButtonElement>(null);
  const name = row?.host ?? '';
  const detail = useQuery({
    queryKey: hostKeys.detail(name),
    queryFn: ({ signal }) => fetchHost(name, signal),
    enabled: open && name !== '',
  });
  const change = useMutation({
    mutationFn: (body: Parameters<typeof holdHost>[1]) => holdHost(name, body),
    // The sheet's foot says the new state (a status line read aloud); no toast over its buttons.
    onSuccess: (host) => {
      queryClient.setQueryData(hostKeys.detail(host.host), host);
      onChanged(host);
    },
    onError: (error) => toast.error('The host was not changed', userMessage(error)),
  });
  const host = detail.data ?? null;
  const held = host ? isHeld(host, now) : false;

  return (
    <RowDetailSheet
      item={row}
      open={open}
      onOpenChange={onOpenChange}
      title={(item) => hostName(item)}
      description={
        row && 'label' in row && row.label ? `Every ${platformOf(row)} site takes its turns here: a 429 pauses them all.` : 'One pace and one hold for every reader.'
      }
      footer={() =>
        host ? (
          <div className="flex flex-wrap items-end justify-end gap-2">
            {/* One status line for both states, so a hold or a release is read aloud where it shows. */}
            <p role="status" className="mr-auto self-center text-[13px] text-muted-foreground">
              {held
                ? (holdText(host, now) ?? holdReasonText(host))
                : lanePaused(host, now) && host.laneHoldUntil
                  ? `Paused with all of ${platformOf(host)} until ${clockText(host.laneHoldUntil, now)}`
                  : isLaneRow(host)
                    ? 'Not paused'
                    : 'Not held'}
            </p>
            {held ? (
              <Button
                ref={releaseRef}
                variant="outline"
                loading={change.isPending}
                onClick={() => (releaseNeedsWarning(host) ? setWarning(true) : change.mutate({ action: 'release' }))}
              >
                Release the hold
              </Button>
            ) : (
              <>
                <Field label="Hold for" className="w-40">
                  <Select options={HOLD_CHOICES} value={hours} onValueChange={setHours} />
                </Field>
                <Button ref={holdRef} variant="destructive-outline" loading={change.isPending} onClick={() => change.mutate({ action: 'hold', hours: Number(hours) })}>
                  {isLaneRow(host) ? `Hold all of ${platformOf(host)}` : 'Hold the host'}
                </Button>
              </>
            )}
            {/* v37 FIX-LANE (D2): inside the sheet, so the question opens over it and focus comes back to its foot. */}
            <ConfirmDialog
              open={warning}
              onOpenChange={setWarning}
              title={`Release ${platformOf(host)}'s pause?`}
              description={
                host.holdUntil
                  ? `${platformOf(host)} asked TailorIT to slow down until ${clockText(host.holdUntil, now)}. Releasing early can get this address blocked by ${platformOf(host)}, and its 429s still count.`
                  : `${platformOf(host)} asked TailorIT to slow down. Releasing early can get this address blocked by ${platformOf(host)}, and its 429s still count.`
              }
              confirmLabel="Release anyway"
              busyLabel="Releasing..."
              cancelLabel="Keep the pause"
              focusCancel
              finalFocus={() => releaseRef.current ?? holdRef.current ?? true}
              onConfirm={async () => {
                await change.mutateAsync({ action: 'release' });
              }}
            />
          </div>
        ) : null
      }
    >
      {() =>
        detail.error ? (
          <Notice tone="error" title="The host didn't load.">
            {userMessage(detail.error)}
          </Notice>
        ) : host ? (
          <HostDetails host={host} now={now} onShowSources={onShowSources} />
        ) : (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        )
      }
    </RowDetailSheet>
  );
}
