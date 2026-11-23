-- v3.5 FIX-STORE (the final review's S3, D3; SP v35 FINAL-FIXES.md, the coordinator's decision 1): who may read a Google
-- Sheet through TailorIT's reader account, and two indexes for the imports.
--
-- 1. sheet_claims: a spreadsheet belongs to the first account that reads it through TailorIT (a preview or an import).
--    user_id is that person's account (the profile the import lands on); NULL is the administrators' (an admin's read
--    claims an unclaimed sheet for them; admins read any sheet). A person reads a spreadsheet only while no account
--    claims it or they do; anyone else is refused (MSG_JOB_IMPORT_SHEET_CLAIMED). A deleted account lets go of its
--    sheets. Backfilled from the reads before this file: every spreadsheet of a sheet source or an admin's import first
--    (the admins'), then each other spreadsheet a person imported, for the profile of the earliest import of it.
-- 2. idx_job_imports_user: a profile's imports, newest first (GET /api/jobs/imports: the latest import on every device),
--    and an account's deletion (job_imports.user_id cascades).
-- 3. idx_job_import_rows_waiting: the import rows still waiting for their read (the link queue's repair: a row whose
--    queue row is done or gone gets its result).
--
-- Additive: one table filled from existing rows, three indexes. No existing row changes.

CREATE TABLE sheet_claims(
  spreadsheet_id text PRIMARY KEY CHECK (spreadsheet_id ~ '^[A-Za-z0-9_-]{20,128}$'),
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL
);
CREATE INDEX idx_sheet_claims_user ON sheet_claims(user_id) WHERE user_id IS NOT NULL;

CREATE INDEX idx_job_imports_user ON job_imports(user_id, id DESC) WHERE kind = 'user';
CREATE INDEX idx_job_import_rows_waiting ON job_import_rows(queue_id) WHERE result IN ('queued', 'working');

-- The backfill (v35-fixstore.test.ts runs these two statements again on rows it makes): the admins' first.
INSERT INTO sheet_claims(spreadsheet_id, user_id, claimed_at)
SELECT read.id, NULL, min(read.at)
FROM (
  SELECT config->'sheet'->>'spreadsheetId' AS id, created_at AS at FROM job_sources WHERE jsonb_typeof(config->'sheet') = 'object'
  UNION ALL
  SELECT config->'sheet'->>'spreadsheetId', created_at FROM job_imports WHERE kind = 'admin' AND jsonb_typeof(config->'sheet') = 'object'
) read
WHERE read.id ~ '^[A-Za-z0-9_-]{20,128}$'
GROUP BY read.id
ON CONFLICT (spreadsheet_id) DO NOTHING;

-- Then each person's earliest import of a spreadsheet no admin read.
INSERT INTO sheet_claims(spreadsheet_id, user_id, claimed_at)
SELECT DISTINCT ON (config->'sheet'->>'spreadsheetId') config->'sheet'->>'spreadsheetId', user_id, created_at
FROM job_imports
WHERE kind = 'user' AND jsonb_typeof(config->'sheet') = 'object' AND (config->'sheet'->>'spreadsheetId') ~ '^[A-Za-z0-9_-]{20,128}$'
ORDER BY config->'sheet'->>'spreadsheetId', created_at, id
ON CONFLICT (spreadsheet_id) DO NOTHING;
