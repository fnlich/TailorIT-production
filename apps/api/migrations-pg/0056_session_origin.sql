-- v3.4 ORIGIN2 (the ORIGIN2 review, finding 2): a session belongs to the address it was signed in at. One TailorIT may
-- answer at APP_ORIGIN, at exact addresses (TRUSTED_PUBLIC_HOSTS, such as a LAN address over plain http) and through a
-- test tunnel; a session cookie sent in clear at a plain-http address must not also work at the https ones. The sign-in
-- keeps the request's public origin (config/public-origin.ts publicOriginOf) here, and a request is signed in only
-- through a session of its own public origin (core/auth/session.ts).
--
-- Additive: one nullable column, no backfill, no index (read with the row by token_hash). A session made before this
-- file has none and is read as APP_ORIGIN's: it keeps working at APP_ORIGIN and nowhere else.
ALTER TABLE user_sessions ADD COLUMN origin text CHECK (char_length(origin) BETWEEN 1 AND 2000);
