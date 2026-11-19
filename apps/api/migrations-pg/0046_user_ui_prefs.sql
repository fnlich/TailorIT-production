-- v3.2 FIX-UX (UXREQ-15; PLAN E11: the Job Tracker's "Lanes shown" is "saved per person"): what a person chose for how
-- TailorIT's pages look, kept on the server so a second browser or device shows the same, and two people sharing a
-- browser keep their own. One row per person, made on their first save; a page without one uses its defaults (the
-- web sends a choice its browser kept before v3.2 once, when the row has none).
--
-- tracker_lanes: the board's lanes shown ({"columns": {"<status>": "forced"|"default"|"hidden"}, "draft": <mode>,
-- "archived": <bool>}); null until the person chooses. Its only writer is apps/api/src/features/me/ui-prefs.ts.
-- Additive: one new empty table.

CREATE TABLE user_ui_prefs(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tracker_lanes json CHECK (tracker_lanes IS NULL OR json_typeof(tracker_lanes) = 'object'),
  updated_at timestamptz NOT NULL
);
