import { CA_PROVINCES, COUNTRIES, US_STATES } from '@tailorit/shared';

// v37 FIX-37A (SP v37 FIXES-37 E5, review H1): a country as a posting's structured data writes it, as a name the places
// reader knows. iCIMS (and other career pages' JSON-LD) write `addressCountry` as an ISO 3166-1 code ("NL", "IN",
// "DEU"); the places reader (@tailorit/shared parseLocations) reads a bare two-letter code after a place as a US state
// or a Canadian province ("Bangalore, KA, IN" was Indiana, "Berlin, DE" Delaware, "Vught, NL" Newfoundland). A code is
// turned into the country's name first: the shared country list's name (the reader knows it, so the job gets its
// country), else the English name the runtime's own region names give. Anything else is kept as written.

/** ISO 3166-1 alpha-3 -> alpha-2 (every assigned code, and Kosovo's user-assigned XKX). */
const ALPHA3 =
  'AFG:AF ALA:AX ALB:AL DZA:DZ ASM:AS AND:AD AGO:AO AIA:AI ATA:AQ ATG:AG ARG:AR ARM:AM ABW:AW AUS:AU AUT:AT AZE:AZ ' +
  'BHS:BS BHR:BH BGD:BD BRB:BB BLR:BY BEL:BE BLZ:BZ BEN:BJ BMU:BM BTN:BT BOL:BO BES:BQ BIH:BA BWA:BW BVT:BV BRA:BR ' +
  'IOT:IO BRN:BN BGR:BG BFA:BF BDI:BI CPV:CV KHM:KH CMR:CM CAN:CA CYM:KY CAF:CF TCD:TD CHL:CL CHN:CN CXR:CX CCK:CC ' +
  'COL:CO COM:KM COG:CG COD:CD COK:CK CRI:CR CIV:CI HRV:HR CUB:CU CUW:CW CYP:CY CZE:CZ DNK:DK DJI:DJ DMA:DM DOM:DO ' +
  'ECU:EC EGY:EG SLV:SV GNQ:GQ ERI:ER EST:EE SWZ:SZ ETH:ET FLK:FK FRO:FO FJI:FJ FIN:FI FRA:FR GUF:GF PYF:PF ATF:TF ' +
  'GAB:GA GMB:GM GEO:GE DEU:DE GHA:GH GIB:GI GRC:GR GRL:GL GRD:GD GLP:GP GUM:GU GTM:GT GGY:GG GIN:GN GNB:GW GUY:GY ' +
  'HTI:HT HMD:HM VAT:VA HND:HN HKG:HK HUN:HU ISL:IS IND:IN IDN:ID IRN:IR IRQ:IQ IRL:IE IMN:IM ISR:IL ITA:IT JAM:JM ' +
  'JPN:JP JEY:JE JOR:JO KAZ:KZ KEN:KE KIR:KI PRK:KP KOR:KR KWT:KW KGZ:KG LAO:LA LVA:LV LBN:LB LSO:LS LBR:LR LBY:LY ' +
  'LIE:LI LTU:LT LUX:LU MAC:MO MDG:MG MWI:MW MYS:MY MDV:MV MLI:ML MLT:MT MHL:MH MTQ:MQ MRT:MR MUS:MU MYT:YT MEX:MX ' +
  'FSM:FM MDA:MD MCO:MC MNG:MN MNE:ME MSR:MS MAR:MA MOZ:MZ MMR:MM NAM:NA NRU:NR NPL:NP NLD:NL NCL:NC NZL:NZ NIC:NI ' +
  'NER:NE NGA:NG NIU:NU NFK:NF MKD:MK MNP:MP NOR:NO OMN:OM PAK:PK PLW:PW PSE:PS PAN:PA PNG:PG PRY:PY PER:PE PHL:PH ' +
  'PCN:PN POL:PL PRT:PT PRI:PR QAT:QA REU:RE ROU:RO RUS:RU RWA:RW BLM:BL SHN:SH KNA:KN LCA:LC MAF:MF SPM:PM VCT:VC ' +
  'WSM:WS SMR:SM STP:ST SAU:SA SEN:SN SRB:RS SYC:SC SLE:SL SGP:SG SXM:SX SVK:SK SVN:SI SLB:SB SOM:SO ZAF:ZA SGS:GS ' +
  'SSD:SS ESP:ES LKA:LK SDN:SD SUR:SR SJM:SJ SWE:SE CHE:CH SYR:SY TWN:TW TJK:TJ TZA:TZ THA:TH TLS:TL TGO:TG TKL:TK ' +
  'TON:TO TTO:TT TUN:TN TUR:TR TKM:TM TCA:TC TUV:TV UGA:UG UKR:UA ARE:AE GBR:GB USA:US UMI:UM URY:UY UZB:UZ VUT:VU ' +
  'VEN:VE VNM:VN VGB:VG VIR:VI WLF:WF ESH:EH YEM:YE ZMB:ZM ZWE:ZW XKX:XK';

/** Alpha-3 -> alpha-2. */
export const COUNTRY_ALPHA3: ReadonlyMap<string, string> = new Map(
  ALPHA3.split(' ').map((pair) => pair.split(':') as [string, string]),
);

/** The assigned alpha-2 codes (and XK): the alpha-3 table's. */
const ALPHA2 = new Set(COUNTRY_ALPHA3.values());

let regionNames: Intl.DisplayNames | null | undefined;

/** The runtime's English region names (null where the runtime has none). */
function displayNames(): Intl.DisplayNames | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  return regionNames;
}

/** The ISO alpha-2 code a country code names ("nl", "NLD" -> "NL"), or null when the text is no assigned code. */
export function countryCodeOf(text: string): string | null {
  const code = text.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return ALPHA2.has(code) ? code : null;
  if (/^[A-Z]{3}$/.test(code)) return COUNTRY_ALPHA3.get(code) ?? null;
  return null;
}

/**
 * Whether the places reader would read a region written as `text` as a country of its own: a two-letter code that is
 * no US state nor Canadian province but a country it knows ("HR", Haryana's code, read as Croatia; "BE", Berlin's, as
 * Belgium), or US, UK, GB. Such a region before a country makes a second, bogus place ("Gurgaon, HR, India" was
 * Gurugram in Croatia and India).
 */
export function regionReadAsCountry(text: string): boolean {
  const code = text.trim().replace(/\./g, '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return false;
  if (code === 'US' || code === 'UK' || code === 'GB') return true;
  return !Object.hasOwn(US_STATES, code) && !Object.hasOwn(CA_PROVINCES, code) && Object.hasOwn(COUNTRIES, code);
}

/**
 * A country as written, with an ISO alpha-2 or alpha-3 code turned into its name (see the top): "NL" -> "Netherlands",
 * "IND" -> "India", "RW" -> "Rwanda"; a name, or any other text, as written.
 */
export function countryNameOf(text: string): string {
  const code = countryCodeOf(text);
  if (!code) return text;
  if (Object.hasOwn(COUNTRIES, code)) return COUNTRIES[code]!.name;
  const name = displayNames()?.of(code);
  return name && name !== code ? name : text;
}
