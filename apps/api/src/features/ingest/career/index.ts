// v30 S5: career pages (docs/design/part2/12-job-sourcing.md §3.4, §11 phase 5): employers' own career sites read
// through their sitemaps and the schema.org JobPosting data of each posting page, every read through the shared polite
// reader (core/seams.ts siteReader, E2's), behind the admin switch SITE_READER_CAREER_PAGES (off until the owner's
// lawyer's view, question 8) and the identity guard (BOT_USER_AGENT, question 7). The pieces:
//   switch.ts    the two gates;
//   config.ts    a career_site source's config;
//   guards.ts    robots.txt as kept and the opt-outs, checked before the reader is asked;
//   read.ts      one read through the reader, sorted for the run;
//   sitemap.ts   sitemaps (index, urlset, text, gzip) and the posting-page patterns;
//   jsonld.ts    the page's own JobPosting;
//   keys.ts      the `ld` and `ghjid` keys (and the `ats` key a gh_jid resolves to);
//   run.ts       one run of a site (the career_site adapter's fetch: ingest/adapters/careerSite.ts);
//   handoff.ts   the hiringOrganization hand-off to the company's sources (called by the store);
//   discover.ts  finding career sites (the daily step ingest.career_sites).

export { assertCareerPagesAllowed, careerPagesOn, CareerPagesOffError, CareerSiteOptedOutError, type CareerDeps } from './switch';
export { careerHostOfConfig, careerRobotsPaths, careerSiteConfigOf, careerSiteSourceOf, type CareerSiteConfig } from './config';
export { careerKeysOf, ghJobIdOf } from './keys';
export { expiredAt, jobPostingOf, pageJobPosting, type JobPostingData } from './jsonld';
export { careerPostingIdOf, readCareerSite } from './run';
export { handOffHiringOrganization } from './handoff';
export { careerSiteHostOf, careerSitesStep, discoverCareerSites, offerCareerSites } from './discover';
