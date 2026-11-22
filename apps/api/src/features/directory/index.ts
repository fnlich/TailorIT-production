import type { Feature } from '../../core/feature';
import { runReviewerCommand } from './reviewer';

// v34 DIRKIT (PLAN G8): what TailorIT's listing in Claude's Connectors Directory needs from the server itself (the
// rest of the kit is docs/directory and scripts/directory-check.mjs): `directory:reviewer`, the reviewer's account with
// sample data (reviewer.ts). A command only: no route, no service. `npm run directory:reviewer -- --email <address>`
// (scripts/directory-reviewer.mjs checks there is a database first, then runs it quietly).
export const directoryFeature: Feature = {
  name: 'directory',
  commands: { 'directory:reviewer': runReviewerCommand },
};
