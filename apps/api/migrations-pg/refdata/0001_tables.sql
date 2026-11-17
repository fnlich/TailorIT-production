-- v3.0 E1: the `refdata` schema's tables (docs/design/part2/13-company-enrichment.md §10; 11-database.md §5.4). The
-- monthly build (features/companies/refdata/build.ts) runs this folder's files, in order, into a fresh schema
-- `refdata_next` (its search_path), loads the dumps, runs the index files, then swaps the schema in for `refdata`.
-- The migration runner never reads this folder (it reads migrations-pg/NNNN_name.sql only): these tables are rebuilt
-- whole each month and never altered in place. A change here changes the files' fingerprint; a reader then uses the
-- schema only once a build of the new files has swapped in (refdata/format.ts).
--
-- Reference data only, from open sources: Wikidata (CC0), SEC EDGAR (US government, public) and GLEIF (CC0). No person,
-- no TailorIT row. Values are kept as the source gives them (QIDs, codes); the matcher maps them to a company's fields.

-- The build's own facts: its id, when it was built, the files' fingerprint, the dumps it read.
CREATE TABLE meta(
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

-- Wikidata items that are organisations with a website, an exchange, a LinkedIn ID, an LEI or a CIK (13 §3.2).
CREATE TABLE wd_orgs(
  qid text PRIMARY KEY,                         -- 'Q95'
  label text,                                   -- the English label
  description text,                             -- the English description (a tagline candidate)
  official_name text,                           -- P1448
  name_keys text[] NOT NULL DEFAULT '{}',       -- normalizeCompanyName of the label, the aliases and the official name
  website text,                                 -- P856, the first current value
  domain text,                                  -- its registrable domain, when it can be a company's (features/companies/domain.ts)
  linkedin_id text,                             -- P4264
  cik text,                                     -- P5531, ten digits
  lei text,                                     -- P1278
  industry_qids text[] NOT NULL DEFAULT '{}',   -- P452
  employees bigint,                             -- P1128, the newest value
  employees_as_of date,                         -- its P585
  inception_year smallint,                      -- P571's year
  hq_qid text,                                  -- P159, the current value
  country_qid text,                             -- P17
  exchanges jsonb NOT NULL DEFAULT '[]',        -- P414: [{qid, ticker}] (the ticker is the statement's P249)
  parent_qid text,                              -- P749
  owner_qid text,                               -- P127
  type_qids text[] NOT NULL DEFAULT '{}'        -- P31
);

-- The items wd_orgs points at (places, industries, exchanges, types): their label and, for a place, where it lies.
CREATE TABLE wd_items(
  qid text PRIMARY KEY,
  label text,
  parent_qid text,                              -- P131 (the administrative unit it lies in)
  country_qid text,                             -- P17
  iso_country text,                             -- P297 (a country's two letters)
  iso_region text                               -- P300 (a first-level subdivision: 'US-CA')
);

-- SEC EDGAR's filers (submissions): operating companies and filers with a ticker.
CREATE TABLE sec_filers(
  cik text PRIMARY KEY,                         -- ten digits
  name text NOT NULL,
  name_key text NOT NULL,
  tickers text[] NOT NULL DEFAULT '{}',
  exchanges text[] NOT NULL DEFAULT '{}',
  sic text,
  sic_description text,
  city text,                                    -- the business address
  region text,
  country text,
  entity_type text,
  former_names text[] NOT NULL DEFAULT '{}'
);

-- GLEIF's legal entities (the Golden Copy's LEI records), active ones only.
CREATE TABLE gleif_entities(
  lei text PRIMARY KEY,
  legal_name text NOT NULL,
  name_key text NOT NULL,
  other_names text[] NOT NULL DEFAULT '{}',
  hq_city text,                                 -- the headquarters address (never the legal address: 13 §6.1)
  hq_region text,                               -- ISO 3166-2 as GLEIF gives it ('US-CA')
  hq_country text,                              -- ISO 3166-1 alpha-2
  status text,
  created_on date                               -- the entity's creation date (an incorporation, never "founded")
);

-- GLEIF's relationship records: who consolidates whom (13 §5.4).
CREATE TABLE gleif_relations(
  child_lei text NOT NULL,
  parent_lei text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('direct', 'ultimate')),
  PRIMARY KEY (child_lei, kind, parent_lei)
);
