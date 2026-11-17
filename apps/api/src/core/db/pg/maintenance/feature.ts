import type { Feature } from '../../../feature';
import { checkPartitionsAtStartup, housekeepPartitions, partitionsDailyStep } from './housekeeping';

// v30 D5L: the database's own upkeep as a feature (features/index.ts lists it, last), so the server, the CLI and the
// tests run it through the usual hooks:
// - services: the start-up partition check, before any route or worker runs (it throws when today's partitions cannot
//   be made);
// - daily: the partitions' housekeeping (11-database.md §8.1);
// - commands: `db:partitions`, one housekeeping pass now, with what it did.
// The backups are not here: scripts/db-backup.mjs runs them (backup-cli.ts), a cold copy needs the server stopped.

export const dbMaintenanceFeature: Feature = {
  name: 'db-maintenance',
  services: async (deps) => {
    await checkPartitionsAtStartup(deps);
  },
  daily: [{ name: 'partitions', run: partitionsDailyStep }],
  commands: {
    'db:partitions': async (deps) => {
      const report = await housekeepPartitions(deps);
      console.log(`Partitions made: ${report.made.join(', ') || 'none'}`);
      console.log(`Partitions dropped: ${report.dropped.join(', ') || 'none'}`);
      for (const problem of report.problems) console.log(`Problem: ${problem}`);
      if (report.problems.length) process.exitCode = 1;
    },
  },
};
