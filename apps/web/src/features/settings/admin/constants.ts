import {
  durationText,
  expectedOf,
  formatTimeOfDay,
  microsToUsdText,
  parseDuration,
  renderMessage,
  resetText,
  usdToMicros,
  validateConstant,
  type AdminConstantList,
  type ConstantGroup,
  type ConstantKey,
} from '@tailorit/shared/constants';

// v2.0: Admin › Constants (docs/design/v2.0/08-ui.md, "Constants"; 02-constants.md). What each row shows (its value
// and where it came from), the typed editor of each kind, and the value an edit sends, in the stored form: micro-dollars
// for a usd kind, null for Unlimited. Pure, so the tests read it without a page. The server checks every value again
// (validateConstant) and its 400 message shows under the field.

/** One row of Admin › Constants as the list answers it (its key a plain string). */
export type ConstantRow = AdminConstantList['items'][number];

/** The groups as sections, in the order the admin reads them. */
export const GROUP_ORDER: readonly ConstantGroup[] = [
  'accounts',
  'time',
  'ai',
  'prepare',
  'auto_apply',
  'resumes',
  'jobs',
  'mcp',
  'contact',
  'announcements',
  'retention',
  'messages',
];

export const GROUP_TITLE: Record<ConstantGroup, string> = {
  accounts: 'Accounts',
  time: 'Day boundary',
  ai: 'Server AI',
  prepare: 'Prepare',
  auto_apply: 'Queue',
  resumes: 'Resumes',
  jobs: 'Jobs',
  mcp: 'MCP',
  contact: 'Contact',
  announcements: 'Announcements',
  retention: 'Retention',
  messages: 'Messages',
};

export type SourceTone = 'tint' | 'neutral' | 'outline' | 'warning';

/** The source badge: "Admin override", ".env", "Default", or "Stored override is invalid". */
export function sourceBadge(row: Pick<ConstantRow, 'source' | 'invalidOverride'>): { label: string; tone: SourceTone } {
  if (row.invalidOverride) return { label: 'Stored override is invalid', tone: 'warning' };
  if (row.source === 'db') return { label: 'Admin override', tone: 'tint' };
  if (row.source === 'env') return { label: '.env', tone: 'neutral' };
  return { label: 'Default', tone: 'outline' };
}

/** Whether Reset applies: an override is stored (valid or not). */
export function hasOverride(row: Pick<ConstantRow, 'source' | 'invalidOverride'>): boolean {
  return row.source === 'db' || row.invalidOverride;
}

/**
 * Where Reset sends the value, for the confirm: ".env (7)" when .env sets it, else "the default (7)".
 */
export function resetTarget(row: Pick<ConstantRow, 'envSet' | 'envDisplay' | 'defaultDisplay'>): string {
  return row.envSet && row.envDisplay !== null ? `.env (${row.envDisplay})` : `the default (${row.defaultDisplay})`;
}

/** The rows a search keeps: its words in the label, the key, the help or the value. */
export function matchesSearch(row: Pick<ConstantRow, 'key' | 'label' | 'help' | 'display'>, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${row.label} ${row.key} ${row.help} ${row.display}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The rows by group, in GROUP_ORDER, each group's rows as the server lists them; empty groups left out. */
export function groupRows<R extends Pick<ConstantRow, 'group'>>(rows: readonly R[]): { group: ConstantGroup; rows: R[] }[] {
  return GROUP_ORDER.map((group) => ({ group, rows: rows.filter((row) => row.group === group) })).filter(
    (entry) => entry.rows.length > 0,
  );
}

// The editor ----------------------------------------------------------------------------------------------------------

/** The editor's state: the value as typed, and Unlimited for the kinds that allow it. */
export interface ConstantDraft {
  text: string;
  unlimited: boolean;
}

/** The kinds that may be Unlimited (null). */
export const UNLIMITED_KINDS = new Set(['limit', 'usd_limit']);

/** The durations offered in the Select; anything else is "Custom". */
export const DURATION_CHOICES = [
  { value: 'P1W', label: '1 week' },
  { value: 'P1M', label: '1 month' },
  { value: 'P3M', label: '3 months' },
  { value: 'custom', label: 'Custom' },
] as const;

/** Every half hour of the day, as the time Select lists it ("00:30" → "12:30 AM"). */
export const HALF_HOURS: readonly { value: string; label: string }[] = Array.from({ length: 48 }, (_unused, index) => {
  const value = `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`;
  return { value, label: formatTimeOfDay(value) };
});

/** The editor's starting state from the row's current value. */
export function draftOf(row: Pick<ConstantRow, 'kind' | 'value'>): ConstantDraft {
  const value = row.value;
  switch (row.kind) {
    case 'limit':
    case 'usd_limit':
      if (value === null) return { text: '', unlimited: true };
      return { text: row.kind === 'usd_limit' ? microsToUsdText(Number(value)) : String(value), unlimited: false };
    case 'usd':
      return { text: microsToUsdText(Number(value)), unlimited: false };
    case 'bool':
      return { text: value ? 'true' : 'false', unlimited: false };
    case 'email':
      return { text: typeof value === 'string' ? value : '', unlimited: false };
    case 'prices':
      return { text: JSON.stringify(value, null, 2), unlimited: false };
    default:
      return { text: value === null || value === undefined ? '' : String(value), unlimited: false };
  }
}

export type DraftResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * The value an edit sends, in the stored form, checked with the constants' own validateConstant (the server checks it
 * again). "0.10" is 100000 micro-dollars; Unlimited is null; an empty email is none (null).
 */
export function valueOfDraft(row: Pick<ConstantRow, 'key' | 'kind'>, draft: ConstantDraft): DraftResult {
  const text = draft.text.trim();
  let value: unknown;
  switch (row.kind) {
    case 'int':
    case 'limit':
      if (row.kind === 'limit' && draft.unlimited) value = null;
      else if (!/^-?\d+$/.test(text)) return { ok: false, error: wordsOf(row) };
      else value = Number(text);
      break;
    case 'usd':
    case 'usd_limit':
      if (row.kind === 'usd_limit' && draft.unlimited) value = null;
      else {
        const micros = usdToMicros(text);
        if (micros === null) return { ok: false, error: wordsOf(row) };
        value = micros;
      }
      break;
    case 'ratio':
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return { ok: false, error: wordsOf(row) };
      value = Number(text);
      break;
    case 'bool':
      value = text === 'true';
      break;
    case 'email':
      value = text === '' ? null : text;
      break;
    case 'prices':
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, error: wordsOf(row) };
      }
      break;
    case 'message':
      // The words as written, line breaks kept (only the ends trimmed).
      value = draft.text.replace(/\r\n?/g, '\n').trim();
      break;
    default:
      value = text;
  }
  const checked = validateConstant(row.key as ConstantKey, value);
  return checked.ok ? { ok: true, value: checked.value } : { ok: false, error: checked.error };
}

/** The constants' words for what a valid value looks like. */
function wordsOf(row: Pick<ConstantRow, 'key'>): string {
  return expectedOf(row.key as ConstantKey);
}

/** Which duration choice a value is ("P1M" → "P1M"; "P30D" → "custom"). */
export function durationChoiceOf(value: string): (typeof DURATION_CHOICES)[number]['value'] {
  const known = DURATION_CHOICES.find((choice) => choice.value === value);
  return known && parseDuration(value) ? known.value : 'custom';
}

/** "P30D" → "30 days", for the custom duration's hint. */
export const durationWords = durationText;

/**
 * v2.0 fix (UX-12): who last changed an override, never a raw user id: the admin's email (as the API answers it once
 * FIX-INT has it send the email), the signed-in admin's own email for their own id, else "another admin".
 */
export function changedByText(updatedBy: string | null, me: { id: string; email: string } | null | undefined): string | null {
  if (!updatedBy) return null;
  if (updatedBy.includes('@')) return updatedBy;
  if (me && updatedBy === me.id) return me.email;
  return 'another admin';
}

/** Sample values for a message's live preview ({reset_time} is the installation's own, see previewParams). */
export const SAMPLE_PARAMS = {
  limit: 7,
  used: 3,
  max: 100,
  minutes: 12,
  // v30 INT-0: the counts of the sign-in, ZIP and upload messages.
  seconds: 30,
  left_out: 3,
  contact_email: 'admin@example.com',
  reason: 'on-site',
  value: 'on-site',
} as const;

/**
 * v2.0 fix (REQ-11): the preview's values, its {reset_time} from the reset constants as they are now (DAY_RESET_TIME,
 * DAY_RESET_ZONE_LABEL: "6:30 AM Eastern Time" once an admin moved the reset), not a fixed "12:00 AM Pacific Time".
 */
export function previewParams(reset: { time: string; zoneLabel: string }) {
  return { ...SAMPLE_PARAMS, reset_time: resetText(reset.time, reset.zoneLabel) };
}

/** A message as people would read it, with the sample values filled in. */
export function messagePreview(template: string, params: ReturnType<typeof previewParams>): string {
  return renderMessage(template, params);
}

/** `text` with `{name}` put where the cursor was (or over the selection), and where the cursor goes after it. */
export function insertPlaceholder(
  text: string,
  name: string,
  selection: { start: number; end: number } | null,
): { text: string; cursor: number } {
  const token = `{${name}}`;
  const start = selection ? Math.max(0, Math.min(selection.start, text.length)) : text.length;
  const end = selection ? Math.max(start, Math.min(selection.end, text.length)) : text.length;
  return { text: text.slice(0, start) + token + text.slice(end), cursor: start + token.length };
}
