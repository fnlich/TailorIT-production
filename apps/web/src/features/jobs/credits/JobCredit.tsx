import type { JobCredit as JobCreditValue } from '@tailorit/shared';
import { clsx } from 'clsx';
import { CREDIT_LEAD, creditLine } from './credit';

// v30 S4: a job's credit line, where its source's terms ask for one (12 §3.6-3.7): on the job's card in the list
// (below the card's link, since a link may not hold another) and in its detail, under the title's chips. The name
// links to the source in a new tab. Nothing for a job whose source asks for no credit.

function CreditText({ credit }: { credit: JobCreditValue | null | undefined }) {
  const line = creditLine(credit);
  if (!line) return null;
  return (
    <>
      {CREDIT_LEAD}{' '}
      {line.href ? (
        <a
          href={line.href}
          target="_blank"
          rel="noopener"
          className="font-medium underline underline-offset-2 hover:text-foreground"
          data-job-credit-link=""
        >
          {line.text}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="font-medium">{line.text}</span>
      )}
    </>
  );
}

/**
 * The feed row's credit line, under the row's words. v31 FIX-JOBS: the row's title link is stretched over the row, so
 * the line sits above it (`relative z-10`) and its own link stays its own.
 */
export function CardCredit({ credit, className }: { credit: JobCreditValue | null | undefined; className?: string }) {
  if (!creditLine(credit)) return null;
  return (
    <p className={clsx('relative z-10 w-fit max-w-full truncate text-xs leading-4 text-muted-foreground', className)} data-job-credit="card">
      <CreditText credit={credit} />
    </p>
  );
}

/** The detail's credit line, under the title's chips. */
export function DetailCredit({ credit, className }: { credit: JobCreditValue | null | undefined; className?: string }) {
  if (!creditLine(credit)) return null;
  return (
    <p className={clsx('text-[13px] leading-5 text-muted-foreground', className)} data-job-credit="detail">
      <CreditText credit={credit} />
    </p>
  );
}

/**
 * v30 FIX-WEB (REV-REQ REQ-1): a list row's credit line, where the job is kept rather than found: the company page's
 * positions, the Saved and Queue panes, the Tracker's cards and rows ("visible credit with a link", Himalayas' terms).
 * Inside a row that opens on a click, the link's own click stays the link's.
 */
export function RowCredit({ credit, className }: { credit: JobCreditValue | null | undefined; className?: string }) {
  if (!creditLine(credit)) return null;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <p
      className={clsx('truncate text-xs leading-4 text-muted-foreground', className)}
      data-job-credit="row"
      onClick={stop}
      onKeyDown={stop}
      onMouseDown={stop}
      onPointerDown={stop}
    >
      <CreditText credit={credit} />
    </p>
  );
}
