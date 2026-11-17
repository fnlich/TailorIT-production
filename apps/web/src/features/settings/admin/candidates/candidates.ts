import {
  DISCOVERY_OFF_LABEL,
  JOB_SOURCE_CANDIDATE_STATUS_LABEL,
  JOB_SOURCE_DISCOVERED_VIA_LABEL,
  JOB_SOURCE_KIND_LABEL,
  type AdminCandidatesAddResult,
  type AdminCandidatesBulkResult,
  type CandidateFunnel,
  type JobSourceCandidate,
  type JobSourceCandidateStatus,
  type JobSourceKind,
} from '@tailorit/shared/sourcing';
import type { BadgeTone } from '@/components/ui/Badge';
import { countLabel } from '../../../../lib/format';
import { formatCount } from '../sources/sources';
import type { CandidateBulkAction } from './api';

// v30 S2: the words Admin › Candidates shows (docs/design/part2/12-job-sourcing.md §4): a candidate's state and its
// next try, the funnel (found, waiting, became sources, not found, not allowed, dropped), why validation is off,
// Common Crawl's progress, a board's open life, and what retry, drop and Add boards did. Pure.

/** A candidate state's badge tone. */
export const STATUS_TONE: Record<JobSourceCandidateStatus, BadgeTone> = {
  new: 'sky',
  valid: 'success',
  empty: 'tint',
  not_found: 'neutral',
  forbidden: 'destructive',
  error: 'warning',
  dropped: 'outline',
};

/** The funnel's steps, in the order a board moves through them. */
export const FUNNEL_ORDER: readonly JobSourceCandidateStatus[] = ['new', 'error', 'not_found', 'valid', 'empty', 'forbidden', 'dropped'];

/** "Jan 5, 3:00 PM": a next try or a check, in the viewer's time. */
function whenText(value: string): string {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Whether validation reads boards now, and the kinds it does not read yet (P6.1: the v2.0 kinds validate with today's
 * identity; every new kind waits for BOT_USER_AGENT). v30 FIX-WEB (REV-UX UX-12).
 */
export interface ValidationState {
  on: boolean;
  waitingKinds: readonly JobSourceKind[];
}

/** The funnel's validation as a ValidationState (on, nothing waiting, when an older server says nothing). */
export function validationStateOf(funnel: Pick<CandidateFunnel, 'validation'> | null | undefined): ValidationState {
  const validation = funnel?.validation;
  if (!validation) return { on: true, waitingKinds: [] };
  return { on: validation.on, waitingKinds: validation.waitingKinds };
}

/**
 * A candidate's state in a line: its words, its tries, and when it is read next (or why it never is). v30 FIX-WEB
 * (REV-UX UX-12): while validation is off, or does not read the candidate's kind yet, a waiting candidate says so
 * instead of promising the next pass.
 */
export function statusLine(
  candidate: Pick<JobSourceCandidate, 'status' | 'attempts' | 'nextCheckAt'> & { kind?: JobSourceKind },
  now: number,
  validation: ValidationState = { on: true, waitingKinds: [] },
): string {
  const label = JOB_SOURCE_CANDIDATE_STATUS_LABEL[candidate.status];
  const tries = candidate.attempts > 1 ? `, ${candidate.attempts} tries in a row` : '';
  if (candidate.status === 'new' || candidate.status === 'error' || candidate.status === 'not_found') {
    if (!validation.on) return `${label}${tries}; validation is off`;
    if (candidate.kind && validation.waitingKinds.includes(candidate.kind)) {
      return `${label}${tries}; ${JOB_SOURCE_KIND_LABEL[candidate.kind]} boards are not validated yet`;
    }
    if (!candidate.nextCheckAt) return `${label}${tries}`;
    const due = Date.parse(candidate.nextCheckAt) <= now;
    return `${label}${tries}; ${due ? 'read at the next pass' : `next try ${whenText(candidate.nextCheckAt)}`}`;
  }
  return `${label}${tries}`;
}

/** "Greenhouse", "Workday career site": a candidate's kind. */
export const kindText = (candidate: Pick<JobSourceCandidate, 'kind'>) => JOB_SOURCE_KIND_LABEL[candidate.kind];

/** "Common Crawl, seen 3 times". */
export function foundText(candidate: Pick<JobSourceCandidate, 'discoveredVia' | 'seenCount'>): string {
  const seen = candidate.seenCount > 1 ? `, seen ${formatCount(candidate.seenCount)} times` : '';
  return `${JOB_SOURCE_DISCOVERED_VIA_LABEL[candidate.discoveredVia]}${seen}`;
}

/** "12 days" (one decimal under 10), or null when nothing closed yet. */
export function openLifeText(days: number | null | undefined): string | null {
  if (days === null || days === undefined) return null;
  const rounded = days < 10 ? Math.round(days * 10) / 10 : Math.round(days);
  return `${rounded.toLocaleString('en-US')} ${rounded === 1 ? 'day' : 'days'}`;
}

/** The source column: the board's open jobs now and how long its jobs stay open, once it is a source. */
export function sourceText(candidate: Pick<JobSourceCandidate, 'sourceId' | 'sourceOpenJobs' | 'openLifeDays' | 'openJobs' | 'sourceEnabled'>): string | null {
  if (candidate.sourceId === null) return null;
  const open = candidate.sourceOpenJobs ?? candidate.openJobs ?? null;
  const parts = [open === null ? null : countLabel(open, 'open job', 'open jobs')];
  const life = openLifeText(candidate.openLifeDays);
  if (life) parts.push(`jobs stay open about ${life}`);
  if (candidate.sourceEnabled === false) parts.push('paused');
  return parts.filter(Boolean).join(', ') || 'A source';
}

/** The funnel's counts as rows (label, count, state), in FUNNEL_ORDER, with the total found first. */
export function funnelRows(funnel: CandidateFunnel): Array<{ status: JobSourceCandidateStatus | 'all'; label: string; count: number }> {
  const counts = new Map(funnel.byStatus.map((row) => [row.status, row.count]));
  const total = funnel.byStatus.reduce((sum, row) => sum + row.count, 0);
  return [
    { status: 'all', label: 'Found', count: total },
    ...FUNNEL_ORDER.map((status) => ({ status, label: JOB_SOURCE_CANDIDATE_STATUS_LABEL[status], count: counts.get(status) ?? 0 })),
  ];
}

/** The signals that found boards, most first (those with none left out). */
export function viaRows(funnel: CandidateFunnel): Array<{ label: string; count: number }> {
  return funnel.byVia
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((row) => ({ label: JOB_SOURCE_DISCOVERED_VIA_LABEL[row.discoveredVia], count: row.count }));
}

/** Validation's line: on with today's reads against the cap, or off and why. */
export function validationText(funnel: CandidateFunnel): { on: boolean; text: string } {
  const validation = funnel.validation;
  const today = `${formatCount(funnel.validatedToday)} of ${formatCount(validation?.cap ?? 0)} board reads today`;
  if (!validation) return { on: true, text: today };
  if (!validation.on && validation.reason) return { on: false, text: `${DISCOVERY_OFF_LABEL[validation.reason]}. ${today}.` };
  const waiting = validation.waitingKinds.length
    ? ` Waiting, not read yet: ${validation.waitingKinds.map((kind) => JOB_SOURCE_KIND_LABEL[kind]).join(', ')}.`
    : '';
  return { on: true, text: `Validating: ${today}.${waiting}` };
}

/** Common Crawl's line: the crawl read and how far, or that none was read yet. */
export function crawlText(funnel: CandidateFunnel): string | null {
  const crawl = funnel.commonCrawl;
  if (!crawl) return null;
  if (!crawl.crawl) return 'Common Crawl: no crawl read yet.';
  if (crawl.done) return `Common Crawl: ${crawl.crawl} read through.`;
  return `Common Crawl: reading ${crawl.crawl}, host ${Math.min(crawl.query + 1, crawl.queries)} of ${crawl.queries}.`;
}

/** Name probes' line: off (with the measure owner question 17 waits for), or their daily cap. */
export function probesText(funnel: CandidateFunnel): string | null {
  if (funnel.probesPerHost === undefined) return null;
  const without = funnel.companiesWithoutBoard === undefined ? '' : ` ${countLabel(funnel.companiesWithoutBoard, 'company', 'companies')} with open jobs ${funnel.companiesWithoutBoard === 1 ? 'has' : 'have'} no known board.`;
  return funnel.probesPerHost > 0
    ? `Name probes: ${formatCount(funnel.probesPerHost)} guesses a day per job board.${without}`
    : `Name probes: off.${without}`;
}

/** The bulk bar's buttons. */
export const CANDIDATE_BULK_LABEL: Record<CandidateBulkAction, string> = { retry: 'Retry', drop: 'Drop' };
const DONE_WORDS: Record<CandidateBulkAction, string> = { retry: 'due for validation', drop: 'dropped' };

/** What a retry or drop did: "3 candidates dropped", with how many were skipped and the notice's tone. */
export function candidateBulkSummary(action: CandidateBulkAction, result: AdminCandidatesBulkResult): { title: string; description: string | null; tone: 'success' | 'warning' | 'error' } {
  const done = result.counts.done ?? 0;
  const skipped = result.counts.skipped ?? 0;
  const failed = result.counts.failed ?? 0;
  const title = done > 0 ? `${countLabel(done, 'candidate', 'candidates')} ${DONE_WORDS[action]}` : `No candidate ${DONE_WORDS[action]}`;
  const rest = [skipped ? `${skipped} skipped` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
  return { title, description: rest ? `${rest}.` : null, tone: failed > 0 && done === 0 ? 'error' : rest ? 'warning' : 'success' };
}

/** The entries of the Add boards box: one per line (or comma), trimmed, each once. */
export function parseEntries(text: string): string[] {
  return [...new Set(text.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

/**
 * v30 FIX-WEB (REV-UX UX-17): the entries that are neither a board's address nor a board's name (a name is one word of
 * letters, digits, dots, dashes or underscores): free text such as "not a board at all", which the server refuses
 * (counted as "not a board TailorIT reads"), said before it is sent.
 */
export function notBoardEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => /\s/.test(entry) || !/^[a-z0-9][\w.:/?#=&%~+-]*$/i.test(entry));
}

const ADD_WORDS: Record<keyof AdminCandidatesAddResult['counts'], [string, string]> = {
  added: ['new candidate', 'new candidates'],
  bumped: ['seen again', 'seen again'],
  known_source: ['already a source', 'already sources'],
  forbidden: ['not allowed (opted out)', 'not allowed (opted out)'],
  refused: ['not a board TailorIT reads', 'not boards TailorIT reads'],
};

/** What Add boards did, in a line: "2 new candidates, 1 already a source". */
export function addSummary(result: AdminCandidatesAddResult): string {
  const parts = (Object.keys(ADD_WORDS) as Array<keyof typeof ADD_WORDS>)
    .filter((outcome) => (result.counts[outcome] ?? 0) > 0)
    .map((outcome) => {
      const count = result.counts[outcome]!;
      const [one, many] = ADD_WORDS[outcome];
      return `${formatCount(count)} ${count === 1 ? one : many}`;
    });
  return parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing was added.';
}
