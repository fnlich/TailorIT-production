-- v3.4 ORIGIN (PLAN G7, "MCP behind a changing test address"): TailorIT's OAuth server answers at the address each
-- request came through (APP_ORIGIN, or a trusted test tunnel's host: TRUSTED_PUBLIC_HOSTS), so an authorization request
-- keeps the issuer it was made at beside its resource (kept since 0041). The consent answers the client with that `iss`,
-- and the code is exchanged only at that issuer's token endpoint: a code from one address never works at another.
--
-- Additive: one nullable column, no index (read by id_hash and code_hash only), no row changes. A request kept before
-- this file (they live OAUTH_REQUEST_MINUTES, 10 by default) has none and is read as APP_ORIGIN's, as before.
ALTER TABLE oauth_requests ADD COLUMN issuer text CHECK (char_length(issuer) BETWEEN 1 AND 2000);
