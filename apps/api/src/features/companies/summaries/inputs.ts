import { createHash } from 'node:crypto';
import {
  COMPANY_FOUNDED_LABEL,
  COMPANY_SOURCE_LABEL,
  NOT_SPECIFIED_INDUSTRY,
  companyStageLabel,
  formatLocation,
  industryLabel,
  type CompanyFoundedKind,
  type CompanySourceKind,
} from '@tailorit/shared';
import type { DbQueries } from '../../../core/db/types';
import { candidatesOf, cleanFields, profileRowOf, stableJson, valuesOfRow } from '../profile';

// v30 E3: what the AI may read about a company (docs/design/part2/13-company-enrichment.md §8, "Inputs"), and whether
// a summary may be written for it now.
//
// The texts: the summary and tagline values of the company's own allowed sources, as they are stored (each at most
// COMPANY_SUMMARY_MAX): its website's description (company_site), its job board's intro (ats_board), its newest
// posting's "About" section and other posting words (job_posting), its Wikidata description (wikidata). Never an
// admin's, the AI's own, the old columns' (licence `legacy`) or a vendor's; never a source under
// COMPANY_FIELD_MIN_CONFIDENCE (it may be another company); never a text whose host said `ai-input=no` (12 §9.7: the
// company's board sources' ai_input, the newest open posting's for the About section, a site row's `aiInput: false`)
// or whose page said `nosnippet` (a site row's `nosnippet: true`).
// The facts: the profile's industry, headquarters, founded year and stage, as words, unless the AI itself gave them.
// The hash: of the name, the texts, the facts and whether the industry is asked for (state.ts compares it).
//
// Eligible: a shared company (never an account's own, a merged or an opted-out one: 13 §5.6), with open jobs (13 §8:
// "summaries only for companies with open jobs at first"), whose summary no admin locked, with at least
// COMPANY_AI_MIN_INPUT_CHARS characters of text.

/** The source kinds whose words the AI reads, in the order it reads them. */
export const SUMMARY_TEXT_KINDS = ['company_site', 'ats_board', 'job_posting', 'wikidata'] as const satisfies readonly CompanySourceKind[];
/** The value fields read as text. */
const TEXT_FIELDS = ['summary', 'tagline'] as const;

/** Why a company gets no summary now (state.ts keeps it as last_check). */
export type SummaryIneligible = 'not_shared' | 'no_jobs' | 'locked' | 'too_little';

/** One text the AI reads. */
export interface SummaryText {
  sourceId: number;
  kind: CompanySourceKind;
  /** The sources line's words for it ("the company's website", "Wikidata"). */
  from: string;
  text: string;
}

export interface SummaryInputs {
  companyId: number;
  name: string;
  texts: SummaryText[];
  /** "Industry: Technology", "Headquarters: Austin, TX, United States", "Founded: 2016", "Stage: Public". */
  facts: string[];
  /** No source but the AI gives an industry (and no admin locked it): the AI maps one from the texts. */
  mapIndustry: boolean;
  /** The lowest match confidence of the sources quoted: the AI's answer is no surer than what it read. */
  confidence: number;
  /** Characters of text. */
  textChars: number;
  /** sha256 (hex) of what the AI reads. */
  hash: string;
}

export type SummaryLook =
  | { eligible: true; inputs: SummaryInputs; openJobs: number }
  | { eligible: false; reason: SummaryIneligible; inputs: SummaryInputs | null; openJobs: number };

export interface SummaryLookOptions {
  /** COMPANY_FIELD_MIN_CONFIDENCE. */
  minConfidence: number;
  /** COMPANY_AI_MIN_INPUT_CHARS. */
  minChars: number;
}

interface SourceRow {
  id: number;
  kind: string;
  ref: string;
  licence: string;
  match_confidence: number;
  fields: string;
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseList(text: string | null | undefined): string[] {
  try {
    const value: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const textKey = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** The open jobs a summary is written for (live, shared, not held). */
export const OPEN_JOBS_SQL = 'SELECT count(*) AS n FROM jobs WHERE company_id = ? AND active AND owner_user_id IS NULL AND held_since IS NULL';

/** The profile's facts as words, leaving out what the AI itself gave (its own answer is no input). */
function factsOf(values: ReturnType<typeof valuesOfRow>, provenance: Record<string, unknown>, aiSources: ReadonlySet<number>): string[] {
  const fromAi = (field: string) => aiSources.has(Number(provenance[field]));
  const facts: string[] = [];
  const industry = typeof values.industry === 'string' && values.industry !== NOT_SPECIFIED_INDUSTRY && !fromAi('industry') ? industryLabel(values.industry) : '';
  if (industry) facts.push(`Industry: ${industry}`);
  if (!fromAi('hqCity') && (values.hqCity || values.hqRegion || values.hqCountryCode)) {
    const place = formatLocation({
      raw: '',
      city: (values.hqCity as string | undefined) ?? null,
      region: (values.hqRegion as string | undefined) ?? null,
      countryCode: (values.hqCountryCode as string | undefined) ?? null,
      isRemote: false,
    });
    if (place) facts.push(`Headquarters: ${place}`);
  }
  if (typeof values.foundedYear === 'number' && !fromAi('foundedYear')) {
    const kind = (values.foundedKind as CompanyFoundedKind | undefined) ?? 'founded';
    facts.push(`${COMPANY_FOUNDED_LABEL[kind] ?? COMPANY_FOUNDED_LABEL.founded}: ${values.foundedYear}`);
  }
  const stage = typeof values.stage === 'string' && !fromAi('stage') ? companyStageLabel(values.stage) : '';
  if (stage) {
    const ticker = values.stage === 'public' && typeof values.ticker === 'string' ? values.ticker : null;
    const exchange = typeof values.exchange === 'string' ? values.exchange : null;
    facts.push(`Stage: ${stage}${ticker ? ` (${exchange ? `${exchange}: ` : ''}${ticker})` : ''}`);
  }
  return facts;
}

/** What the AI may read about a company, and whether it may be summarised now (see the module's note). */
export async function lookAtCompany(t: DbQueries, companyId: number, options: SummaryLookOptions): Promise<SummaryLook> {
  const company = await t.one<{ name: string; owner_user_id: string | null; merged_into_id: number | null; do_not_fetch: boolean }>(
    'SELECT name, owner_user_id, merged_into_id, do_not_fetch FROM companies WHERE id = ?',
    [companyId],
  );
  if (!company || company.owner_user_id !== null || company.merged_into_id !== null || company.do_not_fetch) {
    return { eligible: false, reason: 'not_shared', inputs: null, openJobs: 0 };
  }
  const openJobs = Number((await t.one<{ n: number }>(OPEN_JOBS_SQL, [companyId]))?.n ?? 0);
  const profile = await profileRowOf(t, companyId);
  const values = valuesOfRow(profile);
  const provenance = profile?.provenance ? parseObject(profile.provenance) : {};
  const locked = new Set<string>(parseList(profile?.locked_fields));
  const sources = await t.all<SourceRow>(
    "SELECT id, kind, ref, licence, match_confidence, fields::text AS fields FROM company_sources WHERE company_id = ? AND status = 'ok' ORDER BY id",
    [companyId],
  );
  // 12 §9.7: a host that said ai-input=no keeps its words from the AI.
  const boardsSayNo = Boolean(
    (await t.one<{ no: boolean }>('SELECT EXISTS (SELECT 1 FROM job_sources WHERE company_id = ? AND NOT ai_input) AS no', [companyId]))?.no,
  );
  const newest = await t.one<{ ai_input: boolean }>(
    `SELECT ai_input FROM jobs WHERE company_id = ? AND active AND owner_user_id IS NULL AND held_since IS NULL
     ORDER BY posted_sort DESC, id DESC LIMIT 1`,
    [companyId],
  );
  const aboutSaysNo = newest ? !newest.ai_input : false;

  const texts: SummaryText[] = [];
  const seen = new Set<string>();
  const quoted = new Set<number>();
  for (const kind of SUMMARY_TEXT_KINDS) {
    for (const source of sources) {
      if (source.kind !== kind || source.licence === 'legacy' || source.match_confidence < options.minConfidence) continue;
      const raw = parseObject(source.fields);
      if (kind === 'company_site' && (raw.aiInput === false || raw.nosnippet === true)) continue;
      if (kind === 'ats_board' && boardsSayNo) continue;
      if (kind === 'job_posting' && (source.ref === 'about' ? aboutSaysNo : boardsSayNo)) continue;
      const fields = cleanFields(raw);
      for (const field of TEXT_FIELDS) {
        const text = fields[field];
        if (typeof text !== 'string' || !text.trim()) continue;
        const key = textKey(text);
        // A text another holds whole (a tagline inside its own summary) is read once.
        if (seen.has(key) || [...seen].some((other) => other.includes(key))) continue;
        seen.add(key);
        quoted.add(source.id);
        texts.push({ sourceId: source.id, kind, from: COMPANY_SOURCE_LABEL[kind], text: text.trim() });
      }
    }
  }
  const aiSources = new Set(sources.filter((source) => source.kind === 'ai').map((source) => source.id));
  const facts = factsOf(values, provenance, aiSources);
  const otherIndustry = candidatesOf('industry', sources).some(
    (candidate) => candidate.sourceKind !== 'ai' && candidate.value !== NOT_SPECIFIED_INDUSTRY && candidate.confidence >= options.minConfidence,
  );
  const mapIndustry = !otherIndustry && !locked.has('industry');
  const name = (typeof values.displayName === 'string' && values.displayName) || company.name;
  const textChars = texts.reduce((sum, text) => sum + text.text.length, 0);
  const confidence = Math.min(100, ...sources.filter((source) => quoted.has(source.id)).map((source) => source.match_confidence));
  const hash = createHash('sha256')
    .update(stableJson({ name, texts: texts.map((text) => [text.kind, text.text]), facts, mapIndustry }))
    .digest('hex');
  const inputs: SummaryInputs = { companyId, name, texts, facts, mapIndustry, confidence, textChars, hash };

  if (openJobs === 0) return { eligible: false, reason: 'no_jobs', inputs, openJobs };
  if (locked.has('summary')) return { eligible: false, reason: 'locked', inputs, openJobs };
  if (textChars < options.minChars) return { eligible: false, reason: 'too_little', inputs, openJobs };
  return { eligible: true, inputs, openJobs };
}
