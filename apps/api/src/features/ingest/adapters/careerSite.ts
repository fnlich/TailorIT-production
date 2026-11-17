import { careerRobotsPaths } from '../career/config';
import { defineAdapter } from './define';

// v30 S5: employers' career sites (docs/design/part2/12-job-sourcing.md §3.4, §11 phase 5): their sitemaps and the
// schema.org JobPosting data of each posting page, read through the shared polite reader (core/seams.ts siteReader),
// never through the ingest client: one identity (BOT_USER_AGENT), robots.txt before every read, one request to a host
// in SITE_READER_HOST_GAP_SECONDS, HTML only, no scripts run. Off until an admin turns on SITE_READER_CAREER_PAGES (the
// lawyer's view, owner question 8) and BOT_USER_AGENT names TailorIT's public bot page (question 7): a run refuses
// before it asks for anything (features/ingest/career/switch.ts), and the worker never picks such a source while either
// is off (scheduler.ts runnableKinds). Its hosts are any site's (`*`): the source's own host, whatever its config names.
// The run itself is features/ingest/career/run.ts, loaded when a run starts: it reads through core/seams, whose
// re-exports reach the ingest service and so this registry (adapters/index.ts), which must never wait on itself.

export const careerSiteAdapter = defineAdapter({
  kind: 'career_site',
  label: 'Career site (sitemaps and JobPosting data)',
  access: 'page',
  hosts: ['*'],
  robotsPaths: (source) => careerRobotsPaths(source.config),
  async fetch(source, ctx) {
    const { readCareerSite } = await import('../career/run');
    return readCareerSite(source, ctx);
  },
});
