import { defineConfig } from 'tsup';

// Production bundle of the API. Internal workspace packages are source-only TypeScript, so they are
// bundled in; native and browser-driving modules stay external and load from node_modules at runtime.
export default defineConfig({
  // v3.0 PG-0: cluster-cli starts and stops the embedded PostgreSQL for scripts/start.mjs (dist/cluster-cli.js). v3.0
  // D5L (INT-2): backup-cli runs scripts/db-backup.mjs where tsx is not installed (dist/backup-cli.js). Named entries,
  // so each lands at dist/<name>.js (a list of paths kept their folders: dist/core/db/pg/cluster-cli.js).
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'cluster-cli': 'src/core/db/pg/cluster-cli.ts',
    'backup-cli': 'src/core/db/pg/maintenance/backup-cli.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@tailorit\//],
  external: [
    'better-sqlite3',
    'puppeteer-core',
    '@puppeteer/browsers',
    'pdf-parse',
    '@napi-rs/canvas',
    'pdfjs-dist',
    // v3.0 PG-0: the PostgreSQL client and the embedded server's binaries load from node_modules.
    'pg',
    'pg-copy-streams',
    'embedded-postgres',
    /^@embedded-postgres\//,
  ],
});
