import { isIPv4 } from 'node:net';
import { isLoopbackHost, isPublicIpHost } from './addresses';
import type { AppConfig } from './env';

// v34 ORIGIN (PLAN G8 "Production knobs"): what the API warns about at its start (apps/api/src/index.ts logs each line
// at warn), never refuses: the release export's boot check starts production on http://localhost (docs/RELEASE-EXPORT.md
// §6). scripts/doctor.mjs checks the https address too.
// The ORIGIN security review: the web server passes every client's Host (as X-Forwarded-Host) and X-Forwarded-For on to
// the API from this machine, so with WEB_HOST on the network any computer there can claim a trusted tunnel's address or
// an address in Claude's range (finding 3); a TRUST_PROXY that trusts any peer (a number of proxies, uniquelocal,
// linklocal) lets a caller that reaches the API or the web server name its own address (finding 5).
// v34 ORIGIN2 (PLAN G7b): a plain-http exact address in TRUSTED_PUBLIC_HOSTS means other devices open TailorIT there:
// the start says so (or that WEB_HOST keeps them out), with what works there (email-code sign-in; the extension stays
// paired to APP_ORIGIN). The ORIGIN2 review: the Claude-range claim whenever WEB_HOST is on the network (6b); no advice
// to open the web server in production, where a proxy serves the address (6a); a separate warning for a plain-http
// address that is no private network's (3); next dev gives no hot reload at a name (7); an IP address written without a
// scheme (8). Other devices are best served by the production start (npm run build, then npm start); npm run dev keeps
// next dev's development tools to this computer (scripts/dev-guard.mjs).

type WarningConfig = Pick<AppConfig, 'isProduction' | 'appOrigin' | 'trustedPublicHosts' | 'trustProxy' | 'apiHost' | 'webHost'>;

/** Whether TRUST_PROXY trusts a peer by its position or its network, not by its exact addresses. */
function trustsAnyPeer(setting: AppConfig['trustProxy']): boolean {
  if (typeof setting === 'number') return setting > 0;
  if (typeof setting !== 'string') return false;
  return setting.split(',').some((item) => item === 'uniquelocal' || item === 'linklocal');
}

/** The start's warnings for `config`, each a sentence saying what to do. */
export function startWarnings(config: WarningConfig): string[] {
  const warnings: string[] = [];
  if (config.isProduction && !config.appOrigin.startsWith('https://')) {
    warnings.push(
      `[api] APP_ORIGIN=${config.appOrigin} is not https: Claude and ChatGPT connect only to https addresses, and sign-in ` +
        'cookies are not marked Secure. Put TailorIT behind https (DEPLOYMENT.md) and set APP_ORIGIN to that address.',
    );
  }
  // v34 ORIGIN2 (PLAN G7b): an exact address (written with its scheme) is the operator's own, honoured in production
  // too; the production warning is about hosts and patterns, whose scheme is forwarded (test tunnels).
  const entries = config.trustedPublicHosts;
  const listed = (list: typeof entries) => list.map((entry) => entry.text).join(',');
  const forwardedScheme = entries.filter((entry) => entry.origin === undefined);
  if (config.isProduction && forwardedScheme.length > 0) {
    warnings.push(
      `[api] TRUSTED_PUBLIC_HOSTS=${listed(forwardedScheme)} in production: requests through those hosts get OAuth addresses of their ` +
        'own. Leave them out unless you test through them.',
    );
  }
  // v34 ORIGIN2 (the ORIGIN2 review, finding 8): an IP address and port without a scheme is a host whose scheme comes
  // from X-Forwarded-Proto (https without one): a device opening it directly over http is refused there.
  for (const entry of forwardedScheme) {
    if (entry.wildcard || !isIPv4(entry.host)) continue;
    const address = `http://${entry.host}${entry.port === null ? '' : `:${entry.port}`}`;
    warnings.push(
      `[api] TRUSTED_PUBLIC_HOSTS=${entry.text} has no scheme, so it is read as a tunnel's or a proxy's host (https unless they say ` +
        `otherwise): a device opening ${address} directly is refused there. For another device on your network, write ${address}.`,
    );
  }
  const webOnNetwork = !isLoopbackHost(config.webHost);
  // v34 ORIGIN2: a plain-http exact address is one a device on the network opens anyway: claiming it gains nothing. The
  // review's finding 6b: Claude's range is claimed through X-Forwarded-For, whatever TRUSTED_PUBLIC_HOSTS holds.
  const claimable = entries.filter((entry) => !entry.origin?.startsWith('http:'));
  if (webOnNetwork && claimable.length > 0) {
    warnings.push(
      `[api] WEB_HOST=${config.webHost} with TRUSTED_PUBLIC_HOSTS=${listed(claimable)}: any computer that reaches the web server ` +
        "can claim a tunnel's address and an address in Claude's range. Do this on a network you trust only; else keep WEB_HOST on " +
        'this computer or leave those out of TRUSTED_PUBLIC_HOSTS (none trusts no host).',
    );
  } else if (webOnNetwork) {
    warnings.push(
      `[api] WEB_HOST=${config.webHost}: any computer that reaches the web server can claim an address in Claude's range (the web ` +
        'server passes X-Forwarded-For on), which has higher sign-in and MCP limits. Do this on a network you trust only.',
    );
  }
  // v34 ORIGIN2: another device opens TailorIT at a plain-http exact address (a LAN address beside APP_ORIGIN).
  const plainHttp = entries.filter((entry) => entry.origin?.startsWith('http:') && !isLoopbackHost(entry.host.replace(/^\[(.*)\]$/, '$1')));
  if (plainHttp.length > 0 && !webOnNetwork && !config.isProduction) {
    // The review's finding 6a: in production a proxy on this computer (Caddy) serves such an address; no advice there.
    warnings.push(
      `[api] TRUSTED_PUBLIC_HOSTS lists ${listed(plainHttp)}, but the web server listens on WEB_HOST=${config.webHost}, this computer ` +
        'only: other devices cannot open it there unless a proxy on this computer serves it. To serve other devices, set ' +
        "WEB_HOST=0.0.0.0 and use the production start (npm run build, then npm start); with npm run dev, next dev's development " +
        'tools still answer this computer only.',
    );
  } else if (plainHttp.length > 0 && webOnNetwork) {
    const names = plainHttp.filter((entry) => !entry.host.startsWith('[') && !isIPv4(entry.host));
    warnings.push(
      `[api] Other devices on your network can open TailorIT at ${listed(plainHttp)} (WEB_HOST=${config.webHost}), over plain http: ` +
        'anyone on that network can read what is sent there: use a network you trust, and let your router forward nothing to this ' +
        'computer. Sign in there with an email code (Google ' +
        `sign-in works at APP_ORIGIN only); the browser extension stays paired to APP_ORIGIN, ${config.appOrigin}.` +
        // The review's finding 7: next dev answers hot reload to IP addresses only (a name could be answered by another device).
        (!config.isProduction && names.length > 0
          ? ` npm run dev gives no hot reload at ${listed(names)} (a page there reloads after about 40 seconds): open the IP address, ` +
            'or use the production start.'
          : ''),
    );
  }
  // The review's finding 3: louder, for an address that may be on the internet (in every mode: a proxy may serve it).
  for (const entry of plainHttp.filter((item) => isPublicIpHost(item.host))) {
    warnings.push(
      `[api] WARNING: ${entry.text} (TRUSTED_PUBLIC_HOSTS) is not a private network address, and TailorIT answers there over plain ` +
        'http: anyone on the internet who can reach it reads everything sent there (sign-in codes, session cookies). Check that ' +
        'your router forwards nothing to this computer (no port forwarding, no DMZ) and that your provider or VPN does not route ' +
        'that address to it from outside; reach TailorIT from outside over https only (a tunnel, or APP_ORIGIN behind https).',
    );
  }
  const exposed = [
    ['API_HOST', config.apiHost],
    ['WEB_HOST', config.webHost],
  ].filter(([, host]) => !isLoopbackHost(host!));
  if (trustsAnyPeer(config.trustProxy) && exposed.length > 0) {
    warnings.push(
      `[api] TRUST_PROXY=${String(config.trustProxy)} trusts whatever connects, and ${exposed.map(([name, host]) => `${name}=${host}`).join(', ')} ` +
        "can be reached from the network: a caller there can name any address. Name the proxies' addresses instead (loopback,10.0.0.0/8).",
    );
  }
  return warnings;
}
