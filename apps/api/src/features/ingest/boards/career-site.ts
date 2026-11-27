import { CAREER_SITE_BOARD } from '@tailorit/shared/sourcing';
import { careerSiteAdapter } from '../adapters/careerSite';
import { careerHostOfConfig, careerSiteSourceOf } from '../career/config';
import type { ApiBoardDescriptor } from './types';

// v38 FRAME: an employer's own career site's API part (its shared part: @tailorit/shared/sourcing CAREER_SITE_BOARD): read
// through the shared site reader while SITE_READER_CAREER_PAGES is on (v30 S5). Its host is the API's rule (career/
// config.ts: a public site host, never a refused board's or LinkedIn's).

export const CAREER_SITE: ApiBoardDescriptor<'career_site'> = {
  board: CAREER_SITE_BOARD,
  adapter: careerSiteAdapter,
  readKind: 'site_reader',
  // v30 S5: career sites' own terms cannot be read site by site (12 §3.4): reading them at all waits for the owner's
  // lawyer's view (SITE_READER_CAREER_PAGES, off), and robots.txt decides every read.
  terms: { status: 'allowed_with_conditions', url: null },
  transferKeys: ['host', 'sitemaps', 'postingPaths'],
  boardOf: (input) => careerSiteSourceOf(input)?.name ?? '',
  configOfBoard: (board) => careerSiteSourceOf(board)?.config ?? { host: board },
  hostOf: careerHostOfConfig,
};
