import {
  ATS_NAMES,
  AUTOFILL_AGENT_ATS,
  AUTOFILL_AGENT_RUN_TIMEOUT_MS,
  AUTOFILL_QUEUE_ATS,
  type AtsKind,
  type AutofillAgentReason,
  type AutofillAgentRunKind,
} from '@tailorit/shared/autofill';
import type { PrepareFilters } from '@tailorit/shared/filters';
import {
  QUEUE_PANE_DISPLAY_LABELS,
  SAVED_JOB_MARKER_LABELS,
  isActivePrepareState,
  type PreparingItem,
  type QueuePaneItem,
  type QueueUsage,
  type SavedJobFilter,
  type SavedJobItem,
  type SavedJobSupport,
} from '@tailorit/shared/prepare';
import type { BadgeTone } from '../../components/ui/Badge';
import type { MessageRenderer } from '../../components/limits/limits';
import type { StateIconName } from '../../components/queue';
import { RESUME_MODE_SHORT, stepText } from '../prepare/copy';

// v2.0: the Auto-apply page's model and words (docs/design/v2.0/08-ui.md, "The Auto-Apply page"; 05-prepare-flow.md,
// "The state machine"), the part that is not React: each Saved row's marker and action, each Queue row's group, state
// line and actions, the panes' filters, the live summary and how often the page reads again. Pure, so the pages only
// draw. The state words come from the constants (STATE_*, MARKER_*, STATUS_DRAFT_LABEL) through `t`.

/** Why the agent did not submit a job, in the person's words. */
export const REASON_TEXT: Record<AutofillAgentReason, string> = {
  required_field_empty: 'A required question was still empty: your autofill profile has no answer for it.',
  posting_forbids_ai: 'The posting asks applicants not to use AI.',
  ai_guess_legal: 'A legal question was answered with an AI guess, and your skip rule says to stop there.',
  captcha: 'A CAPTCHA stopped it: only you can answer one.',
  sign_in: 'The site asked you to sign in or create an account.',
  sign_in_failed: 'Signing in with your saved job-site sign-in did not work.',
  email_code: 'The site sent a code to your email.',
  validation_error: 'The form still showed an error after one more try.',
  unsupported_site: 'The extension cannot fill applications on this site yet.',
  posting_closed: 'The posting has closed.',
  page_error: 'The application page did not load, or stopped working.',
  timed_out:
    `The extension took it but never reported back within ${AUTOFILL_AGENT_RUN_TIMEOUT_MS / 60_000} minutes. It may have been sent: check the site, then Mark as applied or Try again.`,
  already_applied: 'You have applied already: the site says so, or your Job Tracker has it past Saved.',
  cancelled: 'The run was stopped.',
  other: 'Something else stopped it.',
};

/** Names in a sentence: "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Greenhouse, Lever, Ashby, …": the platforms whose applications Run auto-apply fills. */
export function agentSitesText(kinds: readonly AtsKind[] = AUTOFILL_AGENT_ATS): string {
  return listed(kinds.map((kind) => ATS_NAMES[kind]));
}

/** The platforms only the extension's Queue tab opens (AUTOFILL_QUEUE_ATS without AUTOFILL_AGENT_ATS). */
export function queueSitesText(
  kinds: readonly AtsKind[] = AUTOFILL_QUEUE_ATS,
  agentKinds: readonly AtsKind[] = AUTOFILL_AGENT_ATS,
): string {
  return listed(kinds.filter((kind) => !agentKinds.includes(kind)).map((kind) => ATS_NAMES[kind]));
}

// The page --------------------------------------------------------------------------------------------------------

export const PAGE_TITLE = 'Auto-apply';
export const PAGE_LEAD = 'Save jobs, then Prepare & Queue them. TailorIT applies to the ready ones for you.';
export const HOW_TITLE = 'How auto-apply works';

/** The "How auto-apply works" popover's paragraphs. */
export function howItWorks(): string[] {
  return [
    "Save jobs from Jobs, or with the extension's Add job. Prepare & Queue makes each job's kit (the resume, a cover " +
      'letter when one is needed, and answers to the questions TailorIT knows), then queues it.',
    `Run auto-apply in the TailorIT extension takes the ready jobs on ${agentSitesText()}, one at a time, while your ` +
      `browser is open. The Queue tab in the extension's panel opens those and the jobs on ${queueSitesText()} in tabs, ` +
      'while you are at your browser.',
    "Jobs auto-apply can't run on are marked with a hand: open the job page, copy what was prepared, apply, then " +
      'Mark as applied. Jobs you apply to by hand never count toward a daily limit.',
    "Auto-apply submits answers TailorIT's AI guessed without asking you first. A CAPTCHA, an email code or a sign-in " +
      "it can't do stops it, and the job waits in the queue as Needs you, with the reason.",
  ];
}

// Support: the at-a-glance difference --------------------------------------------------------------------------------

export type SupportKind = 'auto' | 'manual';
export const supportKind = (support: SavedJobSupport): SupportKind => (support === 'manual' ? 'manual' : 'auto');

/** The support icon's tooltip and accessible name. */
export function supportText(support: SavedJobSupport): string {
  if (support === 'manual') return "Apply manually: auto-apply can't run on this site";
  if (support === 'tab') return "Auto-apply supported, in the extension's Queue tab";
  return 'Auto-apply supported';
}

// The Saved pane ----------------------------------------------------------------------------------------------------

/** The Saved pane's filter tabs. `queued` reads Draft, as its rows' marker (A30): savedFilterLabel. */
export const SAVED_FILTER_LABEL: Record<Exclude<SavedJobFilter, 'queued'>, string> = {
  all: 'All',
  ready: 'To prepare',
  filtered: 'Filtered',
};

/** A Saved filter tab's name; `queued` is STATUS_DRAFT_LABEL's words (v30 ST5: an admin's rename reaches the tab). */
export function savedFilterLabel(filter: SavedJobFilter, t: MessageRenderer): string {
  return filter === 'queued' ? t('STATUS_DRAFT_LABEL') : SAVED_FILTER_LABEL[filter];
}

/** The empty words of a Saved tab with nothing in it (All has its own empty state). */
export const SAVED_FILTER_EMPTY: Record<Exclude<SavedJobFilter, 'all'>, string> = {
  ready: 'Every saved job is prepared or on its way.',
  filtered: 'No saved job is filtered out.',
  queued: 'No saved job is a draft in the queue.',
};

export type MarkerIcon = 'check' | 'spinner' | 'funnel' | 'x' | 'warning' | 'sparkle';

export interface MarkerView {
  tone: BadgeTone;
  icon: MarkerIcon;
  label: string;
}

const MARKER_STYLE: Record<Exclude<SavedJobItem['marker'], 'none'>, { tone: BadgeTone; icon: MarkerIcon }> = {
  queued: { tone: 'success', icon: 'check' },
  preparing: { tone: 'sky', icon: 'spinner' },
  filtered: { tone: 'outline', icon: 'funnel' },
  prepare_failed: { tone: 'destructive', icon: 'x' },
  not_applied: { tone: 'warning', icon: 'warning' },
  prepared: { tone: 'tint', icon: 'sparkle' },
};

/**
 * A Saved row's marker (05's state table, column "Saved row marker"): null for none. The words are the server's
 * (`label`), else the constants' (a queued entry reads Draft, A30).
 */
export function savedMarker(item: Pick<SavedJobItem, 'marker' | 'label' | 'reasons'>, t: MessageRenderer): MarkerView | null {
  if (item.marker === 'none') return null;
  const style = MARKER_STYLE[item.marker];
  const key = SAVED_JOB_MARKER_LABELS[item.marker];
  let label = item.label;
  if (!label && item.marker === 'filtered') label = t('MSG_FILTERED', { reason: item.reasons?.[0]?.label ?? 'a filter' });
  if (!label && key) label = t(key);
  // A30: Draft's words are always the constant's, whatever an older answer said ("Queued").
  if (item.marker === 'queued') label = t('STATUS_DRAFT_LABEL');
  return { ...style, label: label ?? '' };
}

/** A Saved row's action: Prepare & Queue, Cancel while preparing, View in queue once queued; none otherwise. */
export type SavedAction = 'prepare' | 'cancel' | 'view_in_queue';
export function savedAction(item: Pick<SavedJobItem, 'marker' | 'prepareId' | 'queueId'>): SavedAction | null {
  switch (item.marker) {
    case 'none':
    case 'filtered':
    case 'prepare_failed':
    case 'prepared':
      return 'prepare';
    case 'preparing':
      return item.prepareId ? 'cancel' : null;
    case 'queued':
    case 'not_applied':
      return 'view_in_queue';
  }
}

/**
 * Whether a Saved row can be chosen in select mode: one whose action is Prepare & Queue. v30 FIX-WEB (REV-UX UX-10): not
 * a job that closed (FIX-B's optional `closed`): nobody can apply to it.
 */
export const selectableSaved = (item: Pick<SavedJobItem, 'marker' | 'prepareId' | 'queueId'>) =>
  savedAction(item) === 'prepare' && (item as { closed?: unknown }).closed !== true;

/**
 * The rows in the order a tab shows them: as the server sent them (newest saved first), except To prepare, which lists
 * the filtered and failed ones last.
 */
export function orderSaved<T extends Pick<SavedJobItem, 'marker'>>(items: readonly T[], filter: SavedJobFilter): T[] {
  if (filter !== 'ready') return [...items];
  const late = (item: T) => item.marker === 'filtered' || item.marker === 'prepare_failed';
  return [...items.filter((item) => !late(item)), ...items.filter(late)];
}

/** How many prepare filters are on (the Saved pane's Filters count). */
export function filtersOnCount(filters: PrepareFilters | null | undefined): number {
  if (!filters) return 0;
  return [
    filters.locationTypes.length > 0,
    filters.jobTypes.length > 0,
    filters.industries !== null && filters.industries.ids.length > 0,
    filters.locationMismatch,
    filters.qualificationMismatch,
    filters.certificationMismatch,
    filters.autoApplySupport === 'supported',
    filters.minSalaryUsd !== null,
    filters.experienceLevels.length > 0,
    filters.noSponsorship,
    filters.clearanceMismatch,
    filters.custom.enabled,
  ].filter(Boolean).length;
}

// The Queue pane ----------------------------------------------------------------------------------------------------

/** One row of the Queue pane: a Prepare (active, failed, or prepared and not queued) or a queue row. */
export type QueueRow = { kind: 'prepare'; item: PreparingItem } | { kind: 'queue'; item: QueuePaneItem };

export const rowKey = (row: QueueRow) => (row.kind === 'prepare' ? `p:${row.item.prepareId}` : `q:${row.item.queueId}`);
export const rowApplicationId = (row: QueueRow) => row.item.applicationId;

export const QUEUE_GROUPS = ['applying', 'preparing', 'up_next', 'manual', 'attention', 'done'] as const;
export type QueueGroup = (typeof QUEUE_GROUPS)[number];

/** The Queue pane's group titles; Preparing and Apply manually are their states' words (queueGroupTitle). */
export const QUEUE_GROUP_TITLE: Record<Exclude<QueueGroup, 'preparing' | 'manual'>, string> = {
  applying: 'Applying now',
  up_next: 'Up next',
  attention: 'Needs attention',
  done: 'Done',
};

/** A group's title; Preparing and Apply manually read STATE_PREPARING and STATE_MANUAL (v30 ST5: one source). */
export function queueGroupTitle(group: QueueGroup, t: MessageRenderer): string {
  if (group === 'preparing') return t('STATE_PREPARING');
  if (group === 'manual') return t('STATE_MANUAL');
  return QUEUE_GROUP_TITLE[group];
}

/** The group a row sits in (null: a Prepare the pane does not show, such as a cancelled or a queued one). */
export function groupOf(row: QueueRow): QueueGroup | null {
  if (row.kind === 'prepare') {
    const { state } = row.item;
    if (isActivePrepareState(state)) return 'preparing';
    if (state === 'failed' || state === 'prepared') return 'attention';
    return null;
  }
  switch (row.item.display) {
    case 'applying':
      return 'applying';
    case 'ready':
    case 'waiting_reset':
      return 'up_next';
    case 'manual':
      return 'manual';
    case 'failed':
    case 'needs_you':
      return 'attention';
    case 'applied':
      return 'done';
  }
}

/** The Queue pane's filter tabs: Active (preparing, up next, applying, manual) and Done (the finished ones). */
export const QUEUE_FILTERS = ['all', 'active', 'done'] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];
export const QUEUE_FILTER_LABEL: Record<QueueFilter, string> = { all: 'All', active: 'Active', done: 'Done' };
const ACTIVE_GROUPS: readonly QueueGroup[] = ['applying', 'preparing', 'up_next', 'manual'];

export function inQueueFilter(group: QueueGroup, filter: QueueFilter): boolean {
  if (filter === 'all') return true;
  return ACTIVE_GROUPS.includes(group) === (filter === 'active');
}

/** The pane's rows, grouped in order (empty groups left out); the rows keep the server's order within a group. */
export function groupRows(
  preparing: readonly PreparingItem[],
  items: readonly QueuePaneItem[],
  filter: QueueFilter = 'all',
  hidden: ReadonlySet<string> = new Set(),
): Array<{ group: QueueGroup; rows: QueueRow[] }> {
  const rows: QueueRow[] = [
    ...preparing.map((item) => ({ kind: 'prepare' as const, item })),
    ...items.map((item) => ({ kind: 'queue' as const, item })),
  ];
  const byGroup = new Map<QueueGroup, QueueRow[]>();
  for (const row of rows) {
    if (hidden.has(rowKey(row))) continue;
    const group = groupOf(row);
    if (!group || !inQueueFilter(group, filter)) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), row]);
  }
  return QUEUE_GROUPS.filter((group) => byGroup.has(group)).map((group) => ({ group, rows: byGroup.get(group)! }));
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** v30 ST5: the state icons' names are components/queue's (StateLine draws them). */
export type StateIcon = StateIconName;

/** A row's state line: an icon, the state's words, and a muted detail. */
export interface StateLine {
  icon: StateIcon;
  text: string;
  detail?: string;
  /** The detail reads as a warning (needs you) rather than muted. */
  tone?: 'muted' | 'warning' | 'error';
}

/** After this long with no save, a Prepare with the person's own AI adds "Waiting for your AI client". */
export const OWN_AI_QUIET_MS = 2 * 60_000;

const RUN_WORDS: Record<AutofillAgentRunKind, string> = {
  agent: 'with Run auto-apply',
  tab: 'in the Queue tab',
  manual: 'by you',
};

export interface StateContext {
  t: MessageRenderer;
  now: number;
  /** "12:00 AM Pacific Time". */
  resetText: string;
  /** QUEUE_SIZE_MAX, for the "queue full" words (v2.0 fix REQ-3: MSG_PREPARE_QUEUE_FULL, not a literal). */
  queueMax: number;
  /** This row's place among Up next (1-based), when it is there. */
  place?: number;
  /** A finished time in the person's own clock ("2:14 PM"). */
  clock?: (iso: string) => string;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** The state line of a row (08's state table). */
export function stateLine(row: QueueRow, context: StateContext): StateLine {
  const { t } = context;
  if (row.kind === 'prepare') {
    const item = row.item;
    if (isActivePrepareState(item.state)) {
      if (item.mode === 'mcp') {
        const quiet = context.now - Date.parse(item.updatedAt) >= OWN_AI_QUIET_MS;
        return {
          icon: 'spinner',
          text: t('STATE_PREPARING_OWN_AI'),
          ...(quiet ? { detail: 'Waiting for your AI client', tone: 'muted' as const } : {}),
        };
      }
      return { icon: 'spinner', text: t('STATE_PREPARING'), detail: stepText(item.step, item.resumeMode) };
    }
    if (item.state === 'prepared') {
      return {
        icon: 'info',
        text: t('STATE_PREPARED'),
        detail: item.error ?? t('MSG_PREPARE_QUEUE_FULL', { limit: context.queueMax }),
        tone: 'muted',
      };
    }
    return {
      icon: 'x',
      text: t('STATE_PREPARE_FAILED'),
      detail: item.error ?? item.reason?.label ?? t('MSG_PREPARE_FAILED'),
      tone: 'error',
    };
  }
  const item = row.item;
  const words = item.label || t(QUEUE_PANE_DISPLAY_LABELS[item.display]);
  switch (item.display) {
    case 'ready':
      return { icon: 'dot', text: words, ...(context.place ? { detail: `${ordinal(context.place)} in line` } : {}) };
    case 'waiting_reset':
      return { icon: 'clock', text: words, detail: `until ${context.resetText}`, tone: 'muted' };
    case 'applying':
      return { icon: 'pulse', text: words, detail: item.run ? RUN_WORDS[item.run] : undefined };
    case 'applied': {
      const at = item.finishedAt ? (context.clock ?? timeOf)(item.finishedAt) : undefined;
      return { icon: 'check', text: words, detail: at };
    }
    case 'failed':
      return { icon: 'x', text: words, detail: item.reason ? REASON_TEXT[item.reason] : undefined, tone: 'error' };
    case 'needs_you':
      return { icon: 'warning', text: words, detail: item.reason ? REASON_TEXT[item.reason] : undefined, tone: 'warning' };
    case 'manual':
      return { icon: 'hand', text: words };
  }
}

/** A row's actions, in order: the first is the primary one (kept visible on a phone); the rest go into ⋯ there. */
export type QueueAction =
  | 'cancel'
  | 'view_kit'
  | 'remove'
  | 'open_tracker'
  | 'try_again'
  | 'open_job'
  | 'mark_applied'
  | 'dismiss'
  | 'prepare';

/** The actions of 08's state table, by row. */
export function rowActions(row: QueueRow): QueueAction[] {
  if (row.kind === 'prepare') {
    const { state } = row.item;
    if (isActivePrepareState(state)) return ['cancel'];
    if (state === 'prepared') return ['prepare'];
    return ['try_again', 'dismiss'];
  }
  const item = row.item;
  const remove: QueueAction[] = ['remove'];
  switch (item.display) {
    case 'ready':
    case 'waiting_reset':
      return ['view_kit', ...remove];
    case 'applying':
      return ['view_kit'];
    case 'applied':
      return item.applicationId ? ['open_tracker'] : [];
    case 'failed':
      return [...(item.applicationId ? (['try_again'] as const) : []), 'open_job', 'mark_applied', ...remove];
    case 'needs_you':
      return ['open_job', 'mark_applied', ...(item.applicationId ? (['try_again'] as const) : []), ...remove];
    case 'manual':
      return ['open_job', 'mark_applied', 'view_kit', ...remove];
  }
}

/** The words of each action (the row's job name goes into its accessible name). */
export const ACTION_LABEL: Record<QueueAction, string> = {
  cancel: 'Cancel',
  view_kit: 'View kit',
  remove: 'Remove',
  open_tracker: 'Open in Job Tracker',
  try_again: 'Try again',
  open_job: 'Open job page',
  mark_applied: 'Mark as applied',
  dismiss: 'Dismiss',
  prepare: 'Prepare & Queue',
};

/** The kit line's chip (v20 A29): which resume the prepared item uses. Null for a row queued before v2.0. */
export function kitResumeText(item: Pick<QueuePaneItem, 'resumeMode' | 'prepareId'>): string | null {
  if (item.resumeMode) return RESUME_MODE_SHORT[item.resumeMode];
  return item.prepareId === null ? 'Queued before v2.0' : null;
}

/** Whether the Queue tab's row is in the extension's hands (its run holds a reservation). */
export const isApplying = (item: Pick<QueuePaneItem, 'display'>) => item.display === 'applying';

/** The Up next places (1-based) of the supported rows, in the order the extension takes them. */
export function upNextPlaces(items: readonly QueuePaneItem[]): Map<string, number> {
  const places = new Map<string, number>();
  let place = 0;
  for (const item of items) {
    if (item.display === 'ready' || item.display === 'waiting_reset') places.set(item.queueId, ++place);
  }
  return places;
}

// Usage, live summary, polling ----------------------------------------------------------------------------------------

/** The Free account's usage: the meter's numbers (reserved = runs in progress), or null for an unlimited one. */
export function usageView(
  usage: QueueUsage | null | undefined,
  items: readonly Pick<QueuePaneItem, 'display' | 'run'>[],
): { used: number; limit: number; reserved: number; reached: boolean; resetText: string } | null {
  if (!usage) return null;
  const reserved = items.filter((item) => item.display === 'applying' && item.run !== 'manual').length;
  return { used: usage.used, limit: usage.limit, reserved: Math.min(reserved, usage.used), reached: usage.reached, resetText: usage.resetText };
}

/**
 * "Up next" says when it goes on while the daily limit holds the supported rows. v2.0 fix (UX-8): "continues at", not
 * "resumes at", which reads as résumés in a resume app.
 */
export function upNextTitle(waiting: boolean, resetText: string): string {
  return waiting ? `${QUEUE_GROUP_TITLE.up_next} · continues at ${resetText}` : QUEUE_GROUP_TITLE.up_next;
}

/**
 * v2.0 fix (REQ-4, UX-8): the waiting notice's second line: the admin-editable MSG_WAITING_FOR_RESET ("Daily auto-apply
 * limit reached. These jobs wait until {reset_time}."), then that manual jobs don't count.
 */
export function waitingNoticeLine(t: MessageRenderer, resetText: string): string {
  return `${t('MSG_WAITING_FOR_RESET', { reset_time: resetText })} Jobs you apply to by hand don't count.`;
}

const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`;

/**
 * The Queue pane's live summary, "1 job preparing. 2 jobs ready. 1 applied.": the parts there are, never a row at a
 * time. Empty when the pane is empty.
 */
export function liveSummary(preparing: readonly PreparingItem[], items: readonly QueuePaneItem[]): string {
  const count = (display: QueuePaneItem['display']) => items.filter((item) => item.display === display).length;
  const active = preparing.filter((item) => isActivePrepareState(item.state)).length;
  const parts: string[] = [];
  if (active > 0) parts.push(`${jobs(active)} preparing.`);
  const ready = count('ready');
  if (ready > 0) parts.push(`${jobs(ready)} ready.`);
  const waiting = count('waiting_reset');
  if (waiting > 0) parts.push(`${jobs(waiting)} waiting for the daily reset.`);
  const applying = count('applying');
  if (applying > 0) parts.push(`${jobs(applying)} applying.`);
  const manual = count('manual');
  if (manual > 0) parts.push(`${manual} to apply manually.`);
  const attention =
    count('failed') + count('needs_you') + preparing.filter((item) => item.state === 'failed' || item.state === 'prepared').length;
  if (attention > 0) parts.push(`${attention} ${attention === 1 ? 'needs' : 'need'} attention.`);
  const applied = count('applied');
  if (applied > 0) parts.push(`${applied} applied.`);
  return parts.join(' ');
}

/** The Saved pane's live summary, "2 preparing. 1 filtered. 3 drafts in the queue.": the parts there are. */
export function savedSummary(items: readonly Pick<SavedJobItem, 'marker'>[]): string {
  const count = (marker: SavedJobItem['marker']) => items.filter((item) => item.marker === marker).length;
  const parts: string[] = [];
  const preparing = count('preparing');
  if (preparing > 0) parts.push(`${preparing} preparing.`);
  const drafts = count('queued');
  if (drafts > 0) parts.push(`${drafts} ${drafts === 1 ? 'draft' : 'drafts'} in the queue.`);
  const filtered = count('filtered');
  if (filtered > 0) parts.push(`${filtered} filtered.`);
  const failed = count('prepare_failed') + count('not_applied');
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? 'needs' : 'need'} attention.`);
  return parts.join(' ');
}

/** The live regions speak at most this often. */
export const LIVE_THROTTLE_MS = 10_000;
/** While anything is preparing or applying, the page reads again this often (PREPARE_POLL_MS). */
export const BUSY_POLL_MS = 3_000;
/** Otherwise this often. */
export const IDLE_POLL_MS = 30_000;

/** How often the panes are read again: often while anything is preparing or applying, slowly otherwise. */
export function pollInterval(
  preparing: readonly Pick<PreparingItem, 'state'>[] | undefined,
  items: readonly Pick<QueuePaneItem, 'display'>[] | undefined,
): number {
  const busy =
    (preparing ?? []).some((item) => isActivePrepareState(item.state)) ||
    (items ?? []).some((item) => item.display === 'applying');
  return busy ? BUSY_POLL_MS : IDLE_POLL_MS;
}

/** A row changed its state since the last read: it flashes. Keys are rowKey; values the state shown. */
export function changedRows(before: ReadonlyMap<string, string>, rows: readonly QueueRow[]): string[] {
  const changed: string[] = [];
  for (const row of rows) {
    const key = rowKey(row);
    const now = row.kind === 'prepare' ? `${row.item.state}:${row.item.step ?? ''}` : row.item.display;
    const was = before.get(key);
    if (was !== undefined && was !== now) changed.push(key);
  }
  return changed;
}

/** The state of every row, for the next changedRows. */
export function rowStates(rows: readonly QueueRow[]): Map<string, string> {
  return new Map(
    rows.map((row) => [rowKey(row), row.kind === 'prepare' ? `${row.item.state}:${row.item.step ?? ''}` : row.item.display]),
  );
}

/** A posting address the page may link to: http(s) only. */
export function postingHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** The Mark as applied confirm's words. */
export const MARK_APPLIED_CONFIRM =
  "Mark this job as applied? It moves to Applied in your Job Tracker and leaves Saved Jobs. This doesn't count toward your daily auto-apply limit.";
