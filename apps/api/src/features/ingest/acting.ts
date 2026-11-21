import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3, §4 "The route guard"): job ingestion's pages (Admin ›
// Sources, Runs, Import, Hosts, Purges, the sourcing report) are an administrator's own: never done on a profile shared
// with the signed-in person. Admin › Import nests the Google Sheet import's router (/api/admin/import/sheets), so its
// mount takes one whole-mount value (a table cannot reach a nested router).

/** Every ingest mount: /api/admin/sources, runs, import (with its nested sheets router), hosts, purges, sourcing. */
export const INGEST_ACTING: ActingSpec = 'never';
