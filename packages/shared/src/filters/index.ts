// v2.0: the prepare filters. schema.ts is the contract (W0-A); evaluate.ts and merge.ts are the pure logic (P4).
export * from './schema';
export * from './evaluate';
export * from './merge';
// v20 P4: the job facts' pure parts (the rules' extraction and the merge into job_facts) live beside the job modules
// and are exported here, so jobs/index.ts (not P4's) stays as it is. INT may move these two lines there.
export * from '../jobs/eligibility';
export * from '../jobs/facts-build';
