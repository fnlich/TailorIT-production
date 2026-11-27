import { SheetSourceConfigSchema, type SheetSourceConfig } from '@tailorit/shared/ingest';
import {
  BAMBOOHR_OWN_LABELS, // v38 FRAME: the board registry's (the API's normaliser reads the same list)
  bamboohrCompanyOfTyped,
  BOARD_DESCRIPTORS,
  boardDescriptorOf,
  icimsBoardOfTyped,
  JOB_SOURCE_ROBOTS_LABEL,
  JOB_SOURCE_WAITING_LABEL,
  JOB_SOURCE_RUNNABLE_ROBOTS,
  JOB_SOURCE_RUNNABLE_TERMS,
  JOB_SOURCE_TERMS_LABEL,
  type BoardDescriptor, // v38 FIX-APP
  type AdminSourceRow,
  type AdminSourcesTurnedOff, // v36 FIX-SRC
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
import { FIELD_KINDS, type AddableKind } from '../types';

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
  // v37 BOARDS (PLAN B4, I1): BambooHR, iCIMS; v38 FRAME (SP v38 PLAN A10): every field-added board kind, its words its
  // descriptor's label.
  ...FIELD_KINDS.map((kind) => ({ value: kind, label: boardDescriptorOf(kind)!.label })),
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
  // v38 FRAME (SP v38 PLAN A10): a board kind's words are its descriptor's (Board gitlab, Site palantir (EU), Account
  // huggingface, Tenant nvidia, a Workday career site's host and site, a career site's host, a BambooHR company, an iCIMS
  // site; null for a feed ATS's, whose row says all).
  const board = boardDescriptorOf(source.kind);
  if (board) return board.detail?.(source.config) ?? null;
  const text = (key: string) => (typeof source.config[key] === 'string' ? (source.config[key] as string) : '');
  switch (source.kind) {
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

/**
 * Kinds whose sources are never run: Workday's single postings, the job pages', an admin's published page jobs. v38
 * FRAME: a board kind's whose row runs not (its descriptor's).
 */
const UNRUN_KINDS: readonly JobSourceKind[] = [...BOARD_DESCRIPTORS.filter((board) => !board.row.runs).map((board) => board.kind), 'page', 'ext_page'];

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
 * sheet is read again from Admin › Import's Recent imports, not from Sources. v38 FIX-APP (REVIEW38-ux L10): every
 * links-only board kind's too (SmartRecruiters, Taleo, Paycom, Dayforce, UKG: its descriptor's row runs not).
 */
export function runNowHint(source: { kind: JobSourceKind }): string | null {
  if (source.kind === 'workday') return 'TailorIT reads Workday postings one at a time, when someone adds one; their re-checks keep them up to date.';
  if (source.kind === 'page' || source.kind === 'ext_page') return 'These jobs keep the text people saw on their pages: TailorIT never reads those pages.';
  const board = linksOnlyBoard(source);
  if (board) return `TailorIT reads ${board.runLabel ?? board.label} postings one at a time, when someone adds one; it doesn't list this board.`;
  return null;
}

// v38 FIX-APP (REVIEW38-ux L10): a links-only board kind's source (made by a link read): it is never run, and says so.
/** The words of a links-only source (Admin › Sources' row, its sheet). */
export const LINKS_ONLY = {
  label: 'Links only',
  text: "TailorIT checks this site's job links but doesn't list its jobs.",
} as const;

/** A links-only board kind's descriptor (its row runs not: Workday's one posting, SmartRecruiters, ...), else null. */
export function linksOnlyBoard(source: { kind: JobSourceKind }): BoardDescriptor | null {
  const board = boardDescriptorOf(source.kind);
  return board && !board.row.runs ? board : null;
}

/** v38 FIX-APP (REVIEW38-ux L10): robots.txt in words: a links-only kind with no source-level verdict asks it on each read. */
export function robotsLabelOf(source: { kind: JobSourceKind; robotsStatus: JobSourceRobotsStatus }): string {
  return source.robotsStatus === 'not_applicable' && linksOnlyBoard(source) ? 'Checked on each read' : JOB_SOURCE_ROBOTS_LABEL[source.robotsStatus];
}
// end v38 FIX-APP

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
 * v31 RUNS: "Paused" is an admin's pause (pausedAt); a source turned off reads "Disabled". v36 SOURCES: one found that no
 * admin turned on yet reads "Not until turned on" (its Status says "Waiting for an admin").
 */
export function scheduleText(
  row: Pick<AdminSourceRow, 'running' | 'enabled' | 'nextRunAt' | 'termsStatus' | 'robotsStatus' | 'kind' | 'pausedAt' | 'waitingForAdmin'>,
  now: number,
): string {
  if (row.running) return 'Running now';
  if (linksOnlyBoard(row)) return LINKS_ONLY.label; // v38 FIX-APP (ux L10)
  if (isUnrun(row)) return 'Never run';
  if (row.pausedAt) return 'Paused';
  if (row.waitingForAdmin) return 'Not until turned on'; // v36 SOURCES
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
  // v37 FIX-37B (E8): terms are recorded on the source itself (its sheet's Terms), since v3.7 for every kind.
  terms: "Its terms don't allow automated reads, so TailorIT doesn't read it; change them under Terms in its details.",
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

// v36 SOURCES (SP v36 PLAN S1, S5, S8): a source runs only once an admin turned it on, and says who did and when.

/** The kinds that run while off: the demo jobs (an import's records, csv and json, are no source listed here). */
const RUNS_WHILE_OFF_KINDS: readonly JobSourceKind[] = ['csv', 'json', 'seed'];

/**
 * Why Run now waits for the source to be turned on (the server refuses it: MSG_INGEST_SOURCE_OFF, rendered by `t`), or
 * null when it is on (or a kind that runs while off).
 */
export function offRunNowHint(row: Pick<AdminSourceRow, 'enabled' | 'kind'>, t: MessageRenderer): string | null {
  if (row.enabled || RUNS_WHILE_OFF_KINDS.includes(row.kind)) return null;
  if (linksOnlyBoard(row)) return null; // v38 FIX-APP (ux L10): never turned on: Run now says why it never runs
  return t('MSG_INGEST_SOURCE_OFF');
}

/**
 * v37 FIX-37B (SP v37 FIXES-37 E8, the ux review's M2): why Run now is off for a source whose recorded terms don't allow
 * automated access, in the server's words for its refusal (MSG_INGEST_SOURCE_TERMS: "Its terms are Forbidden: TailorIT
 * doesn't read it."), or null when its terms let it run (or a kind that runs while off, or one never run).
 */
export function termsRunNowHint(row: Pick<AdminSourceRow, 'termsStatus' | 'kind'>, t: MessageRenderer): string | null {
  if (RUNS_WHILE_OFF_KINDS.includes(row.kind) || isUnrun(row) || termsLetRun(row.termsStatus)) return null;
  return t('MSG_INGEST_SOURCE_TERMS', { status: JOB_SOURCE_TERMS_LABEL[row.termsStatus] });
}

/**
 * "Waiting for an admin"'s "?": what it means and what ends it, in one sentence. v37 INT-B (TRANSFER E4): a source
 * imported from a file waits too, and TailorIT did not find it.
 */
export const WAITING_FOR_ADMIN_TIP = 'TailorIT found this board, or an admin imported it; it stays off and never runs until you turn it on.';

/** "Nov 23, 2026": an enable's day, in the viewer's time. */
function dayText(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Who turned the source on and when ("Turned on by ana@example.com, Nov 23, 2026"); "Last turned on by ..." once it is
 * off again; "Turned on Nov 23, 2026" when who is not known (an account deleted since, or a source on before v3.6);
 * "Never turned on" when no admin ever did.
 */
export function turnedOnText(row: Pick<AdminSourceRow, 'enabled' | 'enabledAt' | 'enabledBy'>): string {
  if (!row.enabledAt) return 'Never turned on';
  const lead = row.enabled ? 'Turned on' : 'Last turned on';
  return row.enabledBy ? `${lead} by ${row.enabledBy}, ${dayText(row.enabledAt)}` : `${lead} ${dayText(row.enabledAt)}`;
}

/** v36 FIX-SRC (D6): the notice's counts, of each part and of those still off. */
export type TurnedOffCounts = Pick<
  NonNullable<AdminSourcesTurnedOff['notice']>,
  'untouched' | 'changed' | 'candidates' | 'untouchedOff' | 'changedOff' | 'candidatesOff'
>;

/** v36 FIX-SRC (D6): every source the notice names, and those of them still off. */
export function turnedOffTotals(notice: TurnedOffCounts): { total: number; off: number } {
  return {
    total: notice.untouched + notice.changed + notice.candidates,
    off: notice.untouchedOff + notice.changedOff + notice.candidatesOff,
  };
}

/**
 * v3.6's notice (the sources 0060 turned off), in words: its title and the line under it. v36 FIX-SRC (D6): the boards an
 * admin added from Admin › Candidates are told apart ("added from Candidates"), never "untouched since found".
 */
export function turnedOffWords(notice: TurnedOffCounts): {
  title: string;
  description: string;
} {
  const { total, off } = turnedOffTotals(notice);
  const parts = [
    notice.untouched > 0 ? `${formatCount(notice.untouched)} untouched since found` : null,
    notice.candidates > 0 ? `${formatCount(notice.candidates)} added from Candidates` : null,
    notice.changed > 0 ? `${formatCount(notice.changed)} changed since (maybe by an admin)` : null,
  ].filter(Boolean);
  const still = off === total ? 'They run only once you turn them on.' : `${formatCount(off)} of them are still off; they run only once you turn them on.`;
  return {
    title: `v3.6 turned off ${formatCount(total)} ${total === 1 ? 'source' : 'sources'} that discovery had switched on`,
    description: `${parts.join(', ')}. ${still}`,
  };
}
// end v36 SOURCES

/** "80,214". */
export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

// v37 BOARDS (SP v37 PLAN B4, I1): Add source's BambooHR and iCIMS fields, read as the API reads them (it checks again).

/**
 * v37 FIX-37B (the ux review's L1): BambooHR's own hosts' first labels: never a company's (the API's router refuses them
 * too). v38 FRAME: the board registry's one list.
 */
export { BAMBOOHR_OWN_LABELS };

/**
 * A BambooHR company from what an admin typed: its name ("acme") or an address on <name>.bamboohr.com; null when it
 * names none (v37 FIX-37B: or one of BambooHR's own hosts, www.bamboohr.com). v38 FRAME: its descriptor's field check.
 */
export const bamboohrCompanyOf = bamboohrCompanyOfTyped;

/**
 * An iCIMS site's board from what an admin typed: its board ("careers-acme"), its host or any page of it; null when it
 * names none (another domain, iCIMS's own hosts, an employees' internal-<co> portal). v38 FRAME: its descriptor's.
 */
export const icimsBoardOfInput = icimsBoardOfTyped;

/**
 * v38 FRAME (SP v38 PLAN A10): the board what an admin typed in a field-added board kind's field names, as its descriptor
 * reads it (its own check, else its normaliser); null when it names none. The API checks again.
 */
export function fieldBoardOf(kind: AddableKind, input: string): string | null {
  const add = boardDescriptorOf(kind)?.addSource;
  if (!add) return null;
  const named = add.boardOfInput ? add.boardOfInput(input) : boardDescriptorOf(kind)!.boardOf(input) || null;
  // v38 FIX-APP (REVIEW38-ux L18): a job's own link of a kind whose links name no board (the API reads its page once).
  return named ?? (add.postingLink && postingLinkOf(kind, input) ? POSTING_LINK : null);
}

/** v38 FIX-APP (REVIEW38-ux L18): what fieldBoardOf answers for a job's own link (its board is read from its page). */
export const POSTING_LINK = 'posting link';

/** v38 FIX-APP (REVIEW38-ux L18): whether a typed address is a job's own link of the kind (its descriptor's parseLink). */
function postingLinkOf(kind: AddableKind, input: string): boolean {
  const board = boardDescriptorOf(kind);
  const text = input.trim();
  if (!board?.parseLink || !/^https?:\/\//i.test(text)) return false;
  try {
    return board.parseLink(new URL(text)) !== null;
  } catch {
    return false;
  }
}
// end v37 BOARDS

/**
 * v37 FIX-37A (SP v37 FIXES-37 E6, REVIEW37-ux M4): Add source's Company name tip. A BambooHR board never names its
 * company: TailorIT reads the name from the company's careers page once (adapters/bamboohr.ts), unless one is typed.
 */
export function companyNameHint(kind: AddableKind): string {
  // v38 FRAME: a field-added board kind's descriptor may say why (BambooHR's).
  return boardDescriptorOf(kind)?.addSource?.companyHint ?? "Shown when the board doesn't name the company.";
}

// v37 BOARDS (SP v37 PLAN B3): a source's Terms editor (status, terms page, note), every kind's. The API checks again.

/** job_sources.terms_note's limit (its CHECK; the PATCH route's). */
export const TERMS_NOTE_MAX = 1000;

/** The statuses the editor offers, in the order an admin decides them. */
export const TERMS_STATUS_OPTIONS: ReadonlyArray<{ value: JobSourceTermsStatus; label: string }> = (
  ['allowed', 'allowed_with_conditions', 'needs_contract', 'forbidden', 'unchecked'] as const
).map((value) => ({ value, label: JOB_SOURCE_TERMS_LABEL[value] }));

/** Why the terms page cannot be saved (an https address, or nothing), or null. */
export function termsUrlProblem(url: string): string | null {
  const text = url.trim();
  return text && !/^https:\/\/\S+$/.test(text) ? 'Give the terms page as an https address.' : null;
}

/** Why the note cannot be saved (too long), or null. */
export function termsNoteProblem(note: string): string | null {
  return note.trim().length > TERMS_NOTE_MAX ? `Keep the note under ${formatCount(TERMS_NOTE_MAX)} characters.` : null;
}

/** The PATCH body of the editor's fields: an empty page or note clears it. */
export function termsBodyOf(status: JobSourceTermsStatus, url: string, note: string) {
  return { termsStatus: status, termsUrl: url.trim() || null, termsNote: note.trim() || null };
}

/** Whether the scheduler may run a source of this status (the words under the status: what it changes). */
export function termsLetRun(status: JobSourceTermsStatus): boolean {
  return (JOB_SOURCE_RUNNABLE_TERMS as readonly JobSourceTermsStatus[]).includes(status);
}
// end v37 BOARDS (terms)
