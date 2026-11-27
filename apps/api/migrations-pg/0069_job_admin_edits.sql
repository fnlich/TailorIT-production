-- v3.8 REVEDIT (SP v38 PLAN.md E1-E6; the owner's addendum of 2026-11-25: "admin should be able to edit on review job
-- tab so that admin can change the job link, job description, ..."): an admin edits a job from Admin › Review.
--
-- job_admin_edits keeps, per job and field, the value an admin gave it (features/job-reviews/edit/): every later write of
-- the posting (a source run, a re-check, Retry read, an AI reading's fill) puts the admin's value back (keepAdminEdits),
-- and `original` keeps the posting's own value of the field as last read, so "Use the posting's text again" can write it
-- back and drop the row. `value` and `original` hold the field's value as the editor sends it (packages/shared
-- reviews/edit.ts JobEditValues: a link, a title, the cleaned description HTML, the places, a salary...); `original` is
-- null until the field had a value of the posting's. Who and when (edited_by, edited_at) are the job's "Edited by an
-- admin" mark, shown to administrators only; the audit log line names the fields, never their values. A job's rows go
-- with the job (ON DELETE CASCADE); a person's own job's rows move to the shared job it gives way to.
--
-- Additive: one new table (no row of any other table changes). Every statement may run again.

CREATE TABLE IF NOT EXISTS job_admin_edits(
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('link','applyUrl','title','company','description','locations','workArrangement',
    'employmentType','salary','postedAt')),
  value jsonb NOT NULL,
  original jsonb,
  edited_by text REFERENCES users(id) ON DELETE SET NULL,
  edited_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, field)
);
