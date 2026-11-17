import { companySizeBucket, parseLocations, type IndustryId } from '@tailorit/shared';
import { companyDomainsOf, registrableDomain } from '../domain';
import { cleanFields, linkedinCompanyUrl, type ProfileFields } from '../profile';
import type { SitePage } from './page';

// v30 E2: a company website's facts as its company_sources row's values (docs/design/part2/13-company-enrichment.md
// §3.3, §6.1): the profile's priority then decides which it shows (an admin's first; a board's name before the site's;
// Wikidata's headquarters and founding before the site's). What a site never gives: a funding figure, a stage, a
// sponsorship. Every value goes through the profile's own checks (cleanFields).

/** NAICS sectors (and the few subsectors that differ) to TailorIT's industries; the longest prefix wins. */
const NAICS_INDUSTRY: ReadonlyArray<readonly [string, IndustryId]> = [
  ['11', 'other'],
  ['21', 'energy_utilities'],
  ['22', 'energy_utilities'],
  ['23', 'other'],
  ['31', 'manufacturing'],
  ['32', 'manufacturing'],
  ['33', 'manufacturing'],
  ['42', 'retail_ecommerce'],
  ['44', 'retail_ecommerce'],
  ['45', 'retail_ecommerce'],
  ['48', 'logistics_transportation'],
  ['49', 'logistics_transportation'],
  ['51', 'technology'],
  ['512', 'media_entertainment'],
  ['513', 'media_entertainment'],
  ['515', 'media_entertainment'],
  ['516', 'media_entertainment'],
  ['517', 'telecommunications'],
  ['5112', 'technology'],
  ['52', 'finance'],
  ['524', 'insurance'],
  ['53', 'real_estate'],
  ['54', 'consulting'],
  ['5411', 'legal'],
  ['5415', 'technology'],
  ['55', 'other'],
  ['56', 'other'],
  ['61', 'education'],
  ['62', 'healthcare'],
  ['71', 'media_entertainment'],
  ['72', 'hospitality_travel'],
  ['81', 'other'],
  ['813', 'nonprofit'],
  ['92', 'government'],
  ['928', 'military'],
];

/** A NAICS code's industry (and its words for industry_detail), or null. */
export function naicsIndustry(code: string | null): { industry: IndustryId; detail: string } | null {
  const digits = /^\s*(\d{2,6})\b/.exec(code ?? '')?.[1];
  if (!digits) return null;
  let best: readonly [string, IndustryId] | null = null;
  for (const entry of NAICS_INDUSTRY) if (digits.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best ? { industry: best[1], detail: `NAICS ${digits}` } : null;
}

/** An LEI (ISO 17442: 18 letters or digits and 2 check digits, ISO 7064 mod 97-10), upper case; null when it is none. */
export function leiOf(value: string | null): string | null {
  const lei = (value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{18}\d{2}$/.test(lei)) return null;
  let rest = 0;
  for (const char of lei) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1 ? lei : null;
}

/** A founding date's year ("1998", "1998-05-01"), or null. */
function yearOf(date: string | null): number | null {
  const year = /^\s*(\d{4})\b/.exec(date ?? '')?.[1];
  return year ? Number(year) : null;
}

/** The headquarters of a schema.org address, read as a place (a two-letter country is its code). */
function headquartersOf(address: NonNullable<NonNullable<SitePage['organization']>['address']>) {
  const country = address.country?.trim() ?? null;
  const place = parseLocations([address.locality, address.region, country].filter(Boolean).join(', '))[0];
  return {
    hqCity: address.locality ?? place?.city ?? null,
    hqRegion: address.region ?? place?.region ?? null,
    hqCountryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : (place?.countryCode ?? null),
  };
}

/**
 * A homepage's facts (and its about page's description, when the homepage has none) as source values: the site's
 * address it was read at gives the website and the domain; `day` (YYYY-MM-DD) dates an employee count.
 */
export function siteFields(page: SitePage, input: { finalUrl: string; day: string; aboutDescription?: string | null }): ProfileFields {
  const org = page.organization;
  const origin = new URL(input.finalUrl).origin;
  const links = [...page.profileLinks];
  const linkedin = links.map(linkedinCompanyUrl).find(Boolean) ?? null;
  const naics = naicsIndustry(org?.naics ?? null);
  const founded = yearOf(org?.foundingDate ?? null);
  const employees = org?.employees ?? null;
  const bucket = companySizeBucket(employees ?? org?.employeesMax ?? org?.employeesMin ?? null);
  // The site's own address: its Organization.url when that is on the same registrable domain, else where it was read.
  const stated = org?.url && registrableDomain(org.url) === registrableDomain(input.finalUrl) ? org.url : null;
  const website = stated ?? `${origin}/`;
  return cleanFields({
    displayName: org?.name ?? page.siteName,
    legalName: org?.legalName ?? null,
    website,
    domain: companyDomainsOf([website])[0] ?? null,
    linkedinUrl: linkedin,
    otherLinks: links.filter((link) => !linkedinCompanyUrl(link)),
    summary: page.description ?? input.aboutDescription ?? null,
    foundedYear: founded,
    foundedKind: founded === null ? null : 'founded',
    employees,
    employeesAsOf: employees === null ? null : input.day,
    sizeBucket: bucket,
    ...(org?.address ? headquartersOf(org.address) : {}),
    industry: naics?.industry ?? null,
    industryDetail: naics?.detail ?? null,
  });
}
