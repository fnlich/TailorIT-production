'use client';

import {
  COMPANY_MATCH_REVIEW_KINDS,
  type AdminCompanyMatchReview,
  type CompanyMatchReviewKind,
} from '@tailorit/shared/companies';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { JOB_SOURCE_KIND_LABEL, type JobSourceKind } from '@tailorit/shared/sourcing';
import { useRef, useState, type ReactNode } from 'react';
import { AdminResourceTab, ShowMoreButton, type AdminColumn } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ShieldCheckIcon } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { focusSoon } from '@/lib/focusLater';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { companiesAdminKeys, decideCompanyReview, fetchCompanyReviews, reopenCompanyReview, type ReviewStatusFilter } from './api';
import { reviewKindLabel } from './fields';

// v30 E0-WEB: the match review queue (13-company-enrichment.md §5.5): merges, homonyms and the domain, Wikidata and
// board matches below the automatic threshold, each with both sides' evidence, to accept or reject. The threshold is a
// constant (COMPANY_MATCH_AUTO_MIN), set so the queue stays small.

const PAGE_SIZE = 50;
const STATUS_TONE = { open: 'sky', accepted: 'success', rejected: 'neutral' } as const;
const STATUS_LABEL = { open: 'Open', accepted: 'Accepted', rejected: 'Rejected' } as const;

/** One piece of a candidate's evidence as words: a key and its value ("domain: acme.com"). */
export function evidenceLines(candidate: Record<string, unknown>): Array<{ key: string; value: string }> {
  return Object.entries(candidate)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      key: key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase(),
      value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value),
    }));
}

/**
 * "Greenhouse board x2" for a board alias ("greenhouse:x2"); the alias itself when its platform is not a source kind.
 * v30 FIX-WEB (REV-UX UX-13).
 */
export function boardWords(alias: string): string {
  const colon = alias.indexOf(':');
  if (colon <= 0) return alias;
  const kind = alias.slice(0, colon) as JobSourceKind;
  const label = (JOB_SOURCE_KIND_LABEL as Record<string, string>)[kind];
  return label ? `${label} board ${alias.slice(colon + 1)}` : alias;
}

/**
 * v30 FIX-WEB (REV-UX UX-13): the candidate's keys in the order that names what differs, by kind: a board joined by name
 * is its board (its name is the company's own), a website its domain, a Wikidata item its label and id.
 */
const OTHER_SIDE_KEYS: Record<string, readonly string[]> = {
  board_by_name: ['board', 'name', 'label', 'value'],
  domain: ['domain', 'website', 'name', 'label', 'value'],
  wikidata: ['label', 'qid', 'name', 'value'],
};
const DEFAULT_KEYS = ['name', 'label', 'domain', 'website', 'board', 'qid', 'value'];

/** The other side of a review: the other company, else what the candidate brings (a board, a website, a Wikidata item). */
export function otherSide(review: Pick<AdminCompanyMatchReview, 'otherCompany' | 'candidate'> & { kind?: AdminCompanyMatchReview['kind'] }): string {
  if (review.otherCompany) return review.otherCompany.name;
  const candidate = review.candidate;
  for (const key of (review.kind && OTHER_SIDE_KEYS[review.kind]) ?? DEFAULT_KEYS) {
    const value = candidate[key];
    if (typeof value === 'string' && value.trim()) return key === 'board' ? boardWords(value.trim()) : value.trim();
  }
  return 'A candidate';
}

/** v30 FIX-WEB (UX-13): what rejecting a review does, said before it is done. */
export function rejectWords(review: Pick<AdminCompanyMatchReview, 'kind' | 'company' | 'otherCompany' | 'candidate'>): { title: string; description: string } {
  const other = otherSide(review);
  if (review.kind === 'board_by_name') {
    return {
      title: `Reject: ${other} is not ${review.company.name}?`,
      description: `${other} and its jobs move to a company of their own. Reopen brings the review back; it does not move the board back.`,
    };
  }
  return {
    title: `Reject: ${other} is not ${review.company.name}?`,
    description: 'The two stay apart, and the matcher does not ask again. Reopen brings the review back.',
  };
}

export function MatchReviews({ viewSwitch, onOpenCompany }: { viewSwitch: ReactNode; onOpenCompany: (companyId: number) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [status, setStatus] = useState<ReviewStatusFilter>('open');
  const [kind, setKind] = useState<CompanyMatchReviewKind | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  // v30 FIX-WEB (UX-13): Reject asks first.
  const [rejecting, setRejecting] = useState<AdminCompanyMatchReview | null>(null);
  // v30 FIX-WEB (REV-UX UX-4): where focus goes once a decided row leaves the Open view: the next row, else the one before.
  const focusAfter = useRef<string[] | null>(null);
  // After a confirmed Reject, the confirm's own closing moves focus there (the dialog holds focus until it closes).
  const rejectTargets = useRef<string[] | null>(null);

  const reviews = useInfiniteQuery({
    queryKey: companiesAdminKeys.reviewList(status, kind),
    queryFn: ({ pageParam, signal }) => fetchCompanyReviews({ status, kind, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = reviews.data?.pages.flatMap((page) => page.items);
  const total = reviews.data?.pages[0]?.total;

  /** The selectors focus goes to after `review` is decided: the next row's first button, else the previous row's. */
  const neighbours = (review: AdminCompanyMatchReview): string[] => {
    const list = items ?? [];
    const index = list.findIndex((item) => item.id === review.id);
    const next = list[index + 1] ?? list[index - 1];
    const row = (id: number) => `table[aria-label="Company match reviews"] tr[data-admin-row="${id}"]`;
    return [
      ...(next ? [`${row(next.id)} [data-review-decide]`, `${row(next.id)} button`] : []),
      `${row(review.id)} [data-review-decide]`,
      `${row(review.id)} button`,
      '[aria-label="Review status"] [role="tab"][aria-selected="true"]',
      '[aria-label="Review status"] [role="tab"]',
    ];
  };

  const decide = useMutation({
    mutationFn: ({ review, decision }: { review: AdminCompanyMatchReview; decision: 'accept' | 'reject' | 'reopen' }) =>
      decision === 'reopen' ? reopenCompanyReview(review.id) : decideCompanyReview(review.id, { decision }),
    onMutate: ({ review }) => {
      focusAfter.current = neighbours(review);
    },
    onSuccess: (decided, { decision }) => {
      if (decision === 'reject') rejectTargets.current = focusAfter.current;
      const words = decided.status === 'accepted' ? 'Match accepted' : decided.status === 'rejected' ? 'Match rejected' : 'Match reopened';
      toast.success(words, `${decided.company.name}: ${reviewKindLabel(decided.kind)}`);
      void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.reviews });
      void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.lists });
      void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.company(decided.company.id) });
    },
    onError: (error) => toast.error('The review was not decided', userMessage(error)),
    onSettled: (_answer, _error, { decision }) => {
      const targets = focusAfter.current;
      focusAfter.current = null;
      if (targets && decision !== 'reject') focusSoon(targets);
    },
  });
  const busy = (review: AdminCompanyMatchReview) => decide.isPending && decide.variables?.review.id === review.id;

  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: AdminColumn<AdminCompanyMatchReview>[] = [
    {
      key: 'kind',
      header: 'Match',
      className: 'w-56',
      cell: (review) => (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{reviewKindLabel(review.kind)}</span>
          <span className="text-[13px] text-muted-foreground tabular-nums">{`Score ${review.score}`}</span>
        </div>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      cell: (review) => (
        <button type="button" onClick={() => onOpenCompany(review.company.id)} className="text-left font-semibold hover:underline">
          {review.company.name}
        </button>
      ),
    },
    {
      key: 'other',
      header: 'Other side',
      cell: (review) =>
        review.otherCompany ? (
          <button type="button" onClick={() => onOpenCompany(review.otherCompany!.id)} className="text-left font-medium hover:underline">
            {review.otherCompany.name}
          </button>
        ) : (
          <span className="break-all" data-other-side="">
            {otherSide(review)}
          </span>
        ),
    },
    {
      key: 'found',
      header: 'Found',
      className: 'w-32',
      cell: (review) => (
        <Tooltip content={new Date(review.createdAt).toLocaleString('en-US')}>
          <span className="text-[13px] text-muted-foreground">{relativeTime(review.createdAt, now)}</span>
        </Tooltip>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'w-36',
      cell: (review) => (
        <div>
          <Badge tone={STATUS_TONE[review.status]}>{STATUS_LABEL[review.status]}</Badge>
          {review.decidedBy && <p className="mt-1 truncate text-[13px] text-muted-foreground">{`by ${review.decidedBy}`}</p>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-72 text-right',
      cell: (review) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button size="sm" variant="ghost" aria-expanded={expanded.has(review.id)} onClick={() => toggle(review.id)}>
            {expanded.has(review.id) ? 'Hide evidence' : 'Evidence'}
          </Button>
          {review.status === 'open' && (
            <>
              <Button
                size="sm"
                loading={busy(review)}
                focusableWhenDisabled
                onClick={() => decide.mutate({ review, decision: 'accept' })}
                aria-label={`Accept: ${review.company.name}, ${reviewKindLabel(review.kind)}`}
                data-review-decide=""
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy(review)}
                focusableWhenDisabled
                onClick={() => setRejecting(review)}
                aria-label={`Reject: ${review.company.name}, ${reviewKindLabel(review.kind)}`}
              >
                Reject
              </Button>
            </>
          )}
          {/* v30 FIX-WEB (UX-13): a rejected review can be taken back to the queue. */}
          {review.status === 'rejected' && (
            <Button
              size="sm"
              variant="outline"
              loading={busy(review)}
              focusableWhenDisabled
              onClick={() => decide.mutate({ review, decision: 'reopen' })}
              aria-label={`Reopen: ${review.company.name}, ${reviewKindLabel(review.kind)}`}
              data-review-decide=""
            >
              Reopen
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <AdminResourceTab
      title="Match reviews"
      description="Matches the matcher would not make alone: two companies that may be one, a name several companies share, a website, Wikidata item or second board joined by name. Accept takes the match; Reject keeps them apart."
      actions={viewSwitch}
      lead={
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SegmentedControl<ReviewStatusFilter>
            aria-label="Review status"
            size="sm"
            value={status}
            onValueChange={setStatus}
            items={[
              { value: 'open', label: status === 'open' && total !== undefined ? `Open (${total.toLocaleString('en-US')})` : 'Open' },
              { value: 'accepted', label: 'Accepted' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Select<'all' | CompanyMatchReviewKind>
            aria-label="Kind of match"
            options={[{ value: 'all', label: 'Every kind' }, ...COMPANY_MATCH_REVIEW_KINDS.map((value) => ({ value, label: reviewKindLabel(value) }))]}
            value={kind ?? 'all'}
            onValueChange={(value) => setKind(value === 'all' ? null : value)}
            className="w-64"
          />
        </div>
      }
      items={items}
      error={reviews.error}
      errorTitle="The match reviews could not be loaded"
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void reviews.refetch()}>
          Try again
        </Button>
      }
      empty={{
        icon: <ShieldCheckIcon size={22} />,
        title: status === 'open' ? 'No match waits for a decision' : 'No match reviews here',
        description: status === 'open' ? 'When the matcher is not sure two records are one company, it asks here.' : undefined,
      }}
      tableLabel="Company match reviews"
      columns={columns}
      getKey={(review) => review.id}
      expanded={expanded}
      renderExpanded={(review) => {
        const lines = evidenceLines(review.candidate);
        if (lines.length === 0) return <p className="text-[13px] text-muted-foreground">No evidence was kept.</p>;
        return (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[180px_minmax(0,1fr)]" aria-label={`Evidence of review ${review.id}`}>
            {lines.map((line) => (
              <div key={line.key} className="contents">
                <dt className="text-muted-foreground">{line.key}</dt>
                <dd className="break-all text-foreground">{line.value}</dd>
              </div>
            ))}
          </dl>
        );
      }}
      tableClassName={clsx(reviews.isFetching && !reviews.isFetchingNextPage && 'opacity-70')}
      footer={
        // v30 FIX-WEB (UX-4): focus stays on the button while the next page loads. (UX-13's confirm is after the table.)
        <ShowMoreButton hasMore={reviews.hasNextPage} loading={reviews.isFetchingNextPage} onMore={() => void reviews.fetchNextPage()} afterLast={['table[aria-label="Company match reviews"] tbody tr:last-of-type button', 'table[aria-label="Company match reviews"] tbody tr:last-of-type [role="checkbox"]']}>
          Show more reviews
        </ShowMoreButton>
      }
    >
      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={rejecting ? rejectWords(rejecting).title : ''}
        description={rejecting ? rejectWords(rejecting).description : undefined}
        confirmLabel="Reject"
        busyLabel="Rejecting…"
        // Once rejected, the row leaves the Open view: focus goes to the next row instead of the opener.
        finalFocus={() => {
          const targets = rejectTargets.current;
          rejectTargets.current = null;
          for (const selector of targets ?? []) {
            const target = document.querySelector<HTMLElement>(selector);
            if (target) return target;
          }
          return true;
        }}
        onConfirm={async () => {
          if (!rejecting) return;
          await decide.mutateAsync({ review: rejecting, decision: 'reject' });
        }}
      />
    </AdminResourceTab>
  );
}
