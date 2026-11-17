import type { Feature } from '../../core/feature';
import { factsBackfillStep } from '../ingest/facts';
import { createJobFactsService } from './service';

// v2.0 P4 (06-filters-analysis.md, 01's 0825): each job's facts for the prepare filters. `deps.services.jobFacts`
// (ensure, read, refreshText); no routes. v3.0 DB-INGEST (11-database.md §5.5a): every open job has them, built at
// ingest (ingest/facts.ts); the daily backfill fills the open jobs that lack them (`job-facts.backfill`).

export const jobFactsFeature: Feature = {
  name: 'job-facts',
  services(deps) {
    deps.services.jobFacts = createJobFactsService(deps);
  },
  daily: [factsBackfillStep],
};
