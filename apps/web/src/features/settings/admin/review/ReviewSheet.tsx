'use client';

import {
  JOB_REVIEW_NOTE_MAX,
  REVIEW_CHECK_LABEL,
  REVIEW_SIGNAL_LABEL,
  type AdminReviewDetail,
  type AdminReviewRow,
  type ReviewDecision,
} from '@tailorit/shared/reviews';
import { JOB_SOURCE_KIND_LABEL } from '@tailorit/shared/sourcing';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { ArrowCounterClockwiseIcon, ArrowSquareOutIcon, CheckIcon, XIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { RowDetailSheet, StateLine } from '../../../../components/queue';
import { fetchReview, reviewKeys } from './api';
import {
  checkLine,
  COMPANY_MATCH_LABEL,
  distanceText,
  linkStateText,
  noteProblem,
  offerText,
  originLine,
  reviewStateLine,
  rowName,
  STRENGTH_LABEL,
  VIA_LABEL,
} from './copy';
import { ReportersDisclosure } from './Reporters';

// v30 X1-WEB: a review's evidence (14 §6.2, "The detail sheet"), on components/queue's RowDetailSheet: each report
// (signal, marker, how it came, when; who reported, on expand, administrators only), TailorIT's check, the job's
// links and their state, and for a new job its posting (the API's sanitised HTML), the likely duplicates, the company
// match and what approving offers to discovery; then the decision, with an optional note.

/** The posting's own HTML, in the Jobs page's type scale (sanitised by the API). */
const POSTING_HTML = clsx(
  'text-sm leading-6 text-foreground break-words',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_h1]:mt-4 [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
  '[&_a]:text-primary-ink [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_b]:font-semibold',
);

export interface ReviewSheetProps {
  row: AdminReviewRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onDecide: (row: AdminReviewRow, decision: ReviewDecision, note: string) => void;
}

export function ReviewSheet({ row, open, onOpenChange, busy, onDecide }: ReviewSheetProps) {
  const [note, setNote] = useState('');
  const { t } = usePublicConstants();
  const problem = noteProblem(note, JOB_REVIEW_NOTE_MAX, (max) => t('MSG_TEXT_TOO_LONG', { max }));
  const change = (next: boolean) => {
    if (!next) setNote('');
    onOpenChange(next);
  };
  const decide = (item: AdminReviewRow, decision: ReviewDecision) => {
    if (problem) return;
    onDecide(item, decision, note.trim());
  };
  return (
    <RowDetailSheet
      item={row}
      open={open}
      onOpenChange={change}
      title={(item) => rowName(item.job)}
      description={row ? (originLine(row) ?? 'A posting reported as closed') : undefined}
      className="sm:max-w-[560px]!"
      footer={(item) =>
        item.state === 'pending' ? (
          <>
            <Button
              variant="outline"
              icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
              disabled={busy || problem !== null}
              onClick={() => decide(item, 'reject')}
            >
              Reject
            </Button>
            <Button icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />} loading={busy} disabled={problem !== null} onClick={() => decide(item, 'approve')}>
              Approve
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            icon={<ArrowCounterClockwiseIcon size={14} aria-hidden="true" />}
            loading={busy}
            disabled={problem !== null}
            onClick={() => decide(item, 'reopen')}
          >
            Reopen
          </Button>
        )
      }
    >
      {(item) => <SheetBody row={item} note={note} onNote={setNote} problem={problem} />}
    </RowDetailSheet>
  );
}

function Section({ title, children, mark }: { title: string; children: ReactNode; mark: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2" data-sheet-section={mark}>
      <h3 id={id} className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function SheetBody({ row, note, onNote, problem }: { row: AdminReviewRow; note: string; onNote: (note: string) => void; problem: string | null }) {
  const now = useNow();
  const detail = useQuery({ queryKey: reviewKeys.detail(row.id), queryFn: ({ signal }) => fetchReview(row.id, signal) });
  const line = reviewStateLine(row);
  const name = rowName(row.job);
  return (
    <div className="flex flex-col gap-6" data-review-sheet={row.id}>
      <div>
        <StateLine icon={line.icon} text={line.text} detail={line.detail} tone={line.tone} />
        {row.decidedAt && <p className="mt-1 text-[13px] text-muted-foreground">Decided {relativeTime(row.decidedAt, now)}</p>}
      </div>
      {detail.isError ? (
        <Notice
          tone="error"
          title="The evidence could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(detail.error)}
        </Notice>
      ) : !detail.data ? (
        <div aria-busy="true" aria-label="Loading the evidence" className="flex flex-col gap-3">
          <Skeleton className="h-4 w-1/3" />
          <SkeletonText lines={3} />
          <Skeleton className="h-4 w-1/4" />
          <SkeletonText lines={2} />
        </div>
      ) : (
        <Evidence detail={detail.data} now={now} name={name} />
      )}
      <Field label="Note" optional error={problem ?? undefined} hint="Kept with the decision. Plain text.">
        <Textarea value={note} rows={2} onChange={(event) => onNote(event.target.value)} data-review-note="" />
      </Field>
    </div>
  );
}

/** The sheet's evidence (exported for the web tests: v30 FIX-WEB, INT-3 #12's check history and "Reopened by its source"). */
export function Evidence({ detail, now, name }: { detail: AdminReviewDetail; now: number; name: string }) {
  const check = checkLine(detail);
  return (
    <>
      <Section title={`Reports (${detail.reports.length})`} mark="reports">
        {detail.reports.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No report is left on it.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Reports">
            {detail.reports.map((report, index) => (
              <li key={`${report.createdAt}-${index}`} className="rounded-control border border-border px-3 py-2 text-[13px] leading-5" data-report="">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-foreground">
                  {report.signal ? REVIEW_SIGNAL_LABEL[report.signal] : VIA_LABEL[report.via]}
                  {report.strength && (
                    <Badge tone={report.strength === 'weak' ? 'neutral' : 'tint'}>{STRENGTH_LABEL[report.strength]}</Badge>
                  )}
                </p>
                <p className="text-muted-foreground">
                  {report.signal ? `${VIA_LABEL[report.via]} · ` : ''}
                  {relativeTime(report.seenAt, now)}
                  {report.marker && (
                    <>
                      {' · Marker '}
                      <code className="rounded-tag bg-surface-muted px-1 text-xs">{report.marker}</code>
                    </>
                  )}
                </p>
                {report.details && <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{report.details}</p>}
                {!report.trusted && <p className="mt-1 text-muted-foreground">Does not count toward automatic decisions.</p>}
                {report.pageJobId !== null && <p className="mt-1 text-muted-foreground">Their own page job: #{report.pageJobId}</p>}
              </li>
            ))}
          </ul>
        )}
        <ReportersDisclosure reviewId={detail.id} count={detail.reporters} name={name} />
      </Section>

      {check && (
        <Section title="TailorIT's check" mark="check">
          <p className="text-[13px] text-foreground">
            {check}
            {detail.checkedAt && <span className="text-muted-foreground"> · {relativeTime(detail.checkedAt, now)}</span>}
          </p>
          {/* v30 INT-3 (decision 3): every re-check of the job, newest first (job_review_checks). */}
          {detail.checks && detail.checks.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-5 text-muted-foreground" aria-label="TailorIT's checks" data-review-checks="">
              {detail.checks.map((entry, index) => (
                <li key={`${entry.checkedAt}-${index}`}>
                  <span className="text-foreground">{REVIEW_CHECK_LABEL[entry.state]}</span> · {relativeTime(entry.checkedAt, now)}
                  {entry.sourceMadeDue && ' · its source was asked to list it again'}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {detail.reopenedAt && (
        <Section title="Reopened by its source" mark="reopened">
          <p className="text-[13px] text-foreground" data-review-reopened="">
            A source listed the job again {relativeTime(detail.reopenedAt, now)}, after this report was approved.
          </p>
        </Section>
      )}

      <Section title="Links" mark="links">
        {detail.links.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No source lists this job: the reports are about the job as a whole.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="The job's links">
            {detail.links.map((link) => (
              <li key={`${link.sourceId}:${link.sourceJobId}`} className="text-[13px] leading-5" data-link={link.state}>
                <p className="flex flex-wrap items-center gap-x-2 font-medium text-foreground">
                  <span className="break-all">
                    {JOB_SOURCE_KIND_LABEL[link.sourceKind]} · {link.sourceName}
                  </span>
                  {link.reported && <Badge tone="sky">Named in the reports</Badge>}
                </p>
                <p className="text-muted-foreground">
                  {linkStateText(link, link.missingSince ? relativeTime(link.missingSince, now) : null)}
                  {' · '}
                  {link.lastVerifiedAt ? `Last verified ${relativeTime(link.lastVerifiedAt, now)}` : 'Never verified'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {detail.posting && (
        <Section title="The posting" mark="posting">
          <div className="text-[13px] leading-5">
            <p className="font-medium text-foreground">{detail.posting.title}</p>
            <p className="text-muted-foreground">
              {[detail.posting.companyName, ...detail.posting.locations].filter(Boolean).join(' · ')}
            </p>
          </div>
          {detail.posting.descriptionHtml ? (
            <div
              className={clsx(POSTING_HTML, 'max-h-80 overflow-y-auto rounded-control border border-border p-3')}
              // The API's sanitised posting HTML (as the Jobs page draws it); a page job's text arrives escaped.
              dangerouslySetInnerHTML={{ __html: detail.posting.descriptionHtml }}
              data-review-posting=""
              tabIndex={0}
              role="region"
              aria-label="The posting's text"
            />
          ) : (
            <p className="text-[13px] text-muted-foreground">The posting has no text.</p>
          )}
          {/^https?:\/\//i.test(detail.posting.applyUrl) && (
            <a
              href={detail.posting.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 self-start text-[13px] font-medium text-primary-ink underline underline-offset-2"
            >
              Open the original posting
              <ArrowSquareOutIcon size={12} aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </Section>
      )}

      {detail.kind === 'new_job' && (
        <Section title="Likely duplicates" mark="duplicates">
          {detail.duplicates.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No open job of this company looks the same.</p>
          ) : (
            <ul className="flex flex-col gap-1.5" aria-label="Likely duplicates">
              {detail.duplicates.map((duplicate) => {
                const distance = distanceText(duplicate.distanceBits);
                return (
                  <li key={duplicate.jobId} className="text-[13px] leading-5">
                    <Link href={`/jobs?jobId=${duplicate.jobId}`} className="font-medium text-foreground hover:underline">
                      {duplicate.title}
                    </Link>
                    <span className="text-muted-foreground">
                      {' '}
                      · {duplicate.companyName}
                      {duplicate.postedAt && ` · posted ${relativeTime(duplicate.postedAt, now)}`}
                      {distance && ` · ${distance}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {detail.company && (
        <Section title="Company" mark="company">
          <p className="text-[13px] leading-5 text-foreground">
            <span className="font-medium">{detail.company.name}</span>
            <span className="text-muted-foreground"> · {COMPANY_MATCH_LABEL[detail.company.resolvedBy]}</span>
          </p>
          {detail.company.doNotFetch && (
            <Notice tone="warning">This company opted out: it is never approved automatically, and its board never becomes a source.</Notice>
          )}
        </Section>
      )}

      {detail.offersToDiscovery && (
        <p className="text-[13px] leading-5 text-muted-foreground" data-review-offer="">
          {offerText(detail.offersToDiscovery)}
        </p>
      )}
    </>
  );
}
