-- v3.1 LINK2: the jobs stored before v3.1 from what an import or a browser said, and a weekly re-read of the jobs
-- TailorIT read from their page (docs/design/v3.1/21-jobs-from-links.md §9, §10).
--
-- 1. job_link_queue.for_job_id: the job a queued read is for (`legacy`: a job an import or a published page copy made
--    before v3.1, read now from its link; `recheck`: a job read from its page, read again to see it is still open). A
--    link may wait once per job it is read for, and once for no job (an import's or an admin's link): the one open row
--    per link becomes one per link and job.
-- 2. job_link_queue.origin gains `legacy` and `recheck`; job_verifications.origin gains `legacy`.
-- 3. job_verifications.user_id may be null: a legacy job TailorIT could not read and no one account added stays held
--    (seen only by the accounts that track it) and is listed in "Couldn't verify" with no adder.
-- The rows are written by the jobs feature's daily passes (job-links.legacy-links, job-links.page-recheck), not here.
-- Additive: one column, two wider checks, one nullable column, one index rebuilt (the table is empty before v3.1).

ALTER TABLE job_link_queue ADD COLUMN for_job_id bigint REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE job_link_queue DROP CONSTRAINT job_link_queue_origin_check;
ALTER TABLE job_link_queue ADD CONSTRAINT job_link_queue_origin_check
  CHECK (origin IN ('admin','import','sheets','ft_lake','legacy','recheck'));

DROP INDEX ux_job_link_queue_open;
CREATE UNIQUE INDEX ux_job_link_queue_open ON job_link_queue(url_key, (COALESCE(for_job_id, 0))) WHERE state <> 'done';
CREATE INDEX idx_job_link_queue_for_job ON job_link_queue(for_job_id) WHERE for_job_id IS NOT NULL;

ALTER TABLE job_verifications ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_origin_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_origin_check
  CHECK (origin IN ('web','tracker','mcp','admin','import','sheets','ft_lake','extension','extension_page','applied','legacy'));
