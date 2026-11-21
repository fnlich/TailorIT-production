import {
  SHARE_PERMISSION_ROWS,
  SHARE_PRESET_PERMISSIONS,
  closureOf,
  neededBy,
  normalizePermissions,
  presetOf,
  rowOfPermission,
  type SharePermission,
  type SharePreset,
} from '@tailorit/shared/sharing';

// v33 SHARE-7 (PLAN F9 "Permissions"; SP v33 PLAN-sharing.md §3): the permission grid's logic, apart from its drawing.
// A set is always closed (SHARE-0's closure rules): ticking a box ticks every box it needs; a box another ticked box
// needs is ticked and cannot be unticked (the grid shows it disabled with "Needed by <row>."). The presets are SHARE-0's
// sets; any other set is Custom. The server refuses a set that is not closed, so the grid never sends one.

/** One box of the grid as it is drawn. */
export interface GridBox {
  perm: SharePermission;
  checked: boolean;
  /** Ticked because a ticked box needs it: it cannot be unticked. */
  locked: boolean;
  /** The row of the first ticked box that needs it (the tip's {row}); null when nothing needs it. */
  neededByRow: string | null;
}

/** One row of the grid: its id, words keys, and its See and Change boxes (null where the row has none). */
export interface GridRow {
  id: (typeof SHARE_PERMISSION_ROWS)[number]['id'];
  label: (typeof SHARE_PERMISSION_ROWS)[number]['label'];
  tip: (typeof SHARE_PERMISSION_ROWS)[number]['tip'];
  see: GridBox | null;
  change: GridBox | null;
}

/** The set after the person ticks (`on`) or unticks `perm`: ticking adds what it needs; a needed box stays ticked. */
export function toggleBox(perms: readonly SharePermission[], perm: SharePermission, on: boolean): SharePermission[] {
  if (on) return closureOf([...perms, perm]);
  if (neededBy(perm, perms).length > 0) return normalizePermissions(perms);
  return normalizePermissions(perms.filter((other) => other !== perm));
}

/** The boxes of a preset (a copy); Custom keeps `current`. */
export function presetBoxes(preset: SharePreset, current: readonly SharePermission[]): SharePermission[] {
  if (preset === 'custom') return normalizePermissions(current);
  return [...SHARE_PRESET_PERMISSIONS[preset]];
}

/** One box's state in `perms`. `labelOf` gives a row's words (the tip names the needing box's row). */
export function boxOf(perm: SharePermission, perms: readonly SharePermission[], labelOf: (row: GridRow['label']) => string): GridBox {
  const needing = neededBy(perm, perms);
  const checked = perms.includes(perm);
  const first = needing[0];
  return {
    perm,
    checked,
    locked: checked && needing.length > 0,
    neededByRow: first ? labelOf(rowOfPermission(first).label) : null,
  };
}

/** The grid's rows for `perms`, in SHARE-0's order. */
export function gridOf(perms: readonly SharePermission[], labelOf: (row: GridRow['label']) => string): GridRow[] {
  return SHARE_PERMISSION_ROWS.map((row) => ({
    id: row.id,
    label: row.label,
    tip: row.tip,
    see: row.see ? boxOf(row.see, perms, labelOf) : null,
    change: row.change ? boxOf(row.change, perms, labelOf) : null,
  }));
}

/** The preset a set is (SHARE-0's presetOf: Custom unless exactly a preset's boxes). */
export const presetOfBoxes = (perms: readonly SharePermission[]): SharePreset => presetOf(perms);

/** Whether the set lets them change anything (the list's summary says "can see" or "can see and change"). */
export function canChangeSomething(perms: readonly SharePermission[]): boolean {
  return perms.some((perm) => SHARE_PERMISSION_ROWS.some((row) => row.change === perm));
}
