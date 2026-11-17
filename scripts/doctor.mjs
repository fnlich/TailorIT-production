#!/usr/bin/env node
// `npm run doctor`: checks what TailorIT needs on this machine and says what to do about anything missing.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { databaseSettings, loadRootEnv, outsideSettings, readEnvText, repoRoot } from './env.mjs';
import { paint } from './proc.mjs';

loadRootEnv();
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

// Node
const major = Number(process.versions.node.split('.')[0]);
check('Node 24', major === 24, `found ${process.versions.node}`);

// The database: PostgreSQL 18 (v3.0; RET retired SQLite). DATABASE_URL names a server; without it the API starts the
// embedded server from npm (@embedded-postgres/<os>-<arch>), which on Windows needs the Microsoft Visual C++ 2015-2022
// x64 runtime, 14.44 or later (an older msvcp140.dll crashes initdb). Nothing here starts or opens the database.
const database = databaseSettings();
if (!database.embedded) {
  check('PostgreSQL', true, 'DATABASE_URL is set (a PostgreSQL 18 server)');
} else {
  const name = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  try {
    const require = createRequire(join(repoRoot, 'apps', 'api', 'package.json'));
    const binaries = await import(pathToFileURL(require.resolve(name)).href);
    const missing = ['initdb', 'pg_ctl', 'postgres'].filter((tool) => !binaries[tool] || !existsSync(binaries[tool]));
    const where = database.dataDir || 'DATA_DIR/pg';
    check(
      'PostgreSQL (embedded)',
      missing.length === 0,
      missing.length ? `${name} lacks ${missing.join(', ')} -> run: npm ci` : `${name}; data in ${where}, port ${database.port}`,
    );
  } catch (error) {
    check('PostgreSQL (embedded)', false, `${name} not installed (${error.message.split('\n')[0]}) -> run: npm ci, or set DATABASE_URL`);
  }
  if (process.platform === 'win32') {
    const runtime = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item "$env:SystemRoot\\System32\\msvcp140.dll").VersionInfo.ProductVersion'],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    const found = /^(\d+)\.(\d+)/.exec(runtime.stdout?.trim() ?? '');
    const recent = found !== null && (Number(found[1]) > 14 || (Number(found[1]) === 14 && Number(found[2]) >= 44));
    check(
      'Visual C++ 2015-2022 x64 runtime',
      recent,
      found
        ? `msvcp140 ${runtime.stdout.trim()}${recent ? '' : ' -> install the latest Microsoft Visual C++ 2015-2022 Redistributable (x64), 14.44 or later'}`
        : 'not found -> install the Microsoft Visual C++ 2015-2022 Redistributable (x64), 14.44 or later',
    );
  }
}

// v30 SCH: the new outside reads' identity (BOT_USER_AGENT) and the services' keys. Off is fine: each stays off until the
// owner supplies it (the API refuses a malformed BOT_USER_AGENT at start).
const outside = outsideSettings();
const bot = outside.bot;
check(
  'Bot identity (new outside reads)',
  !('error' in bot),
  'error' in bot
    ? `BOT_USER_AGENT ${bot.error} -> see "New outside reads" in .env.example`
    : bot.placeholder
      ? 'off (optional): BOT_USER_AGENT is blank or a placeholder, so new outside reads stay off'
      : bot.userAgent,
);
const keys = [['usajobs', 'USAJOBS'], ['himalayas', 'Himalayas'], ['logoDev', 'logo.dev']];
check('Outside services', true, keys.map(([key, name]) => `${name} ${outside.keys[key] ? 'key set' : 'off (no key)'}`).join(', '));

// Chrome for PDF rendering
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = chromeCandidates.find((p) => existsSync(p));
check('Chrome/Edge for PDF', Boolean(chrome), chrome ?? 'none found -> set CHROME_PATH or run: npm run setup:browser');

// Claude CLI (the AI provider)
const cli = process.env.AI_CLI_BIN || 'claude';
const shell = process.platform === 'win32';
const version = spawnSync(cli, ['--version'], { encoding: 'utf8', shell, windowsHide: true, timeout: 20_000 });
if (version.status !== 0) {
  check('claude CLI', false, 'not found -> npm i -g @anthropic-ai/claude-code, then: claude auth login');
} else {
  check('claude CLI', true, version.stdout.trim());
  const status = spawnSync(cli, ['auth', 'status'], { encoding: 'utf8', shell, windowsHide: true, timeout: 20_000 });
  let info = null;
  try {
    info = JSON.parse(status.stdout);
  } catch {
    /* not JSON */
  }
  check(
    'claude signed in (subscription)',
    Boolean(info?.loggedIn) && info?.authMethod !== 'api_key',
    info ? `loggedIn=${info.loggedIn} authMethod=${info.authMethod} plan=${info.subscriptionType ?? '?'}` : 'run: claude auth login',
  );
}
check('AI model', true, process.env.AI_CLI_MODEL || 'claude-sonnet-5-5 (default)');

// Addresses (.env.example's "Addresses" block): where each server listens, the address people open, and that they agree.
// The API checks each value itself at its start; this only reads them.
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const WILDCARD_HOST = /^(?:0\.0\.0\.0|::|\[::\])$/;
const bareHost = (host) => host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
const urlHost = (host) => (bareHost(host).includes(':') ? `[${bareHost(host)}]` : bareHost(host));
const webHost = process.env.WEB_HOST?.trim() || 'localhost';
const webPort = process.env.WEB_PORT?.trim() || '3100';
const apiHost = process.env.API_HOST?.trim() || '127.0.0.1';
const apiPort = process.env.API_PORT?.trim() || '4100';
const appOriginSetting = process.env.APP_ORIGIN?.trim() || 'http://localhost:3100';
let appOrigin = null;
try {
  const url = new URL(appOriginSetting);
  const plain = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && plain) appOrigin = url;
} catch {
  appOrigin = null;
}
const addressProblems = [];
if (!appOrigin) {
  addressProblems.push(`APP_ORIGIN=${appOriginSetting} is not an address such as http://192.168.1.20:3100 (no path)`);
} else {
  const openHost = bareHost(appOrigin.hostname);
  const openPort = appOrigin.port || (appOrigin.protocol === 'https:' ? '443' : '80');
  // APP_ORIGIN names the web server itself (this computer, or WEB_HOST), not a reverse proxy: the same port.
  if ((LOOPBACK_HOST.test(openHost) || openHost === bareHost(webHost)) && openPort !== webPort) {
    addressProblems.push(`APP_ORIGIN's port ${openPort} is not WEB_PORT ${webPort}`);
  }
  // A web server on one network address does not answer on this computer's loopback.
  if (LOOPBACK_HOST.test(openHost) && !LOOPBACK_HOST.test(webHost) && !WILDCARD_HOST.test(webHost)) {
    addressProblems.push(`APP_ORIGIN is on this computer, but the web server listens on WEB_HOST=${webHost} only`);
  }
}
// API_INTERNAL_URL (blank: API_HOST and API_PORT) still naming this computer's API at another port: a leftover.
const internal = process.env.API_INTERNAL_URL?.trim();
if (internal) {
  try {
    const url = new URL(internal);
    const host = bareHost(url.hostname);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if ((LOOPBACK_HOST.test(host) || host === bareHost(apiHost)) && port !== apiPort) {
      addressProblems.push(`API_INTERNAL_URL=${internal} is not at API_PORT ${apiPort} (blank it to follow API_PORT)`);
    }
  } catch {
    addressProblems.push(`API_INTERNAL_URL=${internal} is not an address`);
  }
}
const dialApi = WILDCARD_HOST.test(apiHost) || /^localhost$/i.test(apiHost) ? '127.0.0.1' : urlHost(apiHost);
const mcpEndpoint = process.env.MCP_PUBLIC_URL?.trim() || `http://${dialApi}:${apiPort}/mcp`;
check(
  'Addresses',
  addressProblems.length === 0,
  addressProblems.length
    ? `${addressProblems.join('; ')} -> see "Addresses" in .env.example`
    : `open ${appOrigin.origin}; web listens on ${webHost}:${webPort}, API on ${apiHost}:${apiPort}; MCP ${mcpEndpoint}`,
);
const exposed = [['WEB_HOST', webHost], ['API_HOST', apiHost]].filter(([, host]) => !LOOPBACK_HOST.test(host));
if (exposed.length) {
  const names = exposed.map(([name, host]) => `${name}=${host}`).join(', ');
  const fixedCode = Boolean(process.env.AUTH_DEV_FIXED_CODE?.trim()) && process.env.NODE_ENV !== 'production';
  check(
    'Network exposure',
    !fixedCode,
    fixedCode
      ? `${names} with AUTH_DEV_FIXED_CODE set: anyone on the network signs in as anyone -> clear AUTH_DEV_FIXED_CODE`
      : `${names}: other computers on the network can reach it (sign-in and tokens still apply)`,
  );
}

// Sign-in configuration
const google = Boolean(process.env.GOOGLE_CLIENT_ID);
const smtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
check('.env present', existsSync(join(repoRoot, '.env')), 'copy .env.example to .env');
check('Google sign-in', google, google ? `authorize ${appOrigin?.origin ?? appOriginSetting} on the OAuth client` : 'GOOGLE_CLIENT_ID not set');
check(
  'Email codes (SMTP)',
  smtp || process.env.NODE_ENV !== 'production',
  smtp ? `${process.env.SMTP_HOST}` : 'SMTP not set: in development, codes are printed by the API',
);
check('Admin accounts', Boolean(process.env.ADMIN_EMAILS), process.env.ADMIN_EMAILS || 'ADMIN_EMAILS not set (no admin)');

// Google Sheet import (optional): the service account key is a JSON key and git ignores it. Only the key's
// client_email is ever printed.
const keySetting = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim();
const keyFile = keySetting ? resolve(repoRoot, keySetting) : join(repoRoot, 'service-account-key.json');
if (!existsSync(keyFile)) {
  check('Google Sheet import', true, `off (optional): no key at ${keyFile}`);
} else {
  let key = null;
  try {
    if (statSync(keyFile).size <= 64 * 1024) key = JSON.parse(readEnvText(keyFile));
  } catch {
    key = null;
  }
  const valid =
    key !== null &&
    typeof key === 'object' &&
    (key.type === undefined || key.type === 'service_account') &&
    typeof key.client_email === 'string' &&
    key.client_email.trim() !== '' &&
    typeof key.private_key === 'string' &&
    key.private_key.includes('PRIVATE KEY');
  check(
    'Google Sheet import',
    valid,
    valid ? `share sheets with ${key.client_email} (Viewer)` : `${keyFile} is not a service account JSON key -> download a JSON key of the service account`,
  );
  const inRepo = relative(repoRoot, keyFile);
  if (inRepo && !inRepo.startsWith('..') && !isAbsolute(inRepo)) {
    const path = inRepo.split(sep).join('/');
    const ignored = spawnSync('git', ['check-ignore', '-q', path], { cwd: repoRoot, windowsHide: true, timeout: 20_000 });
    if (ignored.error) check('Key file git-ignored', true, 'git not found');
    else if (ignored.status === 0) check('Key file git-ignored', true, path);
    else if (ignored.status === 1) check('Key file git-ignored', false, `${path} could be committed -> add it to .gitignore`);
    else check('Key file git-ignored', true, 'not a git checkout');
  }
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? paint('green', 'ok  ') : paint('red', 'FAIL')} ${r.name.padEnd(width)}  ${paint('gray', r.detail ?? '')}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
