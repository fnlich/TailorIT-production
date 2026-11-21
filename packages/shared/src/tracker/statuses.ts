import { z } from 'zod';
// v20 A30
import type { AutofillAgentState } from '../autofill/agent';
import type { MessageKey } from '../constants/constants';
// end v20 A30

// The tracker's statuses, numeric codes (as stored) in the order every select lists them. Archived is not a status: it
// is the application's `archived_at`.

export const APPLICATION_STATUSES = [1, 2, 11, 12, 13, 21, 22, 23, 24] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const STATUS = {
  saved: 1,
  applied: 2,
  screen: 11,
  interviewing: 12,
  offer: 13,
  withdrawn: 21,
  ghosted: 22,
  rejected: 23,
  accepted: 24,
} as const satisfies Record<string, ApplicationStatus>;
export type StatusKey = keyof typeof STATUS;

/** Withdrawn, Ghosted, Rejected, Accepted: an application holds at most one of them. */
export const TERMINAL_STATUSES = [21, 22, 23, 24] as const satisfies readonly ApplicationStatus[];

export const ApplicationStatusSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(11),
  z.literal(12),
  z.literal(13),
  z.literal(21),
  z.literal(22),
  z.literal(23),
  z.literal(24),
]);

/** Phosphor icon names the web maps to components. */
export type StatusIcon =
  | 'bookmark'
  | 'paper-plane'
  | 'file-search'
  | 'chats'
  | 'envelope-open'
  | 'undo'
  | 'chat-slash'
  | 'x-circle'
  | 'confetti';

export type StatusTone = 'neutral' | 'blue' | 'orange' | 'purple' | 'green' | 'red';

/** A board column's default visibility: always shown, or shown only while it has cards. */
export type ColumnDefault = 'forced' | 'default';

export interface StatusInfo {
  code: ApplicationStatus;
  key: StatusKey;
  /** Board columns, selects, menus. */
  label: string;
  /** The list view's stepper. */
  stepLabel: string;
  /** The Application flow chart's nodes. */
  sankeyLabel: string;
  icon: StatusIcon;
  tone: StatusTone;
  /**
   * The chart colour; Saved is not charted. v31 INT-2: the v3.1 stage colours (the values of the tokens the web's chart
   * reads, apps/web/src/features/tracker/chart/FlowChart.tsx STAGE_TOKEN; a web test keeps them equal), so the
   * Sankey report's answer and the chart's fallback match what the page draws.
   */
  sankeyColor: string | null;
  column: ColumnDefault;
  terminal: boolean;
}

const info = (
  code: ApplicationStatus,
  key: StatusKey,
  label: string,
  icon: StatusIcon,
  tone: StatusTone,
  sankeyColor: string | null,
  column: ColumnDefault,
  extra: { stepLabel?: string; sankeyLabel?: string } = {},
): StatusInfo => ({
  code,
  key,
  label,
  stepLabel: extra.stepLabel ?? label,
  sankeyLabel: extra.sankeyLabel ?? label,
  icon,
  tone,
  sankeyColor,
  column,
  terminal: code >= 21,
});

export const STATUS_INFO: Readonly<Record<ApplicationStatus, StatusInfo>> = {
  1: info(1, 'saved', 'Saved', 'bookmark', 'neutral', null, 'forced'),
  2: info(2, 'applied', 'Applied', 'paper-plane', 'blue', '#3a45c9', 'forced'),
  11: info(11, 'screen', 'Screen', 'file-search', 'orange', '#2563b5', 'default', { sankeyLabel: 'Screening' }),
  12: info(12, 'interviewing', 'Interviewing', 'chats', 'purple', '#6a73da', 'forced', { stepLabel: 'Interview' }),
  13: info(13, 'offer', 'Offer', 'envelope-open', 'green', '#1d7f4e', 'forced'),
  21: info(21, 'withdrawn', 'Withdrawn', 'undo', 'red', '#d9a021', 'default'),
  22: info(22, 'ghosted', 'Ghosted', 'chat-slash', 'red', '#8e94ab', 'default'),
  23: info(23, 'rejected', 'Rejected', 'x-circle', 'red', '#c2363a', 'forced'),
  24: info(24, 'accepted', 'Accepted', 'confetti', 'green', '#16653e', 'default'),
};

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === 'number' && (APPLICATION_STATUSES as readonly number[]).includes(value);
}

export function isTerminalStatus(status: ApplicationStatus): boolean {
  return (TERMINAL_STATUSES as readonly number[]).includes(status);
}

/** The board/select label ("Interviewing"). */
export function statusLabel(status: ApplicationStatus): string {
  return STATUS_INFO[status].label;
}

/** A status from a code, a numeric string or a key ("12", "interviewing"); null otherwise. */
export function parseStatus(value: unknown): ApplicationStatus | null {
  if (isApplicationStatus(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const asNumber = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (isApplicationStatus(asNumber)) return asNumber;
  return Object.hasOwn(STATUS, text) ? STATUS[text as StatusKey] : null;
}

/** Statuses that celebrate (confetti on reaching them). */
export function isCelebratedStatus(status: ApplicationStatus): boolean {
  return status === STATUS.offer || status === STATUS.accepted;
}

// v31 FIX-DOCS: an empty board lane's words are the constants MSG_TRACKER_LANE_EMPTY_TITLE / _TEXT / _DROP (the web's
// BoardView reads them), no longer copies here.

// v20 A30, v33 TRACKER (F1 "No Draft lane") --------------------------------------------------------------------------
// "Draft" (DECISIONS A30): a Tracker entry at Saved whose job has a live queue row (prepared, its kit frozen, waiting
// or being applied). v3.3 (the owner: "Draft lane in Job tracker is useless. remove this lane. If the job in saved lane
// is drafted, just mark only as `Draft`"): Draft is no longer a status anywhere, only a mark. The entry stays in Saved
// (the board's Saved lane, the list's Saved stage, MCP's `saved` with its Q flag) and shows a Draft badge on its card,
// its row and its detail. It was never stored: STATUS, STATUS_INFO and application_status_events are unchanged.
// Applied (2) ends it as before; removing the queue row, or a row that finished without being applied (failed,
// skipped, needs-you), drops the mark.

/** The queue row states that mark a Saved entry Draft: waiting its turn or being applied (not yet finished). */
export const DRAFT_QUEUE_STATES = ['queued', 'running'] as const satisfies readonly AutofillAgentState[];

/** Draft's words live in one place, the constant STATUS_DRAFT_LABEL (admin-editable): read it, never copy it. */
export const DISPLAY_STATUS_DRAFT_LABEL_KEY = 'STATUS_DRAFT_LABEL' as const satisfies MessageKey;

/**
 * Whether an entry carries the Draft mark: Saved, not archived, and its job has a live queue row (`queued`: a row in
 * DRAFT_QUEUE_STATES). A `queued` left out (an older answer) counts as false.
 */
export function isDraftEntry(entry: {
  status: ApplicationStatus;
  queued?: boolean | null;
  archivedAt?: string | null;
}): boolean {
  return entry.status === STATUS.saved && entry.queued === true && !entry.archivedAt;
}
// end v20 A30
