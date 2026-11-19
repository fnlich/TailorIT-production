-- v3.2 ADMINAPP (E6, the owner's "In admin review, admin should be able to approve manually"): an admin's approval of
-- a job TailorIT could not read itself (Admin › Review › Couldn't verify; a v3.0 page review whose page it cannot read).
-- The job is published as it was captured (its adder's browser or typed words; the admin types nothing), and this row
-- says so: which link, what was approved, who approved it and when. The job DTOs read it as the verification state
-- `admin_approved`; an approval of the same link again finds it (idempotent); the audit log line has the same facts.
--
-- kind: `captured` (an account's own job, its words from their browser or typed, made public) or `legacy` (a job
-- stored before v3.1 from an import or a published page copy, held by the legacy pass, its hold lifted).
-- Additive: one new empty table.

CREATE TABLE job_admin_approvals(
  job_id bigint PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  url_key text NOT NULL CHECK (char_length(url_key) BETWEEN 9 AND 2100),
  kind text NOT NULL CHECK (kind IN ('captured','legacy')),
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL,
  -- The accounts whose own job of the link became this job (the adders told).
  adders integer NOT NULL DEFAULT 0 CHECK (adders >= 0)
);
-- A second approval of the same link (another adder's job, the same row of the list) finds the first.
CREATE INDEX idx_job_admin_approvals_url ON job_admin_approvals(url_key);
