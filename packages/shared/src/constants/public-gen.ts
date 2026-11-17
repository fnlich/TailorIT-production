import { constantSpec, PUBLIC_CONSTANT_KEYS } from './constants';

// v20 FIX-A (SEC-5): writes ./public/specs.ts, the web's copy of the public constants' kinds, defaults and bounds,
// generated from this folder's table so every default still has one source. The web imports ./public only, never the
// table, whose budgets, prices and capacity threshold must not reach a browser. The web's test
// (apps/web/src/lib/constants.bundle.test.ts) compares the file with this text, and writes it when run with
// WRITE_PUBLIC_CONSTANTS=1 after a public constant is added or its default changes.

/** The generated module, from the repository root. */
export const PUBLIC_SPECS_FILE = 'packages/shared/src/constants/public/specs.ts';

/** The whole text of ./public/specs.ts for the table as it is now. */
export function publicSpecsModuleText(): string {
  const entries = PUBLIC_CONSTANT_KEYS.map((key) => {
    const spec = constantSpec(key);
    const parts = [`kind: ${JSON.stringify(spec.kind)}`, `default: ${JSON.stringify(spec.default)}`];
    if ('min' in spec && spec.min !== undefined) parts.push(`min: ${spec.min}`);
    if ('max' in spec && spec.max !== undefined) parts.push(`max: ${spec.max}`);
    return `  ${key}: { ${parts.join(', ')} },`;
  });
  return [
    '// GENERATED from ../constants.ts by publicSpecsModuleText() (../public-gen.ts): do not edit by hand. After a public',
    '// constant is added or changed, run WRITE_PUBLIC_CONSTANTS=1 npx vitest run apps/web/src/lib/constants.bundle.test.ts',
    "// v20 FIX-A (SEC-5): the public constants' kinds, defaults and bounds, for the web, which never imports the table.",
    "import type { PublicConstantSpecs } from '../constants';",
    '',
    'export const PUBLIC_CONSTANT_SPECS = {',
    ...entries,
    '} as const satisfies PublicConstantSpecs;',
    '',
  ].join('\n');
}
