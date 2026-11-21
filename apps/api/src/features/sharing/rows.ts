import {
  normalizePermissions,
  presetOf,
  type GrantState,
  type GrantView,
  type ProfileKey,
} from '@tailorit/shared/sharing';

// v33 SHARE-2: profile_grants as the sharing feature reads it (the one feature besides core/auth/grants.ts that reads
// that table; every other module asks core/auth/grants.ts). The live check itself is grants.ts's LIVE_GRANT_SQL.

/** A grant row with its grantee's name (users b, joined; null before anyone accepted) and its state as shown. */
export interface GrantRow {
  id: string;
  owner_user_id: string;
  grantee_email: string;
  grantee_user_id: string | null;
  grantee_name: string | null;
  permissions: string[] | null;
  state: GrantState;
  /** SHOWN_STATE: `expired` once a date passed, before the sweep writes it. */
  shown_state: GrantState;
  invite_expires_at: string;
  access_ends_at: string | null;
  remove_queued: boolean;
  created_at: string;
  accepted_at: string | null;
  changed_at: string;
  ended_at: string | null;
}

/** A grant's state as people read it (alias g, parameter @now): a date that passed reads `expired` at once. */
export const SHOWN_STATE = `CASE
    WHEN g.state = 'pending' AND g.invite_expires_at <= CAST(@now AS timestamptz) THEN 'expired'
    WHEN g.state = 'active' AND g.access_ends_at IS NOT NULL AND g.access_ends_at <= CAST(@now AS timestamptz) THEN 'expired'
    ELSE g.state END`;

/** The columns of GrantRow (alias g for profile_grants, b for its grantee; parameter @now). */
export const GRANT_COLUMNS = `g.id, g.owner_user_id, g.grantee_email, g.grantee_user_id, b.name AS grantee_name, g.permissions,
    g.state, ${SHOWN_STATE} AS shown_state, g.invite_expires_at, g.access_ends_at, g.remove_queued, g.created_at,
    g.accepted_at, g.changed_at, g.ended_at`;

/** FROM profile_grants g with its grantee (b). */
export const GRANT_FROM = 'profile_grants g LEFT JOIN users b ON b.id = g.grantee_user_id';

const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** A grant as its owner sees it in Settings › Sharing. */
export function grantViewOf(row: GrantRow): GrantView {
  const permissions = normalizePermissions(row.permissions ?? []);
  return {
    key: row.id as ProfileKey,
    email: row.grantee_email,
    name: row.grantee_user_id !== null && row.accepted_at !== null ? (row.grantee_name ?? '') : null,
    state: row.shown_state,
    permissions,
    preset: presetOf(permissions),
    inviteExpiresAt: iso(row.invite_expires_at)!,
    accessEndsAt: iso(row.access_ends_at),
    removeQueued: row.remove_queued,
    createdAt: iso(row.created_at)!,
    acceptedAt: iso(row.accepted_at),
    endedAt: iso(row.ended_at),
  };
}

/**
 * `values` as a PostgreSQL array literal ('{"a","b"}'), every element quoted: bind it as CAST(@x AS text[]) (or another
 * array type). The client binds scalars only.
 */
export function sqlTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/** The other person's name in a sharing notification: their name, else their address. */
export function nameOrEmail(person: { name: string | null | undefined; email: string }): string {
  return person.name?.trim() || person.email;
}
