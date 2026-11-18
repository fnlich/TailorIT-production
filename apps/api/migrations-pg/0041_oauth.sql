-- v3.1 OAUTH (docs/design/v3.1/23-mcp-oauth.md): TailorIT's own OAuth 2.1 authorization server, so Claude and ChatGPT
-- connect to the MCP server (/mcp) with a few clicks and a consent page, beside the personal `tim_` tokens.
--
-- 1. oauth_clients: the AI apps that may ask. A Dynamic Client Registration (kind `dcr`, id `dcr_...`) or a Client ID
--    Metadata Document (kind `cimd`, the id is the document's https address), read and cached (fetched_at, expires_at).
--    Public clients only: no secret is ever stored. `recognized` is claude, chatgpt or other (by the redirect's host or
--    the document's host: packages/shared/src/oauth). Names no person.
-- 2. oauth_grants: one person's yes to one client (one live grant per person and client). Revoking it (the person, a
--    reused refresh token or code, the account) ends every token it issued.
-- 3. oauth_requests: one authorization request between /oauth/authorize and the consent page, single use and short
--    lived (OAUTH_REQUEST_MINUTES), bound to the browser that started it (browser_hash, a cookie's SHA-256), then its
--    authorization code (code_hash, OAUTH_CODE_SECONDS, used once).
-- 4. oauth_tokens: access (`tio_`, OAUTH_ACCESS_TOKEN_MINUTES) and refresh (`tir_`, rotated, OAUTH_REFRESH_IDLE_DAYS)
--    tokens, only their SHA-256 stored; `audience` is the MCP endpoint they were issued for (RFC 8707).
-- 5. mcp_unsupported_reports.grant_id: a report_unsupported call made with an OAuth token names its grant, as one made
--    with a personal token names the token.
--
-- Additive: four new tables, one nullable column and its index. No seeded table gains a required column.

CREATE TABLE oauth_clients(
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 8 AND 2000),
  kind text NOT NULL CHECK (kind IN ('dcr','cimd')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  redirect_uris json NOT NULL CHECK (json_typeof(redirect_uris) = 'array'),
  recognized text NOT NULL DEFAULT 'other' CHECK (recognized IN ('claude','chatgpt','other')),
  metadata json NOT NULL DEFAULT '{}' CHECK (json_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL,
  fetched_at timestamptz,
  expires_at timestamptz,
  CHECK ((kind = 'cimd') = (fetched_at IS NOT NULL))
);
CREATE INDEX idx_oauth_clients_dcr_created ON oauth_clients(created_at) WHERE kind = 'dcr';

CREATE TABLE oauth_grants(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scopes json NOT NULL CHECK (json_typeof(scopes) = 'array'),
  resource text NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('person','client','refresh_reused','code_reused','unused')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- One live grant per person and client: a second consent reuses it.
CREATE UNIQUE INDEX idx_oauth_grants_live ON oauth_grants(user_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_grants_client ON oauth_grants(client_id);
CREATE INDEX idx_oauth_grants_revoked ON oauth_grants(revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE oauth_requests(
  id_hash text PRIMARY KEY CHECK (char_length(id_hash) = 64),
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2000),
  code_challenge text NOT NULL CHECK (char_length(code_challenge) = 43),
  scopes json NOT NULL CHECK (json_typeof(scopes) = 'array'),
  resource text NOT NULL,
  state text CHECK (char_length(state) <= 2000),
  browser_hash text NOT NULL CHECK (char_length(browser_hash) = 64),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  decided_at timestamptz,
  decision text CHECK (decision IN ('allow','deny')),
  grant_id text REFERENCES oauth_grants(id) ON DELETE CASCADE,
  code_hash text UNIQUE CHECK (char_length(code_hash) = 64),
  code_expires_at timestamptz,
  code_used_at timestamptz,
  CHECK ((decided_at IS NULL) = (decision IS NULL)),
  CHECK (code_hash IS NULL OR (decision = 'allow' AND grant_id IS NOT NULL AND code_expires_at IS NOT NULL))
);
CREATE INDEX idx_oauth_requests_expires ON oauth_requests(expires_at);
CREATE INDEX idx_oauth_requests_client ON oauth_requests(client_id);
CREATE INDEX idx_oauth_requests_grant ON oauth_requests(grant_id) WHERE grant_id IS NOT NULL;

CREATE TABLE oauth_tokens(
  token_hash text PRIMARY KEY CHECK (char_length(token_hash) = 64),
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  audience text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- The refresh token this one was issued for (a rotation), or null for the code exchange.
  rotated_from text CHECK (char_length(rotated_from) = 64),
  -- A refresh token's use: it is spent then, and a second use revokes its grant.
  rotated_at timestamptz,
  revoked_at timestamptz,
  CHECK (kind = 'refresh' OR rotated_at IS NULL)
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens(grant_id, kind);
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);

ALTER TABLE mcp_unsupported_reports ADD COLUMN grant_id text REFERENCES oauth_grants(id) ON DELETE SET NULL;
CREATE INDEX idx_mcp_unsupported_grant ON mcp_unsupported_reports(grant_id, created_at) WHERE grant_id IS NOT NULL;
