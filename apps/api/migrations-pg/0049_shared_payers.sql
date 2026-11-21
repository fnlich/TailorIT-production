-- v3.3 SHARE-0 (PLAN F9 "Shared profiles"; the design SP v33 PLAN-sharing.md §5, §6, §7, §11): who started the work on a
-- profile and who pays for it. When B works on A's profile, the row stays A's (user_id: whose data) and names B (who
-- started it and pays: B's plan, budget, credit and hourly limits) and the grant it ran under (grant_id: the work stops
-- when that grant ends or loses the permission, core/auth/grants.ts assertGrantLive). The person's own work names
-- nobody else: grant_id NULL.
--
-- prepare_jobs: started_by (who started the Prepare; its payer) NOT NULL, the rows before this backfilled to their
--   user_id, and a new row that names nobody is the owner's own (the trigger below: the v3.2 writers stay correct);
--   grant_id. The hourly Prepare count per payer reads (started_by, started_at).
-- ai_tasks: grant_id and grant_perm (the permission the task was queued under: a removed permission stops the work it
--   authorized); the per-payer count of active tasks per kind reads coalesce(charge_user_id, user_id).
-- resume_analysis_backlog, resume_copy_backlog: charge_user_id (who pays the AI reading or copy; NULL: the resume's
--   owner, as before) and grant_id.
-- mcp_result_sets: profile_user_id (whose profile the set lists; NULL: the caller's own, user_id) and grant_id (a set
--   made on someone else's profile; it goes with its grant).
-- autofill_agent_queue: prepared_by (who prepared the row: B for a job B prepared; NOT NULL, backfilled and defaulted
--   to user_id as prepare_jobs.started_by), grant_id, awaiting_owner (a job B prepared without A's "Apply without my
--   OK": the extension never claims it until A approves) and approved_at; the claim reads (user_id, state,
--   awaiting_owner, created_at).
--
-- Every grant_id names a profile_grants row and is set only when the payer is not the owner. No row is deleted; the
-- backfills copy user_id.

-- Prepare ---------------------------------------------------------------------------------------------------------------
ALTER TABLE prepare_jobs
  ADD COLUMN started_by text REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE SET NULL;
UPDATE prepare_jobs SET started_by = user_id WHERE started_by IS NULL;
ALTER TABLE prepare_jobs ALTER COLUMN started_by SET NOT NULL;
ALTER TABLE prepare_jobs ADD CONSTRAINT prepare_jobs_grant_payer CHECK (grant_id IS NULL OR started_by <> user_id);
CREATE INDEX idx_prepare_jobs_started_by ON prepare_jobs(started_by, started_at);
CREATE INDEX idx_prepare_jobs_grant ON prepare_jobs(grant_id, state) WHERE grant_id IS NOT NULL;

-- A Prepare inserted without started_by is its owner's own (the v3.2 writers, and every own Prepare after them).
CREATE FUNCTION prepare_jobs_started_by_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.started_by IS NULL THEN
    NEW.started_by := NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_prepare_jobs_started_by BEFORE INSERT ON prepare_jobs
  FOR EACH ROW WHEN (NEW.started_by IS NULL) EXECUTE FUNCTION prepare_jobs_started_by_default();

-- The AI queue ----------------------------------------------------------------------------------------------------------
ALTER TABLE ai_tasks
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE SET NULL,
  ADD COLUMN grant_perm text CHECK (grant_perm IN ('tracker:view','tracker:edit','documents:view','documents:edit',
    'prepare:view','prepare:run','queue:edit','apply','autofill:view','autofill:edit','settings:view','settings:edit',
    'sensitive:view','sensitive:edit','exports','mcp'));
-- A task queued under a grant names the permission that allowed it.
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_grant_perm CHECK (grant_id IS NULL OR grant_perm IS NOT NULL);
-- The two-active-tasks cap and the CLI line, per payer and kind.
CREATE INDEX idx_ai_payer_kind_active ON ai_tasks((coalesce(charge_user_id, user_id)), kind)
  WHERE status IN ('queued','running');
-- Ending a grant cancels its tasks that have not finished.
CREATE INDEX idx_ai_grant_active ON ai_tasks(grant_id) WHERE grant_id IS NOT NULL AND status IN ('queued','running');

-- The resume backlogs ---------------------------------------------------------------------------------------------------
ALTER TABLE resume_analysis_backlog
  ADD COLUMN charge_user_id text REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE SET NULL;
ALTER TABLE resume_analysis_backlog ADD CONSTRAINT resume_analysis_backlog_grant_payer
  CHECK (grant_id IS NULL OR (charge_user_id IS NOT NULL AND charge_user_id <> user_id));
CREATE INDEX idx_resume_backlog_payer ON resume_analysis_backlog((coalesce(charge_user_id, user_id)), started_at);
CREATE INDEX idx_resume_backlog_grant ON resume_analysis_backlog(grant_id) WHERE grant_id IS NOT NULL;

ALTER TABLE resume_copy_backlog
  ADD COLUMN charge_user_id text REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE SET NULL;
ALTER TABLE resume_copy_backlog ADD CONSTRAINT resume_copy_backlog_grant_payer
  CHECK (grant_id IS NULL OR (charge_user_id IS NOT NULL AND charge_user_id <> user_id));
CREATE INDEX idx_resume_copy_payer ON resume_copy_backlog((coalesce(charge_user_id, user_id)), created_at, seq);
CREATE INDEX idx_resume_copy_grant ON resume_copy_backlog(grant_id) WHERE grant_id IS NOT NULL;

-- MCP's result sets -----------------------------------------------------------------------------------------------------
ALTER TABLE mcp_result_sets
  ADD COLUMN profile_user_id text REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE CASCADE;
-- A set of someone else's profile names its grant; one of the caller's own names none.
ALTER TABLE mcp_result_sets ADD CONSTRAINT mcp_result_sets_profile_grant CHECK (
  (grant_id IS NULL AND (profile_user_id IS NULL OR profile_user_id = user_id))
  OR (grant_id IS NOT NULL AND profile_user_id IS NOT NULL AND profile_user_id <> user_id)
);
CREATE INDEX idx_mcp_result_sets_grant ON mcp_result_sets(grant_id) WHERE grant_id IS NOT NULL;

-- The auto-apply queue --------------------------------------------------------------------------------------------------
ALTER TABLE autofill_agent_queue
  ADD COLUMN prepared_by text REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE SET NULL,
  ADD COLUMN awaiting_owner boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_at timestamptz;
UPDATE autofill_agent_queue SET prepared_by = user_id WHERE prepared_by IS NULL;
ALTER TABLE autofill_agent_queue ALTER COLUMN prepared_by SET NOT NULL;
ALTER TABLE autofill_agent_queue ADD CONSTRAINT autofill_agent_queue_grant_payer CHECK (grant_id IS NULL OR prepared_by <> user_id);
-- Only a job someone else prepared waits for the owner; an approved one waits no more.
ALTER TABLE autofill_agent_queue ADD CONSTRAINT autofill_agent_queue_awaiting CHECK (
  (NOT awaiting_owner OR prepared_by <> user_id) AND (NOT awaiting_owner OR approved_at IS NULL)
);
CREATE INDEX idx_autofill_agent_queue_claim ON autofill_agent_queue(user_id, state, awaiting_owner, created_at, seq);
CREATE INDEX idx_autofill_agent_queue_grant ON autofill_agent_queue(grant_id) WHERE grant_id IS NOT NULL;

-- A queue row inserted without prepared_by is its owner's own (as prepare_jobs.started_by).
CREATE FUNCTION autofill_agent_queue_prepared_by_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prepared_by IS NULL THEN
    NEW.prepared_by := NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_autofill_agent_queue_prepared_by BEFORE INSERT ON autofill_agent_queue
  FOR EACH ROW WHEN (NEW.prepared_by IS NULL) EXECUTE FUNCTION autofill_agent_queue_prepared_by_default();
