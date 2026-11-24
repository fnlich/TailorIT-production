-- v3.6 SOURCES (SP v36 PLAN S1, S7): a job source is on only through an admin's action, recorded on its row.
--
-- 1. job_sources.enabled defaults to false. enabled_at (when an admin last turned the source on) and enabled_by (that
--    admin's account; null once the account is gone, or for a source that was on before v3.6) are written by the one
--    writer of "on", features/ingest/sources.ts enableSources, which only the admin routes call (the switch, bulk
--    Enable, Enable all, an import run's Enable all, Add source with "Turn on now"). Turning a source off clears
--    neither, so Admin › Sources can say who turned it on last; a source with enabled_at is never Add job's link keeper
--    again (discovery cannot undo an admin's off: discovery/offer.ts isLinkKeeper).
-- 2. A CHECK: a source that is on has enabled_at. It reads enabled_at, not enabled_by: enabled_by goes null when the
--    admin's account is deleted. Added NOT VALID, then validated once step 3 made every row hold.
-- 3. Existing servers (data, once):
--    - every source that is on and was added by an admin, or is older than discovery (discovered_via NULL: Add source,
--      an import's record, the lake, the demo jobs, Add job's keeper an admin turned on), or was found by an admin's
--      import and switched on (discovered_via `import`: only an admin switches those on) stays on, with
--      enabled_at = updated_at (its last change; who turned it on is not known: enabled_by stays null);
--    - every source that is on and was made or switched on by discovery's validation (discovered_via any other value:
--      v3.5's validation switched them on without an admin) is turned off and not due (next_run_at NULL). Its jobs
--      stay; they are not re-verified until an admin turns the source on (after JOB_UNVERIFIED_HIDE_DAYS they leave
--      search, open). updated_at is left as it was. Their ids go into app_settings' one-time notice
--      `ingest:v36-turned-off` ({"at", "untouched": [ids], "changed": [ids]}), which Admin › Sources shows with a
--      filter for them and Enable all (features/ingest/turned-off.ts): `untouched` since found (updated_at equals
--      created_at, as a source validation made is written, or the time validation read its board, within a minute, as
--      an adopted keeper is), else `changed` since (maybe by an admin: a rename, its terms, an off and on). No notice
--      is written when none was turned off.
--
-- Every statement may run again (the columns and the CHECK are added only when missing; the notice is never
-- overwritten): v36-source-enable.test.ts runs the file again on rows it makes.

ALTER TABLE job_sources ALTER COLUMN enabled SET DEFAULT false;
ALTER TABLE job_sources ADD COLUMN IF NOT EXISTS enabled_at timestamptz;
ALTER TABLE job_sources ADD COLUMN IF NOT EXISTS enabled_by text REFERENCES users(id) ON DELETE SET NULL;

-- 3. Discovery's sources off, and the notice of them, in one statement (the UPDATE's rows feed the notice).
WITH turned AS (
  UPDATE job_sources s SET enabled = false, next_run_at = NULL
  WHERE s.enabled AND s.enabled_at IS NULL AND s.discovered_via IS NOT NULL AND s.discovered_via <> 'import'
  RETURNING s.id,
    (s.updated_at = s.created_at OR EXISTS (
      SELECT 1 FROM job_source_candidates c
      WHERE c.source_id = s.id AND c.checked_at IS NOT NULL AND abs(extract(epoch FROM s.updated_at - c.checked_at)) <= 60
    )) AS untouched
)
INSERT INTO app_settings(key, value, updated_at)
SELECT 'ingest:v36-turned-off',
  json_build_object(
    'at', now(),
    'untouched', COALESCE(json_agg(t.id ORDER BY t.id) FILTER (WHERE t.untouched), CAST('[]' AS json)),
    'changed', COALESCE(json_agg(t.id ORDER BY t.id) FILTER (WHERE NOT t.untouched), CAST('[]' AS json))
  ),
  now()
FROM turned t
HAVING count(*) > 0
ON CONFLICT (key) DO NOTHING;

-- 3. The rest that are on stay on, recorded.
UPDATE job_sources SET enabled_at = updated_at WHERE enabled AND enabled_at IS NULL;

-- 2. The CHECK.
ALTER TABLE job_sources DROP CONSTRAINT IF EXISTS job_sources_enabled_recorded;
ALTER TABLE job_sources ADD CONSTRAINT job_sources_enabled_recorded CHECK (NOT enabled OR enabled_at IS NOT NULL) NOT VALID;
ALTER TABLE job_sources VALIDATE CONSTRAINT job_sources_enabled_recorded;
