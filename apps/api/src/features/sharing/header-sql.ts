// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §2 "Invite notices"): the header's invite columns, in a module of their
// own (no import), so features/notifications/header.ts builds its one statement with them at load whatever the module
// order. The reads of profile_grants stay in features/sharing (SHARE-1's structure scan).

/**
 * GET /api/me/header's invite columns (features/notifications/header.ts puts them in its one statement; alias u for the
 * reader's users row, parameters @now and @sharing): `invites`, the invites waiting for the reader (the account menu's
 * "1 invite"); `invites_unnoticed`, those of them the reader has no sharing_invited notice of yet (and whose sharing
 * notices are on). Zero both while SHARING_ENABLED is off.
 */
export const HEADER_INVITE_COLUMNS = `
    (SELECT count(*) FROM profile_grants g JOIN users o ON o.id = g.owner_user_id
      WHERE CAST(@sharing AS boolean) AND g.state = 'pending' AND g.grantee_email = lower(u.email)
        AND g.invite_expires_at > CAST(@now AS timestamptz) AND o.disabled_at IS NULL AND g.owner_user_id <> u.id) AS invites,
    (SELECT count(*) FROM profile_grants g JOIN users o ON o.id = g.owner_user_id
      WHERE CAST(@sharing AS boolean) AND g.state = 'pending' AND g.grantee_email = lower(u.email)
        AND g.invite_expires_at > CAST(@now AS timestamptz) AND o.disabled_at IS NULL AND g.owner_user_id <> u.id
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.dedupe_key = 'sharing_invited:' || g.id)
        AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = u.id AND p.kind_group = 'sharing' AND NOT p.enabled)
    ) AS invites_unnoticed`;

