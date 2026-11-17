import type { DbQueries } from '../../../core/db/types';
import { refdataState } from './format';

// v30 E1: the coverage report (docs/design/part2/13-company-enrichment.md §11 phase 1: "a coverage report (share of
// companies and of open jobs per field) goes to the owner"). Over the companies TailorIT may enrich (shared, not merged,
// not opted out): how many have each shown field, and how many of the open jobs belong to a company that has it; the
// same per open source (a company with a Wikidata, SEC or GLEIF row); the refdata build in place; the open reviews.
// One read of the profiles with the open-job counts (the partial index of open jobs per company).

/** The profile fields the report counts (13 §11's list: website, LinkedIn, industry, size, stage, HQ, founded, legal name). */
export const COVERAGE_FIELDS = [
  ['website', 'p.website IS NOT NULL'],
  ['linkedinUrl', 'p.linkedin_url IS NOT NULL'],
  ['industry', 'p.industry IS NOT NULL'],
  ['sizeBucket', 'p.size_bucket IS NOT NULL'],
  ['employees', 'p.employees IS NOT NULL'],
  ['stage', 'p.stage IS NOT NULL'],
  ['headquarters', '(p.hq_city IS NOT NULL OR p.hq_country_code IS NOT NULL)'],
  ['foundedYear', 'p.founded_year IS NOT NULL'],
  ['legalName', 'p.legal_name IS NOT NULL'],
  ['logo', 'p.logo_path IS NOT NULL'],
  ['summary', 'p.summary IS NOT NULL'],
] as const;
export const COVERAGE_SOURCES = ['wikidata', 'sec', 'gleif'] as const;

export interface CoverageLine {
  name: string;
  companies: number;
  /** Share of the companies (0 to 1). */
  companyShare: number;
  /** Open jobs whose company has it. */
  openJobs: number;
  openJobShare: number;
}

export interface CoverageReport {
  at: string;
  companies: number;
  companiesWithOpenJobs: number;
  openJobs: number;
  fields: CoverageLine[];
  sources: CoverageLine[];
  refdata: { ready: boolean; buildId: number | null; builtAt: string | null; wdOrgs: number; secFilers: number; gleifEntities: number } | null;
  openReviews: Record<string, number>;
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0);

/** The report now. */
export async function coverageReport(db: DbQueries, at: string): Promise<CoverageReport> {
  const columns = [
    ...COVERAGE_FIELDS.map(([name, test]) => [name, test] as const),
    ...COVERAGE_SOURCES.map(
      (kind) => [`source:${kind}`, `EXISTS (SELECT 1 FROM company_sources s WHERE s.company_id = c.id AND s.kind = '${kind}' AND s.status = 'ok')`] as const,
    ),
  ];
  const select = columns
    .map(
      ([, test], index) =>
        `count(*) FILTER (WHERE ${test})::bigint AS c${index}, coalesce(sum(o.n) FILTER (WHERE ${test}), 0)::bigint AS j${index}`,
    )
    .join(',\n      ');
  const row = (await db.one<Record<string, number>>(
    `WITH open AS (SELECT company_id, count(*) AS n FROM jobs WHERE active /* held_since: counts (a report) */ GROUP BY company_id)
     SELECT count(*)::bigint AS companies, count(o.company_id)::bigint AS with_open, coalesce(sum(o.n), 0)::bigint AS open_jobs,
      ${select}
     FROM companies c JOIN company_profiles p ON p.company_id = c.id LEFT JOIN open o ON o.company_id = c.id
     WHERE c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND NOT c.do_not_fetch`,
  ))!;
  const companies = Number(row.companies);
  const openJobs = Number(row.open_jobs);
  const lines = columns.map(([name], index) => ({
    name,
    companies: Number(row[`c${index}`]),
    companyShare: share(Number(row[`c${index}`]), companies),
    openJobs: Number(row[`j${index}`]),
    openJobShare: share(Number(row[`j${index}`]), openJobs),
  }));
  const state = await refdataState(db);
  let refdata: CoverageReport['refdata'] = null;
  if (state.ready) {
    const counts = (await db.one<{ orgs: number; filers: number; entities: number }>(
      `SELECT (SELECT count(*) FROM refdata.wd_orgs)::bigint AS orgs, (SELECT count(*) FROM refdata.sec_filers)::bigint AS filers,
         (SELECT count(*) FROM refdata.gleif_entities)::bigint AS entities`,
    ))!;
    refdata = {
      ready: true,
      buildId: state.buildId,
      builtAt: state.builtAt,
      wdOrgs: Number(counts.orgs),
      secFilers: Number(counts.filers),
      gleifEntities: Number(counts.entities),
    };
  } else if (state.stale) {
    refdata = { ready: false, buildId: state.buildId, builtAt: state.builtAt, wdOrgs: 0, secFilers: 0, gleifEntities: 0 };
  }
  const reviews = await db.all<{ kind: string; n: number }>(
    "SELECT kind, count(*)::int AS n FROM company_match_reviews WHERE status = 'open' GROUP BY kind ORDER BY kind",
  );
  return {
    at,
    companies,
    companiesWithOpenJobs: Number(row.with_open),
    openJobs,
    fields: lines.slice(0, COVERAGE_FIELDS.length),
    sources: lines.slice(COVERAGE_FIELDS.length).map((line) => ({ ...line, name: line.name.slice('source:'.length) })),
    refdata,
    openReviews: Object.fromEntries(reviews.map((review) => [review.kind, review.n])),
  };
}

const percent = (value: number) => `${(value * 100).toFixed(1)} %`;

/** The report as Markdown, for the owner (the command prints it). */
export function coverageMarkdown(report: CoverageReport): string {
  const lines = [
    `# Company coverage, ${report.at.slice(0, 10)}`,
    '',
    `${report.companies.toLocaleString('en-US')} companies (${report.companiesWithOpenJobs.toLocaleString('en-US')} with open jobs), ` +
      `${report.openJobs.toLocaleString('en-US')} open jobs.`,
    report.refdata?.ready
      ? `Reference data: build ${report.refdata.buildId ?? '?'} of ${report.refdata.builtAt?.slice(0, 10) ?? '?'}: ` +
        `${report.refdata.wdOrgs.toLocaleString('en-US')} Wikidata organisations, ${report.refdata.secFilers.toLocaleString('en-US')} SEC filers, ` +
        `${report.refdata.gleifEntities.toLocaleString('en-US')} GLEIF entities.`
      : report.refdata
        ? 'Reference data: the build in place was made by other schema files; run a new build.'
        : 'Reference data: no build yet.',
    '',
    '| Field | Companies | Share | Open jobs | Share |',
    '|---|---:|---:|---:|---:|',
    ...report.fields.map(
      (line) => `| ${line.name} | ${line.companies.toLocaleString('en-US')} | ${percent(line.companyShare)} | ${line.openJobs.toLocaleString('en-US')} | ${percent(line.openJobShare)} |`,
    ),
    '',
    '| Source | Companies | Share | Open jobs | Share |',
    '|---|---:|---:|---:|---:|',
    ...report.sources.map(
      (line) => `| ${line.name} | ${line.companies.toLocaleString('en-US')} | ${percent(line.companyShare)} | ${line.openJobs.toLocaleString('en-US')} | ${percent(line.openJobShare)} |`,
    ),
    '',
    `Open reviews: ${Object.entries(report.openReviews).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'none'}.`,
  ];
  return `${lines.join('\n')}\n`;
}
