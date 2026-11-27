import { LEVER_BOARD, leverRegionOf, leverSite } from '@tailorit/shared/sourcing';
import { leverAdapter, leverHost, leverPosting } from '../adapters/lever';
import { importBoardConfig, importText } from './configs';
import { configString, readPostingJson } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 FRAME: Lever's API part (its shared part: @tailorit/shared/sourcing LEVER_BOARD). One posting:
// /v0/postings/{site}/{id}?mode=json, on its EU host for an EU site. A link is read through the autofill contract's
// addable posting (autofill/jobs.ts).

const apiUrl = (ref: PostingRef) =>
  `${leverHost(ref.region)}/v0/postings/${encodeURIComponent(ref.board)}/${encodeURIComponent(ref.externalId)}?mode=json`;

export const LEVER: ApiBoardDescriptor<'lever'> = {
  board: LEVER_BOARD,
  adapter: leverAdapter,
  terms: { status: 'allowed', url: 'https://github.com/lever/postings-api' },
  transferKeys: ['site', 'region'],
  importable: true,
  // Its site, and its region (an EU site's postings are on Lever's EU host).
  importConfig: (given, name) => ({
    ...importBoardConfig(LEVER_BOARD, given, name),
    region: importText(given.region).toLowerCase() === 'eu' ? 'eu' : 'global',
  }),
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const board = leverSite(configString(source.config, 'site'));
      return board ? { kind: 'lever', board, externalId: sourceJobId, region: leverRegionOf(source.config) } : null;
    },
    apiUrl,
    read: (http, ref, options) => readPostingJson(http, apiUrl(ref), LEVER_BOARD.label, ref, options, leverPosting),
  },
};
