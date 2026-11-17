-- v3.0 FIX-C (W5 review UX-1; docs/design/part2/11-database.md §5.4 company_job_counts): the counts kept current.
-- company_job_counts was recounted only by merges, splits, opt-outs and the nightly step, so Admin › Companies, the
-- Candidates funnel and the name probes read 0 for a company whose jobs a run made that day. Every change of a job that
-- moves its company's counts (a job made or removed; its active, held_since, company_id, owner_user_id or posted_sort
-- changed: a run's new postings, a close, a reopen, a hold cleared, a merge) appends its company to
-- company_count_touches; the companies worker drains that list every pass and recounts those companies
-- (features/companies/counts.ts drainCompanyCountTouches), a few seconds behind.
--
-- Why a trigger and an append-only list: every writer of jobs is covered (ingest's runs, the one close function,
-- purges, approvals, merges, an admin's SQL) with no call to forget; the list has no key and no foreign key, so a
-- writer never waits on another (an ingest batch's transaction would otherwise hold a counted company's row until it
-- commits); the row trigger fires only when a counted column changes (a run's "seen again" writes do not).
CREATE TABLE company_count_touches(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL
);

CREATE FUNCTION touch_company_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO company_count_touches(company_id) VALUES (NEW.company_id);
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO company_count_touches(company_id) VALUES (OLD.company_id);
  ELSE
    INSERT INTO company_count_touches(company_id) VALUES (NEW.company_id);
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      INSERT INTO company_count_touches(company_id) VALUES (OLD.company_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_jobs_company_counts_insert AFTER INSERT ON jobs
  FOR EACH ROW WHEN (NEW.owner_user_id IS NULL) EXECUTE FUNCTION touch_company_counts();
CREATE TRIGGER trg_jobs_company_counts_update AFTER UPDATE OF active, held_since, company_id, owner_user_id, posted_sort ON jobs
  FOR EACH ROW WHEN ((OLD.active, OLD.held_since, OLD.company_id, OLD.owner_user_id, OLD.posted_sort)
    IS DISTINCT FROM (NEW.active, NEW.held_since, NEW.company_id, NEW.owner_user_id, NEW.posted_sort))
  EXECUTE FUNCTION touch_company_counts();
CREATE TRIGGER trg_jobs_company_counts_delete AFTER DELETE ON jobs
  FOR EACH ROW WHEN (OLD.owner_user_id IS NULL) EXECUTE FUNCTION touch_company_counts();
