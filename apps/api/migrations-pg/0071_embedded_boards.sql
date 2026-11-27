-- v3.8.1 EMBED (SP v381 PLAN E2): the boards a company's own site embeds (a Greenhouse or Ashby job board shown on the
-- company's careers page: a link like https://<site>/jobs/<id>?gh_jid=<id> or https://<site>/careers?ashby_jid=<uuid>).
--
-- embedded_boards remembers, for a site (its registrable domain, lower case; the whole host on a shared hosting suffix),
-- the boards of a kind its job pages show:
--   - `confirmed_via` 'page': a job link on the site named a board TailorIT found on the link's page and confirmed by
--     reading the posting from the board's public API (features/jobs/add/embedded-board.ts); 'posting_url': a Greenhouse
--     run listed a posting whose own link is on the site and names the same id in ?gh_jid= (features/ingest/
--     embedded-boards.ts); 'admin': kept for an admin's own word (no writer in v3.8.1);
--   - `first_link`: the link that first confirmed the board (its shared form: no secret parameter), for Admin › Sources;
--   - `misses`: the site's job links in a row the board did not hold and whose page no longer named it; at
--     EMBEDDED_BOARD_MISSES the board is forgotten (never a board a Greenhouse run names: `posting_url`); a confirmation
--     sets it back to 0;
--   - `forgotten_at`, `forgotten_by` (v3.8.1 FIX-381, SP v381 FIXES-381 G6): an admin's Forget (Admin › Sources). A
--     forgotten board is never read for the site's links, and neither a link nor a run remembers it again for that site
--     until an admin's Remember again clears the mark.
-- At most EMBEDDED_BOARDS_PER_SITE boards a site and kind (the least recently confirmed goes first). It is no company
-- alias: company matching and opt-outs never read it (a page's word is no strong domain alias); only the link reads,
-- the career-page keys (career/keys.ts greenhouseBoardsOfDomain) and Admin › Sources read it.
--
-- Additive: a new, empty table. Every statement may run again.

CREATE TABLE IF NOT EXISTS embedded_boards (
  site text NOT NULL CHECK (site <> '' AND site = lower(site) AND length(site) <= 253),
  kind text NOT NULL CHECK (kind IN ('greenhouse', 'ashby')),
  board text NOT NULL CHECK (board <> '' AND length(board) <= 100),
  confirmed_via text NOT NULL CHECK (confirmed_via IN ('page', 'posting_url', 'admin')),
  first_link text CHECK (first_link IS NULL OR length(first_link) <= 2048),
  first_seen_at timestamptz NOT NULL,
  last_confirmed_at timestamptz NOT NULL,
  misses integer NOT NULL DEFAULT 0 CHECK (misses >= 0),
  forgotten_at timestamptz,
  forgotten_by text REFERENCES users(id) ON DELETE SET NULL,
  CHECK (forgotten_by IS NULL OR forgotten_at IS NOT NULL),
  PRIMARY KEY (site, kind, board)
);

-- One row a board whatever its case (a Greenhouse token is read as written; an Ashby board in lower case).
CREATE UNIQUE INDEX IF NOT EXISTS idx_embedded_boards_site_board ON embedded_boards (site, kind, lower(board));
-- Admin › Sources: the sites that embed a source's board.
CREATE INDEX IF NOT EXISTS idx_embedded_boards_board ON embedded_boards (kind, lower(board));
