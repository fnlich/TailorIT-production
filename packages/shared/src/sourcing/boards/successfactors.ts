import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, configWords, hostOfTyped } from './url';

// v38 ATS-D: SAP SuccessFactors' classic career sites (@tailorit/shared/autofill parseAtsUrl's `successfactors`):
// https://career<n>.successfactors.com/career?career_ns=job_listing&company=<company>&career_job_req_id=<req id>. Their
// robots.txt disallows every path for every robot (SP v38 EVIDENCE.md §18: `User-agent: *`, `Disallow: /`), so TailorIT
// never reads them: a link is recognised, cleaned, and its verdict is can't read (`robots`), with no request (the API
// part). Career Site Builder sites (<company>.jobs.hr.cloud.sap and the employers' own domains) stay career sites.

/** The classic career sites' hosts (parseAtsUrl's): career<n>.successfactors.com or .eu. */
const SUCCESSFACTORS_HOSTS = String.raw`^career\d{0,3}\.successfactors\.(?:com|eu)$`;
const SUCCESSFACTORS_HOST = new RegExp(SUCCESSFACTORS_HOSTS);
/** The company id and a requisition's number as the addresses write them. */
const COMPANY = /^[A-Za-z0-9_-]{1,60}$/;
const REQ_ID = /^\d{1,12}$/;

/** The posting a career site's address names: its company (as written) and requisition; null for any other page. */
export function successFactorsPostingOf(url: BoardUrl): { company: string; id: string } | null {
  if (!SUCCESSFACTORS_HOST.test(boardHostOf(url)) || (url.pathname !== '/career' && url.pathname !== '/career/')) return null;
  const company = url.searchParams.get('company') ?? url.searchParams.get('career_company') ?? '';
  const id = url.searchParams.get('career_job_req_id') ?? '';
  return COMPANY.test(company) && REQ_ID.test(id) ? { company, id } : null;
}

/** A SuccessFactors company id from a typed id ("AcmeRobotics") or any address naming it (?company=); '' for none. */
export function successFactorsCompany(input: string): string {
  const text = input.trim();
  if (COMPANY.test(text)) return text;
  const host = hostOfTyped(text);
  if (!host || !SUCCESSFACTORS_HOST.test(host)) return '';
  const company = /[?&](?:career_)?company=([^&#]*)/.exec(text)?.[1] ?? '';
  let decoded = company;
  try {
    decoded = decodeURIComponent(company);
  } catch {
    return '';
  }
  return COMPANY.test(decoded) ? decoded : '';
}

export const SUCCESSFACTORS_BOARD = defineBoard({
  kind: 'successfactors',
  label: 'SAP SuccessFactors',
  row: { access: 'public_api', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'successfactors',
  hosts: SUCCESSFACTORS_HOSTS,
  domains: ['successfactors.com', 'successfactors.eu'],
  atsKind: 'successfactors',
  configKey: 'company',
  boardWords: 'SuccessFactors company',
  configSchema: z.strictObject({ company: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  // The company id keeps its case ("AcmeRobotics"), as its addresses write it.
  keepsCase: true,
  boardOf: successFactorsCompany,
  configOfBoard: (board) => ({ company: board }),
  // A company's site is on one of SAP's data centres' hosts: no one host.
  hostOf: () => null,
  // REQUEST.md #18: keep career_ns=job_listing, company and career_job_req_id, drop the rest; written in the stored form's
  // order (every stored link sorts its parameters by name), which is parseAtsUrl's canonical address too.
  cleanLink: (url) => {
    const posting = successFactorsPostingOf(url);
    return posting
      ? `https://${boardHostOf(url)}/career?career_job_req_id=${posting.id}&career_ns=job_listing&company=${encodeURIComponent(posting.company)}`
      : null;
  },
  lane: {
    key: 'successfactors.lane',
    label: 'SAP SuccessFactors (all sites)',
    name: 'SAP SuccessFactors',
  },
  detail: (config) => (configWords(config, 'company') ? `Company ${configWords(config, 'company')}` : null),
  examples: [
    {
      link: 'https://career4.successfactors.com/career?career_ns=job_listing&company=AcmeRobotics&career_job_req_id=4821&_s.crb=a1B2c3D4e5&utm_source=LinkedIn',
      clean: 'https://career4.successfactors.com/career?career_job_req_id=4821&career_ns=job_listing&company=AcmeRobotics',
      board: 'AcmeRobotics',
      externalId: '4821',
      found: null,
    },
  ],
});
