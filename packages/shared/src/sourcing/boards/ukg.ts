import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, hostOfTyped } from './url';

// v38 ATS-D: UKG Recruiting (UKG Pro Recruiting, the older UltiPro; @tailorit/shared/autofill parseAtsUrl's `ultipro`).
// A posting's page, https://<sub>.rec.pro.ukg.net/<tenant>/JobBoard/<board uuid>/OpportunityDetail?opportunityId=<uuid>
// (the older recruiting.ultipro.com has the same layout), carries its whole record in the raw HTML (an inline
// `new US.Opportunity.CandidateOpportunityDetail({...})`), and its robots.txt allows */JobBoard/: the API part reads it.
// A board's list is a POST its robots.txt disallows (*/JobBoardView), so a UKG source never runs (SP v38 PLAN "Final
// coverage" #20): its links are read one at a time, and kept under their tenant's source, made off.

/** UKG's recruiting hosts: a tenant's <sub>.rec.pro.ukg.net, and the older shared recruiting[2].ultipro.com and .ca. */
const UKG_HOSTS = String.raw`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.rec\.pro\.ukg\.net|recruiting2?\.ultipro\.com|recruiting\.ultipro\.ca)$`;
const UKG_HOST = new RegExp(UKG_HOSTS);

/** A tenant's code as its addresses write it ("ACM1001ACME"), and a board's or an opportunity's id (a UUID). */
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The board's pages that name one opportunity in ?opportunityId=: its posting and its application. */
const OPPORTUNITY_PAGES: ReadonlySet<string> = new Set(['OpportunityDetail', 'OpportunityApply']);

/** The posting a UKG address names: its tenant, board and opportunity as written; null for any other page. */
export function ukgPostingOf(url: BoardUrl): { tenant: string; board: string; id: string } | null {
  if (!UKG_HOST.test(boardHostOf(url))) return null;
  const [tenant, jobBoard, board, page, ...rest] = boardSegmentsOf(url);
  const id = url.searchParams.get('opportunityId') ?? '';
  if (!tenant || !TENANT.test(tenant) || jobBoard !== 'JobBoard' || !board || !UUID.test(board)) return null;
  if (!page || !OPPORTUNITY_PAGES.has(page) || rest.length > 0 || !UUID.test(id)) return null;
  return { tenant, board, id };
}

/** A posting's clean link (REQUEST.md #20): its OpportunityDetail page with its opportunityId alone, on its own host. */
export function ukgPostingUrl(host: string, posting: { tenant: string; board: string; id: string }): string {
  return `https://${host}/${posting.tenant}/JobBoard/${posting.board}/OpportunityDetail?opportunityId=${posting.id}`;
}

/** A UKG tenant from a typed code ("ACM1001ACME") or any address of its boards, in lower case; '' for none. */
export function ukgTenant(input: string): string {
  const text = input.trim();
  if (TENANT.test(text)) return text.toLowerCase();
  const host = hostOfTyped(text);
  if (!host || !UKG_HOST.test(host)) return '';
  const tenant = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/?#]+)\/JobBoard(?:\/|$)/i.exec(text)?.[1] ?? '';
  return TENANT.test(tenant) ? tenant.toLowerCase() : '';
}

export const UKG_BOARD = defineBoard({
  kind: 'ukg',
  label: 'UKG Recruiting',
  row: { access: 'structured_data', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'ultipro',
  hosts: UKG_HOSTS,
  domains: ['ukg.net', 'ultipro.com', 'ultipro.ca'],
  atsKind: 'ultipro',
  configKey: 'tenant',
  boardWords: 'UKG Recruiting tenant',
  configSchema: z.strictObject({ tenant: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: ukgTenant,
  configOfBoard: (board) => ({ tenant: board }),
  // A tenant's postings are on its own host (or the shared older ones): no one host.
  hostOf: () => null,
  // No boardOfUrl: a UKG board's list is robots-disallowed, so discovery never offers one (it could never run).
  cleanLink: (url) => {
    const posting = ukgPostingOf(url);
    return posting ? ukgPostingUrl(boardHostOf(url), posting) : null;
  },
  // One request at a time to all of UKG Recruiting (its tenants' hosts are UKG's own servers).
  lane: {
    key: 'ukg.lane',
    label: 'UKG Recruiting (all sites)',
    name: 'UKG Recruiting',
  },
  detail: (config) => (configWords(config, 'tenant') ? `Tenant ${configWords(config, 'tenant')}` : null),
  examples: [
    {
      link: 'https://acmerobotics.rec.pro.ukg.net/ACM1001ACME/JobBoard/0f6c1a2b-3d4e-4f50-8a61-7b8c9d0e1f23/OpportunityDetail?opportunityId=5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d&jr_id=6af0c1d2e3f4a5b6c7d8e9f0',
      clean:
        'https://acmerobotics.rec.pro.ukg.net/ACM1001ACME/JobBoard/0f6c1a2b-3d4e-4f50-8a61-7b8c9d0e1f23/OpportunityDetail?opportunityId=5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
      board: 'acm1001acme',
      externalId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
      found: null,
    },
    {
      // The application's page is the same posting: its clean link is the posting's page.
      link: 'https://recruiting.ultipro.com/GLO1002GLBX/JobBoard/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/OpportunityApply?opportunityId=9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b&source=LinkedIn',
      clean:
        'https://recruiting.ultipro.com/GLO1002GLBX/JobBoard/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/OpportunityDetail?opportunityId=9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b',
      board: 'glo1002glbx',
      externalId: '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b',
      found: null,
    },
  ],
});
