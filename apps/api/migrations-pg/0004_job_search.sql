-- v3.0 PG-SEARCH (PLAN §8; 11-database.md §5.6, §7): what the search projection needs beyond the baseline's job_search.

-- The company's own word on visa sponsorship (companies.sponsors_h1b today, company_profiles after E0-API): the Jobs
-- page's H-1B filter and MCP's `sponsorship: yes` take a job that says nothing when its company sponsors, as v2.0 did;
-- `sponsorship` stays the job's own statement (job_facts' words), which MCP's other sponsorship filters read.
ALTER TABLE job_search ADD COLUMN company_sponsors boolean;

-- "Highest salary" orders every match, a job without a salary last: one index over that whole order, so the sort and
-- its keyset pages read it in order (the baseline's partial index left the jobs without a salary to a sort).
DROP INDEX js_salary;
CREATE INDEX js_salary ON job_search ((COALESCE(salary_sort, -1)) DESC, job_id DESC);

-- The search row follows its job's state whoever writes it (projectJob does all of it in the change's transaction;
-- this keeps a writer that forgot it from showing what it must not):
--   - the job closes, goes unverified or is held: its row leaves search at once;
--   - its owner (who may see it), its company (a hidden company hides it) or its analysis (the years MCP reads)
--     changes: the row's copies follow.
-- Coming back (reopened, verified, approved) and every other change need projectJob, which builds the row's words in
-- the app; the nightly repair catches what slips past.
CREATE FUNCTION tailorit_job_search_follow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.active OR NEW.unverified_since IS NOT NULL OR NEW.held_since IS NOT NULL THEN
    DELETE FROM job_search WHERE job_id = NEW.id;
  ELSIF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
        OR NEW.analysis_id IS DISTINCT FROM OLD.analysis_id THEN
    UPDATE job_search SET owner_user_id = NEW.owner_user_id, company_id = NEW.company_id,
      min_years = COALESCE((SELECT a.required_years FROM job_analyses a WHERE a.id = NEW.analysis_id),
                           (SELECT f.min_years FROM job_facts f WHERE f.job_id = NEW.id))
    WHERE job_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER jobs_search_follow
  AFTER UPDATE OF active, unverified_since, held_since, owner_user_id, company_id, analysis_id ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION tailorit_job_search_follow();
