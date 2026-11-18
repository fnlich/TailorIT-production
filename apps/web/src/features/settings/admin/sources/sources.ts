import { SHEET_SOURCE_LABEL, SheetSourceConfigSchema, type SheetSourceConfig } from '@tailorit/shared/ingest';
import {
  JOB_SOURCE_ROBOTS_LABEL,
  JOB_SOURCE_RUNNABLE_ROBOTS,
  JOB_SOURCE_RUNNABLE_TERMS,
  JOB_SOURCE_TERMS_LABEL,
  type AdminSourceRow,
  type JobSourceKind,
  type JobSourceRobotsStatus,
  type JobSourceTermsStatus,
  type JobSourceTier,
} from '@tailorit/shared/sourcing';
import type { MessageRenderer } from '../../../../components/limits/limits';
import type { BadgeTone } from '../../../../components/ui/Badge';
import { formatDate } from '../../../../lib/format';
import type { AddableKind } from '../types';

// The words Admin › Sources shows for a source (pure, so the web unit tests can import it). v30 S1-WEB: a row is CT's
// AdminSourceRow (12 §12.1's columns: tier, terms, robots, the next run, the last complete listing); a source's
// settings (`config`, read from its own route) still say what a v2.0 board or file reads.

/** The kinds Add source offers, with their words. */
const ADDABLE_KIND_ITEMS: ReadonlyArray<{ value: AddableKind; label: string }> = [
  { value: 'greenhouse', label: 'Greenhouse' },
  { value: 'lever', label: 'Lever' },
  { value: 'ashby', label: 'Ashby' },
  { value: 'workable', label: 'Workable' },
  // v30 S4: the US federal feed and the remote-job APIs (12 §3.6-3.7).
  { value: 'usajobs', label: 'USAJOBS' },
  { value: 'himalayas', label: 'Himalayas' },
  { value: 'jobicy', label: 'Jobicy' },
  { value: 'career_site', label: 'Career site' }, // v30 FIX-WEB (REQ-5)
  { value: 'ft_lake', label: 'free_tailor lake' },
  { value: 'seed', label: 'Demo jobs' },
];

/**
 * v30 INT-0 (ST4's exact edit for ST5): the kinds Add source offers. The demo jobs are dev-only (the API's dev-only seam
 * holds their adapter, and the production export leaves it empty, so the API refuses a demo source there): a production
 * build does not offer them.
 */
export function addableKindItems(production: boolean): ReadonlyArray<{ value: AddableKind; label: string }> {
  return production ? ADDABLE_KIND_ITEMS.filter((item) => item.value !== 'seed') : ADDABLE_KIND_ITEMS;
}

/** A source's kind and settings, as its own route answers them. */
interface SourceWithSettings {
  kind: JobSourceKind;
  config: Record<string, unknown>;
}

/** Where a csv source's copy came from, when it is a Google Sheet import; null for every other source. */
export function sheetOf(source: SourceWithSettings): SheetSourceConfig | null {
  if (source.kind !== 'csv') return null;
  const parsed = SheetSourceConfigSchema.safeParse(source.config.sheet);
  return parsed.success ? parsed.data : null;
}

/** Whether a row is a Google Sheet import (a csv source the server labels so): it can be imported again. */
export function isSheetRow(row: Pick<AdminSourceRow, 'kind' | 'kindLabel'>): boolean {
  return row.kind === 'csv' && row.kindLabel === SHEET_SOURCE_LABEL;
}

/**
 * What a source reads, in a few words, from its settings: "Board gitlab", "Site palantir (EU)", "Account huggingface",
 * "sheet.csv", "Job sheet, tab 10/22/2026". Null when its settings say nothing more than its row (a newer kind).
 */
export function sourceDetail(source: SourceWithSettings): string | null {
  const text = (key: string) => (typeof source.config[key] === 'string' ? (source.config[key] as string) : '');
  switch (source.kind) {
    case 'greenhouse':
      return `Board ${text('token')}`;
    case 'lever':
      return `Site ${text('site')}${text('region') === 'eu' ? ' (EU)' : ''}`;
    case 'ashby':
      return `Board ${text('board')}`;
    case 'workable':
      return `Account ${text('account')}`;
    case 'workday':
      return `Tenant ${text('tenant')}`;
    case 'page':
      return 'Jobs added from the pages people saw';
    case 'ft_lake':
      return text('path') || 'Default database path';
    case 'csv': {
      const sheet = sheetOf(source);
      if (sheet) return `${sheet.spreadsheetTitle}, tab ${sheet.tabTitle}`;
      return text('fileName') || 'Uploaded file';
    }
    case 'json':
      return text('fileName') || 'Uploaded file';
    case 'seed':
      return text('anchor') ? `Dated from ${formatDate(text('anchor'))}` : 'Demo postings';
    // v30 S4: what each feed source searches.
    case 'usajobs': {
      const params = source.config.params && typeof source.config.params === 'object' ? Object.entries(source.config.params) : [];
      return params.length ? `Search ${params.map(([name, value]) => `${name}=${String(value)}`).join(', ')}` : 'Every open announcement';
    }
    case 'himalayas':
      return text('country').toLowerCase() === 'any' ? 'Remote jobs open anywhere' : `Remote jobs open to ${text('country') || 'US'}`;
    case 'jobicy':
      return [`Region ${text('geo') || 'usa'}`, text('industry') && `industry ${text('industry')}`, text('tag') && `tag ${text('tag')}`]
        .filter(Boolean)
        .join(', ');
    // v30 FIX-WEB (REQ-5): a career site reads its own host.
    case 'career_site':
      return text('host') ? `Career site ${text('host')}` : null;
    default:
      return null;
  }
}

// v30 FIX-WEB (REV-REQ REQ-7): the feeds' notes in Add source, their words the message constants' and their numbers the
// public constants' (never typed out here), and REQ-5's career site added by hand: its address as the host the API keeps.

/** The numbers the feeds' notes say. */
export interface FeedNoteNumbers {
  USAJOBS_MAX_ROWS: number;
  JOBICY_READ_GAP_MINUTES: number;
}

/** "once an hour", "once every 90 minutes", "once every 2 hours". */
export function readGapText(minutes: number): string {
  if (minutes === 60) return 'once an hour';
  if (minutes % 60 === 0) return `once every ${minutes / 60} hours`;
  return `once every ${minutes.toLocaleString('en-US')} minutes`;
}

/**
 * What keeps each feed (and a career site) off, and what it reads; null for a kind without a note. `t` renders the
 * message constants (MSG_SOURCE_NOTE_*).
 */
export function feedNote(kind: AddableKind, numbers: FeedNoteNumbers, t: MessageRenderer): string | null {
  switch (kind) {
    case 'usajobs':
      return t('MSG_SOURCE_NOTE_USAJOBS', { max: formatCount(numbers.USAJOBS_MAX_ROWS) });
    case 'himalayas':
      return t('MSG_SOURCE_NOTE_HIMALAYAS');
    case 'jobicy':
      return t('MSG_SOURCE_NOTE_JOBICY', { gap: readGapText(numbers.JOBICY_READ_GAP_MINUTES) });
    case 'career_site':
      return t('MSG_SOURCE_NOTE_CAREER_SITE');
    default:
      return null;
  }
}

/**
 * A career site's host from what an admin typed: an address (https://careers.acme.com/jobs) or a bare host, in lower
 * case; null when it names no public host (no dot, a space, an IP address, localhost). The API checks it again.
 */
export function careerSiteHost(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  return host;
}

/** A row's second line: its kind, its host and its company ("Greenhouse · boards-api.greenhouse.io · Acme"). */
export function sourceLine(row: Pick<AdminSourceRow, 'kindLabel' | 'host' | 'companyName' | 'name'>): string {
  const company = row.companyName && row.companyName !== row.name ? row.companyName : null;
  return [row.kindLabel, row.host, company].filter(Boolean).join(' · ');
}

/** Kinds whose sources are never run: Workday's single postings, the job pages', an admin's published page jobs. */
const UNRUN_KINDS: readonly JobSourceKind[] = ['workday', 'page', 'ext_page'];

/** Whether a source is never run (Workday's, the job pages'): Run now and turning it on are not offered. */
export function isUnrun(source: { kind: JobSourceKind }): boolean {
  return UNRUN_KINDS.includes(source.kind);
}

/** Whether a source can be deleted: not the job pages', which keep the jobs people added from pages. */
export function isDeletable(source: { kind: JobSourceKind }): boolean {
  return source.kind !== 'page' && source.kind !== 'ext_page';
}

/**
 * "Run now" of a sheet source imports its stored copy again; a Workday or job-page source is never run. This says so
 * (null for other sources, and while a sheet source's settings are not known).
 */
export function runNowHint(source: { kind: JobSourceKind; config?: Record<string, unknown> }): string | null {
  if (source.kind === 'workday') return 'TailorIT reads Workday postings one at a time, when someone adds one; their re-checks keep them up to date.';
  if (source.kind === 'page' || source.kind === 'ext_page') return 'These jobs keep the text people saw on their pages: TailorIT never reads those pages.';
  const sheet = source.config ? sheetOf({ kind: source.kind, config: source.config }) : null;
  return sheet ? `Imports the copy read ${formatDate(sheet.readAt)} again. To read the sheet again, use Import the sheet again.` : null;
}

/** v31 RUNS: whether an admin paused it (no run of it starts until Continue). */
export function isPaused(row: Pick<AdminSourceRow, 'pausedAt'>): boolean {
  return Boolean(row.pausedAt);
}

/**
 * v31 RUNS: why Run now waits: the source, or every run, is paused (null when it may run), in the server's words for its
 * refusal (MSG_INGEST_SOURCE_PAUSED, MSG_INGEST_RUNS_PAUSED; `t` renders the message constants).
 */
export function pausedRunNowHint(row: Pick<AdminSourceRow, 'pausedAt'>, runsPaused: boolean, t: MessageRenderer): string | null {
  if (row.pausedAt) return t('MSG_INGEST_SOURCE_PAUSED');
  if (runsPaused) return t('MSG_INGEST_RUNS_PAUSED');
  return null;
}

/** Whether its terms and robots.txt let the scheduler run it (the due index's condition). */
export function isRunnable(row: Pick<AdminSourceRow, 'termsStatus' | 'robotsStatus'>): boolean {
  return (
    (JOB_SOURCE_RUNNABLE_TERMS as readonly JobSourceTermsStatus[]).includes(row.termsStatus) &&
    (JOB_SOURCE_RUNNABLE_ROBOTS as readonly JobSourceRobotsStatus[]).includes(row.robotsStatus)
  );
}

export const TIER_TONE: Record<JobSourceTier, BadgeTone> = {
  hot: 'tint',
  normal: 'neutral',
  quiet: 'outline',
  empty: 'outline',
  failing: 'destructive',
  not_found: 'warning',
};

export function termsTone(status: JobSourceTermsStatus): BadgeTone {
  if (status === 'allowed') return 'success';
  if (status === 'allowed_with_conditions') return 'tint';
  if (status === 'unchecked') return 'neutral';
  return 'destructive';
}

export function robotsTone(status: JobSourceRobotsStatus): BadgeTone {
  if (status === 'allowed' || status === 'not_applicable') return 'success';
  if (status === 'unchecked') return 'neutral';
  if (status === 'error') return 'warning';
  return 'destructive';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "in 5 minutes", "in 3 hours", "in 2 days"; "now" once it is due. */
export function untilText(value: string, now: number): string {
  const ahead = Date.parse(value) - now;
  if (!Number.isFinite(ahead) || ahead < MINUTE) return 'now';
  const [count, unit] =
    ahead < HOUR ? [Math.floor(ahead / MINUTE), 'minute'] : ahead < DAY ? [Math.floor(ahead / HOUR), 'hour'] : [Math.floor(ahead / DAY), 'day'];
  return `in ${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * When it runs next: running, paused by an admin, disabled, held back by its terms or robots, due, or in some time.
 * v31 RUNS: "Paused" is an admin's pause (pausedAt); a source turned off reads "Disabled".
 */
export function scheduleText(
  row: Pick<AdminSourceRow, 'running' | 'enabled' | 'nextRunAt' | 'termsStatus' | 'robotsStatus' | 'kind' | 'pausedAt'>,
  now: number,
): string {
  if (row.running) return 'Running now';
  if (isUnrun(row)) return 'Never run';
  if (row.pausedAt) return 'Paused';
  if (!row.enabled) return 'Disabled';
  if (!(JOB_SOURCE_RUNNABLE_TERMS as readonly JobSourceTermsStatus[]).includes(row.termsStatus)) {
    return `Not run: terms ${JOB_SOURCE_TERMS_LABEL[row.termsStatus].toLowerCase()}`;
  }
  if (!(JOB_SOURCE_RUNNABLE_ROBOTS as readonly JobSourceRobotsStatus[]).includes(row.robotsStatus)) {
    return `Not run: robots.txt ${JOB_SOURCE_ROBOTS_LABEL[row.robotsStatus].toLowerCase()}`;
  }
  if (!row.nextRunAt) return 'Not scheduled';
  const until = untilText(row.nextRunAt, now);
  return until === 'now' ? 'Due now' : `Next ${until}`;
}

/** "3 failures in a row"; null when its last run did not fail. */
export function failureText(row: Pick<AdminSourceRow, 'consecutiveFailures'>): string | null {
  const count = row.consecutiveFailures;
  return count > 0 ? `${count} ${count === 1 ? 'failure' : 'failures'} in a row` : null;
}

/** "80,214". */
export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}
