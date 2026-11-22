#!/usr/bin/env node
// Runs Next for apps/web with the root `.env` loaded.
//
// Why a launcher (lessons from free_tailor's frontend/scripts/next.mjs):
// - npm runs scripts through cmd.exe on Windows, so `--port ${WEB_PORT:-3100}` would reach Next literally.
// - Next only reads `.env` files from its own directory; TailorIT keeps one `.env` at the repository root.
// - On Windows, Turbopack's `next dev` can die natively (0xC0000005) shortly after "Ready". `dev` then restarts once
//   with webpack's dev server (`next dev --webpack`).
// - Next listens on every network interface unless told otherwise, and in development AUTH_DEV_FIXED_CODE signs anyone
//   in as anyone: the server listens on WEB_HOST, by default this computer only.
// - v34 ORIGIN2 (the ORIGIN2 review, finding 1): next dev answers its development tools (its Node inspector, a restart,
//   its MCP endpoint) to any request without an Origin header, so `dev` and `dev-webpack` put next dev on 127.0.0.1 at a
//   port picked free at start, behind the dev guard (scripts/dev-guard.mjs) at WEB_HOST:WEB_PORT: it passes everything
//   on, but those tools only to the browser on this computer. `start` (next start has none of them) is unchanged.
//
// Usage: node scripts/next-launch.mjs <dev|dev-webpack|build|start>
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { freeLoopbackPort, launchPlan, startDevGuard } from './dev-guard.mjs'; // v34 ORIGIN2
import { loadRootEnv, repoRoot } from './env.mjs';
import { paint } from './proc.mjs';

loadRootEnv();

const MODES = {
  dev: ['dev'],
  'dev-webpack': ['dev', '--webpack'],
  build: ['build'],
  start: ['start'],
};

const mode = process.argv[2];
if (!MODES[mode]) {
  console.error(`usage: node scripts/next-launch.mjs <${Object.keys(MODES).join('|')}>`);
  process.exit(2);
}

const webDir = join(repoRoot, 'apps', 'web');
const require = createRequire(join(webDir, 'package.json'));
const nextBin = require.resolve('next/dist/bin/next');
const port = process.env.WEB_PORT || '3100';
// WEB_HOST: an IP address or a host name of this computer (a LAN address such as 192.168.1.20, or 0.0.0.0 for every
// network interface). "localhost" means 127.0.0.1: Node binds a host name to its first address only, ::1 on Windows,
// which would leave http://127.0.0.1:<port> refused; browsers opening http://localhost:<port> fall back to 127.0.0.1 by
// themselves. An IPv6 address may be written in brackets ([::1]); Next takes it without.
const hostSetting = process.env.WEB_HOST?.trim() || 'localhost';
const host = hostSetting.toLowerCase() === 'localhost' ? '127.0.0.1' : hostSetting.replace(/^\[(.*)\]$/, '$1');
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|::1|\[::1\])$/;

// Windows reports an access violation either unsigned or as the signed int32 of 0xC0000005.
const ACCESS_VIOLATION = new Set([3221225477, -1073741819]);

// v34 ORIGIN2: where Next listens (next dev behind the dev guard: dev-guard.mjs launchPlan).
const plan = launchPlan({
  mode,
  host,
  port,
  internalPort: mode === 'dev' || mode === 'dev-webpack' ? await freeLoopbackPort() : null,
});

function argsFor(nextArgs) {
  return plan.next === null ? nextArgs : [...nextArgs, '--port', plan.next.port, '--hostname', plan.next.host];
}

if (mode !== 'build' && !LOOPBACK.test(host)) {
  // The API ignores the fixed code in production (NODE_ENV=production, which `npm start` sets). v34 FIX-API (the final
  // security review, F1): it answers only this computer, unless the test servers' AUTH_DEV_FIXED_CODE_ANY_ADDRESS is on.
  const fixedCode = Boolean(process.env.AUTH_DEV_FIXED_CODE?.trim()) && process.env.NODE_ENV !== 'production';
  const fixedAnywhere = fixedCode && /^(1|true|yes|on)$/i.test(process.env.AUTH_DEV_FIXED_CODE_ANY_ADDRESS?.trim() ?? '');
  console.warn(
    paint(
      fixedAnywhere ? 'red' : 'yellow',
      `[next] WEB_HOST=${hostSetting}: the web server can be reached from other computers on the network.` +
        // v34 ORIGIN2: what the dev guard keeps to this computer, and the better fit for other devices.
        (plan.guard
          ? "\n[next] next dev's development tools (its Node inspector, restart, MCP endpoint) answer the browser on this " +
            'computer only (the dev guard). For other devices and tunnels the production start is the better fit: npm ' +
            'run build, then npm start.'
          : '') +
        (fixedAnywhere
          ? '\n[next] AUTH_DEV_FIXED_CODE is set with AUTH_DEV_FIXED_CODE_ANY_ADDRESS, so anyone on the network can sign in ' +
            'as any address, administrators included. Clear both, or set WEB_HOST=localhost.'
          : fixedCode
            ? '\n[next] AUTH_DEV_FIXED_CODE works only from this computer: other devices sign in with an emailed code.'
            : ''),
    ),
  );
}

// v34 ORIGIN2: the dev guard listens where next dev did; next dev behind it, on 127.0.0.1 only.
if (plan.guard) {
  try {
    const guard = await startDevGuard({
      listenHost: host,
      listenPort: plan.listen.port,
      targetPort: Number(plan.next.port),
      appOrigin: process.env.APP_ORIGIN,
      trustedPublicHosts: process.env.TRUSTED_PUBLIC_HOSTS, // v34 INT-2: hot reload at the exact addresses (a LAN page)
      log: (line) => console.warn(paint('yellow', line)),
    });
    const shownHost = host.includes(':') ? `[${host}]` : host;
    console.log(
      paint(
        'gray',
        `[next] TailorIT's web server: http://${shownHost}:${guard.port} (next dev behind it on 127.0.0.1:${plan.next.port}; open the first)`,
      ),
    );
  } catch (error) {
    const busy = error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE';
    console.error(
      paint(
        'red',
        busy
          ? `[next] Port ${port} is in use: stop whatever listens there, or set WEB_PORT.`
          : `[next] The web server could not listen on ${host}:${port}: ${error}`,
      ),
    );
    process.exit(1);
  }
}

function run(nextArgs, { allowFallback }) {
  const child = spawn(process.execPath, [nextBin, ...argsFor(nextArgs)], {
    cwd: webDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  const forward = (signal) => child.kill(signal);
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  child.on('exit', (code, signal) => {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    if (allowFallback && process.platform === 'win32' && signal == null && ACCESS_VIOLATION.has(code)) {
      console.error(
        paint(
          'yellow',
          `[next] Turbopack's dev server crashed natively (exit ${code}, 0xC0000005, vercel/next.js#95015).\n` +
            '[next] Restarting once with webpack: next dev --webpack. To choose webpack yourself: npm run dev:webpack',
        ),
      );
      run(MODES['dev-webpack'], { allowFallback: false });
      return;
    }
    process.exit(signal ? 1 : (code ?? 1));
  });
}

run(MODES[mode], { allowFallback: mode === 'dev' });
