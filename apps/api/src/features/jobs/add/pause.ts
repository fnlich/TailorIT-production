// v31 LINK: whether the worker's outside work is paused (v3.1 RUNS: Admin › Runs' Pause all). The link queue's reads
// (an import's, a Google Sheet's, the lake's, an admin's links) are the worker's outside work and wait while it is; a
// person's own single add (POST /api/jobs/add, the tracker, the MCP tool, the extension) never does. v31 INT-1: RUNS'
// runsPaused (features/ingest/pause-state.ts) under the name the queue reads.
export { runsPaused as outsideWorkPaused } from '../../ingest/pause-state';
