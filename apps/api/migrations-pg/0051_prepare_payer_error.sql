-- v3.3 SHARE-5 (the SHARE-5 review, 2026-11-20, decision 7; PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5 "Refusal
-- wording"): a Prepare someone a profile is shared with (B) started there that B's own limit stopped (B's AI budget,
-- B's hourly limits) is stored with the reason `payer_limit` and neutral words in `error` (MSG_PREPARE_PAYER_LIMIT: what
-- the owner, and anyone else who reads the Prepare, sees). B's refusal in its own words is kept apart, in payer_error,
-- and shown to B alone (a read compares the reader with started_by). Only such a Prepare has one; no row changes.
ALTER TABLE prepare_jobs ADD COLUMN payer_error text CHECK (char_length(payer_error) <= 2000);
