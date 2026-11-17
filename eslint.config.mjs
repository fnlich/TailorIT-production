// Lint config for packages/* and apps/api (apps/web has its own, based on eslint-config-next).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// v3.0 D2 (docs/design/part2/11-database.md §9.3): the async data layer's rules, as a plugin of this file.
// - no-raw-db: data access only through deps.db (core/db's DbClient); a `.prepare(` on a database handle outside
//   core/db is an error (v3.0 INT-1, once the D2 shim was gone), as is importing better-sqlite3.
// - no-io-in-tx: a transaction never waits for outside I/O: it holds a pool connection and its row locks while it
//   waits. The tests' runtime guard fails such a tx, and this names the known clients where they are written.
// The named exceptions (DATA_LAYER_EXCEPTIONS below) are the only files that open a SQLite file (v3.0 RET retired
// SQLite as TailorIT's database; apps/api/test/structure-sqlite.test.ts scans every import of better-sqlite3).

/** Names whose `.prepare(` is a database handle's: deps.db.legacy, db, raw, database, a handle's `legacy`. */
const DB_HANDLE = /^(db|raw|database|legacy|connection|sqlite)$/i;
/** Calls that reach outside the database (the AI queue, files, PDFs, HTTP, timers, child processes, mail). */
const IO_FUNCTIONS = new Set([
  'fetch',
  'request',
  'requireAi',
  'getFileStore',
  'getPdfService',
  'parsePdf',
  'parseDocx',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'spawn',
  'execFile',
  'exec',
  'readFile',
  'writeFile',
  'readFileSync',
  'writeFileSync',
  'rmSync',
  'renameSync',
  'mkdirSync',
  'sendMail',
]);
const IO_METHODS = new Set(['enqueue', 'waitFor', 'printPdf', 'screenshotPng', 'getJson', 'getText', 'sendMail', 'complete']);
const TX_METHODS = new Set(['tx', 'atomic', 'savepoint']);

/**
 * The files that open and drive a SQLite file of their own, each with its reason (v3.0 INT-1; v3.0 RET kept the two
 * exceptions when it retired SQLite, and better-sqlite3 stays a dependency for them alone): free_tailor's job lake, and
 * D0's SQLite seed tool. TailorIT's own database is PostgreSQL (core/db, deps.db).
 * v3.0 FIX-INT (REV-REQ REQ-4): this file imports nothing from tools/, and its tools/ globs and entries match nothing
 * when tools/ is absent (the production export drops it); the tool's lint is the root's `npm run lint:tools`.
 */
export const DATA_LAYER_EXCEPTIONS = [
  { file: 'apps/api/src/features/ingest/lake.ts', reason: "reads the job lake, free_tailor's own read-only SQLite file, never TailorIT's database" },
  { file: 'tools/mcp-scale/sqlite.ts', reason: "D0's SQLite seed tool: opens its scratch database and makes v2.0's schema (schema-v20.sql) in it" },
  { file: 'tools/mcp-scale/seed-scale.ts', reason: "D0's SQLite seed tool: fills the full-size scratch database (millions of rows) at bulk speed" },
  { file: 'tools/mcp-scale/seed-sql.ts', reason: "D0's SQLite seed tool: the bulk SQL the seed runs on its scratch database" },
];

const nameOf = (node) =>
  node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' && !node.computed ? node.property.name : null;

const dataLayer = {
  rules: {
    'no-raw-db': {
      meta: { type: 'problem', messages: { raw: 'Read and write through deps.db (one, all, run, tx), not a raw handle: v3.0 D2.' } },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== 'MemberExpression' || nameOf(callee) !== 'prepare') return;
            if (DB_HANDLE.test(nameOf(callee.object) ?? '')) context.report({ node, messageId: 'raw' });
          },
        };
      },
    },
    'no-io-in-tx': {
      meta: {
        type: 'problem',
        messages: { io: '{{name}} is outside I/O: never inside a transaction (do it before or after the tx): v3.0 D2.' },
      },
      create(context) {
        /** Whether `node` runs inside a function given to `.tx(`, `.atomic(` or `.savepoint(`. */
        const insideTx = (node) => {
          for (let at = node.parent; at; at = at.parent) {
            const fn = at.type === 'ArrowFunctionExpression' || at.type === 'FunctionExpression';
            if (fn && at.parent?.type === 'CallExpression' && at.parent.arguments.includes(at) && TX_METHODS.has(nameOf(at.parent.callee) ?? '')) {
              return at.parent.callee.type === 'MemberExpression';
            }
          }
          return false;
        };
        return {
          CallExpression(node) {
            const callee = node.callee;
            const name = callee.type === 'Identifier' ? callee.name : null;
            const method = callee.type === 'MemberExpression' ? nameOf(callee) : null;
            if (!(name && IO_FUNCTIONS.has(name)) && !(method && IO_METHODS.has(method))) return;
            if (insideTx(node)) context.report({ node, messageId: 'io', data: { name: `${name ?? method}()` } });
          },
        };
      },
    },
  },
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', 'apps/web/**', 'e2e/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // The templates are drawn by the editor and printed by the API from the same components, so they stay pure:
    // text and links become React elements (never raw HTML), and the only hooks are useContext and useSlots (which
    // reads a context).
    files: ['packages/resume-templates/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Inline markup becomes React elements; a template never writes raw HTML.',
        },
        {
          selector: 'CallExpression[callee.name=/^use(?!Context$|Slots$)[A-Z]/]',
          message: 'A template component uses no hook but useContext: it must draw the same in the editor and in the PDF.',
        },
      ],
    },
  },
  // v3.0 D2: the async data layer.
  {
    // A missed `await` on an async data call is no type error (a void call, a value passed on): typed linting finds
    // it. `npm run lint` covers apps/api/src; `npx eslint apps/api/test` the tests.
    files: ['apps/api/src/**/*.ts', 'apps/api/test/**/*.ts'],
    languageOptions: { parserOptions: { project: './apps/api/tsconfig.json', tsconfigRootDir: import.meta.dirname } },
    plugins: { 'data-layer': dataLayer },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      'data-layer/no-io-in-tx': 'error',
    },
  },
  {
    // v3.0 INT-1: errors. Only core/db drives the driver (PostgreSQL's); every feature reads and writes through deps.db.
    files: ['apps/api/src/**/*.ts', 'tools/mcp-scale/**/*.ts'],
    ignores: ['apps/api/src/core/db/**', ...DATA_LAYER_EXCEPTIONS.map((exception) => exception.file)],
    plugins: { 'data-layer': dataLayer },
    rules: {
      'data-layer/no-raw-db': 'error',
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'better-sqlite3', message: "TailorIT's database is PostgreSQL: read and write through deps.db (v3.0 D2, RET)." }] },
      ],
    },
  },
);
