-- v3.0 PG-0: the PostgreSQL baseline (docs/design/part2/11-database.md §5, 14-extension-reports.md §9; PLAN §4).
-- The whole target schema in one file, not a replay of the 38 SQLite migrations: v2.0's tables in §5.1's types, the
-- Part 2 tables (sources and ingest, the shared reader, companies, job_keys, job_texts, job_search, the per-person and
-- application tables and their triggers, the reviews), the reference rows, and partitions for the current and next
-- periods. v3.0 starts on an empty database (DECISIONS P5): nothing is copied into it.
--
-- Conventions (11 §5.1, with PG-0's deviations, each the smallest fix against today's code; SP build/PG-0.md):
-- - integer keys: bigint identity (BY DEFAULT: fixtures may name ids); v2.0's text ids stay text (tests and fixtures
--   use readable ids such as 'u1'; uuid would gain 20 bytes a row and change nothing else);
-- - times: timestamptz; day keys: date; 0/1 flags: boolean (the coordinator's decision K);
-- - JSON: `json` (kept byte for byte, as SQLite's TEXT was) for v2.0's documents and lists the app parses, `jsonb`
--   where SQL reads inside or compares (job_sources.config, jobs' level and subcategory lists, the autofill profile,
--   job_analyses.facts) and in the Part 2 tables;
-- - hashes the code writes as hex text (content_hash, source_hash, sha256) stay text; new tables use bytea;
-- - `seq bigint GENERATED ALWAYS AS IDENTITY` on every table whose SQL ordered by rowid (INT-1's list A);
-- - `-- legacy: <package> drops it` marks a v2.0 column that a later package moves off and drops (PLAN §8, §4); nobody
--   else adds a reader to it.
-- Comments here say what a column means when the design does not; the design documents say why.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trusted: the company typeahead and job_search's place text (11 §5.4, §5.6)

-- ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

-- The apply link's host and platform, as features/mcp/platform.ts reads them (hostOf, platformOfUrl): the text between
-- "://" and the next "/" in lower case; the platform by host suffix, then Greenhouse's ?gh_jid=, else 'site'; 'unknown'
-- without a link. jobs.apply_host and apply_platform are generated from them (11 §5.1 wanted ordinary columns written
-- by ingest; generated columns keep v2.0's writers as they are: DB-INGEST may switch). A test keeps them equal to
-- platform.ts.
CREATE FUNCTION tailorit_url_host(url text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN strpos(url, '://') = 0 THEN NULL
    ELSE lower(split_part(substr(url, strpos(url, '://') + 3), '/', 1)) END
$$;

CREATE FUNCTION tailorit_url_platform(url text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN url IS NULL OR btrim(url) = '' THEN 'unknown'
    WHEN tailorit_url_host(url) IS NULL THEN 'site'
    ELSE coalesce((
      SELECT p.platform FROM (VALUES
        (1, 'greenhouse', 'greenhouse.io'), (2, 'lever', 'lever.co'), (3, 'ashby', 'ashbyhq.com'),
        (4, 'workday', 'myworkdayjobs.com'), (5, 'workday', 'myworkdaysite.com'), (6, 'workable', 'workable.com'),
        (7, 'icims', 'icims.com'), (8, 'taleo', 'taleo.net'), (9, 'successfactors', 'successfactors.com'),
        (10, 'successfactors', 'successfactors.eu'), (11, 'oracle', 'oraclecloud.com'),
        (12, 'oracle', 'oraclegovcloud.com'), (13, 'jobvite', 'jobvite.com'), (14, 'jazzhr', 'applytojob.com'),
        (15, 'bamboohr', 'bamboohr.com'), (16, 'rippling', 'rippling.com'), (17, 'breezy', 'breezy.hr'),
        (18, 'careerplug', 'careerplug.com'), (19, 'pinpoint', 'pinpointhq.com'),
        (20, 'paycor', 'recruitingbypaycor.com'), (21, 'hibob', 'hibob.com'), (22, 'ultipro', 'ultipro.com'),
        (23, 'dayforce', 'dayforcehcm.com'), (24, 'paylocity', 'paylocity.com'), (25, 'dice', 'dice.com'),
        (26, 'clearcompany', 'clearcompany.com'), (27, 'adp', 'adp.com'),
        (28, 'smartrecruiters', 'smartrecruiters.com'), (29, 'linkedin', 'linkedin.com')
      ) AS p(rank, platform, suffix)
      WHERE right('.' || tailorit_url_host(url), char_length(p.suffix) + 1) = '.' || p.suffix
      ORDER BY p.rank LIMIT 1),
      CASE WHEN strpos(lower(url), 'gh_jid=') > 0 THEN 'greenhouse' ELSE 'site' END)
  END
$$;

-- ── Reference lists (11 §5.2): a new value is an INSERT ────────────────────────────────────────────────────────────

-- ATS and job-board platforms: jobs.apply_platform's values. auto_apply says what the extension can do there (the
-- agent fills it; the Queue tab opens it; neither). A posting's own answer is per link (job_facts.auto_apply).
CREATE TABLE platforms(
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9]{1,39}$'),
  label text NOT NULL,
  auto_apply text NOT NULL CHECK (auto_apply IN ('agent','tab','none'))
);
INSERT INTO platforms(key, label, auto_apply) VALUES
  ('greenhouse','Greenhouse','agent'), ('lever','Lever','agent'), ('ashby','Ashby','agent'),
  ('workday','Workday','agent'), ('workable','Workable','agent'), ('icims','iCIMS','agent'),
  ('taleo','Taleo','tab'), ('successfactors','SuccessFactors','tab'), ('oracle','Oracle Recruiting Cloud','tab'),
  ('jobvite','Jobvite','agent'), ('jazzhr','JazzHR','tab'), ('bamboohr','BambooHR','tab'),
  ('rippling','Rippling','tab'), ('breezy','Breezy HR','tab'), ('careerplug','CareerPlug','tab'),
  ('pinpoint','Pinpoint','agent'), ('paycor','Paycor','tab'), ('hibob','HiBob','tab'),
  ('ultipro','UltiPro (UKG Pro)','tab'), ('dayforce','Dayforce','tab'), ('paylocity','Paylocity','tab'),
  ('dice','Dice','none'), ('clearcompany','ClearCompany','tab'), ('adp','ADP Workforce Now','tab'),
  ('smartrecruiters','SmartRecruiters','agent'), ('ukgready','UKG Ready','tab'), ('paycom','Paycom','tab'),
  ('jobdiva','JobDiva','tab'), ('eightfold','Eightfold','tab'),
  ('linkedin','LinkedIn','none'), ('site','A company site','none'), ('unknown','No link','none');

-- Kinds of job source (11 §5.2, 12 §12.1, 14 §9's ext_page).
CREATE TABLE job_source_kinds(
  kind text PRIMARY KEY CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text NOT NULL,
  access text NOT NULL CHECK (access IN ('public_api','licensed_api','sitemap','structured_data','user_added',
    'admin_import','internal')),
  runs boolean NOT NULL,
  precedence smallint NOT NULL CHECK (precedence BETWEEN 0 AND 4),
  attribution jsonb,
  raw_keep_days smallint NOT NULL DEFAULT 0 CHECK (raw_keep_days >= 0),
  ai_input boolean NOT NULL DEFAULT true
);
INSERT INTO job_source_kinds(kind, label, access, runs, precedence, attribution, raw_keep_days) VALUES
  ('greenhouse','Greenhouse','public_api',true,4,NULL,30), ('lever','Lever','public_api',true,4,NULL,30),
  ('ashby','Ashby','public_api',true,4,NULL,30), ('workable','Workable','public_api',true,4,NULL,30),
  ('workday','Workday (one posting)','public_api',false,4,NULL,30),
  ('workday_site','Workday career site','sitemap',true,4,NULL,30),
  ('personio','Personio','public_api',true,4,NULL,30), ('recruitee','Recruitee','public_api',true,4,NULL,30),
  ('breezy','Breezy HR','public_api',true,4,NULL,30), ('bamboohr','BambooHR','public_api',true,4,NULL,30),
  ('career_site','Career site','structured_data',true,3,NULL,30),
  ('usajobs','USAJOBS','licensed_api',true,3,'{"text":"USAJOBS","url":"https://www.usajobs.gov/"}',30),
  ('jobtech','JobTech (Arbetsförmedlingen)','public_api',true,3,NULL,30),
  ('nav','NAV','licensed_api',true,3,NULL,7),
  ('tyomarkkinatori','Työmarkkinatori','licensed_api',true,3,
     '{"text":"(Lähde: Työmarkkinatorin asiakastietojärjestelmä)"}',30),
  ('himalayas','Himalayas','public_api',true,2,'{"text":"Himalayas","url":"https://himalayas.app/"}',30),
  ('jobicy','Jobicy','public_api',true,2,'{"text":"Jobicy","url":"https://jobicy.com/"}',30),
  ('vendor_feed','Licensed feed','licensed_api',true,2,NULL,0),
  ('page','A page a person saved','user_added',false,0,NULL,0),
  ('ext_page','A page job an admin published','user_added',false,0,NULL,0),
  ('csv','CSV import','admin_import',false,3,NULL,0), ('json','JSON import','admin_import',false,3,NULL,0),
  ('ft_lake','free_tailor lake','internal',true,2,NULL,0), ('seed','Demo seed','internal',false,1,NULL,0);

-- AI task kinds (@tailorit/shared AI_TASK_KINDS; the paused resume bank's four; 13 §8's company_summary).
CREATE TABLE ai_task_kinds(kind text PRIMARY KEY CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'));
INSERT INTO ai_task_kinds(kind) VALUES
  ('resume_import'), ('entry_bullets'), ('job_analysis'), ('cover_letter'), ('template_fill'), ('resume_analysis'),
  ('bank_tag'), ('bank_draft'), ('bank_review'), ('bank_fix'),
  ('autofill_pick'), ('autofill_classify'), ('autofill_draft'), ('autofill_answer'),
  ('tailor'), ('job_search'), ('custom_filter'), ('company_summary');

-- ── Accounts and sign-in ───────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE users(
  id text PRIMARY KEY,
  email text NOT NULL,                      -- stored normalised (lower case); unique without case below
  name text NOT NULL DEFAULT '',
  avatar_url text,
  google_sub text UNIQUE,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  default_resume_id text,                   -- REFERENCES resumes(id) ON DELETE SET NULL (added below)
  disabled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_sign_in_at timestamptz,
  account_type text NOT NULL DEFAULT 'free' CHECK (account_type IN ('free','paid')),
  paid_until timestamptz
);
CREATE UNIQUE INDEX users_email_lower ON users(lower(email));
CREATE INDEX idx_users_paid_until ON users(paid_until) WHERE account_type = 'paid';

CREATE TABLE user_sessions(
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  user_agent text,
  ip text
);
CREATE INDEX idx_sessions_exp ON user_sessions(expires_at);
CREATE INDEX idx_sessions_user ON user_sessions(user_id);

-- One live code per address; the address stored normalised (SQLite's COLLATE NOCASE key).
CREATE TABLE login_codes(
  email text PRIMARY KEY,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- ── Files and documents ────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE stored_files(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('resume','letter_import','template_import','job_import')),
  original_name text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  thumb_path text,
  page_count integer,
  created_at timestamptz NOT NULL
);
CREATE INDEX idx_files_user ON stored_files(user_id, created_at DESC);

CREATE TABLE resume_photos(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png')),
  bytes bytea NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  sha256 text NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  created_at timestamptz NOT NULL
);
CREATE INDEX idx_resume_photos_user ON resume_photos(user_id, created_at);

CREATE TABLE resumes(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('built','uploaded')),
  title text,                               -- the Rename; NULL derives the label from the document
  template_id text,
  data json,                                -- the editor's document, read whole (out of line by TOAST)
  file_id text REFERENCES stored_files(id) ON DELETE SET NULL,
  extracted_text text,
  source_resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_edited_at timestamptz,
  document_revision integer NOT NULL DEFAULT 0,
  made_by text NOT NULL DEFAULT 'editor' CHECK (made_by IN ('upload','editor','copy','tailor'))
);
CREATE INDEX idx_resumes_user ON resumes(user_id, updated_at DESC);
CREATE INDEX idx_resumes_made_by ON resumes(user_id, made_by, created_at DESC);

ALTER TABLE users ADD CONSTRAINT users_default_resume_fk
  FOREIGN KEY (default_resume_id) REFERENCES resumes(id) ON DELETE SET NULL;

CREATE TABLE resume_analyses(
  resume_id text NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('deterministic','ai')),
  version integer NOT NULL,
  content_hash text NOT NULL,
  hard_skills json NOT NULL DEFAULT '[]',
  soft_skills json NOT NULL DEFAULT '[]',
  keywords json NOT NULL DEFAULT '{"roles":[],"certifications":[],"domains":[]}',
  experience json NOT NULL DEFAULT '[]',
  years_stated double precision CHECK (years_stated IS NULL OR (years_stated >= 0 AND years_stated <= 80)),
  years_stated_basis text CHECK (years_stated_basis IN ('field','stated')),
  person_name text,
  model text,
  prompt_hash text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (resume_id, source)
);
CREATE INDEX idx_resume_analyses_hash ON resume_analyses(content_hash, source, version);

CREATE TABLE resume_analysis_backlog(
  resume_id text PRIMARY KEY REFERENCES resumes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting','queued','done','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  task_id text,
  next_attempt_at timestamptz NOT NULL,
  started_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX idx_resume_backlog_next ON resume_analysis_backlog(state, next_attempt_at);
CREATE INDEX idx_resume_backlog_user ON resume_analysis_backlog(user_id, started_at);

CREATE TABLE resume_copy_backlog(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_resume_id text NOT NULL UNIQUE REFERENCES resumes(id) ON DELETE CASCADE,
  batch_id text NOT NULL,
  label text NOT NULL,
  template_id text,
  state text NOT NULL CHECK (state IN ('waiting','making','ready','failed','stopped')),
  task_id text,
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  retries integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL
);
CREATE INDEX idx_resume_copy_due ON resume_copy_backlog(state, next_attempt_at);
CREATE INDEX idx_resume_copy_result ON resume_copy_backlog(resume_id);
CREATE INDEX idx_resume_copy_user ON resume_copy_backlog(user_id, created_at, seq);

CREATE TABLE user_skills(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_key text NOT NULL,
  skill text NOT NULL,
  type text NOT NULL DEFAULT 'hard' CHECK (type IN ('hard','soft')),
  category text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  PRIMARY KEY (user_id, type, skill_key)
);
CREATE INDEX idx_user_skills_order ON user_skills(user_id, created_at, seq);

CREATE TABLE cover_letter_templates(
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  is_system boolean NOT NULL DEFAULT false,
  system_key text UNIQUE,
  name text NOT NULL,
  content_html text NOT NULL DEFAULT '',    -- variables as literal {{UPPER_SNAKE}} text
  content_text text NOT NULL DEFAULT '',
  font_family text NOT NULL DEFAULT 'Times New Roman',
  ai_prompt text NOT NULL DEFAULT '' CHECK (char_length(ai_prompt) <= 1000),
  origin text NOT NULL DEFAULT 'blank' CHECK (origin IN ('blank','uploaded','duplicated','system')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_edited_at timestamptz,
  CHECK ((is_system AND user_id IS NULL) OR (NOT is_system AND user_id IS NOT NULL))
);
CREATE INDEX idx_cltpl_user ON cover_letter_templates(user_id, updated_at DESC);

-- ── Companies (11 §5.4, 13 §10) ────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE companies(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  name_key text NOT NULL,                   -- normalizeCompanyName; 'page:<user>:<key>' for an account's own row
  owner_user_id text REFERENCES users(id) ON DELETE CASCADE,
  merged_into_id bigint REFERENCES companies(id),
  do_not_fetch boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- v2.0's enrichment columns, until readers use company_profiles (11 §5.4):
  website text,                             -- legacy: E0-API drops it
  logo_path text,                           -- legacy: E0-API drops it
  tagline text,                             -- legacy: E0-API drops it
  about text,                               -- legacy: E0-API drops it
  size_bucket text,                         -- legacy: E0-API drops it
  stage text,                               -- legacy: E0-API drops it
  funding text,                             -- legacy: E0-API drops it
  headquarters text,                        -- legacy: E0-API drops it
  founded_year integer,                     -- legacy: E0-API drops it
  industry text,                            -- legacy: E0-API drops it
  links json NOT NULL DEFAULT '[]',         -- legacy: E0-API drops it
  sponsors_h1b boolean,                     -- legacy: E0-API drops it (company_profiles.sponsors_h1b)
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
-- The name key is unique until resolveCompany matches by alias (13 §5.1: homonyms share a name key); v2.0's company
-- creation upserts on it (ON CONFLICT(name_key)).
CREATE UNIQUE INDEX idx_companies_name_key ON companies(name_key);   -- legacy: E0-API drops it (for a plain index)
CREATE INDEX idx_companies_owner ON companies(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_companies_merged ON companies(merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX idx_companies_name_trgm ON companies USING gin (name gin_trgm_ops);

CREATE TABLE company_profiles(
  company_id bigint PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  display_name text, legal_name text,
  tagline text CHECK (char_length(tagline) <= 90),
  summary text CHECK (char_length(summary) <= 600),
  summary_origin text CHECK (summary_origin IN ('source_text','ai','admin')),
  website text, domain text,
  linkedin_url text CHECK (linkedin_url ~ '^https://www\.linkedin\.com/company/.+'),
  other_links jsonb NOT NULL DEFAULT '[]',
  logo_path text,
  logo_sha256 bytea,
  industry text, industry_detail text,
  employees integer CHECK (employees >= 0), employees_as_of date,
  size_bucket text,
  stage text, ticker text, exchange text,
  hq_city text, hq_region text, hq_country_code char(2),
  founded_year smallint CHECK (founded_year BETWEEN 1600 AND 2100),
  founded_kind text CHECK (founded_kind IN ('founded','incorporated')),
  funding_total_usd bigint, funding_as_of date,
  sponsors_h1b boolean,
  provenance jsonb NOT NULL DEFAULT '{}',
  confidence jsonb NOT NULL DEFAULT '{}',
  locked_fields jsonb NOT NULL DEFAULT '[]',
  conflicts jsonb NOT NULL DEFAULT '{}',
  enriched_at timestamptz, next_refresh_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_company_profiles_refresh ON company_profiles(next_refresh_at);
CREATE INDEX idx_company_profiles_domain ON company_profiles(domain) WHERE domain IS NOT NULL;

CREATE TABLE company_sources(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ref text NOT NULL DEFAULT '',
  licence text NOT NULL,
  attribution text,
  match_confidence smallint NOT NULL CHECK (match_confidence BETWEEN 0 AND 100),
  fields jsonb NOT NULL DEFAULT '{}',
  content_hash bytea,
  status text NOT NULL CHECK (status IN ('ok','not_found','blocked','robots_disallowed','error')),
  retrieved_at timestamptz NOT NULL, expires_at timestamptz,
  purge_group text,
  UNIQUE (company_id, kind, ref)
);
CREATE INDEX idx_company_sources_purge ON company_sources(purge_group) WHERE purge_group IS NOT NULL;
CREATE INDEX idx_company_sources_expiry ON company_sources(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE company_aliases(
  kind text NOT NULL CHECK (kind IN ('board','domain','domain_shared','wikidata','cik','lei','uk_company','ticker',
    'linkedin_slug','name_key','legal_name_key')),
  value text NOT NULL,
  company_id bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id bigint REFERENCES company_sources(id) ON DELETE SET NULL,
  confidence smallint NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  is_primary boolean NOT NULL DEFAULT false,
  valid_from date, valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value, company_id)
);
CREATE UNIQUE INDEX idx_company_alias_strong ON company_aliases(kind, value)
  WHERE kind IN ('board','domain','wikidata','cik','lei','uk_company');
CREATE INDEX idx_company_alias_company ON company_aliases(company_id);

CREATE TABLE company_relations(
  parent_id bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  child_id bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('subsidiary','brand','acquired')),
  source_id bigint REFERENCES company_sources(id) ON DELETE SET NULL,
  confidence smallint NOT NULL,
  PRIMARY KEY (parent_id, child_id),
  CHECK (parent_id <> child_id)
);
CREATE INDEX idx_company_relations_child ON company_relations(child_id);

CREATE TABLE company_enrichment_queue(
  company_id bigint PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  steps jsonb NOT NULL DEFAULT '[]',
  priority integer NOT NULL,
  due_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0, last_error text, leased_until timestamptz
);
CREATE INDEX idx_company_queue_due ON company_enrichment_queue(due_at, priority DESC);

CREATE TABLE company_match_reviews(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('merge','homonym','domain','wikidata','board_by_name')),
  company_id bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  other_company_id bigint REFERENCES companies(id) ON DELETE CASCADE,
  candidate jsonb NOT NULL,
  score smallint NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
  decided_by text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_company_reviews_open ON company_match_reviews(created_at) WHERE status = 'open';

CREATE TABLE company_job_counts(
  company_id bigint PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  open_jobs integer NOT NULL DEFAULT 0,
  closed_jobs integer NOT NULL DEFAULT 0,
  last_posted_at timestamptz,
  counted_at timestamptz NOT NULL
);

CREATE TABLE user_hidden_companies(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at timestamptz,
  PRIMARY KEY (user_id, company_id)
);

-- ── The shared reader (11 §5.3a) ───────────────────────────────────────────────────────────────────────────────────

CREATE TABLE site_robots(
  host text PRIMARY KEY,
  fetched_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','no_rules','unreachable')),
  http_status smallint, rules text, crawl_delay_s integer,
  content_signals text,
  ai_input boolean,
  sitemaps jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE crawl_hosts(
  host text PRIMARY KEY,
  min_interval_ms integer NOT NULL DEFAULT 1000,
  next_slot_at timestamptz NOT NULL DEFAULT now(),
  hold_until timestamptz,
  hold_reason text CHECK (hold_reason IN ('retry_after','breaker','bot_check','admin')),
  consecutive_failures smallint NOT NULL DEFAULT 0,
  last_status smallint,
  updated_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 70);
CREATE INDEX idx_crawl_hosts_held ON crawl_hosts(hold_until) WHERE hold_until IS NOT NULL;

CREATE TABLE crawl_opt_outs(
  domain text PRIMARY KEY,
  company_id bigint REFERENCES companies(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (char_length(reason) <= 500),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Jobs (11 §5.5) ─────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE job_analyses(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  content_hash text NOT NULL,
  source text NOT NULL CHECK (source IN ('deterministic','ft_lake','ai')),
  version integer NOT NULL,
  model text,
  prompt_hash text,
  requirements json NOT NULL DEFAULT '[]',
  responsibilities json NOT NULL DEFAULT '[]',
  desired json NOT NULL DEFAULT '[]',
  keywords json NOT NULL DEFAULT '{"high":[],"low":[]}',
  experience_levels json NOT NULL DEFAULT '[]',
  leadership text,
  min_years integer,
  category_id text,
  subcategory_ids json NOT NULL DEFAULT '[]',
  extras json NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  soft_skills json,
  terms json,
  required_years integer CHECK (required_years IS NULL OR (required_years >= 0 AND required_years <= 30)),
  facts jsonb,
  UNIQUE (content_hash, source, version)
);

CREATE TABLE jobs(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  owner_user_id text REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  apply_url text NOT NULL DEFAULT '',
  apply_host text GENERATED ALWAYS AS (tailorit_url_host(apply_url)) STORED,
  apply_platform text NOT NULL GENERATED ALWAYS AS (tailorit_url_platform(apply_url)) STORED REFERENCES platforms(key),
  link_key text COLLATE "C",                -- legacy: DB-INGEST drops it (job_keys holds every identity key)
  title_key text,                           -- titleKeyOf(title) (12 §7.2): DB-INGEST writes it, then makes it NOT NULL
  content_hash text NOT NULL,               -- sha256 of the text, hex (written by ingest's contentHashOf)
  text_simhash bigint,
  ai_input boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  closed_at timestamptz,
  unverified_since timestamptz,
  held_since timestamptz,                   -- held for review (14 §9): out of every search until approved
  posted_at timestamptz,
  posted_sort timestamptz GENERATED ALWAYS AS (COALESCE(posted_at, first_seen_at)) STORED,
  source_updated_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_verified_at timestamptz,
  employment_type text CHECK (employment_type IN ('full_time','part_time','contract','internship','unpaid','temporary')),
  work_arrangement text CHECK (work_arrangement IN ('remote','hybrid','onsite')),
  experience_levels jsonb NOT NULL DEFAULT '[]',   -- a JSON array (job_search holds the text[] the filters read)
  leadership text CHECK (leadership IN ('ic','manager')),
  category_id text,
  subcategory_ids jsonb NOT NULL DEFAULT '[]',     -- a JSON array, as experience_levels
  salary_min numeric, salary_max numeric, salary_currency text,
  salary_period text CHECK (salary_period IN ('year','month','week','day','hour')),
  salary_annual_usd_min numeric, salary_annual_usd_max numeric, salary_raw text,
  sponsors_h1b boolean, requires_clearance boolean, degree text, industry text,
  locations_text text NOT NULL DEFAULT '', primary_location text NOT NULL DEFAULT '',
  location_count integer NOT NULL DEFAULT 0,
  analysis_id bigint REFERENCES job_analyses(id) ON DELETE SET NULL,
  superseded_by bigint REFERENCES jobs(id) ON DELETE SET NULL,
  made_from text CHECK (char_length(made_from) BETWEEN 3 AND 600),
  view_count integer NOT NULL DEFAULT 0,    -- legacy: DB-JOBS drops it (job_stats counts views)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (active OR closed_at IS NOT NULL)
) WITH (fillfactor = 90);
CREATE UNIQUE INDEX idx_jobs_link ON jobs(link_key) WHERE link_key IS NOT NULL;   -- legacy: DB-INGEST drops it
CREATE INDEX idx_jobs_hash ON jobs(content_hash);
CREATE INDEX idx_jobs_dedup ON jobs(company_id, title_key) INCLUDE (content_hash, text_simhash, posted_sort)
  WHERE active;
CREATE INDEX idx_jobs_unverified ON jobs(unverified_since) WHERE unverified_since IS NOT NULL;
CREATE INDEX idx_jobs_held ON jobs(held_since) WHERE held_since IS NOT NULL;
CREATE INDEX idx_jobs_company_open ON jobs(company_id, posted_sort DESC, id DESC) WHERE active;
CREATE INDEX idx_jobs_company_closed ON jobs(company_id, closed_at DESC, id DESC) WHERE NOT active;
CREATE INDEX idx_jobs_closed_at ON jobs(closed_at) WHERE NOT active;
CREATE INDEX idx_jobs_ai_backlog ON jobs(first_seen_at DESC, id DESC) INCLUDE (content_hash) WHERE active;
CREATE INDEX idx_jobs_owner ON jobs(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_jobs_superseded ON jobs(superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX idx_jobs_analysis ON jobs(analysis_id) WHERE analysis_id IS NOT NULL;

-- The posting text, sanitised HTML only; the plain text is derived where needed (features/jobs/text.ts). Range-
-- partitioned by job id, 2,000,000 ids a partition, one ahead always (D5L's housekeeping makes the next).
CREATE TABLE job_texts(
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  description_html text COMPRESSION lz4 NOT NULL,
  text_chars integer NOT NULL CHECK (text_chars >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (job_id)
) PARTITION BY RANGE (job_id);
CREATE TABLE job_texts_p000 PARTITION OF job_texts FOR VALUES FROM (1) TO (2000001);
CREATE TABLE job_texts_p001 PARTITION OF job_texts FOR VALUES FROM (2000001) TO (4000001);

CREATE TABLE job_stats(
  job_id bigint PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  views bigint NOT NULL DEFAULT 0,
  saves integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

CREATE TABLE job_keys(
  key_kind text NOT NULL CHECK (key_kind IN ('ats','link','ld','ghjid')),
  key text NOT NULL CHECK (char_length(key) <= 2048),
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  PRIMARY KEY (key_kind, key)
);
CREATE INDEX idx_job_keys_job ON job_keys(job_id);

CREATE TABLE job_locations(
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position integer NOT NULL,
  raw text NOT NULL,
  city text,
  region text,
  country_code text,
  is_remote boolean NOT NULL DEFAULT false,
  PRIMARY KEY (job_id, position)
);
CREATE INDEX idx_job_loc ON job_locations(country_code, region, city);

CREATE TABLE job_ai_attempts(
  content_hash text NOT NULL,
  version integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (content_hash, version)
);

CREATE TABLE job_forms(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  form_key text NOT NULL UNIQUE CHECK (char_length(form_key) BETWEEN 5 AND 700),
  job_id bigint REFERENCES jobs(id) ON DELETE CASCADE,
  platform text CHECK (platform IS NULL OR platform ~ '^[a-z]{1,40}$'),
  source text NOT NULL CHECK (source IN ('submission','ats-api')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX idx_job_forms_job ON job_forms(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE job_form_questions(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  form_id bigint NOT NULL REFERENCES job_forms(id) ON DELETE CASCADE,
  question_key text NOT NULL CHECK (char_length(question_key) BETWEEN 1 AND 300),
  option_set_hash text CHECK (option_set_hash IS NULL OR option_set_hash ~ '^([0-9a-f]{16})?$'),
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal BETWEEN 0 AND 999),
  label_key text NOT NULL CHECK (char_length(label_key) <= 500),
  field_kind text NOT NULL CHECK (field_kind IN ('text','textarea','select','radio','checkbox','checkbox-group',
    'combobox','multiselect','typeahead-remote','date','file')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 500),
  options json NOT NULL DEFAULT '[]' CHECK (json_typeof(options) = 'array'),
  section text NOT NULL DEFAULT '' CHECK (char_length(section) <= 200),
  required boolean NOT NULL DEFAULT false,
  step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 99),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 9999),
  source text NOT NULL CHECK (source IN ('submission','ats-api')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (form_id, section, question_key, option_set_hash, ordinal)
);
CREATE INDEX idx_form_questions_key ON job_form_questions(question_key, option_set_hash);

CREATE TABLE job_link_aliases(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias text COLLATE "C" NOT NULL CHECK (char_length(alias) BETWEEN 9 AND 2100 AND left(alias, 8) = 'https://'),
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('linkedin','page','employer')),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX idx_job_link_aliases_alias ON job_link_aliases(user_id, alias);
CREATE INDEX idx_job_link_aliases_job ON job_link_aliases(job_id);

-- Admin › Reports (v2.0); 14 merges its closed reports into job_reviews (X1-API).
CREATE TABLE job_reports(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('inactive','spam','inaccurate','duplicate','other','company_info_wrong')),
  details text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text
);
CREATE INDEX idx_reports_status ON job_reports(status, created_at DESC);

CREATE TABLE job_facts(
  job_id bigint PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  facts_version integer NOT NULL CHECK (facts_version >= 1),
  content_hash text NOT NULL,
  analysis_id bigint REFERENCES job_analyses(id) ON DELETE SET NULL,
  analysis_version integer,
  work_arrangement text CHECK (work_arrangement IN ('remote','hybrid','onsite')),
  employment_type text CHECK (employment_type IN ('full_time','part_time','contract','internship','unpaid','temporary')),
  industry text CHECK (char_length(industry) BETWEEN 1 AND 40),
  degree_level text CHECK (degree_level IN ('none','high_school','associate','bachelor','master','doctorate')),
  min_years integer CHECK (min_years BETWEEN 0 AND 40),
  experience_levels json NOT NULL DEFAULT '[]',
  clearance_required boolean,
  sponsorship text CHECK (sponsorship IN ('offered','not_offered')),
  "authorization" text CHECK ("authorization" IN ('citizen','permanent_resident','any')),
  salary_min_usd integer CHECK (salary_min_usd >= 0),
  salary_max_usd integer CHECK (salary_max_usd >= 0),
  cover_letter_required boolean,
  eligibility_rules boolean NOT NULL DEFAULT false,   -- job_facts_eligibility holds rows for it
  auto_apply text NOT NULL CHECK (auto_apply IN ('agent','tab','none')),
  questions_known integer NOT NULL DEFAULT 0 CHECK (questions_known >= 0),
  details json NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL
);
CREATE INDEX idx_job_facts_filter ON job_facts(work_arrangement, employment_type, industry);
CREATE INDEX idx_job_facts_stale ON job_facts(facts_version, computed_at);

CREATE TABLE job_facts_certifications(
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cert_key text NOT NULL CHECK (char_length(cert_key) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  required boolean NOT NULL,
  PRIMARY KEY (job_id, cert_key)
);
CREATE INDEX idx_job_certs_key ON job_facts_certifications(cert_key, required, job_id);

CREATE TABLE job_facts_eligibility(
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('country','region','utc_offset')),
  value text NOT NULL CHECK (
    (kind = 'country' AND value ~ '^[A-Z]{2}$')
    OR (kind = 'region' AND value ~ '^[A-Z]{2}-[A-Z0-9]' AND char_length(value) <= 9)
    OR (kind = 'utc_offset' AND value ~ '^[+-][0-9]{4}$')),
  source text NOT NULL CHECK (source IN ('rules','ai')),
  PRIMARY KEY (job_id, kind, value)
);
CREATE INDEX idx_job_eligibility_value ON job_facts_eligibility(kind, value, job_id);

CREATE TABLE tailor_job_analyses(
  posting_hash text NOT NULL,
  prompt_hash text NOT NULL,
  model text NOT NULL,
  job_title text NOT NULL DEFAULT '',
  raw json NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (posting_hash, prompt_hash, model)
);
CREATE INDEX idx_tailor_job_analyses_created ON tailor_job_analyses(created_at);

-- ── Job sources and ingest (11 §5.3, 12 §12) ───────────────────────────────────────────────────────────────────────

CREATE TABLE job_sources(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind text NOT NULL REFERENCES job_source_kinds(kind),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  company_id bigint REFERENCES companies(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  cadence interval NOT NULL DEFAULT '1 day',
  next_run_at timestamptz,
  priority smallint NOT NULL DEFAULT 0,
  deactivate_missing boolean NOT NULL DEFAULT true,
  terms_status text NOT NULL DEFAULT 'unchecked'
    CHECK (terms_status IN ('unchecked','allowed','allowed_with_conditions','needs_contract','forbidden')),
  terms_url text,
  terms_checked_at timestamptz,
  terms_note text CHECK (char_length(terms_note) <= 1000),
  robots_status text NOT NULL DEFAULT 'unchecked'
    CHECK (robots_status IN ('unchecked','allowed','disallowed','not_applicable','error')),
  robots_checked_at timestamptz,
  etag text,
  last_modified text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_status text,
  consecutive_failures smallint NOT NULL DEFAULT 0,
  open_jobs integer NOT NULL DEFAULT 0,
  host text,
  tier text NOT NULL DEFAULT 'normal'
    CHECK (tier IN ('hot','normal','quiet','empty','failing','not_found')),
  last_change_at timestamptz,
  last_complete_at timestamptz,
  lease_until timestamptz,
  discovered_via text CHECK (discovered_via IN ('extension','application_link','common_crawl','company_site',
    'cross_link','probe','vendor','admin')),
  ai_input boolean NOT NULL DEFAULT true,
  schedule text NOT NULL DEFAULT 'daily',   -- legacy: S1-API drops it (cadence and next_run_at replace it)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);
CREATE INDEX idx_job_sources_due ON job_sources(next_run_at, priority DESC)
  WHERE enabled AND terms_status IN ('allowed','allowed_with_conditions')
    AND robots_status IN ('allowed','not_applicable');
CREATE INDEX idx_job_sources_company ON job_sources(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_job_sources_host ON job_sources(host);
CREATE INDEX idx_job_sources_verified ON job_sources(last_complete_at) WHERE enabled;

-- v2.0's ingest_runs, renamed (PG-C ports its readers and writers).
CREATE TABLE job_source_runs(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES job_sources(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('schedule','manual','upload','startup','liveness')),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','partial','not_modified')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  http_status smallint,
  bytes_fetched bigint,
  fetched integer NOT NULL DEFAULT 0, created integer NOT NULL DEFAULT 0, updated integer NOT NULL DEFAULT 0,
  unchanged integer NOT NULL DEFAULT 0, deactivated integer NOT NULL DEFAULT 0, reopened integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  error_code text,
  error text CHECK (char_length(error) <= 2000),
  log text CHECK (char_length(log) <= 20000)
);
CREATE INDEX idx_job_source_runs_source ON job_source_runs(source_id, started_at DESC);
CREATE INDEX idx_job_source_runs_age ON job_source_runs(started_at);

CREATE TABLE job_source_links(
  source_id bigint NOT NULL REFERENCES job_sources(id) ON DELETE CASCADE,
  source_job_id text NOT NULL,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_hash text NOT NULL,                -- hex, as ingest writes it
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  miss_count smallint NOT NULL DEFAULT 0,
  missing_since timestamptz,
  liveness_checked_at timestamptz,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- the order links were made (from-page's linkIdFor)
  PRIMARY KEY (source_id, source_job_id)
);
CREATE INDEX idx_jsl_job ON job_source_links(job_id, seq);
CREATE INDEX idx_jsl_live ON job_source_links(source_id) INCLUDE (source_job_id, source_hash, miss_count, job_id)
  WHERE missing_since IS NULL;
CREATE INDEX idx_jsl_liveness ON job_source_links(source_id, liveness_checked_at NULLS FIRST)
  WHERE missing_since IS NULL;

CREATE TABLE job_postings_raw(
  source_id bigint NOT NULL,
  source_job_id text NOT NULL,
  fetched_at timestamptz NOT NULL,
  run_id bigint,
  payload_hash bytea NOT NULL,
  content_type text NOT NULL CHECK (char_length(content_type) <= 100),
  payload text COMPRESSION lz4 NOT NULL,
  PRIMARY KEY (source_id, source_job_id, fetched_at)
) PARTITION BY RANGE (fetched_at);

CREATE TABLE job_source_candidates(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind text NOT NULL REFERENCES job_source_kinds(kind),
  name text NOT NULL,
  discovered_via text NOT NULL CHECK (discovered_via IN
    ('extension','application_link','common_crawl','company_site','cross_link','probe','vendor','admin')),
  seen_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','valid','empty','not_found','forbidden','error','dropped')),
  attempts smallint NOT NULL DEFAULT 0,
  next_check_at timestamptz,
  source_id bigint REFERENCES job_sources(id) ON DELETE SET NULL,
  UNIQUE (kind, name)
);
CREATE INDEX idx_jsc_due ON job_source_candidates(next_check_at) WHERE status IN ('new','error','not_found');

CREATE TABLE job_source_purges(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source_id bigint REFERENCES job_sources(id),
  company_id bigint REFERENCES companies(id),
  reason text NOT NULL CHECK (reason IN ('contract_end','opt_out','terms_changed','admin')),
  delete_texts boolean NOT NULL,
  delete_applied_texts boolean NOT NULL DEFAULT false,
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  cursor_job_id bigint,
  jobs_closed integer NOT NULL DEFAULT 0, texts_deleted integer NOT NULL DEFAULT 0,
  raw_deleted integer NOT NULL DEFAULT 0, texts_kept_for_applications integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  CHECK (source_id IS NOT NULL OR company_id IS NOT NULL)
);
CREATE INDEX idx_job_source_purges_open ON job_source_purges(created_at) WHERE state IN ('queued','running');

-- ── Reviews from the extension (14 §9) ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE job_reviews(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('closed','new_job')),
  subject_key text NOT NULL CHECK (char_length(subject_key) <= 2100),
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  origin text CHECK (origin IN ('ats','page')),
  page_host text CHECK (char_length(page_host) <= 253),
  link_source_id bigint,
  link_source_job_id text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','approved','rejected','superseded','expired')),
  reporters integer NOT NULL DEFAULT 0 CHECK (reporters >= 0),
  trusted_reporters integer NOT NULL DEFAULT 0 CHECK (trusted_reporters >= 0),
  strongest text CHECK (strongest IN ('weak','person','strong')),
  check_state text NOT NULL DEFAULT 'none'
    CHECK (check_state IN ('none','queued','gone','live','unreadable','not_possible')),
  checked_at timestamptz,
  decided_by text CHECK (decided_by IN ('admin','auto','server_check','source')),
  decided_by_user text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  note text CHECK (char_length(note) <= 500),
  first_reported_at timestamptz NOT NULL,
  last_reported_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'new_job') = (origin IS NOT NULL))
);
CREATE UNIQUE INDEX ux_job_reviews_open ON job_reviews(kind, subject_key) WHERE state = 'pending';
CREATE INDEX idx_job_reviews_queue ON job_reviews(kind, state, last_reported_at DESC);
CREATE INDEX idx_job_reviews_job ON job_reviews(job_id);
CREATE INDEX idx_job_reviews_check ON job_reviews(checked_at) WHERE state = 'pending' AND check_state = 'queued';
CREATE INDEX idx_job_reviews_decided ON job_reviews(decided_at) WHERE state <> 'pending';

CREATE TABLE job_review_reports(
  review_id bigint NOT NULL REFERENCES job_reviews(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via text NOT NULL CHECK (via IN ('page','agent','queue','person','web','add')),
  signal text CHECK (signal IN ('marker','valid_through_past','no_posting','redirected','person')),
  marker text CHECK (char_length(marker) <= 60),
  strength text CHECK (strength IN ('weak','person','strong')),
  page_job_id bigint REFERENCES jobs(id) ON DELETE SET NULL,
  text_hash bytea,
  details text CHECK (char_length(details) <= 1000),
  seen_at timestamptz NOT NULL,
  day_key date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, user_id)
);
CREATE INDEX idx_jrr_user_day ON job_review_reports(user_id, day_key);

-- ── The search projection (11 §5.6, §7): one row per open, verified, unheld job; written by projectJob ─────────────

CREATE TABLE job_search(
  job_id bigint PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  owner_user_id text,
  company_id bigint NOT NULL,
  posted_sort timestamptz NOT NULL,
  updated_sort timestamptz NOT NULL,
  title_tsv tsvector NOT NULL,
  body_tsv tsvector NOT NULL,
  employment_type text, work_arrangement text,
  experience_levels text[] NOT NULL,
  leadership text, category_id text, subcategory_ids text[] NOT NULL,
  industry text,
  company_size text,
  salary_min_usd integer, salary_max_usd integer,
  salary_sort integer GENERATED ALWAYS AS (COALESCE(salary_max_usd, salary_min_usd)) STORED,
  sponsorship text, clearance_required boolean, degree_level text, min_years smallint, "authorization" text,
  apply_platform text NOT NULL, auto_apply text NOT NULL,
  place_keys text[] NOT NULL,
  locations_text text NOT NULL,
  elig_keys text[] NOT NULL,
  elig_region_countries text[] NOT NULL,
  elig_regions text[] NOT NULL,
  cert_required text[] NOT NULL,
  facts_version smallint NOT NULL,
  refreshed_at timestamptz NOT NULL
);
CREATE INDEX js_title    ON job_search USING gin (title_tsv);
CREATE INDEX js_body     ON job_search USING gin (body_tsv);
CREATE INDEX js_posted   ON job_search(posted_sort DESC, job_id DESC);
CREATE INDEX js_updated  ON job_search(updated_sort DESC, job_id DESC);
CREATE INDEX js_salary   ON job_search(salary_sort DESC, job_id DESC) WHERE salary_sort IS NOT NULL;
CREATE INDEX js_company  ON job_search(company_id, posted_sort DESC);
CREATE INDEX js_category ON job_search(category_id, posted_sort DESC);
CREATE INDEX js_places   ON job_search USING gin (place_keys);
CREATE INDEX js_elig     ON job_search USING gin (elig_keys);
CREATE INDEX js_loc_trgm ON job_search USING gin (locations_text gin_trgm_ops);
CREATE INDEX js_owner    ON job_search(owner_user_id) WHERE owner_user_id IS NOT NULL;

-- ── Per-person state (11 §5.7) ─────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE user_preferences(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  experience_levels json NOT NULL DEFAULT '[]',
  job_types json NOT NULL DEFAULT '[]',
  work_arrangements json NOT NULL DEFAULT '[]',
  categories json NOT NULL DEFAULT '[]',
  locations json NOT NULL DEFAULT '[]',
  min_salary integer,
  phone text NOT NULL DEFAULT '',
  linkedin_url text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  portfolio_url text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL,
  home_country text CHECK (home_country ~ '^[A-Z]{2}$'),
  home_region text CHECK (home_region ~ '^[A-Z0-9]{1,6}$'),
  home_city text CHECK (char_length(home_city) <= 100),
  time_zone text CHECK (char_length(time_zone) BETWEEN 1 AND 64)
);

CREATE TABLE user_settings(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  skip_prepare_confirm boolean NOT NULL DEFAULT false,
  prepare_filters json NOT NULL DEFAULT '{}' CHECK (json_typeof(prepare_filters) = 'object'),
  filters_revision integer NOT NULL DEFAULT 0 CHECK (filters_revision >= 0),
  updated_at timestamptz NOT NULL,
  prepare_resume_mode text NOT NULL DEFAULT 'tailor' CHECK (prepare_resume_mode IN ('default','similar','tailor'))
);

CREATE TABLE user_job_state(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  hidden_at timestamptz,
  viewed_at timestamptz,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE saved_searches(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  query json NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX idx_saved_searches_user ON saved_searches(user_id, created_at DESC);

-- The stored resume counts, maintained by the triggers on resumes below and recounted nightly (DB-JOBS's D1d). Its row
-- is also the person's lock: DbClient.lockPerson takes it FOR UPDATE (made on demand).
CREATE TABLE user_counters(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  resumes_upload integer NOT NULL DEFAULT 0 CHECK (resumes_upload >= 0),
  resumes_editor integer NOT NULL DEFAULT 0 CHECK (resumes_editor >= 0),
  resumes_copy   integer NOT NULL DEFAULT 0 CHECK (resumes_copy >= 0),
  resumes_tailor integer NOT NULL DEFAULT 0 CHECK (resumes_tailor >= 0),
  resumes_total  integer GENERATED ALWAYS AS (resumes_upload + resumes_editor + resumes_copy + resumes_tailor) STORED,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_spend_daily(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key date NOT NULL,
  daily_spent_micros bigint NOT NULL DEFAULT 0 CHECK (daily_spent_micros >= 0),
  credit_spent_micros bigint NOT NULL DEFAULT 0 CHECK (credit_spent_micros >= 0),
  written_off_micros bigint NOT NULL DEFAULT 0 CHECK (written_off_micros >= 0),
  runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day_key)
);
CREATE INDEX idx_ai_spend_day ON ai_spend_daily(day_key);

-- ── Admin data (11 §5.9) ───────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE user_limit_overrides(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  limit_key text NOT NULL CHECK (limit_key IN ('ai_daily_budget')),
  value json NOT NULL CHECK (json_typeof(value) = 'null' OR (json_typeof(value) = 'number' AND value::text ~ '^[0-9]+$')),
  set_by text REFERENCES users(id) ON DELETE SET NULL,
  note text CHECK (char_length(note) <= 500),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, limit_key)
);

CREATE TABLE account_entitlement_events(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('account_type','paid_until','ai_daily_budget')),
  old_value json,
  new_value json,
  source text NOT NULL CHECK (source IN ('admin','payment','system')),
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  payment_ref text CHECK (char_length(payment_ref) BETWEEN 1 AND 200),
  note text CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL
);
CREATE INDEX idx_entitlement_events_user ON account_entitlement_events(user_id, id DESC);

CREATE TABLE ai_credit_ledger(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('grant','purchase','spend','adjustment')),
  amount_micros bigint NOT NULL CHECK (amount_micros <> 0),
  balance_after_micros bigint NOT NULL CHECK (balance_after_micros >= 0),
  day_key date,
  source text NOT NULL CHECK (source IN ('admin','payment','system')),
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  payment_ref text CHECK (char_length(payment_ref) BETWEEN 1 AND 200),   -- one row per purchase (idx_credit_payment)
  task_id text,
  note text CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL,
  CHECK ((kind IN ('grant','purchase') AND amount_micros > 0) OR (kind = 'spend' AND amount_micros < 0)
    OR kind = 'adjustment'),
  CHECK (kind <> 'purchase' OR payment_ref IS NOT NULL)
);
CREATE UNIQUE INDEX idx_credit_payment ON ai_credit_ledger(payment_ref) WHERE payment_ref IS NOT NULL;
CREATE INDEX idx_credit_user ON ai_credit_ledger(user_id, id DESC);

CREATE TABLE announcements(
  id text PRIMARY KEY,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  expires_at timestamptz,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX idx_announcements_expiry ON announcements(expires_at, created_at);

CREATE TABLE announcement_dismissals(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  announcement_id text NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, announcement_id)
);
CREATE INDEX idx_dismissals_announcement ON announcement_dismissals(announcement_id);

-- Admin overrides of the central constants (`const:<KEY>`) and other app-wide values.
CREATE TABLE app_settings(
  key text PRIMARY KEY,
  value json NOT NULL,
  updated_at timestamptz,
  updated_by text REFERENCES users(id) ON DELETE SET NULL
);

-- ── Applications and what each one used (11 §5.8) ──────────────────────────────────────────────────────────────────

CREATE TABLE applications(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- the order rows were made (resume-match's oldest due account)
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint REFERENCES jobs(id) ON DELETE SET NULL,
  company_id bigint REFERENCES companies(id),
  title text NOT NULL,
  company_name text NOT NULL,
  location text NOT NULL DEFAULT '',
  employment_type text NOT NULL CHECK (employment_type IN ('internship','full_time','part_time','contract')),
  posting_url text NOT NULL DEFAULT '',
  description_html text DEFAULT '',         -- NULL: the job's own text (job_texts), DB-JOBS's D1c
  salary_min numeric,
  salary_max numeric,
  salary_currency text,
  salary_period text CHECK (salary_period IN ('year','month','week','day','hour')),
  current_status integer NOT NULL DEFAULT 1,   -- max(application_status_events.status), kept in the same transaction
  favorite boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter_id text,                     -- REFERENCES cover_letters(id) ON DELETE SET NULL (added below)
  notes_html text NOT NULL DEFAULT '',
  tracked_on date NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resume_origin text CHECK (resume_origin IN ('auto','user')),
  resume_matched_at timestamptz,
  resume_match_due boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_app_saved ON applications(user_id, tracked_on DESC, id DESC)
  WHERE current_status = 1 AND archived_at IS NULL;
CREATE INDEX idx_app_board ON applications(user_id, current_status, tracked_on DESC) WHERE archived_at IS NULL;
CREATE INDEX idx_app_archived ON applications(user_id, archived_at DESC) WHERE archived_at IS NOT NULL;
CREATE UNIQUE INDEX idx_app_user_job ON applications(user_id, job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_app_saved_job ON applications(job_id, user_id) WHERE current_status = 1 AND archived_at IS NULL;
CREATE INDEX idx_app_resume ON applications(resume_id) WHERE resume_id IS NOT NULL;
CREATE INDEX idx_app_match_due ON applications(user_id) WHERE resume_match_due;

CREATE TABLE cover_letters(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('blank','generated','uploaded')),
  content_html text NOT NULL DEFAULT '',
  content_text text NOT NULL DEFAULT '',
  font_family text NOT NULL DEFAULT 'Times New Roman',
  application_id text REFERENCES applications(id) ON DELETE SET NULL,
  job_id bigint REFERENCES jobs(id) ON DELETE SET NULL,
  company_name text NOT NULL DEFAULT '',
  job_title text NOT NULL DEFAULT '',
  job_description text DEFAULT '',          -- NULL: the job's own text (DB-JOBS's D1c)
  template_id text REFERENCES cover_letter_templates(id) ON DELETE SET NULL,
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  custom_prompt text NOT NULL DEFAULT '',
  file_id text REFERENCES stored_files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_edited_at timestamptz,
  document_revision integer NOT NULL DEFAULT 0   -- bumped by a content change only (11 §5.8; DB-JOBS)
);
CREATE INDEX idx_letters_user ON cover_letters(user_id, updated_at DESC);

ALTER TABLE applications ADD CONSTRAINT applications_cover_letter_fk
  FOREIGN KEY (cover_letter_id) REFERENCES cover_letters(id) ON DELETE SET NULL;

CREATE TABLE application_status_events(
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status integer NOT NULL CHECK (status IN (1,2,11,12,13,21,22,23,24)),
  occurred_on date NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (application_id, status)
);

CREATE TABLE application_questions(
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  position integer NOT NULL,
  question text NOT NULL,
  answer text NOT NULL DEFAULT '',
  created_at timestamptz,
  updated_at timestamptz
);
CREATE INDEX idx_app_questions ON application_questions(application_id, position);

CREATE TABLE application_form_answers(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  question_id bigint NOT NULL REFERENCES job_form_questions(id) ON DELETE CASCADE,
  answer json CHECK (answer IS NULL OR coalesce(answer->>'kind', '') IN ('text','options','checked','file')),
  category text CHECK (category ~ '^[a-z0-9_]{1,60}$'),
  provenance text CHECK (provenance ~ '^[a-z-]{1,40}$'),
  submitted_at timestamptz NOT NULL,
  UNIQUE (application_id, question_id)
);
CREATE INDEX idx_form_answers_question ON application_form_answers(question_id);
CREATE INDEX idx_form_answers_user ON application_form_answers(user_id, submitted_at DESC);

CREATE TABLE prepare_jobs(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  job_id bigint REFERENCES jobs(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('server','mcp')),
  letter_mode text NOT NULL CHECK (letter_mode IN ('required','always')),
  letter_wanted boolean,                    -- decided once the questions and the analysis are read; NULL not yet
  rebuild boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('waiting','filtering','analyzing','building','queued','prepared','filtered',
    'failed','cancelled')),
  reason_code text CHECK (char_length(reason_code) BETWEEN 1 AND 40),
  error text CHECK (char_length(error) <= 2000),
  queue_id text,                            -- the queue row it made (no foreign key: history)
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  resume_mode text NOT NULL DEFAULT 'tailor' CHECK (resume_mode IN ('default','similar','tailor')),
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_prepare_jobs_active ON prepare_jobs(application_id)
  WHERE state IN ('waiting','filtering','analyzing','building');
CREATE INDEX idx_prepare_jobs_app ON prepare_jobs(application_id, created_at DESC, seq DESC);
CREATE INDEX idx_prepare_jobs_resume ON prepare_jobs(resume_id) WHERE resume_id IS NOT NULL;
CREATE INDEX idx_prepare_jobs_runner ON prepare_jobs(mode, state, created_at, seq)
  WHERE state IN ('waiting','filtering','analyzing','building');
CREATE INDEX idx_prepare_jobs_user ON prepare_jobs(user_id, created_at DESC);

CREATE TABLE prepare_filter_results(
  application_id text PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint REFERENCES jobs(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('pass','fail')),
  reasons json NOT NULL DEFAULT '[]' CHECK (json_typeof(reasons) = 'array'),
  filters_revision integer NOT NULL CHECK (filters_revision >= 0),
  facts_version integer NOT NULL CHECK (facts_version >= 0),
  checked_at timestamptz NOT NULL
);
CREATE INDEX idx_filter_results_user ON prepare_filter_results(user_id, verdict);

CREATE TABLE custom_filter_verdicts(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  prompt_hash text NOT NULL CHECK (char_length(prompt_hash) = 16),
  content_hash text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('pass','fail')),
  reason text CHECK (char_length(reason) <= 120),
  decided_by text NOT NULL CHECK (decided_by IN ('server','mcp')),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, job_id, prompt_hash)
);
CREATE INDEX idx_custom_verdicts_age ON custom_filter_verdicts(decided_at);

CREATE TABLE application_drafts(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  resume_status text NOT NULL DEFAULT 'pending'
    CHECK (resume_status IN ('pending','building','ready','not_ready','failed','skipped','off')),
  letter_status text NOT NULL DEFAULT 'pending'
    CHECK (letter_status IN ('pending','building','ready','not_ready','failed','skipped','off')),
  answers_status text NOT NULL DEFAULT 'pending'
    CHECK (answers_status IN ('pending','building','ready','not_ready','failed','skipped','off')),
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter_id text REFERENCES cover_letters(id) ON DELETE SET NULL,
  built_by text NOT NULL CHECK (built_by IN ('server','mcp')),
  prepare_id text REFERENCES prepare_jobs(id) ON DELETE SET NULL,   -- the Prepare that last worked on this kit
  questions_seen integer NOT NULL DEFAULT 0 CHECK (questions_seen >= 0),
  error text CHECK (char_length(error) <= 2000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  built_at timestamptz
);
CREATE INDEX idx_application_drafts_user ON application_drafts(user_id, updated_at DESC);

CREATE TABLE application_draft_answers(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  draft_id text NOT NULL REFERENCES application_drafts(id) ON DELETE CASCADE,
  question_id bigint NOT NULL REFERENCES job_form_questions(id) ON DELETE CASCADE,
  answer json CHECK (answer IS NULL OR coalesce(answer->>'kind', '') IN ('text','options','checked')),
  status text NOT NULL CHECK (status IN ('ready','not_ready')),
  provenance text NOT NULL CHECK (provenance IN ('server-ai','mcp')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (draft_id, question_id),
  CHECK ((status = 'ready') = (answer IS NOT NULL))
);
CREATE INDEX idx_draft_answers_question ON application_draft_answers(question_id);

-- A used document frozen the moment it would change or go (11 §5.8): content-addressed per person.
CREATE TABLE application_document_snapshots(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('resume','letter')),
  source_id text,
  source_revision integer,
  title text NOT NULL DEFAULT '',
  body json NOT NULL,
  file_id text REFERENCES stored_files(id) ON DELETE RESTRICT,
  content_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, content_hash)
);

CREATE TABLE application_apply_records(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  job_id bigint REFERENCES jobs(id) ON DELETE SET NULL,
  via text NOT NULL CHECK (via IN ('agent','tab','manual','page','tracker','legacy')),
  queue_id text,
  prepare_id text REFERENCES prepare_jobs(id) ON DELETE SET NULL,
  draft_id text REFERENCES application_drafts(id) ON DELETE SET NULL,
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter_id text REFERENCES cover_letters(id) ON DELETE SET NULL,
  answers text NOT NULL CHECK (answers IN ('submitted','prepared','none')),
  day_key date NOT NULL,
  applied_at timestamptz NOT NULL,
  -- What makes the record exact (11 §5.8; DB-JOBS writes them at apply time):
  resume_revision integer,
  letter_revision integer,
  resume_snapshot_id bigint REFERENCES application_document_snapshots(id),
  letter_snapshot_id bigint REFERENCES application_document_snapshots(id),
  answers_used jsonb,
  posting_hash text                         -- jobs.content_hash when applied (hex, as jobs keeps it)
);
CREATE INDEX idx_apply_records_app ON application_apply_records(application_id, id DESC);
CREATE INDEX idx_apply_records_user ON application_apply_records(user_id, applied_at DESC);
CREATE INDEX idx_apply_records_resume ON application_apply_records(resume_id) WHERE resume_id IS NOT NULL;
CREATE INDEX idx_apply_records_letter ON application_apply_records(cover_letter_id) WHERE cover_letter_id IS NOT NULL;

-- ── The extension (autofill) ───────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE extension_tokens(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- the connections list's newest-first tie-break
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  scopes json NOT NULL,
  client json NOT NULL DEFAULT '{}',
  user_agent text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('user','extension','account_disabled'))
);
CREATE INDEX idx_extension_tokens_user ON extension_tokens(user_id, revoked_at, expires_at);

CREATE TABLE extension_connect_codes(
  code_hash text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes json NOT NULL,                     -- chosen when minted; redeem grants these
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  token_id text REFERENCES extension_tokens(id) ON DELETE SET NULL
);
CREATE INDEX idx_extension_codes_user ON extension_connect_codes(user_id, expires_at);
CREATE INDEX idx_extension_codes_order ON extension_connect_codes(user_id, created_at DESC, seq DESC);

CREATE TABLE autofill_agent_queue(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- the list's tie-break and the Queue tab's page cursor
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  application_id text REFERENCES applications(id) ON DELETE SET NULL,
  prepare_id text REFERENCES prepare_jobs(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','submitted','skipped','needs-you','failed')),
  reason text CHECK (reason IN ('required_field_empty','posting_forbids_ai','ai_guess_legal','captcha',
    'sign_in','sign_in_failed','email_code','validation_error','unsupported_site','posting_closed','page_error',
    'timed_out','already_applied','cancelled','other')),
  source text NOT NULL CHECK (source IN ('manual','rule','prepare')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ai_guesses integer CHECK (ai_guesses >= 0),
  claimed_by text REFERENCES extension_tokens(id) ON DELETE SET NULL,
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  run text CHECK (run IN ('agent','tab','manual')),
  submit_pressed boolean,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, job_id),
  CHECK (run IS DISTINCT FROM 'manual' OR claimed_by IS NULL)   -- a manual row never holds a browser
);
CREATE INDEX idx_autofill_agent_queue_app ON autofill_agent_queue(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX idx_autofill_agent_queue_next ON autofill_agent_queue(user_id, state, created_at, seq);
CREATE INDEX idx_autofill_agent_queue_running ON autofill_agent_queue(state, started_at);

CREATE TABLE autofill_agent_dismissed(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE autofill_agent_tombstones(
  queue_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  removed_at timestamptz NOT NULL
);
CREATE INDEX idx_autofill_agent_tombstones_removed ON autofill_agent_tombstones(removed_at);

CREATE TABLE autofill_agent_settings(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rule_enabled boolean NOT NULL DEFAULT false,
  min_match integer NOT NULL CHECK (min_match BETWEEN 0 AND 100),
  rule_enabled_at timestamptz,
  rule_cursor_at timestamptz,
  rule_cursor_job bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

CREATE TABLE autofill_profiles(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_version integer NOT NULL,
  profile jsonb NOT NULL,                   -- jsonb: the letter mode is set in place (dialect.jsonSetText)
  sensitive json NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE autofill_saved_answers(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key text NOT NULL CHECK (char_length(question_key) BETWEEN 1 AND 300),
  option_set_hash text NOT NULL DEFAULT '' CHECK (option_set_hash ~ '^([0-9a-f]{16})?$'),
  scope text NOT NULL DEFAULT '' CHECK (scope = '' OR scope ~ ('^(greenhouse|lever|ashby|workday|workable|icims|'
    || 'taleo|successfactors|oracle|jobvite|jazzhr|bamboohr|rippling|breezy|careerplug|pinpoint|paycor|hibob|ultipro|'
    || 'dayforce|paylocity|dice|clearcompany|adp|smartrecruiters|ukgready|paycom|jobdiva|eightfold):.')),
  field_kind text NOT NULL CHECK (field_kind IN ('text','textarea','select','radio','checkbox','checkbox-group',
    'combobox','multiselect','typeahead-remote','date')),
  question_label text NOT NULL,
  platform text REFERENCES platforms(key),
  answer json NOT NULL CHECK (coalesce(answer->>'kind', '') IN ('text','options','checked')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, question_key, option_set_hash, scope)
);
CREATE INDEX idx_autofill_answers_user ON autofill_saved_answers(user_id, updated_at DESC);

CREATE TABLE autofill_credentials(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host text NOT NULL CHECK (host = '*' OR host ~ '^[a-z0-9.-]{1,253}$'),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) >= 1),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  last_read_host text,
  last_read_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, host)
);

CREATE TABLE autofill_site_requests(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host text NOT NULL CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  first_requested_at timestamptz NOT NULL,
  last_requested_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, host)
);
CREATE INDEX idx_autofill_site_requests_recent ON autofill_site_requests(user_id, last_requested_at DESC);

CREATE TABLE auto_apply_reservations(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  queue_id text NOT NULL,
  job_id bigint REFERENCES jobs(id) ON DELETE SET NULL,
  day_key date NOT NULL,
  run text NOT NULL CHECK (run IN ('agent','tab')),
  token_id text REFERENCES extension_tokens(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('reserved','used','released')),
  settle_reason text CHECK (char_length(settle_reason) <= 40),   -- a result state or reason code, 'removed', ...
  created_at timestamptz NOT NULL,
  settled_at timestamptz
);
CREATE INDEX idx_reservations_count ON auto_apply_reservations(user_id, day_key, state);
CREATE UNIQUE INDEX idx_reservations_live ON auto_apply_reservations(queue_id) WHERE state = 'reserved';
CREATE INDEX idx_reservations_queue ON auto_apply_reservations(queue_id, created_at DESC, seq DESC);

-- ── MCP ────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE mcp_tokens(
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  scopes json NOT NULL DEFAULT '["prebuild"]' CHECK (json_typeof(scopes) = 'array'),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX idx_mcp_tokens_user ON mcp_tokens(user_id, created_at);

CREATE TABLE mcp_prepare_work(
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  canary text NOT NULL CHECK (char_length(canary) BETWEEN 8 AND 64),
  posting_hash text,
  analysis_raw json,
  draft json,
  saves integer NOT NULL DEFAULT 0 CHECK (saves >= 0),
  resume_id text REFERENCES resumes(id) ON DELETE SET NULL,
  resume_revision integer,
  cover_letter_id text REFERENCES cover_letters(id) ON DELETE SET NULL,
  letter_updated_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE mcp_settings(
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revise_rounds integer NOT NULL DEFAULT 2 CHECK (revise_rounds BETWEEN 0 AND 5),
  prompt_mode text NOT NULL DEFAULT 'tailorit' CHECK (prompt_mode IN ('tailorit','own-prompt')),
  updated_at timestamptz NOT NULL,
  custom_instructions text NOT NULL DEFAULT '' CHECK (char_length(custom_instructions) <= 4000)
);

-- A 24-hour cache rewritten all day: UNLOGGED skips the WAL; empty after a crash (an AI client searches again).
CREATE UNLOGGED TABLE mcp_result_sets(
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 8 AND 40),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('search','applications','queue','filter')),
  query json NOT NULL,
  ids json NOT NULL CHECK (json_typeof(ids) = 'array'),
  total integer NOT NULL CHECK (total >= 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_mcp_result_sets_expires ON mcp_result_sets(expires_at);
CREATE INDEX idx_mcp_result_sets_user ON mcp_result_sets(user_id, created_at, seq);

CREATE TABLE mcp_unsupported_reports(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id text REFERENCES mcp_tokens(id) ON DELETE SET NULL,
  request text NOT NULL CHECK (char_length(request) BETWEEN 1 AND 500),
  missing text NOT NULL CHECK (char_length(missing) BETWEEN 1 AND 300),
  tried_tools json NOT NULL DEFAULT '[]' CHECK (json_typeof(tried_tools) = 'array'),
  created_at timestamptz NOT NULL
);
CREATE INDEX idx_mcp_unsupported_token ON mcp_unsupported_reports(token_id, created_at);
CREATE INDEX idx_mcp_unsupported_user ON mcp_unsupported_reports(user_id, created_at, seq);

-- ── The AI queue and metering ──────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE ai_tasks(
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- the queue's tie-break (it ordered by rowid)
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL REFERENCES ai_task_kinds(kind),
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  priority integer NOT NULL DEFAULT 0,
  input json NOT NULL,                      -- legacy: D5L drops it (ai_task_payloads.input)
  result json,                              -- legacy: D5L drops it (ai_task_payloads.result)
  error_code text,
  error_message text,
  model text,
  attempts integer NOT NULL DEFAULT 0,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cache_read_tokens bigint CHECK (cache_read_tokens >= 0),
  cache_write_tokens bigint CHECK (cache_write_tokens >= 0),
  cost_usd double precision CHECK (cost_usd >= 0),
  charge_user_id text REFERENCES users(id) ON DELETE SET NULL,   -- whose budget its prompt runs are charged to
  charged_micros bigint NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
  dedupe_key text,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX idx_ai_charge ON ai_tasks(charge_user_id, created_at) WHERE charge_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ai_dedupe ON ai_tasks(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX idx_ai_kind_created ON ai_tasks(kind, created_at);
CREATE INDEX idx_ai_queue ON ai_tasks(status, priority DESC, created_at, seq);
CREATE INDEX idx_ai_user ON ai_tasks(user_id, kind, status);

-- The AI queue's large inputs and results, by the task's day (11 §5.7): D5L moves them here and drops the partitions
-- after AI_TASK_PAYLOAD_KEEP_DAYS.
CREATE TABLE ai_task_payloads(
  task_id text NOT NULL,                    -- ai_tasks.id (no foreign key: partitions are dropped on their own)
  created_on date NOT NULL,                 -- the task's created_at day (UTC)
  input json NOT NULL,
  result json,
  PRIMARY KEY (task_id, created_on)
) PARTITION BY RANGE (created_on);

CREATE TABLE ai_usage_hourly(
  hour text NOT NULL CHECK (hour ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}$'),   -- the UTC hour, 'YYYY-MM-DDTHH'
  kind text NOT NULL,
  model text NOT NULL,
  runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  reported integer NOT NULL DEFAULT 0 CHECK (reported >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  cached_items integer NOT NULL DEFAULT 0 CHECK (cached_items >= 0),
  PRIMARY KEY (hour, kind, model)
);

CREATE TABLE ai_result_cache(
  kind text NOT NULL,
  model text NOT NULL,
  prompt_version integer NOT NULL,
  scope text NOT NULL,
  item_hash text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  result json NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (scope = coalesce(user_id, '')),
  PRIMARY KEY (kind, model, prompt_version, scope, item_hash)
);
CREATE INDEX idx_result_cache_expiry ON ai_result_cache(expires_at);
CREATE INDEX idx_result_cache_user ON ai_result_cache(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE ai_capacity_readings(
  window_type text PRIMARY KEY CHECK (char_length(window_type) BETWEEN 1 AND 40),
  utilization double precision NOT NULL CHECK (utilization >= 0 AND utilization <= 1),
  status text NOT NULL DEFAULT '' CHECK (char_length(status) <= 40),
  source text NOT NULL CHECK (source IN ('event','text','ledger')),
  resets_at timestamptz,
  seen_at timestamptz NOT NULL
);

-- ── Partitions for the current and next periods (D5L's housekeeping keeps two ahead) ───────────────────────────────

DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series((now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 1, interval '1 day')::date LOOP
    EXECUTE format('CREATE TABLE %I PARTITION OF job_postings_raw FOR VALUES FROM (%L) TO (%L)',
      'job_postings_raw_' || to_char(d, 'YYYYMMDD'), (d::timestamp AT TIME ZONE 'UTC'), ((d + 1)::timestamp AT TIME ZONE 'UTC'));
    EXECUTE format('CREATE TABLE %I PARTITION OF ai_task_payloads FOR VALUES FROM (%L) TO (%L)',
      'ai_task_payloads_' || to_char(d, 'YYYYMMDD'), d, d + 1);
  END LOOP;
END $$;

-- ── Triggers ───────────────────────────────────────────────────────────────────────────────────────────────────────

-- Resume matching is due again (v2.0's 0301 triggers): a saved job's analysis or text changed, the person's resumes'
-- analyses changed, or their default resume did. Only entries the matcher chose (or never chose) are touched.
CREATE FUNCTION mark_match_due_for_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source NOT IN ('ai', 'ft_lake') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.keywords::text IS NOT DISTINCT FROM OLD.keywords::text
     AND NEW.version IS NOT DISTINCT FROM OLD.version THEN RETURN NULL; END IF;
  UPDATE applications SET resume_match_due = true
  WHERE job_id IN (SELECT id FROM jobs WHERE content_hash = NEW.content_hash)
    AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;
CREATE TRIGGER trg_job_analyses_due AFTER INSERT OR UPDATE ON job_analyses
  FOR EACH ROW EXECUTE FUNCTION mark_match_due_for_hash();

CREATE FUNCTION mark_match_due_for_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE applications SET resume_match_due = true
  WHERE job_id = NEW.id
    AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;
CREATE TRIGGER trg_jobs_text_due AFTER UPDATE OF content_hash ON jobs
  FOR EACH ROW WHEN (NEW.content_hash IS DISTINCT FROM OLD.content_hash) EXECUTE FUNCTION mark_match_due_for_job();

CREATE FUNCTION mark_match_due_for_resume_analysis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
     AND NEW.version IS NOT DISTINCT FROM OLD.version THEN RETURN NULL; END IF;
  UPDATE applications SET resume_match_due = true
  WHERE user_id = (SELECT user_id FROM resumes WHERE id = NEW.resume_id)
    AND job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;
CREATE TRIGGER trg_resume_analyses_due AFTER INSERT OR UPDATE OF content_hash, version ON resume_analyses
  FOR EACH ROW EXECUTE FUNCTION mark_match_due_for_resume_analysis();

CREATE FUNCTION mark_match_due_for_default_resume() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE applications SET resume_match_due = true
  WHERE user_id = NEW.id
    AND job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL
    AND NOT resume_match_due AND (resume_origin IS NULL OR resume_origin = 'auto');
  RETURN NULL;
END $$;
CREATE TRIGGER trg_users_default_resume_due AFTER UPDATE OF default_resume_id ON users
  FOR EACH ROW WHEN (NEW.default_resume_id IS DISTINCT FROM OLD.default_resume_id)
  EXECUTE FUNCTION mark_match_due_for_default_resume();

-- A deleted resume releases the entries it was matched to (v2.0's trg_resumes_release_matches).
CREATE FUNCTION release_resume_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE applications
  SET resume_origin = NULL,
      resume_matched_at = NULL,
      resume_match_due = (job_id IS NOT NULL AND current_status = 1 AND archived_at IS NULL)
  WHERE resume_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_resumes_release_matches BEFORE DELETE ON resumes
  FOR EACH ROW EXECUTE FUNCTION release_resume_matches();

-- made_by follows kind (v2.0's 0815): an uploaded resume is made by upload, and only an uploaded one.
CREATE FUNCTION check_resume_made_by() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'built' AND NEW.made_by = 'upload' THEN
      RAISE EXCEPTION 'resumes.made_by: only an uploaded resume is made by upload';
    END IF;
    IF NEW.kind = 'uploaded' THEN NEW.made_by := 'upload'; END IF;
  ELSIF (NEW.kind = 'uploaded') <> (NEW.made_by = 'upload') THEN
    RAISE EXCEPTION 'resumes.made_by: an uploaded resume is made by upload, and only an uploaded one';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_resumes_made_by BEFORE INSERT OR UPDATE OF kind, made_by ON resumes
  FOR EACH ROW EXECUTE FUNCTION check_resume_made_by();

-- The stored resume counts (user_counters, 11 §5.7): one more on insert, one less on delete, moved on a change of
-- made_by. A delete only decrements (an account being deleted takes its row with it).
CREATE FUNCTION count_resumes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE user_counters SET
      resumes_upload = greatest(resumes_upload - (OLD.made_by = 'upload')::int, 0),
      resumes_editor = greatest(resumes_editor - (OLD.made_by = 'editor')::int, 0),
      resumes_copy   = greatest(resumes_copy   - (OLD.made_by = 'copy')::int, 0),
      resumes_tailor = greatest(resumes_tailor - (OLD.made_by = 'tailor')::int, 0),
      updated_at = now()
    WHERE user_id = OLD.user_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO user_counters AS c(user_id, resumes_upload, resumes_editor, resumes_copy, resumes_tailor)
    VALUES (NEW.user_id, (NEW.made_by = 'upload')::int, (NEW.made_by = 'editor')::int, (NEW.made_by = 'copy')::int,
      (NEW.made_by = 'tailor')::int)
    ON CONFLICT (user_id) DO UPDATE SET
      resumes_upload = c.resumes_upload + excluded.resumes_upload,
      resumes_editor = c.resumes_editor + excluded.resumes_editor,
      resumes_copy   = c.resumes_copy + excluded.resumes_copy,
      resumes_tailor = c.resumes_tailor + excluded.resumes_tailor,
      updated_at = now();
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_resumes_count_insert AFTER INSERT ON resumes FOR EACH ROW EXECUTE FUNCTION count_resumes();
CREATE TRIGGER trg_resumes_count_delete AFTER DELETE ON resumes FOR EACH ROW EXECUTE FUNCTION count_resumes();
CREATE TRIGGER trg_resumes_count_update AFTER UPDATE OF made_by ON resumes
  FOR EACH ROW WHEN (NEW.made_by IS DISTINCT FROM OLD.made_by) EXECUTE FUNCTION count_resumes();

-- The copy-on-write rule (11 §5.8): a resume or letter an apply record names at its revision is frozen into a
-- snapshot before it changes or goes. Skipped while the account itself is being deleted (its records go with it).
CREATE FUNCTION snapshot_used_resume() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snap bigint;
  doc json;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document_revision = OLD.document_revision THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM application_apply_records r WHERE r.resume_id = OLD.id
               AND r.resume_revision = OLD.document_revision AND r.resume_snapshot_id IS NULL)
     AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    doc := CASE WHEN OLD.kind = 'uploaded'
      THEN json_build_object('fileId', OLD.file_id, 'extractedText', OLD.extracted_text, 'name', coalesce(OLD.title, ''))
      ELSE coalesce(OLD.data, 'null'::json) END;
    INSERT INTO application_document_snapshots(user_id, kind, source_id, source_revision, title, body, file_id,
      content_hash)
    VALUES (OLD.user_id, 'resume', OLD.id, OLD.document_revision, coalesce(OLD.title, ''), doc, OLD.file_id,
      sha256(convert_to(doc::text, 'UTF8')))
    ON CONFLICT (user_id, kind, content_hash) DO UPDATE SET created_at = application_document_snapshots.created_at
    RETURNING id INTO snap;
    UPDATE application_apply_records SET resume_snapshot_id = snap
    WHERE resume_id = OLD.id AND resume_revision = OLD.document_revision AND resume_snapshot_id IS NULL;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_resumes_snapshot BEFORE UPDATE OF data, document_revision OR DELETE ON resumes
  FOR EACH ROW EXECUTE FUNCTION snapshot_used_resume();

CREATE FUNCTION snapshot_used_letter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snap bigint;
  doc json;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document_revision = OLD.document_revision THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM application_apply_records r WHERE r.cover_letter_id = OLD.id
               AND r.letter_revision = OLD.document_revision AND r.letter_snapshot_id IS NULL)
     AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    doc := json_build_object('html', OLD.content_html, 'text', OLD.content_text);
    INSERT INTO application_document_snapshots(user_id, kind, source_id, source_revision, title, body, content_hash)
    VALUES (OLD.user_id, 'letter', OLD.id, OLD.document_revision, OLD.title, doc, sha256(convert_to(doc::text, 'UTF8')))
    ON CONFLICT (user_id, kind, content_hash) DO UPDATE SET created_at = application_document_snapshots.created_at
    RETURNING id INTO snap;
    UPDATE application_apply_records SET letter_snapshot_id = snap
    WHERE cover_letter_id = OLD.id AND letter_revision = OLD.document_revision AND letter_snapshot_id IS NULL;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_letters_snapshot BEFORE UPDATE OF content_html, content_text, document_revision OR DELETE
  ON cover_letters FOR EACH ROW EXECUTE FUNCTION snapshot_used_letter();
