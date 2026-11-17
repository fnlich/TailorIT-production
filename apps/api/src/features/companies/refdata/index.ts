import type { AppDeps } from '../../../core/context';
import { buildRefdata, rematch } from './build';
import { coverageMarkdown, coverageReport } from './coverage';

// v30 E1: company enrichment from open data (docs/design/part2/13-company-enrichment.md §3.2, §5, §6, §11 phase 1;
// 11-database.md §5.4).
//   format.ts    the `refdata` schema: its names, its files (migrations-pg/refdata), their fingerprint, the state
//   dumps/       the dump readers: Wikidata's entity dump, SEC's submissions, GLEIF's Golden Copy (files.ts: lines,
//                CSV, ZIP entries)
//   load.ts      a build's dumps into `refdata_next`
//   build.ts     the monthly build: its turn (refdata_builds), load, index, the swap, the matching pass, the report
//   match.ts     one company against the refdata: strong keys only, reviews, provenance rows, relations, the profile
//   industries.ts  the industry and stage mappings (labels, SIC codes)
//   lookup.ts    live Wikidata lookups (a new outside read: the identity guard, BOT_USER_AGENT)
//   coverage.ts  the coverage report
//   step.ts      the enrichment queue's wikidata / sec / gleif names (features/companies/enrich)
//
// The commands (features/companies/index.ts lists them; each is its own process, never the API's):
//   npm run refdata:build -- --from <folder> [--no-match]   the monthly build (the folder: wikidata/, sec/, gleif/)
//   npm run refdata:match                                   every company matched again, then the report
//   npm run refdata:coverage [-- --json]                    the coverage report now

export const REFDATA_USAGE =
  'Usage: refdata:build --from <folder> [--no-match]   (the folder holds wikidata/, sec/ and gleif/ dump files)\n' +
  '       refdata:match\n' +
  '       refdata:coverage [--json]';

/** The value of `--name <value>` or `--name=<value>`. */
function option(args: readonly string[], name: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === `--${name}`) return args[i + 1] ?? null;
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return null;
}

export const refdataCommands: Record<string, (deps: AppDeps, args: string[]) => Promise<void>> = {
  async 'refdata:build'(deps, args) {
    const from = option(args, 'from');
    if (!from) {
      console.log(REFDATA_USAGE);
      process.exitCode = 2;
      return;
    }
    const result = await buildRefdata(deps, { from, match: !args.includes('--no-match') });
    console.log(`Refdata build ${result.buildId} is in place.`);
    console.log(JSON.stringify(result.counts, null, 2));
    if (result.coverage) console.log(coverageMarkdown(result.coverage));
  },
  async 'refdata:match'(deps) {
    const { counts, coverage } = await rematch(deps);
    console.log(JSON.stringify(counts, null, 2));
    console.log(coverageMarkdown(coverage));
  },
  async 'refdata:coverage'(deps, args) {
    const report = await coverageReport(deps.db, deps.now().toISOString());
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : coverageMarkdown(report));
  },
};

export { buildRefdata, matchAll, rematch, startBuild, swapRefdata, RefdataBuildBusyError, STALE_MS } from './build';
export { coverageMarkdown, coverageReport, type CoverageReport } from './coverage';
export { refdataFingerprint, refdataState, readRefdataFiles, REFDATA_NEXT, REFDATA_OLD, REFDATA_SCHEMA } from './format';
export { companyKeysOf, decideWikidata, matchCompany, RefdataReader, type MatchResult, type OrgLookup } from './match';
export { createWikidataLookup, wikidataHttp, WIKIDATA_ENTITY, WIKIDATA_SPARQL } from './lookup';
export { refdataStep } from './step';
