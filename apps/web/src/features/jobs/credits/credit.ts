import type { JobCredit } from '@tailorit/shared';

// v30 S4: the credit line a job's source asks for (docs/design/part2/12-job-sourcing.md §3.6-3.7; owner question 10,
// accepted): "Source: Himalayas", its name a link to the source when the source gives one. The API fills the job's
// `credit` (JobSummary.credit, from the source kind's attribution); a job whose source asks for none has no line.
// Pure, so the unit tests read it without a page.

/** The words before the source's name. */
export const CREDIT_LEAD = 'Source:';

/** What the line shows: the source's name, and its https link (null: the name alone). */
export interface CreditLine {
  text: string;
  href: string | null;
}

/** The line of a job's credit, or null when it has none (or none the page can show). */
export function creditLine(credit: JobCredit | null | undefined): CreditLine | null {
  const text = credit?.text.trim();
  if (!credit || !text) return null;
  const href = credit.url && /^https:\/\/\S+$/i.test(credit.url) ? credit.url : null;
  return { text, href };
}

/** The line as one sentence, for a screen reader's name of the link or a plain copy ("Source: Himalayas"). */
export function creditSentence(line: CreditLine): string {
  return `${CREDIT_LEAD} ${line.text}`;
}

/**
 * v30 FIX-WEB (REQ-1): the credit of a Saved, Queue or Tracker item: FIX-B adds an optional `credit` to them (as on
 * JobSummary); an answer without it has none.
 */
export function creditOf(item: object): JobCredit | null {
  const credit = (item as { credit?: JobCredit | null }).credit;
  return credit && typeof credit === 'object' && typeof credit.text === 'string' ? credit : null;
}
