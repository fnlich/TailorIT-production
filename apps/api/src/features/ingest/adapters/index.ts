import type { SourceAdapter, SourceKind } from '../types';
import type { DefinedAdapter } from './define';
import { ftLakeAdapter } from './ftLake';
import { pageAdapter } from './page';
import { csvAdapter, jsonAdapter } from './tabular';
import { extPageAdapter } from './extPage'; // v30 X1-API
import { himalayasAdapter } from './himalayas'; // v30 S4
import { jobicyAdapter } from './jobicy'; // v30 S4
import { usajobsAdapter } from './usajobs'; // v30 S4
import { BOARD_ADAPTERS } from '../boards/index'; // v38 FRAME: every board kind's adapter, from the board registry
// v30 ST0: the dev-only seam's adapters (empty in the production export).
import { DEV_ADAPTERS } from '../../../dev-only/index';

// v30 ST4: the product's adapters, each made with defineAdapter (define.ts) and tested on recorded answers
// (apps/api/test/ingest-adapters-recorded.test.ts). The seed adapter is the dev-only seam's (DEV_ADAPTERS): a
// production install has none, and the service answers a seed source's run with "There is no reader" (it has no seed
// source: the demo jobs are dev-only too).
//
// v38 FRAME (SP v38 PLAN A1): a board kind's adapter is its board descriptor's (ingest/boards: Greenhouse, Lever, Ashby,
// Workable, Workday, the Workday career sites, the feed ATSs, BambooHR, iCIMS, career sites, and every later platform);
// the kinds that are no board are listed here.
const PRODUCT_ADAPTERS = {
  page: pageAdapter,
  csv: csvAdapter,
  json: jsonAdapter,
  ft_lake: ftLakeAdapter,
  // v30 X1-API: the published page jobs' source (never run).
  ext_page: extPageAdapter,
  // v30 S4: the US federal feed and the remote-job APIs (new kinds of read; USAJOBS and Himalayas with their keys).
  usajobs: usajobsAdapter,
  himalayas: himalayasAdapter,
  jobicy: jobicyAdapter,
  ...BOARD_ADAPTERS,
} satisfies Partial<Record<SourceKind, DefinedAdapter>>;

/** The adapters every install has. */
export type ProductSourceKind = keyof typeof PRODUCT_ADAPTERS;

/** One adapter per source kind (a development install's dev-only ones too). */
export const ADAPTERS: Readonly<Record<ProductSourceKind, SourceAdapter>> & Readonly<Partial<Record<SourceKind, SourceAdapter>>> = {
  ...PRODUCT_ADAPTERS,
  // v30 ST0
  ...DEV_ADAPTERS,
};
