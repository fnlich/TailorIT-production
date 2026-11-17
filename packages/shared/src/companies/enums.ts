// v30 CT: the company vocabulary of v3.0 (docs/design/part2/13-company-enrichment.md §2, §5, §6, §8;
// 11-database.md §5.4). The database checks the closed lists of its tables; COMPANY_STAGES and the profile's size and
// industry ids are checked here, in code, so a new value needs no table rebuild (11 §12). Imports nothing, so the job
// DTOs may read it.

/**
 * A company's stage (13 §2), replacing v2.0's free text. The first six come from open sources (a ticker on an
 * exchange, a parent, Wikidata's types); the last five only from a licensed vendor, which v3.0 does not have (owner
 * question 19: venture stages stay empty).
 */
export const COMPANY_STAGES = [
  'public',
  'private',
  'subsidiary',
  'nonprofit',
  'government',
  'education',
  'seed',
  'early',
  'growth',
  'private_equity',
  'acquired',
] as const;
export type CompanyStage = (typeof COMPANY_STAGES)[number];

/** The stages only a licensed vendor supplies. */
export const COMPANY_VENDOR_STAGES = ['seed', 'early', 'growth', 'private_equity', 'acquired'] as const satisfies readonly CompanyStage[];

/** The Company section's words for each stage ("Company Stage: Public"). */
export const COMPANY_STAGE_LABEL: Record<CompanyStage, string> = {
  public: 'Public',
  private: 'Private',
  subsidiary: 'Subsidiary',
  nonprofit: 'Nonprofit',
  government: 'Government',
  education: 'Education',
  seed: 'Seed',
  early: 'Early stage (Series A-B)',
  growth: 'Growth (Series C and later)',
  private_equity: 'Private equity',
  acquired: 'Acquired',
};

/** Whether `value` is a COMPANY_STAGES id. */
export function isCompanyStage(value: unknown): value is CompanyStage {
  return typeof value === 'string' && (COMPANY_STAGES as readonly string[]).includes(value);
}

/** A stage's words: its label for a COMPANY_STAGES id, the stored text itself for a value from before v3.0, else ''. */
export function companyStageLabel(stage: string | null | undefined): string {
  if (!stage) return '';
  return isCompanyStage(stage) ? COMPANY_STAGE_LABEL[stage] : stage;
}

/** Founded and incorporated are kept apart: a registry gives the incorporation date (13 §2). */
export const COMPANY_FOUNDED_KINDS = ['founded', 'incorporated'] as const;
export type CompanyFoundedKind = (typeof COMPANY_FOUNDED_KINDS)[number];
export const COMPANY_FOUNDED_LABEL: Record<CompanyFoundedKind, string> = { founded: 'Founded', incorporated: 'Incorporated' };

/** Where the summary came from: a source's own words (at most 600 characters), the AI (labelled), or an admin. */
export const COMPANY_SUMMARY_ORIGINS = ['source_text', 'ai', 'admin'] as const;
export type CompanySummaryOrigin = (typeof COMPANY_SUMMARY_ORIGINS)[number];

/** company_profiles' text caps (the table's checks): the tagline and the summary. */
export const COMPANY_TAGLINE_MAX = 90;
export const COMPANY_SUMMARY_MAX = 600;
/** The founded year's range (the table's check). */
export const COMPANY_FOUNDED_YEAR_MIN = 1600;
export const COMPANY_FOUNDED_YEAR_MAX = 2100;

/**
 * The kinds of company_sources rows (13 §6.3): what a source read gave. A licensed vendor's rows are
 * `vendor:<name>` (COMPANY_VENDOR_SOURCE_PATTERN), purged together by their purge group.
 */
export const COMPANY_SOURCE_KINDS = [
  'ats_board',
  'job_posting',
  'company_site',
  'wikidata',
  'sec',
  'gleif',
  'logo_dev',
  'ai',
  'admin',
  'legacy',
] as const;
export type CompanySourceKind = (typeof COMPANY_SOURCE_KINDS)[number];
export const COMPANY_VENDOR_SOURCE_PATTERN = /^vendor:[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Each source kind's words in the Company section's sources line ("Sources: the company's website, Wikidata, SEC
 * EDGAR."); '' names nothing there (the AI has its own label; an admin's, the old columns' and a paid logo plan's
 * values need no credit).
 */
export const COMPANY_SOURCE_LABEL: Record<CompanySourceKind, string> = {
  // v30 FIX-WEB (REV-UX UX-19): a board's intro came from the job board, not the company's own site (which the site
  // reader, off by default, never read).
  ats_board: "the company's job board",
  job_posting: "the company's website",
  company_site: "the company's website",
  wikidata: 'Wikidata',
  sec: 'SEC EDGAR',
  gleif: 'GLEIF',
  logo_dev: '',
  ai: '',
  admin: '',
  legacy: '',
};

/** The licence each source's answer is kept under (13 §6.3), and what the UI must then show. */
export const COMPANY_LICENCES = [
  'cc0',
  'us_gov_public',
  'ats_public_api',
  'own_site',
  'cc_by_sa_4',
  'vendor_contract',
  'ai_derived',
  'admin',
  'legacy',
] as const;
export type CompanyLicence = (typeof COMPANY_LICENCES)[number];

/** How a source read went. */
export const COMPANY_SOURCE_STATUSES = ['ok', 'not_found', 'blocked', 'robots_disallowed', 'error'] as const;
export type CompanySourceStatus = (typeof COMPANY_SOURCE_STATUSES)[number];

/** Every key that points at a company (13 §5.1). */
export const COMPANY_ALIAS_KINDS = [
  'board',
  'domain',
  'domain_shared',
  'wikidata',
  'cik',
  'lei',
  'uk_company',
  'ticker',
  'linkedin_slug',
  'name_key',
  'legal_name_key',
] as const;
export type CompanyAliasKind = (typeof COMPANY_ALIAS_KINDS)[number];
/** The strong kinds: each value points at one company only (the unique index), and may merge two rows. */
export const COMPANY_STRONG_ALIAS_KINDS = ['board', 'domain', 'wikidata', 'cik', 'lei', 'uk_company'] as const satisfies readonly CompanyAliasKind[];

/** Parents, subsidiaries and brands, kept apart and never merged (13 §5.4). */
export const COMPANY_RELATION_KINDS = ['subsidiary', 'brand', 'acquired'] as const;
export type CompanyRelationKind = (typeof COMPANY_RELATION_KINDS)[number];

/** What an admin decides in the match review queue (13 §5.5). */
export const COMPANY_MATCH_REVIEW_KINDS = ['merge', 'homonym', 'domain', 'wikidata', 'board_by_name'] as const;
export type CompanyMatchReviewKind = (typeof COMPANY_MATCH_REVIEW_KINDS)[number];
export const COMPANY_MATCH_REVIEW_STATUSES = ['open', 'accepted', 'rejected'] as const;
export type CompanyMatchReviewStatus = (typeof COMPANY_MATCH_REVIEW_STATUSES)[number];
export const COMPANY_MATCH_REVIEW_KIND_LABEL: Record<CompanyMatchReviewKind, string> = {
  merge: 'Same company?',
  homonym: 'Same name, another company?',
  domain: 'Website match',
  wikidata: 'Wikidata match',
  board_by_name: 'Second board joined by name',
};

/** The sources the enrichment worker reads for a company (company_enrichment_queue.steps), each a source kind. */
export const COMPANY_ENRICHMENT_STEPS = [
  'ats_board',
  'wikidata',
  'sec',
  'gleif',
  'company_site',
  'logo_dev',
  'ai',
] as const satisfies readonly CompanySourceKind[];
export type CompanyEnrichmentStep = (typeof COMPANY_ENRICHMENT_STEPS)[number];

/**
 * The profile's fields, by the ids company_profiles' provenance, confidence, locked_fields and conflicts use as
 * keys: each is a key of CompanyProfileSchema (./schemas), whose `summaryOrigin`, `employeesAsOf` and `fundingAsOf`
 * go with their field.
 */
export const COMPANY_PROFILE_FIELDS = [
  'displayName',
  'legalName',
  'tagline',
  'summary',
  'website',
  'domain',
  'linkedinUrl',
  'otherLinks',
  'logoUrl',
  'industry',
  'industryDetail',
  'employees',
  'sizeBucket',
  'stage',
  'ticker',
  'exchange',
  'hqCity',
  'hqRegion',
  'hqCountryCode',
  'foundedYear',
  'foundedKind',
  'fundingTotalUsd',
  'sponsorsH1b',
] as const;
export type CompanyProfileField = (typeof COMPANY_PROFILE_FIELDS)[number];

/** The fields the AI may write, from allowed text only (13 §8): never a fact (a year, a size, a stage, a link). */
export const COMPANY_AI_FIELDS = ['tagline', 'summary', 'industry'] as const satisfies readonly CompanyProfileField[];
