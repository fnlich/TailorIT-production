import { z } from 'zod';
import { InstantSchema } from './common';
import { AUTOFILL_LOOKUP_URL_MAX, type AtsKind } from './lookup';

// Version 9 (v3.0, docs/design/part2/14-extension-reports.md): closed postings. The extension looks only in a posting
// page that is open anyway (one the person opened, or the auto-apply agent or the Queue tab opened), and only when
// TailorIT shows the job as open; it never fetches a job link in the background. A small function the extension's
// worker runs in that one document (outside the content script) reads the closed-list signals below and returns
// marker ids, one date and one yes or no: no text, no address, no field value leaves the page
// (AutofillClosedProbeResult). With the person's setting on (or the card's Report as closed button), the extension
// reports it: POST /api/autofill/jobs/:jobId/closed (scope jobs:add), AutofillClosedReportRequest, answered
// AutofillClosedReportResponse. The server reads a report's strength from this file's list
// (closedReportStrength), never from the extension's word, and weak signals never decide alone.

/**
 * How the extension saw that a posting looks closed: `marker`, a marker of AUTOFILL_CLOSED_MARKERS in the title or the
 * posting area; `valid_through_past`, a JobPosting block whose validThrough is before the check; `no_posting`, a page on
 * the job's own platform host that shows no posting, or no form in time (the agent's and the Queue tab's rule);
 * `redirected`, the agent's or the Queue tab's tab ended on the board's list page instead of the posting (with a
 * marker of kind `address` when the address carries the platform's error flag); `person`, the card's Report as
 * closed button.
 */
export const AUTOFILL_CLOSED_SIGNALS = ['marker', 'valid_through_past', 'no_posting', 'redirected', 'person'] as const;
export type AutofillClosedSignal = (typeof AUTOFILL_CLOSED_SIGNALS)[number];

/**
 * Where the extension saw it: `page`, a posting the person opened; `agent`, the background auto-apply agent's run;
 * `queue`, the Queue tab's run; `person`, the card's Report as closed button. (TailorIT's own Jobs page flag is the
 * server's `web`, never an extension's.)
 */
export const AUTOFILL_CLOSED_VIA = ['page', 'agent', 'queue', 'person'] as const;
export type AutofillClosedVia = (typeof AUTOFILL_CLOSED_VIA)[number];

/** How much a report counts: `weak` never decides alone; `person` is a person's own word; `strong` may decide. */
export const AUTOFILL_CLOSED_STRENGTHS = ['weak', 'person', 'strong'] as const;
export type AutofillClosedStrength = (typeof AUTOFILL_CLOSED_STRENGTHS)[number];

/** Where a marker is read: the document's title, the posting's main area (its text, at most 100,000 characters), or the address the tab ended on. */
export const AUTOFILL_CLOSED_MARKER_PLACES = ['title', 'posting', 'address'] as const;
export type AutofillClosedMarkerPlace = (typeof AUTOFILL_CLOSED_MARKER_PLACES)[number];

/**
 * How a marker's pattern matches (closedMarkerMatches): `phrase`, its words appear in the text, case and runs of white
 * space ignored; `regex`, an anchored regular expression with no nested quantifier and no back-reference (so it runs in
 * linear time), tested with the `i` flag on the text with its runs of white space made one space.
 */
export const AUTOFILL_CLOSED_MATCH_KINDS = ['phrase', 'regex'] as const;
export type AutofillClosedMatchKind = (typeof AUTOFILL_CLOSED_MATCH_KINDS)[number];

/**
 * One closed-list marker: its id (`<platform>.<name>`, or `generic.<name>`), the platform it belongs to (`any` for a
 * generic phrase), its strength, where it is read, how it matches, its pattern, and a sample it matches (the contract
 * test runs each marker on its sample). A platform marker ships only with a fixture of a closed posting in the
 * extension's repository (every hook is read from a snapshot); the generic phrases are weak, English only at first,
 * because a page can carry one in a sidebar about another job.
 */
export interface AutofillClosedMarker {
  id: string;
  platform: AtsKind | 'any';
  strength: Exclude<AutofillClosedStrength, 'person'>;
  where: AutofillClosedMarkerPlace;
  match: AutofillClosedMatchKind;
  pattern: string;
  sample: string;
}

/**
 * The closed list, passed to the extension's in-page function as its argument (it is JSON) and read by the server
 * for each report. Adding a marker comes with a new extension build; both sides pull this file.
 */
export const AUTOFILL_CLOSED_MARKERS = [
  // The extension's fixture: fixtures/smartrecruiters/bertelsmann-expired.html (a disabled button with these words).
  {
    id: 'smartrecruiters.expired',
    platform: 'smartrecruiters',
    strength: 'strong',
    where: 'posting',
    match: 'phrase',
    pattern: 'Sorry, this job has expired',
    sample: 'Sorry, this job has expired',
  },
  {
    id: 'generic.no_longer_accepting',
    platform: 'any',
    strength: 'weak',
    where: 'posting',
    match: 'phrase',
    pattern: 'no longer accepting applications',
    sample: 'This role is no longer accepting applications.',
  },
  {
    id: 'generic.job_expired',
    platform: 'any',
    strength: 'weak',
    where: 'posting',
    match: 'phrase',
    pattern: 'this job has expired',
    sample: 'We are sorry, but this job has expired.',
  },
  {
    id: 'generic.position_filled',
    platform: 'any',
    strength: 'weak',
    where: 'posting',
    match: 'phrase',
    pattern: 'this position has been filled',
    sample: 'Thank you for your interest. This position has been filled.',
  },
  {
    id: 'generic.job_not_found',
    platform: 'any',
    strength: 'weak',
    where: 'title',
    match: 'regex',
    pattern: '^(?:job|position|posting) not found\\b',
    sample: 'Job not found | Careers',
  },
] as const satisfies readonly AutofillClosedMarker[];

/** Every marker's id, in the list's order. */
export const AUTOFILL_CLOSED_MARKER_IDS = AUTOFILL_CLOSED_MARKERS.map((marker) => marker.id) as [
  AutofillClosedMarkerId,
  ...AutofillClosedMarkerId[],
];
export type AutofillClosedMarkerId = (typeof AUTOFILL_CLOSED_MARKERS)[number]['id'];

/** The marker with this id, or null. */
export function closedMarker(id: string | null | undefined): AutofillClosedMarker | null {
  return AUTOFILL_CLOSED_MARKERS.find((marker) => marker.id === id) ?? null;
}

/** Text as a phrase marker compares it: lower case, each run of white space one space, no white space at either end. */
export function foldClosedText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether `marker` matches `text` (the title, the posting area's text or the address, as its `where` says): the
 * reference meaning of a marker. The extension's in-page function cannot import this (a serialised function loses
 * its closure), so it does the same, and its tests run both on the same samples.
 */
export function closedMarkerMatches(marker: Pick<AutofillClosedMarker, 'match' | 'pattern'>, text: string): boolean {
  if (marker.match === 'phrase') return foldClosedText(text).includes(foldClosedText(marker.pattern));
  return new RegExp(marker.pattern, 'i').test(text.replace(/\s+/g, ' ').trim());
}

/** At most this many in-page checks a minute, across tabs (each document is checked at most twice). */
export const AUTOFILL_CLOSED_PROBES_PER_MINUTE = 6;
/**
 * A report is about the last day: the extension drops a queued report older than this, and the server takes a
 * `seenAt` no older than this (an older one counts as this old) and never later than its own clock.
 */
export const AUTOFILL_CLOSED_SEEN_WITHIN_HOURS = 24;

/**
 * What the in-page function returns, and nothing more: the ids of the markers it matched, the JobPosting block's
 * validThrough as written (a date or a date-time; null when there is none), and whether the page shows a posting at
 * all. A strict object: a result that carries anything else (text, an address) is refused, so it never travels on.
 */
export const AutofillClosedProbeResultSchema = z.strictObject({
  markers: z.array(z.enum(AUTOFILL_CLOSED_MARKER_IDS)).max(AUTOFILL_CLOSED_MARKERS.length),
  validThrough: z.string().max(40).nullable(),
  hasPosting: z.boolean(),
});
export type AutofillClosedProbeResult = z.infer<typeof AutofillClosedProbeResultSchema>;

/** The signals only a run the extension opened itself (the agent's, the Queue tab's) can see. */
const RUN_ONLY_SIGNALS: readonly AutofillClosedSignal[] = ['no_posting', 'redirected'];

/**
 * POST /api/autofill/jobs/:jobId/closed (version 9, scope jobs:add): the posting of TailorIT job `jobId` (the one the
 * lookup answered) looks closed. `url` is the posting's address as the lookup was asked with it (no session or
 * tracking parameter); `marker` names the marker of a `marker` signal (read in the title or the posting), and may name
 * an `address` marker of a `redirected` one; no other signal names one. `no_posting` and `redirected` come from the
 * agent or the Queue tab only; `person` is the button, and the button sends `person` only. `seenAt` is when the
 * extension saw it. Nothing else travels: no page text, no screenshot, no other address.
 */
export const AutofillClosedReportRequestSchema = z
  .object({
    url: z.string().min(1).max(AUTOFILL_LOOKUP_URL_MAX),
    signal: z.enum(AUTOFILL_CLOSED_SIGNALS),
    marker: z.enum(AUTOFILL_CLOSED_MARKER_IDS).optional(),
    via: z.enum(AUTOFILL_CLOSED_VIA),
    seenAt: InstantSchema,
  })
  .superRefine((report, ctx) => {
    const marker = closedMarker(report.marker);
    if (report.signal === 'marker') {
      if (!marker) ctx.addIssue({ code: 'custom', path: ['marker'], message: 'A marker signal names its marker' });
      else if (marker.where === 'address') {
        ctx.addIssue({ code: 'custom', path: ['marker'], message: 'An address marker goes with a redirected signal' });
      }
    } else if (report.signal === 'redirected') {
      if (marker && marker.where !== 'address') {
        ctx.addIssue({ code: 'custom', path: ['marker'], message: 'A redirected signal names an address marker only' });
      }
    } else if (marker) {
      ctx.addIssue({ code: 'custom', path: ['marker'], message: 'Only a marker or redirected signal names a marker' });
    }
    if ((report.signal === 'person') !== (report.via === 'person')) {
      ctx.addIssue({ code: 'custom', path: ['via'], message: 'The Report as closed button sends the person signal, and only it' });
    } else if (RUN_ONLY_SIGNALS.includes(report.signal) && report.via !== 'agent' && report.via !== 'queue') {
      ctx.addIssue({ code: 'custom', path: ['via'], message: 'Only the agent and the Queue tab see this signal' });
    }
  });
export type AutofillClosedReportRequest = z.infer<typeof AutofillClosedReportRequestSchema>;

/**
 * How much a report counts, from this file's list: `person` for the button; `strong` for a JobPosting's past
 * validThrough; a marker's own strength for a `marker` signal, and for a `redirected` one that names an address marker;
 * `weak` for `no_posting` and a bare `redirected`.
 */
export function closedReportStrength(report: Pick<AutofillClosedReportRequest, 'signal' | 'marker'>): AutofillClosedStrength {
  switch (report.signal) {
    case 'person':
      return 'person';
    case 'valid_through_past':
      return 'strong';
    case 'no_posting':
      return 'weak';
    case 'marker':
    case 'redirected':
      return closedMarker(report.marker)?.strength ?? 'weak';
  }
}

/**
 * The report's outcome: `queued`, the job's closed review was opened or bumped (an admin, or the automatic rules,
 * decide; every account's report is answered so, trusted or not); `closed`, the job was the account's own page job and
 * is closed now; `already_closed`, TailorIT shows the job as closed already.
 */
export const AUTOFILL_CLOSED_OUTCOMES = ['queued', 'closed', 'already_closed'] as const;
export type AutofillClosedOutcome = (typeof AUTOFILL_CLOSED_OUTCOMES)[number];

/** POST /api/autofill/jobs/:jobId/closed's answer (200). */
export const AutofillClosedReportResponseSchema = z.object({
  outcome: z.enum(AUTOFILL_CLOSED_OUTCOMES),
});
export type AutofillClosedReportResponse = z.infer<typeof AutofillClosedReportResponseSchema>;

/**
 * What POST /api/autofill/jobs/:jobId/closed refuses with, besides every token route's refusals, and the status of
 * each: `validation_failed` (a body this file refuses), `not_found` (no such job this account may see), and
 * `rate_limited` (the account's closed reports for the day are used up: the error's message is the server's words and
 * its `resetAt` the next daily reset; the extension stops its automatic reports until then, and the button shows the
 * words).
 */
export const AUTOFILL_CLOSED_REFUSALS = {
  validation_failed: 400,
  not_found: 404,
  rate_limited: 429,
} as const;
