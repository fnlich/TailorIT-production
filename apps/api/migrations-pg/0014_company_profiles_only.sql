-- v3.0 E0-API (docs/design/part2/13-company-enrichment.md §10-§11 phase 0, 11-database.md §5.4): companies keep only
-- their identity; everything shown about a company is company_profiles', each value with its source
-- (company_sources) and every key that finds a company in company_aliases (features/companies/).
--
-- 1. The v2.0 enrichment columns of companies are copied into company_profiles once, as a `legacy` source row each
--    (an install that starts empty copies nothing: P5; the dry run's seeded rows are what it moves), then dropped.
--    Every reader moved to company_profiles first (features/companies/detail.ts and the other packages' one-line
--    reads, SP\p2\build\E0-API.md). The free-text stage maps to a COMPANY_STAGES id (CT edit E); funding (free text,
--    from no licensed source: 13 §3.4) and a remote logo address (hot-linked: 13 §1 problem 3) are not kept.
-- 2. name_key is no longer unique (13 §5.1: homonyms share a name key; strong keys find a company): a plain index for
--    the name lookups. An account's own company rows ('page:<owner>:<key>', features/companies/resolve.ts) stay unique
--    by their key, so two page jobs of one account at once still make one own row (ON CONFLICT on the partial index).

-- ── 1. Copy, then drop ─────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO company_sources(company_id, kind, ref, licence, match_confidence, fields, status, retrieved_at)
SELECT c.id, 'legacy', '', 'legacy', 100, '{}'::jsonb, 'ok', c.updated_at
FROM companies c
WHERE c.owner_user_id IS NULL
  AND (c.website IS NOT NULL OR c.logo_path IS NOT NULL OR c.tagline IS NOT NULL OR c.about IS NOT NULL
       OR c.size_bucket IS NOT NULL OR c.stage IS NOT NULL OR c.headquarters IS NOT NULL OR c.founded_year IS NOT NULL
       OR c.industry IS NOT NULL OR c.sponsors_h1b IS NOT NULL OR CAST(c.links AS text) <> '[]')
ON CONFLICT (company_id, kind, ref) DO NOTHING;

WITH legacy AS (
  SELECT c.id,
    NULLIF(btrim(c.name), '') AS display_name,
    CASE WHEN c.website ~* '^https?://\S+$' THEN regexp_replace(btrim(c.website), '^http://', 'https://', 'i') END AS website,
    CASE WHEN c.logo_path ~ '^/[^/\\]' THEN btrim(c.logo_path) END AS logo_path,
    NULLIF(left(btrim(c.tagline), 90), '') AS tagline,
    NULLIF(left(btrim(c.about), 600), '') AS summary,
    CASE WHEN c.size_bucket IN ('1-10','11-50','51-200','201-500','501-1000','1001-5000','5001-10000','10001+')
      THEN c.size_bucket END AS size_bucket,
    NULLIF(btrim(c.industry), '') AS industry,
    CASE
      WHEN c.stage ~* '^\s*(public|listed|ipo)\s*$' THEN 'public'
      WHEN c.stage ~* '^\s*(private|privately held|bootstrapped|self-funded|mutual)\s*$' THEN 'private'
      WHEN c.stage ~* '^\s*subsidiary\s*$' THEN 'subsidiary'
      WHEN c.stage ~* '^\s*non-?profit\s*$' THEN 'nonprofit'
      WHEN c.stage ~* '^\s*government\s*$' THEN 'government'
      WHEN c.stage ~* '^\s*education\s*$' THEN 'education'
      WHEN c.stage ~* '^\s*(pre-?seed|seed)\s*$' THEN 'seed'
      WHEN c.stage ~* '^\s*series\s+[ab]\s*$' THEN 'early'
      WHEN c.stage ~* '^\s*series\s+[c-z]\s*$' THEN 'growth'
      WHEN c.stage ~* '^\s*private equity\s*$' THEN 'private_equity'
      WHEN c.stage ~* '^\s*acquired\s*$' THEN 'acquired'
    END AS stage,
    NULLIF(btrim(split_part(c.headquarters, ',', 1)), '') AS hq_city,
    CASE WHEN array_length(string_to_array(c.headquarters, ','), 1) >= 3
      THEN NULLIF(btrim(split_part(c.headquarters, ',', 2)), '') END AS hq_region,
    CASE
      WHEN btrim(reverse(split_part(reverse(c.headquarters), ',', 1))) ~* '^(usa|us|united states)$' THEN 'US'
      WHEN btrim(reverse(split_part(reverse(c.headquarters), ',', 1))) ~ '^[A-Z]{2}$'
        AND array_length(string_to_array(c.headquarters, ','), 1) >= 3
        THEN btrim(reverse(split_part(reverse(c.headquarters), ',', 1)))
    END AS hq_country_code,
    CASE WHEN c.founded_year BETWEEN 1600 AND 2100 THEN c.founded_year END AS founded_year,
    c.sponsors_h1b,
    CASE WHEN json_typeof(c.links) = 'array' THEN CAST(c.links AS jsonb) ELSE '[]'::jsonb END AS other_links,
    c.updated_at
  FROM companies c
)
INSERT INTO company_profiles(company_id, display_name, tagline, summary, summary_origin, website, logo_path, industry,
  size_bucket, stage, hq_city, hq_region, hq_country_code, founded_year, founded_kind, sponsors_h1b, other_links,
  provenance, updated_at)
SELECT l.id, l.display_name, l.tagline, l.summary, CASE WHEN l.summary IS NOT NULL THEN 'source_text' END, l.website,
  l.logo_path, l.industry, l.size_bucket, l.stage, l.hq_city, l.hq_region, l.hq_country_code, l.founded_year,
  CASE WHEN l.founded_year IS NOT NULL THEN 'founded' END, l.sponsors_h1b, l.other_links,
  '{}'::jsonb,
  COALESCE(l.updated_at, now())
FROM legacy l
ON CONFLICT (company_id) DO NOTHING;

-- Each value names its legacy source (provenance: {field: company_sources.id}), so a profile computed again from its
-- sources keeps it (features/companies/profile.ts).
UPDATE company_profiles p SET provenance = (
    SELECT COALESCE(jsonb_object_agg(f.field, s.id), '{}'::jsonb) FROM (VALUES
      ('tagline', p.tagline IS NOT NULL), ('summary', p.summary IS NOT NULL), ('website', p.website IS NOT NULL),
      ('logoUrl', p.logo_path IS NOT NULL), ('industry', p.industry IS NOT NULL), ('sizeBucket', p.size_bucket IS NOT NULL),
      ('stage', p.stage IS NOT NULL), ('hqCity', p.hq_city IS NOT NULL), ('hqRegion', p.hq_region IS NOT NULL),
      ('hqCountryCode', p.hq_country_code IS NOT NULL), ('foundedYear', p.founded_year IS NOT NULL),
      ('foundedKind', p.founded_kind IS NOT NULL), ('sponsorsH1b', p.sponsors_h1b IS NOT NULL),
      ('otherLinks', p.other_links <> '[]'::jsonb)
    ) AS f(field, present) WHERE f.present)
FROM company_sources s
WHERE s.company_id = p.company_id AND s.kind = 'legacy' AND s.ref = '' AND p.provenance = '{}'::jsonb;

-- The legacy source rows keep the values they gave (the editor's candidates).
UPDATE company_sources s SET fields = jsonb_strip_nulls(jsonb_build_object(
    'tagline', p.tagline, 'summary', p.summary, 'website', p.website, 'logoUrl', p.logo_path, 'industry', p.industry,
    'sizeBucket', p.size_bucket, 'stage', p.stage, 'hqCity', p.hq_city, 'hqRegion', p.hq_region,
    'hqCountryCode', p.hq_country_code, 'foundedYear', p.founded_year, 'foundedKind', p.founded_kind,
    'sponsorsH1b', p.sponsors_h1b,
    'otherLinks', CASE WHEN p.other_links <> '[]'::jsonb THEN p.other_links END))
FROM company_profiles p
WHERE s.kind = 'legacy' AND s.ref = '' AND p.company_id = s.company_id AND s.fields = '{}'::jsonb;

ALTER TABLE companies
  DROP COLUMN website,
  DROP COLUMN logo_path,
  DROP COLUMN tagline,
  DROP COLUMN about,
  DROP COLUMN size_bucket,
  DROP COLUMN stage,
  DROP COLUMN funding,
  DROP COLUMN headquarters,
  DROP COLUMN founded_year,
  DROP COLUMN industry,
  DROP COLUMN links,
  DROP COLUMN sponsors_h1b;

-- ── 2. The name key is no longer unique ────────────────────────────────────────────────────────────────────────────

DROP INDEX idx_companies_name_key;
CREATE INDEX idx_companies_name_key ON companies(name_key);
CREATE UNIQUE INDEX idx_companies_own_key ON companies(name_key) WHERE owner_user_id IS NOT NULL;
