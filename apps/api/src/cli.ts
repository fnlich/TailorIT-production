// Maintenance commands: `npm run db:migrate`, or `tsx src/cli.ts <command> [...args]`.
// Commands come from features (Feature.commands), so packages add theirs without editing this file; v30 ST4: the
// development commands (seed:*) come from the dev-only seam (dev-only/index.ts DEV_COMMANDS).
import { setupServices } from './app';
import { createRuntimeDeps } from './deps';
import { FEATURES } from './features/index';
// v30 ST4: the dev-only seam's commands (empty in the production export).
import { DEV_COMMANDS } from './dev-only/index';

const BUILT_IN: Record<string, string> = {
  'db:migrate': 'Apply pending database migrations (also done on every API start).',
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const featureCommands = new Map<string, NonNullable<(typeof FEATURES)[number]['commands']>[string]>();
  for (const feature of FEATURES) {
    for (const [name, run] of Object.entries(feature.commands ?? {})) featureCommands.set(name, run);
  }
  for (const [name, run] of Object.entries(DEV_COMMANDS)) featureCommands.set(name, run); // v30 ST4

  if (!command || command === 'help') {
    console.log('Commands:');
    for (const [name, text] of Object.entries(BUILT_IN)) console.log(`  ${name.padEnd(18)} ${text}`);
    for (const name of featureCommands.keys()) console.log(`  ${name}`);
    return;
  }

  const deps = await createRuntimeDeps(); // opening the database applies migrations
  try {
    if (command === 'db:migrate') {
      console.log('Database is up to date.');
      return;
    }
    const run = featureCommands.get(command);
    if (!run) {
      console.error(`Unknown command: ${command}. Run with "help" to list commands.`);
      process.exitCode = 2;
      return;
    }
    await setupServices(deps);
    await run(deps, args);
  } finally {
    await deps.db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
