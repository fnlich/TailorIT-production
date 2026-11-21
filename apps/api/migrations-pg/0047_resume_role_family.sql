-- v3.3 ROLES (F4, "prompts and the other things will be changed depending on what types of profile (default resume)
-- is"): a person's field (role family) belongs to the resume in use.
--
-- resumes.role_family: the person's choice of field for this resume (the resume's Field select); NULL is "Detect
-- automatically". A new resume made from another (a duplicate, a tailored copy, Prepare's and the MCP's saves, an
-- upload's editable copy) inherits its source's choice (features/resumes/repository.ts insertResume). Changing it does
-- not change document_revision: the tailor dedupe signature includes the family instead.
--
-- resume_analyses.role_family: the field TailorIT detected from that reading (shared roles/detect.ts), stored with the
-- reading so the Resumes list never reads a whole document for it. NULL on a reading stored before v3.3 (read again:
-- RESUME_READING_VERSION 2 makes it stale).
--
-- The API checks values against the 26 family ids (shared roles/families.ts); the CHECK only keeps the shape, so a
-- family added later needs no migration. Additive, no backfill.

ALTER TABLE resumes ADD COLUMN role_family text
  CHECK (role_family IS NULL OR role_family ~ '^[a-z][a-z-]{1,39}$');

ALTER TABLE resume_analyses ADD COLUMN role_family text
  CHECK (role_family IS NULL OR role_family ~ '^[a-z][a-z-]{1,39}$');
