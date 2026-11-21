import { z } from 'zod';
import type { MessageKey } from '../constants/constants';
import { sharedMessage } from '../constants/public/defaults';

// v33 SHARE-0 (PLAN F9; SP v33 PLAN-sharing.md §3): what a person (A) lets the person they share their profile with (B)
// do. A ticks the boxes per grant (Settings › Sharing) and may change them at any time; the server re-reads them on B's
// next request. A set is stored only when it is closed: every box a ticked box needs is ticked too (SHARE_IMPLIES). The
// server refuses a set that is not closed (validation_failed, naming the missing keys); it never adds keys silently. The
// web's grid shows the boxes another box needs ticked and disabled, with a "Needed by {row}" tip.
//
// Always locked, whatever is ticked (no permission exists for them): A's sign-in and sessions, connected apps, MCP
// tokens, settings, custom instructions and reports, extension pairing, job-site sign-ins, A's name and notification
// settings, admin, sharing itself, approving B's queued jobs, dev routes.

/** Every permission, in the grid's order (row by row, See before Change). The canonical order of a stored set. */
export const SHARE_PERMISSIONS = [
  'tracker:view',
  'tracker:edit',
  'documents:view',
  'documents:edit',
  'prepare:view',
  'prepare:run',
  'queue:edit',
  'apply',
  'autofill:view',
  'autofill:edit',
  'settings:view',
  'settings:edit',
  'sensitive:view',
  'sensitive:edit',
  'exports',
  'mcp',
] as const;
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];
export const SharePermissionSchema = z.enum(SHARE_PERMISSIONS);

const PERMISSION_SET: ReadonlySet<string> = new Set(SHARE_PERMISSIONS);
/** Whether `value` names a permission. */
export const isSharePermission = (value: unknown): value is SharePermission =>
  typeof value === 'string' && PERMISSION_SET.has(value);

/**
 * The boxes each box needs directly (the closure rules). Change implies See; `prepare:run` also needs what a kit and
 * MCP's prepare_job_context show (the Job Tracker, Documents, the autofill facts and the job settings); `queue:edit` the
 * queue it changes; `apply` Prepare; `sensitive:*` the autofill profile they belong to; `exports` what they export;
 * `mcp` the Job Tracker its read tools list. v33 SHARE-7: `sensitive:edit` also needs `autofill:edit`: the sensitive
 * answers are saved with the autofill profile (one PUT), so changing them without changing Autofill info is no choice.
 */
export const SHARE_IMPLIES: Readonly<Record<SharePermission, readonly SharePermission[]>> = {
  'tracker:view': [],
  'tracker:edit': ['tracker:view'],
  'documents:view': [],
  'documents:edit': ['documents:view'],
  'prepare:view': [],
  'prepare:run': ['prepare:view', 'tracker:view', 'documents:view', 'autofill:view', 'settings:view'],
  'queue:edit': ['prepare:view'],
  apply: ['prepare:run'],
  'autofill:view': [],
  'autofill:edit': ['autofill:view'],
  'settings:view': [],
  'settings:edit': ['settings:view'],
  'sensitive:view': ['autofill:view'],
  'sensitive:edit': ['sensitive:view', 'autofill:edit'], // v33 SHARE-7: saved with the autofill profile
  exports: ['tracker:view', 'documents:view'],
  mcp: ['tracker:view'],
};

const ORDER = new Map<SharePermission, number>(SHARE_PERMISSIONS.map((perm, at) => [perm, at]));
const byOrder = (a: SharePermission, b: SharePermission) => ORDER.get(a)! - ORDER.get(b)!;

/** `perms` once each, in the canonical order (SHARE_PERMISSIONS'); anything that is no permission is dropped. */
export function normalizePermissions(perms: Iterable<unknown>): SharePermission[] {
  return [...new Set([...perms].filter(isSharePermission))].sort(byOrder);
}

/** Every box `perms` needs, directly or through another box, `perms` included (canonical order). */
export function closureOf(perms: Iterable<SharePermission>): SharePermission[] {
  const out = new Set<SharePermission>();
  const visit = (perm: SharePermission) => {
    if (out.has(perm)) return;
    out.add(perm);
    for (const needed of SHARE_IMPLIES[perm]) visit(needed);
  };
  for (const perm of perms) if (isSharePermission(perm)) visit(perm);
  return [...out].sort(byOrder);
}

/** The boxes `perms` needs but lacks (canonical order); empty for a closed set. */
export function missingImplied(perms: Iterable<SharePermission>): SharePermission[] {
  const have = new Set(perms);
  return closureOf(have).filter((perm) => !have.has(perm));
}

/** Whether every box a ticked box needs is ticked too. The empty set is closed. */
export const isClosed = (perms: Iterable<SharePermission>): boolean => missingImplied(perms).length === 0;

/**
 * The ticked boxes of `perms` that need `perm` (directly or through another box), canonical order: the grid disables
 * `perm` while this is not empty and says "Needed by {row}" of the first.
 */
export function neededBy(perm: SharePermission, perms: Iterable<SharePermission>): SharePermission[] {
  return normalizePermissions(perms).filter((other) => other !== perm && closureOf([other]).includes(perm));
}

// The grid's rows ---------------------------------------------------------------------------------------------------------

/** One row of the grid: its See box and its Change box (null: the row has none), its words. */
export interface SharePermissionRow {
  id: string;
  see: SharePermission | null;
  change: SharePermission | null;
  label: MessageKey;
  tip: MessageKey;
}

/** The grid's rows, in order (PLAN F9's table). Each permission is in exactly one row. */
export const SHARE_PERMISSION_ROWS = [
  { id: 'tracker', see: 'tracker:view', change: 'tracker:edit', label: 'LABEL_SHARING_ROW_TRACKER', tip: 'MSG_SHARING_ROW_TRACKER_TIP' },
  { id: 'documents', see: 'documents:view', change: 'documents:edit', label: 'LABEL_SHARING_ROW_DOCUMENTS', tip: 'MSG_SHARING_ROW_DOCUMENTS_TIP' },
  { id: 'prepare', see: 'prepare:view', change: 'prepare:run', label: 'LABEL_SHARING_ROW_PREPARE', tip: 'MSG_SHARING_ROW_PREPARE_TIP' },
  { id: 'queue', see: null, change: 'queue:edit', label: 'LABEL_SHARING_ROW_QUEUE', tip: 'MSG_SHARING_ROW_QUEUE_TIP' },
  { id: 'apply', see: null, change: 'apply', label: 'LABEL_SHARING_ROW_APPLY', tip: 'MSG_SHARING_ROW_APPLY_TIP' },
  { id: 'autofill', see: 'autofill:view', change: 'autofill:edit', label: 'LABEL_SHARING_ROW_AUTOFILL', tip: 'MSG_SHARING_ROW_AUTOFILL_TIP' },
  { id: 'settings', see: 'settings:view', change: 'settings:edit', label: 'LABEL_SHARING_ROW_SETTINGS', tip: 'MSG_SHARING_ROW_SETTINGS_TIP' },
  { id: 'sensitive', see: 'sensitive:view', change: 'sensitive:edit', label: 'LABEL_SHARING_ROW_SENSITIVE', tip: 'MSG_SHARING_ROW_SENSITIVE_TIP' },
  { id: 'exports', see: 'exports', change: null, label: 'LABEL_SHARING_ROW_EXPORTS', tip: 'MSG_SHARING_ROW_EXPORTS_TIP' },
  { id: 'mcp', see: 'mcp', change: null, label: 'LABEL_SHARING_ROW_MCP', tip: 'MSG_SHARING_ROW_MCP_TIP' },
] as const satisfies readonly SharePermissionRow[];
export type SharePermissionRowId = (typeof SHARE_PERMISSION_ROWS)[number]['id'];
/** The grid's column words. */
export const SHARE_COLUMN_LABELS = { see: 'LABEL_SHARING_SEE', change: 'LABEL_SHARING_CHANGE' } as const satisfies Record<
  'see' | 'change',
  MessageKey
>;
/** The tip of a box another ticked box needs, {row} the needing box's row label. */
export const SHARE_NEEDED_BY_TIP: MessageKey = 'MSG_SHARING_NEEDED_BY';

/** The row a permission is in. */
export function rowOfPermission(perm: SharePermission): (typeof SHARE_PERMISSION_ROWS)[number] {
  return SHARE_PERMISSION_ROWS.find((row) => row.see === perm || row.change === perm)!;
}

// Presets --------------------------------------------------------------------------------------------------------------

/** The grid's presets: `see_only`, `see_and_prepare` (the default of a new grant) and `custom` (anything else). */
export const SHARE_PRESETS = ['see_only', 'see_and_prepare', 'custom'] as const;
export type SharePreset = (typeof SHARE_PRESETS)[number];
export const SHARE_DEFAULT_PRESET: SharePreset = 'see_and_prepare';

/** Each preset's boxes (closed sets, canonical order). */
export const SHARE_PRESET_PERMISSIONS: Readonly<Record<Exclude<SharePreset, 'custom'>, readonly SharePermission[]>> = {
  // The three See boxes of Job Tracker, Documents and Prepare & queue.
  see_only: ['tracker:view', 'documents:view', 'prepare:view'],
  // The table's defaults: See on everything but sensitive answers and exports; Change on the Job Tracker, Documents and
  // Prepare; their own AI on. Queue changes, Apply without my OK and the sensitive answers stay off.
  see_and_prepare: [
    'tracker:view',
    'tracker:edit',
    'documents:view',
    'documents:edit',
    'prepare:view',
    'prepare:run',
    'autofill:view',
    'settings:view',
    'mcp',
  ],
};
/** Each preset's words. */
export const SHARE_PRESET_LABELS = {
  see_only: 'LABEL_SHARING_PRESET_SEE_ONLY',
  see_and_prepare: 'LABEL_SHARING_PRESET_SEE_AND_PREPARE',
  custom: 'LABEL_SHARING_PRESET_CUSTOM',
} as const satisfies Record<SharePreset, MessageKey>;

/** The preset a set is (`custom` unless it is exactly a preset's boxes). */
export function presetOf(perms: Iterable<SharePermission>): SharePreset {
  const key = normalizePermissions(perms).join(' ');
  for (const preset of ['see_only', 'see_and_prepare'] as const) {
    if (SHARE_PRESET_PERMISSIONS[preset].join(' ') === key) return preset;
  }
  return 'custom';
}

// The stored set's schema ----------------------------------------------------------------------------------------------

/**
 * A grant's permissions as a request sends them (POST and PATCH of a grant): known keys, each once, any order; parsed to
 * the canonical order. A set that is not closed fails with MSG_SHARING_NOT_CLOSED naming the missing keys.
 */
export const SharePermissionsSchema = z
  .array(SharePermissionSchema)
  .max(SHARE_PERMISSIONS.length * 2)
  .transform((perms) => normalizePermissions(perms))
  .superRefine((perms, ctx) => {
    const missing = missingImplied(perms);
    if (missing.length > 0) ctx.addIssue({ code: 'custom', message: sharedMessage('MSG_SHARING_NOT_CLOSED', { missing: missing.join(', ') }) });
  });
