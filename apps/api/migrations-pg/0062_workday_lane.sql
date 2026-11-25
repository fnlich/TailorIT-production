-- v3.6.1 LANE (SP v37 PLAN W1, W5, W7): one lane for every Workday site, people's reads first on it, and robots.txt
-- files that keep their last good rules while a refresh fails. v3.6.1 FIX-LANE (SP v37 FIXES-361 D3, F3): a lane's
-- pace adapts to its platform's 429s, and background reads take their turns on it oldest first. A lane is an entry of
-- the lane registry (features/ingest/hosts.ts; only Workday's in v3.6.1): each keeps its own state on its own
-- crawl_hosts row (its key, `workday.lane`), so a later lane needs no new column.
--
-- 1. crawl_hosts.priority_until: while a person waits for a read on a lane (Add job, the extension's add and From page,
--    Add by link, MCP add), the waiting read keeps this a moment ahead of now (features/ingest/hosts.ts createHostGate,
--    `priority: 'interactive'`), and background reads (source runs, re-checks, discovery, the link queue) let it take
--    the next turn first. It runs out by itself when nobody waits. The Workday lane's row is `workday.lane` (it passes
--    the host-name check of Admin › Hosts); every Workday host's requests take their turns on it, its least gap read from
--    WORKDAY_MIN_INTERVAL_MS (its own min_interval_ms stays 0, so an admin's change applies at once).
-- 2. site_robots.failed_at and failed_status: the last refresh of the file that failed (429, a 5xx, no answer) and its
--    HTTP status (null for no answer). A failure is remembered for 10 minutes (features/ingest/robots.ts
--    ROBOTS_UNREACHABLE_RETRY_MS: no read again before that, in any process); the file's last good rules (status ok or
--    no_rules, read at most 7 days ago) stay in the row and keep applying meanwhile. A good read clears both.
-- 3. crawl_hosts.throttle_hits: the times of a lane's 429s within LANE_429_WINDOW_MINUTES of its latest one (kept at each
--    429; neither a good answer nor an admin's Release clears them). Their count sets the pause after a 429 (at most
--    LANE_PAUSE_MAX_MINUTES), the lane's widened gap (its least gap, WORKDAY_MIN_INTERVAL_MS for Workday, x 2^count, at
--    most LANE_MAX_INTERVAL_MS, halving back after each LANE_EASE_MINUTES without one) and the breaker
--    (INGEST_HOST_BREAKER_FAILURES of them in the window hold the lane LANE_BREAKER_HOLD_MINUTES).
-- 4. crawl_hosts.paced_slot_at: a lane's next slot for background reads at its widened gap; next_slot_at stays its next
--    slot at the least gap, which a person's read takes (people's reads are few, and keep their 15 s).
-- 5. crawl_host_waiters: the background reads waiting for a lane's turn, oldest ticket first (a row each while it waits).
--    A waiter looks again every moment and keeps its seen_until ahead; one that stopped looking (its process stopped)
--    no longer holds the line once its seen_until passes, and the next waiter to queue clears it.
--
-- Additive: nullable columns and one new table; no row changes.
ALTER TABLE crawl_hosts ADD COLUMN IF NOT EXISTS priority_until timestamptz;
ALTER TABLE site_robots ADD COLUMN IF NOT EXISTS failed_at timestamptz;
ALTER TABLE site_robots ADD COLUMN IF NOT EXISTS failed_status smallint;
ALTER TABLE crawl_hosts ADD COLUMN IF NOT EXISTS throttle_hits timestamptz[];
ALTER TABLE crawl_hosts ADD COLUMN IF NOT EXISTS paced_slot_at timestamptz;
CREATE TABLE IF NOT EXISTS crawl_host_waiters (
  ticket bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host text NOT NULL,
  asked_at timestamptz NOT NULL,
  seen_until timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crawl_host_waiters_host ON crawl_host_waiters(host, ticket);
