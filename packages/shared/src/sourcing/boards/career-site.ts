import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { configWords, hostOfTyped } from './url';

// v38 FRAME: an employer's own career site (v30 S5: its sitemaps and its posting pages' JSON-LD, read through the shared
// site reader while SITE_READER_CAREER_PAGES is on; the API's adapters/careerSite.ts). Any host: no platform, no lane.
// Which hosts are career sites (never an ATS platform's, LinkedIn or a refused board) is the API's rule (career/config.ts
// careerHostOfConfig, discovery/boards.ts careerSiteOfUrl), which its API part names (ingest/boards/career-site.ts).

export const CAREER_SITE_BOARD = defineBoard({
  kind: 'career_site',
  label: 'Career site',
  row: { access: 'structured_data', runs: true, precedence: 3, rawKeepDays: 30 },
  platform: 'site',
  hosts: null,
  domains: [],
  configKey: 'host',
  configSchema: z.strictObject({
    host: z.string().min(1),
    sitemaps: z.array(z.string()).optional(),
    postingPaths: z.array(z.string()).optional(),
    ...BOARD_CONFIG_COMMON,
  }),
  // The host as written, lower case (the API's career/config.ts checks it is one TailorIT may read).
  boardOf: (input) => (input.includes('.') ? hostOfTyped(input) : ''),
  configOfBoard: (board) => ({ host: board }),
  hostOf: (config) => (typeof config.host === 'string' && config.host.includes('.') ? hostOfTyped(config.host) || null : null),
  detail: (config) => (configWords(config, 'host') ? `Career site ${configWords(config, 'host')}` : null),
  examples: [
    {
      link: 'https://careers.acme-robotics.com/jobs/robotics-engineer-1234?utm_source=newsletter',
      clean: 'https://careers.acme-robotics.com/jobs/robotics-engineer-1234',
      board: null,
      externalId: null,
      found: null,
    },
  ],
});
