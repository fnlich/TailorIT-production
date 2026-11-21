-- v3.3 SHARE-0 (PLAN F9 "Shared profiles"; the design SP v33 PLAN-sharing.md §2, §3, §10, §11): a person (A, the owner)
-- shares their profile with another account (B, the grantee), who then sees and prepares A's data as A allowed and pays
-- for the TailorIT AI they use there.
--
-- profile_grants: one row per invite. Its id is the profile key ('p' and 11 base62 characters, made at random by
-- core/auth/grants.ts newProfileKey), never reused: "Send again" makes a new row. A grant is live (core/auth/grants.ts,
-- the one predicate) while: state 'active', access_ends_at unset or later than now, both accounts enabled, and
-- SHARING_ENABLED on; every request and MCP call reads it again (nothing is cached).
--   grantee_email: the address A typed, normalised (trimmed, lower case); B accepts with a verified sign-in to it.
--   grantee_user_id: B, set when B accepts (an invite is not anyone's yet).
--   permissions: the boxes A ticked (@tailorit/shared/sharing SHARE_PERMISSIONS), a closed set in canonical order; the
--     server refuses one that is not closed. changed_at moves when they, the end date or the state change (MCP's
--     rules pointer).
--   state: pending (invited, until invite_expires_at) -> active (accepted_at) -> revoked (A) | left (B) | expired (the
--     sweep, past either date); pending -> declined | revoked | expired. An ended grant never becomes live again.
--   remove_queued: A's "Also remove the jobs they queued that haven't started" when A stops sharing (default ticked).
--   canary: the grant's MCP tripwire (PLAN-sharing.md §7): random, never shown to A or B, never logged; read only
--     through core/auth/grants.ts heldGrants.
-- One open grant (pending or active) per owner and address.
--
-- profile_activity: what B did on A's profile, counted by the hour (grant, area, action, via): ids and codes only, never
-- a value; names are joined when shown. Both sides read it (B up to ended_at). Kept SHARING_ACTIVITY_KEEP_DAYS.
--
-- notification_prefs.kind_group: the new group `sharing` (@tailorit/shared/notifications NOTIFICATION_GROUPS; its kinds
-- sharing_invited, _changed, _accepted, _declined, _prepared, _ended pass notifications.kind's own check as they are).
--
-- Two new empty tables and one wider check: no row of another table changes.

CREATE TABLE profile_grants(
  id text PRIMARY KEY CHECK (id ~ '^p[0-9A-Za-z]{11}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_email text NOT NULL CHECK (char_length(grantee_email) BETWEEN 3 AND 254 AND grantee_email = lower(btrim(grantee_email))),
  grantee_user_id text REFERENCES users(id) ON DELETE CASCADE,
  permissions text[] NOT NULL DEFAULT '{}' CHECK (
    array_position(permissions, NULL) IS NULL
    AND permissions <@ ARRAY['tracker:view','tracker:edit','documents:view','documents:edit','prepare:view','prepare:run',
      'queue:edit','apply','autofill:view','autofill:edit','settings:view','settings:edit','sensitive:view',
      'sensitive:edit','exports','mcp']::text[]
  ),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','declined','revoked','left','expired')),
  invite_expires_at timestamptz NOT NULL,
  access_ends_at timestamptz,
  remove_queued boolean NOT NULL DEFAULT true,
  canary text NOT NULL CHECK (char_length(canary) BETWEEN 16 AND 64),
  created_at timestamptz NOT NULL,
  accepted_at timestamptz,
  changed_at timestamptz NOT NULL,
  ended_at timestamptz,
  -- Nobody holds a grant of their own profile.
  CONSTRAINT profile_grants_not_own CHECK (grantee_user_id IS DISTINCT FROM owner_user_id),
  -- An accepted grant names its grantee and when it was accepted; an ended one when it ended.
  CONSTRAINT profile_grants_accepted CHECK (state NOT IN ('active','left') OR (grantee_user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT profile_grants_ended CHECK (state IN ('pending','active') OR ended_at IS NOT NULL)
);
-- One open grant per owner and address (a second invite while one waits, or while it is accepted, is refused).
CREATE UNIQUE INDEX ux_profile_grants_open ON profile_grants(owner_user_id, lower(grantee_email))
  WHERE state IN ('pending','active');
-- A's list (newest first) and A's caps (open grants; invites in the last day).
CREATE INDEX idx_profile_grants_owner ON profile_grants(owner_user_id, created_at DESC);
-- The live check (id + grantee) is the primary key; B's profiles and B's cap.
CREATE INDEX idx_profile_grants_grantee ON profile_grants(grantee_user_id) WHERE state = 'active';
-- B's invites, by the address they were sent to.
CREATE INDEX idx_profile_grants_invites ON profile_grants(grantee_email) WHERE state = 'pending';
-- The sweep: invites past their date, accesses past their end date.
CREATE INDEX idx_profile_grants_invite_due ON profile_grants(invite_expires_at) WHERE state = 'pending';
CREATE INDEX idx_profile_grants_access_due ON profile_grants(access_ends_at) WHERE state = 'active' AND access_ends_at IS NOT NULL;

CREATE TABLE profile_activity(
  grant_id text NOT NULL REFERENCES profile_grants(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area text NOT NULL CHECK (area IN ('tracker','documents','prepare','queue','apply','autofill','settings','sensitive',
    'exports','mcp','sharing')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,39}$'),
  via text NOT NULL CHECK (via IN ('web','mcp','extension','system')),
  -- The hour (UTC) the events fell in, on the hour.
  hour timestamptz NOT NULL CHECK (hour = date_trunc('hour', hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  events integer NOT NULL CHECK (events > 0),
  PRIMARY KEY (grant_id, area, action, via, hour)
);
-- A's activity and B's (newest first), and the retention step by age.
CREATE INDEX idx_profile_activity_owner ON profile_activity(owner_user_id, hour DESC);
CREATE INDEX idx_profile_activity_actor ON profile_activity(actor_user_id, hour DESC);
CREATE INDEX idx_profile_activity_hour ON profile_activity(hour);

-- The notification groups: `sharing` joins (0042 named the list in an unnamed check).
ALTER TABLE notification_prefs DROP CONSTRAINT notification_prefs_kind_group_check;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_kind_group_check
  CHECK (kind_group IN ('applications','jobs','account','extension','sharing','admin'));
