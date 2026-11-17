import type { SourceAdapter, SourceKind } from '../types';
import type { DefinedAdapter } from './define';
import { ashbyAdapter } from './ashby';
import { ftLakeAdapter } from './ftLake';
import { greenhouseAdapter } from './greenhouse';
import { leverAdapter } from './lever';
import { pageAdapter } from './page';
import { csvAdapter, jsonAdapter } from './tabular';
import { workableAdapter } from './workable';
import { workdayAdapter } from './workday';
import { extPageAdapter } from './extPage'; // v30 X1-API
// v30 S3: Workday career sites (sitemaps) and the feed ATSs.
import { bamboohrAdapter } from './bamboohr';
import { breezyAdapter } from './breezy';
import { personioAdapter } from './personio';
import { recruiteeAdapter } from './recruitee';
import { workdaySiteAdapter } from './workdaySite';
import { himalayasAdapter } from './himalayas'; // v30 S4
import { jobicyAdapter } from './jobicy'; // v30 S4
import { usajobsAdapter } from './usajobs'; // v30 S4
import { careerSiteAdapter } from './careerSite'; // v30 S5
// v30 ST0: the dev-only seam's adapters (empty in the production export).
import { DEV_ADAPTERS } from '../../../dev-only/index';

// v30 ST4: the product's adapters, each made with defineAdapter (define.ts) and tested on recorded answers
// (apps/api/test/ingest-adapters-recorded.test.ts). The seed adapter is the dev-only seam's (DEV_ADAPTERS): a
// production install has none, and the service answers a seed source's run with "There is no reader" (it has no seed
// source: the demo jobs are dev-only too).
const PRODUCT_ADAPTERS = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workable: workableAdapter,
  workday: workdayAdapter,
  page: pageAdapter,
  csv: csvAdapter,
  json: jsonAdapter,
  ft_lake: ftLakeAdapter,
  // v30 X1-API: the published page jobs' source (never run).
  ext_page: extPageAdapter,
  // v30 S3: new kinds of read (scheduler.ts NEW_READ_KIND_OF: they run once the identity allows). Breezy and BambooHR
  // run only once an admin records their terms (they start `unchecked`).
  workday_site: workdaySiteAdapter,
  personio: personioAdapter,
  recruitee: recruiteeAdapter,
  breezy: breezyAdapter,
  bamboohr: bamboohrAdapter,
  // v30 S4: the US federal feed and the remote-job APIs (new kinds of read; USAJOBS and Himalayas with their keys).
  usajobs: usajobsAdapter,
  himalayas: himalayasAdapter,
  jobicy: jobicyAdapter,
  // v30 S5: employers' career sites through the shared reader (off: SITE_READER_CAREER_PAGES).
  career_site: careerSiteAdapter,
} satisfies Partial<Record<SourceKind, DefinedAdapter>>;

/** The adapters every install has. */
export type ProductSourceKind = keyof typeof PRODUCT_ADAPTERS;

/** One adapter per source kind (a development install's dev-only ones too). */
export const ADAPTERS: Readonly<Record<ProductSourceKind, SourceAdapter>> & Readonly<Partial<Record<SourceKind, SourceAdapter>>> = {
  ...PRODUCT_ADAPTERS,
  // v30 ST0
  ...DEV_ADAPTERS,
};
