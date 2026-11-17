import type { JobSourceKind } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { hostOf } from '../sources';
import { candidateName } from './boards';
import { offerToDiscovery } from './offer';
import { candidateConfig } from './validate';
import { claimCount, discoveryDayOf, probeCounter, releaseCount } from './state';

// v30 S2: name probes, discovery's sixth signal (docs/design/part2/12-job-sourcing.md §4.1 signal 6): for a company
// TailorIT knows with no board, its likely board names (its name, its domain's first label) are tried on each of the
// four public APIs. Each guess is a candidate (`probe`), which validation reads once like any other (a wrong guess,
// a 404, is dropped at once); at most DISCOVERY_PROBES_PER_HOST_PER_DAY guesses a day per API host.
//
// BUILT AND OFF (PLAN §5, owner question 17: "Not at first; decide after S2 measures how many known companies have no
// board"): DISCOVERY_PROBES_PER_HOST_PER_DAY is 0, and at 0 a pass makes no guess and reads nothing. The measure the
// owner asked for is the funnel's `companiesWithoutBoard` (admin.ts). Its reads are validation reads: the identity
// guard ('discovery_validation') and DISCOVERY_VALIDATIONS_PER_DAY apply as well.

/** The kinds probes guess on: the four public APIs. */
export const PROBE_KINDS: readonly JobSourceKind[] = ['greenhouse', 'lever', 'ashby', 'workable'];
/** Companies one pass looks at (most open jobs first). */
export const PROBE_COMPANIES_PER_PASS = 200;

/** A company's likely board names: its name run together and hyphenated, its domain's first label; each once. */
export function probeGuesses(name: string, domain: string | null): string[] {
  const words = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|ag|bv|the)\b\.?/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const label = domain?.toLowerCase().replace(/^www\./, '').split('.')[0] ?? '';
  return [...new Set([words.join(''), words.join('-'), label].filter((guess) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(guess)))];
}

/** What a probe pass did. */
export interface ProbePass {
  /** False while DISCOVERY_PROBES_PER_HOST_PER_DAY is 0 (nothing guessed, nothing read). */
  on: boolean;
  companies: number;
  /** Guesses made into candidates. */
  added: number;
}

/** One probe pass (see the top): off at 0; else guesses made into `probe` candidates, per host under the day's cap. */
export async function probePass(deps: AppDeps): Promise<ProbePass> {
  const perHost = constantsOf(deps).get('DISCOVERY_PROBES_PER_HOST_PER_DAY');
  if (perHost <= 0) return { on: false, companies: 0, added: 0 };
  assertNewReadAllowed(deps, 'discovery_validation');
  const pass: ProbePass = { on: true, companies: 0, added: 0 };
  if (!deps.config.ingest.enabled) return pass;
  const day = discoveryDayOf(deps);
  // Shared companies with open jobs, no board alias, no source and not opted out: most open jobs first.
  const companies = await deps.db.all<{ id: number; name: string; domain: string | null }>(
    `SELECT c.id, c.name, p.domain FROM companies c
     LEFT JOIN company_profiles p ON p.company_id = c.id
     JOIN company_job_counts n ON n.company_id = c.id
     WHERE c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND NOT c.do_not_fetch AND n.open_jobs > 0
       AND NOT EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.kind = 'board')
       AND NOT EXISTS (SELECT 1 FROM job_sources s WHERE s.company_id = c.id)
     ORDER BY n.open_jobs DESC, c.id LIMIT ?`,
    [PROBE_COMPANIES_PER_PASS],
  );
  const full = new Set<string>();
  for (const company of companies) {
    pass.companies += 1;
    for (const guess of probeGuesses(company.name, company.domain)) {
      for (const kind of PROBE_KINDS) {
        const name = candidateName(kind, guess);
        if (!name) continue;
        const host = hostOf(kind, candidateConfig(kind, name)) ?? kind;
        if (full.has(host)) continue;
        // A guess already a candidate (any state) or a known source is not made again, and costs nothing.
        const known = await deps.db.one<{ id: number }>('SELECT id FROM job_source_candidates WHERE kind = ? AND name = ?', [kind, name]);
        if (known) continue;
        if (!(await claimCount(deps.db, day, probeCounter(host), perHost))) {
          full.add(host);
          continue;
        }
        const offered = await deps.db.tx((t) => offerToDiscovery(deps, t, { kind, name, via: 'probe', at: nowIso(deps) }));
        if (offered.outcome === 'added') pass.added += 1;
        else await releaseCount(deps.db, day, probeCounter(host));
      }
    }
    if (full.size >= PROBE_KINDS.length) break;
  }
  if (pass.added > 0) deps.log.info(`[discovery] name probes: ${pass.added} guesses for ${pass.companies} companies`);
  return pass;
}
