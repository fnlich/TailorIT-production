-- v3.0 FIX-C (W5 review, INT-4 open item 12; docs/design/part2/13-company-enrichment.md §7): a name queued again
-- while a worker holds the company's row (an admin's Refresh now, an accepted match review, a new posting's
-- hiringOrganization) must outlive that worker's finish. The worker's finish removes the names it did; a name queued
-- after its claim was not done by it (the claim read the company before the admin asked), so it stays.
-- company_enrichment_queue.requeued holds the names queued under a live lease (features/companies/resolve.ts
-- queueEnrichment); a claim empties it, and the finish keeps those names due (features/companies/enrich/queue.ts).
--
-- One column with a default, nothing else: every row starts with none. v3.0 starts on an empty database (DECISIONS P5).
ALTER TABLE company_enrichment_queue ADD COLUMN requeued jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(requeued) = 'array');
