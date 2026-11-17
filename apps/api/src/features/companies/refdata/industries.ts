import type { CompanyStage, IndustryId } from '@tailorit/shared';

// v30 E1: the deterministic mappings of the open sources' words to TailorIT's lists (docs/design/part2/
// 13-company-enrichment.md §6.1): a Wikidata industry's label and an SEC SIC code to one of the INDUSTRIES ids, and a
// Wikidata type's label to a COMPANY_STAGES id. Read by label, not by item number, so a renumbered or merged Wikidata
// item maps the same; the source's own words stay in industry_detail. No AI anywhere here (13 §8: AI maps only text
// that no rule maps, in phase 3).

/** Label patterns, first match wins (the more specific before the broader). */
const INDUSTRY_RULES: ReadonlyArray<readonly [RegExp, IndustryId]> = [
  [/\binsur/i, 'insurance'],
  [/\b(defen[cs]e|military|armament|weapon)/i, 'military'],
  [/\b(bank|financ|fintech|invest|asset management|payment|brokerage|stock exchange|credit|lending|venture capital|private equity|accounting)/i, 'finance'],
  [/\b(real estate|propert|reit\b)/i, 'real_estate'],
  [/\b(law firm|legal|attorney)/i, 'legal'],
  [/\b(consult|professional services|advisory)/i, 'consulting'],
  [/\b(telecom|wireless|mobile network|internet service provider|cable television)/i, 'telecommunications'],
  [/\b(health|medic|hospital|pharma|biotech|life science|clinical|drug|diagnostic)/i, 'healthcare'],
  [/\b(software|internet|information technology|computer|semiconductor|technology|cloud|artificial intelligence|data|cyber|electronics|saas|video game|e-?sports)/i, 'technology'],
  [/\b(retail|e-?commerce|online shopping|supermarket|department store|grocery|fashion|apparel|consumer goods)/i, 'retail_ecommerce'],
  [/\b(media|entertainment|film|television|broadcast|music|publish|news|advertis|marketing|gaming)/i, 'media_entertainment'],
  [/\b(logistic|transport|shipping|freight|airline|aviation|railway|rail transport|trucking|delivery|courier)/i, 'logistics_transportation'],
  [/\b(energy|oil|petroleum|natural gas|electric|utilit|power|renewable|solar|wind power|mining|coal)/i, 'energy_utilities'],
  [/\b(hotel|hospitality|travel|tourism|restaurant|food service|leisure|casino)/i, 'hospitality_travel'],
  [/\b(educat|university|school|e-?learning|training)/i, 'education'],
  [/\b(government|public administration|public sector)/i, 'government'],
  [/\b(non-?profit|charit|philanthrop|non-governmental)/i, 'nonprofit'],
  [/\b(manufactur|automotive|aerospace|chemical|steel|industrial|machinery|construction|engineering|food industry|beverage|textile|paper|metal|agricultur)/i, 'manufacturing'],
];

/** The first industry id one of these labels maps to; null when none does. */
export function industryOfLabels(labels: readonly (string | null | undefined)[]): IndustryId | null {
  for (const label of labels) {
    if (!label) continue;
    for (const [pattern, id] of INDUSTRY_RULES) if (pattern.test(label)) return id;
  }
  return null;
}

/** SEC SIC code ranges (13 §6.1's, then the divisions around them), first match wins. */
const SIC_RANGES: ReadonlyArray<readonly [number, number, IndustryId]> = [
  [6300, 6411, 'insurance'],
  [6500, 6553, 'real_estate'],
  [6000, 6299, 'finance'],
  [6700, 6799, 'finance'],
  [7370, 7379, 'technology'],
  [3570, 3579, 'technology'],
  [3670, 3679, 'technology'],
  [4800, 4899, 'telecommunications'],
  [4900, 4999, 'energy_utilities'],
  [1000, 1499, 'energy_utilities'],
  [2830, 2836, 'healthcare'],
  [3840, 3851, 'healthcare'],
  [8000, 8099, 'healthcare'],
  [8100, 8199, 'legal'],
  [8200, 8299, 'education'],
  [8742, 8742, 'consulting'],
  [9100, 9799, 'government'],
  [4000, 4799, 'logistics_transportation'],
  [5200, 5999, 'retail_ecommerce'],
  [7000, 7099, 'hospitality_travel'],
  [5800, 5813, 'hospitality_travel'],
  [7800, 7899, 'media_entertainment'],
  [2700, 2799, 'media_entertainment'],
  [8600, 8699, 'nonprofit'],
  [2000, 3999, 'manufacturing'],
];

/** The industry id of an SEC SIC code; null for none (or a code outside the ranges). */
export function industryOfSic(sic: string | null | undefined): IndustryId | null {
  const code = sic && /^\d{3,4}$/.test(sic.trim()) ? Number(sic.trim()) : null;
  if (code === null) return null;
  for (const [from, to, id] of SIC_RANGES) if (code >= from && code <= to) return id;
  return null;
}

/** A Wikidata type's label (P31) to the stage it states; null when it states none. */
const STAGE_RULES: ReadonlyArray<readonly [RegExp, CompanyStage]> = [
  [/\bpublic company\b|\bpublicly (traded|listed)/i, 'public'],
  [/\bsubsidiary\b/i, 'subsidiary'],
  [/\b(non-?profit|charit|foundation|non-governmental organi[sz]ation)/i, 'nonprofit'],
  [/\b(government agency|ministry|public body|government organi[sz]ation|state-owned)/i, 'government'],
  [/\b(university|college|school|educational institution|research institute)/i, 'education'],
  [/\bprivately held\b|\bprivate company\b/i, 'private'],
];

/**
 * A company's stage from Wikidata (13 §6.1): public when it is listed on an exchange now, a subsidiary when it has a
 * parent, else what its types state (nonprofit, government, education, private); null when nothing states one. Venture
 * stages never come from here (a licensed vendor only).
 */
export function stageOfWikidata(input: { listed: boolean; hasParent: boolean; typeLabels: readonly (string | null)[] }): CompanyStage | null {
  if (input.listed) return 'public';
  if (input.hasParent) return 'subsidiary';
  for (const label of input.typeLabels) {
    if (!label) continue;
    for (const [pattern, stage] of STAGE_RULES) if (pattern.test(label)) return stage;
  }
  return null;
}
