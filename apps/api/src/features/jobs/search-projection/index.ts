// v3.0 PG-SEARCH: the search projection (`job_search`, 11-database.md §5.6). Writers call projectJob in the
// transaction of their change; the jobs feature's daily repair (repair.ts) fixes drift both ways.
export { projectJob, projectJobs, searchableSql, SEARCH_PROJECTION_VERSION } from './project';
export { fold, tokensOf, tsvectorOf, placeKeyOf, placeKeysOf, remoteKeyOf, eligibilityOf, RANK_WEIGHTS, rankSql } from './vectors';
