-- v3.3 SHARE-6 (PLAN F9 "Shared profiles"; the design SP v33 PLAN-sharing.md §4 "Explicit changes": addJobByLink takes
-- the actor, who receives the job-link notices, separately from the owner): who added a link TailorIT could not read.
-- When B adds a job's link on A's profile, the job and its tracker entry stay A's (job_verifications.user_id, the adder
-- whose own job it is) and the note names B (added_by) and the grant B added it under (grant_id): the notices of what
-- became of the link (read later, published by an admin) go to B, on A's profile, while that grant is live and still
-- lets B see A's Job Tracker; otherwise to A, as before. A link a person adds on their own profile names nobody else:
-- added_by NULL (the adder is user_id), grant_id NULL.
--
-- Additive: two nullable columns, no backfill, no index (read by the job's key with its row). A deleted account clears
-- them; an ended grant (grants are never deleted) is read as such when a notice is sent (core/auth/grants.ts), and the
-- notice then goes to the job's owner.

ALTER TABLE job_verifications
  ADD COLUMN added_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE SET NULL;

-- v3.3 SHARE-6 (the SHARE-6 review, spec finding 2): a held job's add (a new job TailorIT read that waits for an admin,
-- job-reviews/new-jobs.ts noteHeldAdd) names its adder the same way. The report row stays the owner's (user_id: who
-- sees the held job, through it); added_by and grant_id name who added it on that owner's profile, so the approval's
-- notice goes to them there (job-reviews/service.ts noticeApprovedJob, jobs/add/notify.ts linkNoticeTarget). An own add
-- names nobody (NULL). Additive, nullable, no backfill.
ALTER TABLE job_review_reports
  ADD COLUMN added_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN grant_id text REFERENCES profile_grants(id) ON DELETE SET NULL;

-- v3.3 SHARE-6 (the SHARE-6 review, security finding 1 and spec finding 1): an apply record's kept answers carry their
-- question's key and the answer's category, as the submitted answers do (application_form_answers.category), so a
-- reader without Sensitive answers' See is shown exactly the rows the submitted answers show
-- (applications/apply-records.ts, autofill/answers/screen.ts isSensitiveAnswerRow): a question the extension knew as
-- sensitive by its category alone (a label such as "Details") is left out of both. 0011's freeze, with the two keys
-- added; the trigger (trg_form_answers_freeze) stays bound to it. Records frozen before this keep [{label, answer}]:
-- a reader without that See is shown none of a submission's kept answers whose category is not kept.
CREATE OR REPLACE FUNCTION freeze_replaced_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE application_apply_records r SET answers_used = g.used
  FROM (
    SELECT o.application_id,
      jsonb_agg(jsonb_build_object('label', coalesce(q.label, ''), 'questionKey', coalesce(q.question_key, ''),
          'category', o.category, 'answer', o.answer::jsonb)
        ORDER BY q.step, q.position, o.question_id) AS used
    FROM gone o LEFT JOIN job_form_questions q ON q.id = o.question_id
    GROUP BY o.application_id
  ) g
  WHERE r.id = (SELECT max(r2.id) FROM application_apply_records r2
                 WHERE r2.application_id = g.application_id AND r2.answers = 'submitted')
    AND r.answers_used IS NULL;
  RETURN NULL;
END $$;
