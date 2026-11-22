// v34 ORIGIN2 (the ORIGIN2 review, finding 1): the dev guard, a small HTTP proxy in front of `next dev`
// (scripts/next-launch.mjs, `dev` and `dev-webpack` only; never `next start`).
//
// Why: next dev answers its own development tools to any request that has no Origin header (Next's cross-site check,
// node_modules/next/dist/server/lib/router-utils/block-cross-site-dev.js, lets such a request through). Any device that
// reaches the web server (WEB_HOST=0.0.0.0, a LAN address) and anyone through a test tunnel (cloudflared connects from
// 127.0.0.1) could then open the web server's Node inspector (/__nextjs_attach-nodejs-inspector answers its secret
// address, and a page in the owner's browser can then run code in that process, which holds the root .env), stop it
// (/__nextjs_restart_dev) or read the project's routes and errors (/_next/mcp).
//
// How: next dev listens on 127.0.0.1 at a port picked free at start (internal); this proxy listens where next dev
// listened before (WEB_HOST:WEB_PORT) and passes everything on unchanged (Host and every header kept, request and
// response streamed, the hot reload's WebSocket upgrades as raw sockets), except:
// - next dev's development tools (isDevToolPath) answer 404 unless the request is plainly the owner's browser on this
//   computer (isOwnBrowserHere): a loopback peer, no forwarding header (a tunnel or a proxy adds one), a Host that is
//   this computer's (localhost, 127.0.0.1 or [::1] with WEB_PORT) or APP_ORIGIN's, and no other site's page behind it
//   (an Origin of the same host only; Sec-Fetch-Site same-origin or none);
// - v34 FIX-API (the final security review, F3) and INT-2 (the coordinator's narrower rule): a WebSocket upgrade (next
//   dev's hot reload: the build's errors with their files and code, the pages compiled, messages that compile pages
//   and print in the owner's terminal) passes for the owner's browser on this computer (isOwnBrowserHere) and for a page
//   at APP_ORIGIN's address or one of the operator's exact extra addresses (TRUSTED_PUBLIC_HOSTS entries written with
//   their scheme, such as a LAN address) with no forwarding header and an Origin of that same address
//   (hotReloadAllowed). It is refused when the Host or the Origin names this computer (localhost, 127.0.0.1, [::1]) from
//   another computer or through a forwarder (before, a device could name this computer with Host localhost and a
//   matching Origin, and a forwarder that rewrites the Host got through), at a tunnel's host (*.trycloudflare.com and
//   every TRUSTED_PUBLIC_HOSTS pattern: ORIGIN's decision), and anywhere else. A tunnel page gets no hot reload (its
//   console shows the refused socket, and next dev's client reloads the page after 12 tries, about 40 s); a LAN page
//   at an exact address keeps it (next dev itself still checks its allowedDevOrigins: an IP address is in it, a name
//   only when DEV_ALLOWED_ORIGINS lists it); npm start has none at all;
// - v34 FIX-API (F1): a request from another computer (a peer that is not loopback) reaches next dev and the API with
//   that peer's address added to X-Forwarded-For, so the API never takes it for this computer (the fixed sign-in code).
// A TCP-level forward (ssh -R, a router's port forward, ngrok tcp) delivers a loopback peer with no forwarding header:
// nothing tells it apart from the owner's browser, so never expose npm run dev that way.
// Found in Next 16.3.8 (node_modules/next/dist: next-devtools/server/*-middleware.js, server/dev/middleware-*.js,
// server/mcp/get-mcp-middleware.js, server/lib/router-server.js, server/lib/chrome-devtools-workspace.js,
// shared/lib/constants.js REQUEST_INSIGHTS_DEV_ENDPOINT): every /__nextjs_* path (attach-nodejs-inspector, restart_dev,
// server_status, launch-editor, original-stack-frame(s), source-map, error_feedback, font/, disable_dev_indicator,
// devtools_config), /_next/mcp (the dev MCP server, on by default), /_next/development/request-insights and
// /.well-known/appspecific/com.chrome.devtools.json (the project's folder). After a Next upgrade, search those folders
// for '/__nextjs', '/_next/' and 'development &&' again.
import http from 'node:http';
import net from 'node:net';

/** Paths of next dev's own tools (lower case; a request path that contains one is a dev tool's). */
export const DEV_TOOL_MARKS = Object.freeze(['/__nextjs', '/_next/mcp', '/_next/development', '/.well-known/appspecific/com.chrome.devtools.json']);

/** Headers a tunnel, a proxy or a CDN adds: a request that carries one did not come straight from this computer's browser. */
export const FORWARDING_HEADERS = Object.freeze([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cdn-loop',
  'true-client-ip',
  'via',
]);

/** Hop-by-hop headers: about one connection, never passed on (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** The lowest port the internal port may be: above every port Next refuses (reserved) and every fixed port of TailorIT. */
const LOWEST_INTERNAL_PORT = 10_081;

/** The forms a request path may take on its way to Next's matching: as sent, as a URL parser resolves it, decoded. */
function pathViews(rawUrl) {
  const target = String(rawUrl ?? '').split(/[?#]/, 1)[0] ?? '';
  const views = new Set([target]);
  for (const make of [() => new URL(`http://n${target.startsWith('/') ? '' : '/'}${target}`), () => new URL(target, 'http://n/')]) {
    try {
      views.add(make().pathname);
    } catch {
      /* not a URL in that form: the other views stay */
    }
  }
  for (const view of [...views]) {
    try {
      views.add(decodeURIComponent(view));
    } catch {
      /* a malformed escape: the undecoded view is checked */
    }
  }
  return [...views].map((view) => view.toLowerCase().replace(/\\/g, '/'));
}

/** Whether a request to `rawUrl` (req.url) reaches one of next dev's own tools (DEV_TOOL_MARKS), in any spelling. */
export function isDevToolPath(rawUrl) {
  return pathViews(rawUrl).some((view) => DEV_TOOL_MARKS.some((mark) => view.includes(mark)));
}

/** Whether a socket's peer is this computer (127.x.x.x, ::1, or 127.x.x.x mapped into IPv6). */
export function isLoopbackPeer(address) {
  const bare = String(address ?? '').toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return bare === '::1' || (net.isIPv4(bare) && bare.startsWith('127.'));
}

/**
 * The Host headers of this computer's browser opening the web server at `port`: localhost, 127.0.0.1 and [::1] with
 * the port (and without it on port 80), and APP_ORIGIN's host.
 */
export function ownHosts(port, appOrigin) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]'].map((name) => `${name}:${port}`));
  if (Number(port) === 80) for (const name of ['localhost', '127.0.0.1', '[::1]']) hosts.add(name);
  try {
    if (appOrigin) hosts.add(new URL(appOrigin.trim()).host.toLowerCase());
  } catch {
    /* the API refuses a bad APP_ORIGIN at its start */
  }
  return hosts;
}

/** Whether `origin` (an Origin header) is the address `host` (a Host header) itself: same host, same port. */
export function originIsHost(origin, host) {
  if (typeof origin !== 'string' || typeof host !== 'string' || host === '') return false;
  try {
    const page = new URL(origin);
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
    if (page.origin !== origin.toLowerCase().replace(/\/$/, '')) return false;
    return page.host === new URL(`${page.protocol}//${host.toLowerCase()}`).host;
  } catch {
    return false;
  }
}

/**
 * Whether `req` is plainly the owner's browser on this computer opening TailorIT: a loopback peer, no forwarding
 * header, a Host in `hosts` (ownHosts), and no other page behind it (an Origin of the same address only; Sec-Fetch-Site,
 * when sent, same-origin or none).
 */
export function isOwnBrowserHere(req, hosts) {
  if (!isLoopbackPeer(req.socket?.remoteAddress)) return false;
  const headers = req.headers ?? {};
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return false;
  const host = String(headers.host ?? '').toLowerCase();
  if (!hosts.has(host)) return false;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  // The browser here opens next dev over plain http: its own page's Origin is http and this very address.
  return headers.origin === undefined || (headers.origin.startsWith('http:') && originIsHost(headers.origin, host));
}

// v34 INT-2 (the coordinator's decision on the final security review's F3: the narrower hot-reload rule).

/** This computer's own names, as a Host header or an Origin carries them (any port). */
const THIS_COMPUTER = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The host name of a Host header (`localhost:3100`, `[::1]:3100`) or, with `origin`, of an Origin; '' for neither. */
function hostNameOf(value, { origin = false } = {}) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') return '';
  try {
    return new URL(origin ? text : `http://${text}`).hostname;
  } catch {
    return '';
  }
}

/** Whether a Host header (or, with `origin`, an Origin) names this computer: localhost, 127.0.0.1 or [::1]. */
export function namesThisComputer(value, { origin = false } = {}) {
  return THIS_COMPUTER.has(hostNameOf(value, { origin }));
}

/** An entry written with its scheme: http(s)://, a host (an IPv6 address in brackets), an optional port, a lone `/`. */
const EXACT_ADDRESS = /^https?:\/\/(\[[0-9a-f:.]+\]|[^/:[\]@?#*\\]+)(?::\d{1,5})?\/?$/;

/**
 * The Host headers of the addresses whose pages get hot reload from any peer: APP_ORIGIN's and TRUSTED_PUBLIC_HOSTS's
 * exact addresses (the entries written with their scheme, ORIGIN2: `http://192.0.2.10:3100`), as a browser opening
 * them sends Host (host and port; no port on the scheme's default). Patterns and names without a scheme are tunnels.
 */
export function exactAddresses(appOrigin, trustedPublicHosts) {
  const hosts = new Set();
  const add = (value) => {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') hosts.add(url.host.toLowerCase());
    } catch {
      /* the API refuses a bad APP_ORIGIN or entry at its start */
    }
  };
  if (appOrigin) add(String(appOrigin).trim());
  for (const item of String(trustedPublicHosts ?? '').toLowerCase().split(/[\s,]+/)) {
    if (EXACT_ADDRESS.test(item)) add(item);
  }
  return hosts;
}

/** Cloudflare's quick tunnels: development's blank TRUSTED_PUBLIC_HOSTS, never given hot reload whatever is listed. */
export const TUNNEL_DEFAULT_PATTERN = '*.trycloudflare.com';

/**
 * The tunnels' hosts: `*.trycloudflare.com` and every TRUSTED_PUBLIC_HOSTS entry without a scheme (a `*.` pattern or a
 * name a proxy forwards, whose scheme comes from X-Forwarded-Proto), lower case, without a port.
 */
export function tunnelPatterns(trustedPublicHosts) {
  const patterns = new Set([TUNNEL_DEFAULT_PATTERN]);
  for (const item of String(trustedPublicHosts ?? '').toLowerCase().split(/[\s,]+/)) {
    if (item === '' || item === 'none' || item.includes('://')) continue;
    patterns.add(item.replace(/:\d{1,5}$/, ''));
  }
  return [...patterns];
}

/** Whether a Host header is a tunnel's (tunnelPatterns): `*.name` matches any name under it, a plain name itself. */
export function isTunnelHost(host, patterns) {
  const name = hostNameOf(host);
  if (name === '') return false;
  return patterns.some((pattern) => (pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern));
}

/**
 * Whether a WebSocket upgrade (next dev's hot reload) may pass: the owner's browser on this computer (isOwnBrowserHere),
 * or a page at an exact address (`addresses`: exactAddresses) with no forwarding header, no name of this computer in its
 * Host or Origin, not at a tunnel's host (`tunnels`: tunnelPatterns), no other site's page behind it (Sec-Fetch-Site)
 * and an Origin of that same address.
 */
export function hotReloadAllowed(req, hosts, addresses, tunnels) {
  if (isOwnBrowserHere(req, hosts)) return true;
  const headers = req.headers ?? {};
  // A tunnel, a proxy or a CDN in between (the reviewer's tunnel-forged-host): refused.
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return false;
  const host = String(headers.host ?? '').toLowerCase();
  const origin = headers.origin;
  // This computer's name from another computer (the reviewer's lan-forged-localhost): refused.
  if (namesThisComputer(host) || (origin !== undefined && namesThisComputer(origin, { origin: true }))) return false;
  // A tunnel's host, even when also listed exactly: ORIGIN's decision, no hot reload through a tunnel.
  if (isTunnelHost(host, tunnels)) return false;
  if (!addresses.has(host)) return false;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  return typeof origin === 'string' && originIsHost(origin, host);
}

/** `rawHeaders` without the hop-by-hop ones (and `drop`), as a raw list for http.request or writeHead. */
function passedHeaders(rawHeaders, drop = HOP_BY_HOP) {
  const kept = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (!drop.has(rawHeaders[i].toLowerCase())) kept.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return kept;
}

/**
 * v34 FIX-API (the final security review, F1): the headers a request is passed on with. From another computer (a peer
 * that is not loopback) its address is added to X-Forwarded-For (after any the client sent, as a proxy adds its own
 * hop), so the API sees a network client and never takes the request for this computer.
 */
export function upstreamHeaders(req) {
  const kept = passedHeaders(req.rawHeaders);
  const peer = String(req.socket?.remoteAddress ?? '');
  if (isLoopbackPeer(peer)) return kept;
  const sent = [];
  const rest = [];
  for (let i = 0; i + 1 < kept.length; i += 2) {
    if (kept[i].toLowerCase() === 'x-forwarded-for') sent.push(kept[i + 1]);
    else rest.push(kept[i], kept[i + 1]);
  }
  const address = peer.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '') || 'unknown';
  return [...rest, 'X-Forwarded-For', [...sent, address].join(', ')];
}

/** A path as the log may show it: printable characters only, short. */
const shown = (rawUrl) => String(rawUrl ?? '').split(/[?#]/, 1)[0].replace(/[^\w./%-]/g, '?').slice(0, 80);

/**
 * The guard's HTTP server (not listening): everything to next dev at 127.0.0.1:`targetPort`, but next dev's tools only
 * for the owner's browser here (`hosts`: ownHosts) and WebSockets only for it and for a page at an exact address
 * (`addresses`: exactAddresses; never at a tunnel's host, `tunnels`: tunnelPatterns). `log(line)` hears the first
 * refusals (at most 20 lines).
 */
export function createDevGuard({ targetPort, hosts, addresses = new Set(), tunnels = [TUNNEL_DEFAULT_PATTERN], log = () => {} }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const logged = new Set();
  /** The upgraded sockets (hot reload), ended with the server. */
  const upgraded = new Set();
  const note = (req, what) => {
    const line = `[next] Refused ${what} ${shown(req.url)} from ${req.socket?.remoteAddress ?? 'unknown'}: next dev's development tools answer the browser on this computer only.`;
    if (logged.has(line) || logged.size >= 20) return;
    logged.add(line);
    log(line);
  };

  const server = http.createServer((req, res) => {
    if (isDevToolPath(req.url) && !isOwnBrowserHere(req, hosts)) {
      note(req, 'a request to');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found.\n');
      return;
    }
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: upstreamHeaders(req), agent }, // v34 FIX-API
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, passedHeaders(answer.rawHeaders));
        answer.pipe(res);
        answer.on('error', () => res.destroy());
      },
    );
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '2' });
      res.end("TailorIT's web server is starting. Try again in a moment.\n");
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const own = isOwnBrowserHere(req, hosts);
    const refuse = (status, what) => {
      note(req, what);
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (isDevToolPath(req.url) && !own) return refuse('404 Not Found', 'a socket to');
    // v34 FIX-API (the final security review, F3), INT-2 (the narrower rule): hot reload for the owner's browser here
    // and for a page at APP_ORIGIN's or an exact extra address; never one naming this computer from elsewhere, never a
    // tunnel's or a forwarded one.
    if (!own && !hotReloadAllowed(req, hosts, addresses, tunnels)) return refuse('403 Forbidden', 'a socket from another address to');
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upgraded.add(socket);
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => {
      upgraded.delete(socket);
      upstream.destroy();
    });
    upstream.on('close', () => socket.destroy());
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  /** Stops listening and ends every connection, the upgraded ones too. */
  server.shut = () =>
    new Promise((done) => {
      server.close(() => done());
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      agent.destroy();
    });
  return server;
}

/**
 * Starts the guard on `listenHost`:`listenPort` in front of next dev at 127.0.0.1:`targetPort` (`appOrigin` and
 * `trustedPublicHosts`: APP_ORIGIN and TRUSTED_PUBLIC_HOSTS, for hot reload at the exact addresses). Resolves with the
 * server and the port it listens on (listenPort 0: one the system picked); rejects when it cannot listen (EADDRINUSE).
 */
export function startDevGuard({ listenHost, listenPort, targetPort, appOrigin, trustedPublicHosts, log }) {
  return new Promise((resolve, reject) => {
    // The owner's Host headers name the port it listens on: filled in once it listens (listenPort 0 in tests).
    const hosts = new Set();
    // v34 INT-2: the exact addresses and the tunnels, from APP_ORIGIN and TRUSTED_PUBLIC_HOSTS (next-launch.mjs).
    const addresses = exactAddresses(appOrigin, trustedPublicHosts);
    const tunnels = tunnelPatterns(trustedPublicHosts);
    const server = createDevGuard({ targetPort, hosts, addresses, tunnels, log });
    server.once('error', reject);
    server.listen(Number(listenPort), listenHost, () => {
      server.off('error', reject);
      const port = server.address().port;
      for (const host of ownHosts(port, appOrigin)) hosts.add(host);
      resolve({ server, port, close: () => server.shut() });
    });
  });
}

/** A free port on 127.0.0.1 for next dev behind the guard, picked by the system (never a fixed offset of WEB_PORT). */
export async function freeLoopbackPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const picked = server.address().port;
        server.close(() => resolve(picked));
      });
    });
    if (port >= LOWEST_INTERNAL_PORT) return port;
  }
  throw new Error('No free port above 10080 on 127.0.0.1 for next dev.');
}

/**
 * Where Next listens for `mode` (next-launch.mjs's modes), and whether the guard stands in front: `dev` and
 * `dev-webpack` put next dev on 127.0.0.1:`internalPort` behind the guard at `host`:`port`; `start` listens at
 * `host`:`port` itself (next start has none of these tools); `build` listens nowhere.
 */
export function launchPlan({ mode, host, port, internalPort }) {
  if (mode === 'build') return { guard: false, next: null };
  if (mode === 'dev' || mode === 'dev-webpack') {
    return { guard: true, next: { host: '127.0.0.1', port: String(internalPort) }, listen: { host, port: String(port) } };
  }
  return { guard: false, next: { host, port: String(port) } };
}
