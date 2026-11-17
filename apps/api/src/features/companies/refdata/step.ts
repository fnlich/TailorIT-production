import { constantsOf } from '../../../core/constants/index';
import { newReadsAllowed } from '../../../core/http/identity';
import { defineEnrichmentStep, type EnrichmentDeps } from '../enrich/registry';
import { refdataState } from './format';
import { createWikidataLookup } from './lookup';
import { matchCompany, RefdataReader, type OrgLookup } from './match';

// v30 E1: the enrichment queue's `wikidata`, `sec` and `gleif` names (docs/design/part2/13-company-enrichment.md §7:
// "live Wikidata lookups for new companies between builds"): one company matched against the refdata build in place
// (match.ts), and, when the build has nothing for its domain or its Wikidata key, a live Wikidata lookup (lookup.ts).
//
// The live lookup is a new kind of outside read: while BOT_USER_AGENT is the placeholder no lookup is made at all (the
// match uses the build alone). With neither a build in place nor live lookups the step is off: its names wait in the
// queue (the first build matches every company anyway).
//
// v30 FIX-C (W5 review SEC-5, DECISIONS P6.2): live lookups also need their own admin switch, REFDATA_LIVE_LOOKUPS (off
// by default): they read two Wikimedia APIs under the robots exemption list, the owner's call, which setting the bot's
// identity for the other new reads must not make.

/** Whether live Wikidata lookups may run now: the admin switch on and BOT_USER_AGENT set. */
export const liveLookupsOn = (deps: EnrichmentDeps): boolean => constantsOf(deps).get('REFDATA_LIVE_LOOKUPS') && newReadsAllowed(deps);

export const refdataStep = defineEnrichmentStep({
  name: 'refdata',
  handles: ['wikidata', 'sec', 'gleif'],
  async enabled(deps) {
    return liveLookupsOn(deps) || (await refdataState(deps.db)).ready;
  },
  async run(deps, work) {
    const state = await refdataState(deps.db);
    const lookup: OrgLookup | null = liveLookupsOn(deps) ? createWikidataLookup(deps) : null;
    await matchCompany(deps, work.companyId, { at: work.at, reader: new RefdataReader(deps.db, state.ready), lookup });
    return { kind: 'done' };
  },
});
