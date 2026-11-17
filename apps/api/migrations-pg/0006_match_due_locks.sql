-- v3.0 PG-E: the resume-match-due triggers (0001's, v2.0's 0301) lock every application they would mark, already due
-- or not, before they mark the ones not due yet.
--
-- Why: a choice of the resume matcher (features/resume-match/service.ts, MatchCore.settle) writes through the guard,
-- which clears the due flag and holds the application's row lock until COMMIT, and only then reads again what the
-- choice was made from. At READ COMMITTED, 0001's triggers passed over a row that was still due without touching it
-- (`NOT resume_match_due`): a resume reading, a default resume, a posting's text or analysis that changed while a
-- choice was being written left the row cleared by the choice and chosen on what came before. Now the trigger waits for
-- the choice's transaction and marks the row due after it (its UPDATE reads the row again), or the choice waits for the
-- trigger's transaction and sees the change in its checks.
--
-- The rows are locked in id order (FOR NO KEY UPDATE, the lock an UPDATE takes), so two triggers over the same rows
-- never wait on each other in a circle. Nothing else changes: the same rows are marked, by the same conditions.

CREATE OR REPLACE FUNCTION mark_match_due_for_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source NOT IN ('ai', 'ft_lake') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.keywords::text IS NOT DISTINCT FROM OLD.keywords::text
     AND NEW.version IS NOT DISTINCT FROM OLD.version THEN RETURN NULL; END IF;
  PERFORM 1 FROM applications
  WHERE job_id IN (SELECT id FROM jobs WHERE content_hash = NEW.content_hash)
    AND current_status = 1 AND archived_at IS NULL AND (resume_origin IS NULL OR resume_origin = 'auto')
  ORDER BY id FOR NO KEY UPDATE;
  UPDATE applications SET resume_match_due = true
  WHERE job_id IN (SELECT id FROM jobs WHERE content_hash = NEW.content_hash)
    AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_match_due_for_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM applications
  WHERE job_id = NEW.id
    AND current_status = 1 AND archived_at IS NULL AND (resume_origin IS NULL OR resume_origin = 'auto')
  ORDER BY id FOR NO KEY UPDATE;
  UPDATE applications SET resume_match_due = true
  WHERE job_id = NEW.id
    AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_match_due_for_resume_analysis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
     AND NEW.version IS NOT DISTINCT FROM OLD.version THEN RETURN NULL; END IF;
  PERFORM 1 FROM applications
  WHERE user_id = (SELECT user_id FROM resumes WHERE id = NEW.resume_id)
    AND job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL
    AND (resume_origin IS NULL OR resume_origin = 'auto')
  ORDER BY id FOR NO KEY UPDATE;
  UPDATE applications SET resume_match_due = true
  WHERE user_id = (SELECT user_id FROM resumes WHERE id = NEW.resume_id)
    AND job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_match_due_for_default_resume() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM applications
  WHERE user_id = NEW.id
    AND job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL
    AND (resume_origin IS NULL OR resume_origin = 'auto')
  ORDER BY id FOR NO KEY UPDATE;
  UPDATE applications SET resume_match_due = true
  WHERE user_id = NEW.id
    AND job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;
