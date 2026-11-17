-- v3.0 INT-2 (PG-B's handoff, open item 2): job_source_links.source_job_id compares in byte order.
--
-- The page source's marked link ids (features/autofill/from-page.ts linkIdFor) are a range, '<own> ' up to '<own>!',
-- which is byte order; the statement compares through dialect.collateC (COLLATE "C"), whatever the database's own
-- collation. With the column in the database's collation the primary key (source_id, source_job_id) could not serve
-- that comparison, so the range was a filter over the source's every link. In COLLATE "C", as 0001 declared
-- jobs.link_key and job_link_aliases.alias, the primary key serves it again.
--
-- text to text: no table rewrite; the primary key's index is rebuilt. Equality is unchanged (both collations are
-- deterministic), and on the embedded cluster (builtin C.UTF-8, code point order) the order is unchanged too.

ALTER TABLE job_source_links ALTER COLUMN source_job_id TYPE text COLLATE "C";
