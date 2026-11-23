import { SheetSourceConfigSchema, type SheetSourceConfig } from '@tailorit/shared/ingest';
import {
  JOB_SOURCE_ROBOTS_LABEL,
  JOB_SOURCE_WAITING_LABEL,
  JOB_SOURCE_RUNNABLE_ROBOTS,
  JOB_SOURCE_RUNNABLE_TERMS,
  JOB_SOURCE_TERMS_LABEL,
  type AdminSourceRow,
  type JobSourceKind,
  type JobSourceRobotsStatus,
  type JobSourceTermsStatus,
  type JobSourceTier,
  type JobSourceWaiting,
  type JobSourceWaitingReason,
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
  { value: 'workday_site', label: 'Workday career site' }, // v35 OPSWEB (PLAN H7)
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

/**
 * Where a csv source's copy came from, when it is a Google Sheet import; null for every other source. v35 OPSWEB: an
 * import is no source any more (Sources lists none); Admin › Import's own reading of a sheet record still uses this.
 */
export function sheetOf(source: SourceWithSettings): SheetSourceConfig | null {
  if (source.kind !== 'csv') return null;
  const parsed = SheetSourceConfigSchema.safeParse(source.config.sheet);
  return parsed.success ? parsed.data : null;
}

/**
 * What a source reads, in a few words, from its settings: "Board gitlab", "Site palantir (EU)", "Account huggingface".
 * Null when its settings say nothing more than its row (a newer kind). v35 OPSWEB (PLAN H6): an import's records (csv,
 * json) are no sources, so they have no words here; a Workday career site names its host and site.
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
    // v35 OPSWEB (PLAN H7)
    case 'workday_site':
      return text('host') && text('careerSite') ? `Career site ${text('host')}, site ${text('careerSite')}` : null;
    case 'page':
      return 'Jobs added from the pages people saw';
    case 'ft_lake':
      return text('path') || 'Default database path';
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
 * A Workday or job-page source is never run: this says why (null for other sources). v35 OPSWEB (PLAN H6): an import's
 * sheet is read again from Admin › Import's Recent imports, not from Sources.
 */
export function runNowHint(source: { kind: JobSourceKind }): string | null {
  if (source.kind === 'workday') return 'TailorIT reads Workday postings one at a time, when someone adds one; their re-checks keep them up to date.';
  if (source.kind === 'page' || source.kind === 'ext_page') return 'These jobs keep the text people saw on their pages: TailorIT never reads those pages.';
  return null;
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

// v35 OPSWEB (PLAN H7): a switched-on source that cannot run says why, and what clears it; it starts by itself once it can.

/**
 * Why each wait holds a source and what clears it, in the admin's words: the Waiting badge's "?", one sentence of at most
 * 140 characters (UXREQ-8). The reasons are ADMIN's waiting.ts; JOB_SOURCE_WAITING_LABEL's "Waiting: ..." names them in
 * lists. A held host's tip names when the hold ends.
 */
const WAITING_TIP: Record<JobSourceWaitingReason, string> = {
  ingest_off: 'This server reads no sources while INGEST_ENABLED is off; turn it on and the source starts by itself.',
  runs_paused: 'Every run is paused; continue runs on Admin › Runs and the source starts by itself.',
  paused: "An admin paused this source; continue it from its row's menu and it starts by itself.",
  opted_out: 'Its company asked TailorIT not to read its jobs, so it stays off.',
  not_built: 'TailorIT does not read this kind of source yet.',
  identity: 'TailorIT reads this site only under a named bot; set BOT_USER_AGENT in the server settings and it starts by itself.',
  outside_key: 'This feed needs its API key; add it to the server settings and the source starts by itself.',
  career_pages_off: 'Career page reads are off; turn on Read career pages in Admin › Constants and it starts by itself.',
  terms: "Its site's terms are not recorded as allowing automated reads; record them on its host in Admin › Hosts.",
  robots_pending: "TailorIT reads its host's robots.txt first, then the source starts by itself.",
  robots_disallowed: "The site's robots.txt asks automated readers not to read it; the source starts by itself if that changes.",
  robots_unreadable: "Its host's robots.txt could not be read; TailorIT tries again daily and the source starts by itself.",
  host_held: 'Its host is held (Admin › Hosts); the source starts by itself when the hold ends.',
};

/** The Waiting badge's "?": why the source waits and what clears it, in one sentence; null when it can run. */
export function waitingTip(waiting: JobSourceWaiting | null | undefined): string | null {
  if (!waiting) return null;
  if (waiting.reason === 'host_held' && waiting.until) {
    return `Its host is held until ${new Date(waiting.until).toLocaleString('en-US')}; the source starts by itself then.`;
  }
  return WAITING_TIP[waiting.reason];
}

/** The short words of a wait, for a list ("Waiting: set BOT_USER_AGENT"). */
export function waitingLabel(waiting: JobSourceWaiting): string {
  return JOB_SOURCE_WAITING_LABEL[waiting.reason];
}

/**
 * v35 OPSWEB (PLAN H7): what is wrong with a pasted Workday career site address, part by part (null when its shape is
 * right, or nothing is typed yet). The API reads the site from it and says so again when it cannot.
 */
export function workdayAddressProblem(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return 'Paste the whole address of a page of the career site, such as https://acme.wd5.myworkdayjobs.com/en-US/careers.';
  }
  if (url.protocol !== 'https:') return 'The address must start with https://.';
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const site = /^[A-Za-z0-9_-]{1,100}$/;
  // A locale before the rest (en-US) is allowed.
  const rest = /^[a-z]{2,3}(?:-[a-z0-9]{2,4})?$/i.test(segments[0] ?? '') ? segments.slice(1) : segments;
  if (/^wd\d+\.myworkdaysite\.com$/.test(host)) {
    if (rest[0]?.toLowerCase() !== 'recruiting') return `On ${host} the address needs /recruiting/<company>/<site> after the host.`;
    if (!rest[1]) return 'Add the company after /recruiting/, then the site: /recruiting/<company>/<site>.';
    if (!rest[2]) return 'Add the site after the company: /recruiting/<company>/<site>.';
    if (!site.test(rest[2])) return "The site's name may use only letters, digits, - and _.";
    return null;
  }
  if (!/^[a-z0-9-]+\.(?:wd\d+\.)?myworkdayjobs\.com$/.test(host)) {
    return `The host must be <company>.wd<n>.myworkdayjobs.com or wd<n>.myworkdaysite.com, not ${host}.`;
  }
  if (!rest[0]) return "Add the site's name after the host, as in .../en-US/<site>.";
  if (!site.test(rest[0])) return "The site's name may use only letters, digits, - and _.";
  return null;
}
// end v35 OPSWEB

/** "80,214". */
export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}
