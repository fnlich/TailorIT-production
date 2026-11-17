import { isIP, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { AddressRefusedError, isPublicAddress, publicLookup, type AddressRule, type ResolveHost } from './address';

// v30 E2: the shared site reader's one way out (docs/design/part2/13-company-enrichment.md §4 rule 7; owner question
// 8's dependency, undici, installed by the coordinator). An undici Agent of its own, never Node's global dispatcher,
// whose connector resolves every name through address.ts's publicLookup and checks the connected socket's address
// once more: a private, loopback, link-local or reserved address is refused when the connection is made, for the first
// request and for every redirect hop (each hop is a request of its own: the reader follows redirects itself). One GET
// at a time per call, no redirect followed here, no cookie kept, the body read to at most `maxBytes` (gzip and brotli
// are unpacked by undici's fetch, so the cap counts the bytes as read).
//
// A test gives the reader a fake transport (or this one with a fixed resolver); an e2e server may put one on
// deps.services.siteReaderTransport (index.ts reads it first). Nothing here reads the network on its own.

/** One answer: its status and headers, and its body (2xx only; empty for any other status). */
export interface SiteAnswer {
  status: number;
  headers: { get(name: string): string | null };
  /** The body as read (2xx), at most `maxBytes` of it. */
  body: Buffer;
  /** The body (or its declared length) went past `maxBytes`: reading stopped there. */
  tooLarge: boolean;
}

export interface SiteGetOptions {
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  maxBytes: number;
}

/** One GET of an https address, redirects not followed. Rejects when no answer came (AddressRefusedError: nothing sent). */
export interface SiteTransport {
  get(url: string, options: SiteGetOptions): Promise<SiteAnswer>;
}

declare module '../../context' {
  interface AppServices {
    /** v30 E2: the site reader's transport, when not the default undici one (an e2e server's fixture transport). */
    siteReaderTransport?: SiteTransport;
  }
}

/** A body read to at most `maxBytes`: past it the stream is cancelled. */
async function bodyOf(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  if (!body) return { bytes: Buffer.alloc(0), tooLarge: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks), tooLarge: true };
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), tooLarge: false };
}

export interface UndiciTransportOptions {
  /** The resolver (default: the system's). Tests give a fixed table, so no name is ever looked up outside. */
  resolve?: ResolveHost;
  /** Which addresses may be connected to (default: the public ones). Only a test of the transport itself widens it. */
  allow?: AddressRule;
  /** The longest a connection may take to open (ms). */
  connectTimeoutMs?: number;
}

export interface ClosableSiteTransport extends SiteTransport {
  /** Closes the agent's connections. */
  close(): Promise<void>;
}

/** The reader's undici transport: the connect-time address check, no redirects followed, a capped body. */
export function createUndiciTransport(options: UndiciTransportOptions = {}): ClosableSiteTransport {
  const allow = options.allow ?? isPublicAddress;
  const base = buildConnector({ lookup: publicLookup(options.resolve, allow), timeout: options.connectTimeoutMs ?? 10_000 });
  const connect: buildConnector.connector = (connectOptions, callback) => {
    const host = connectOptions.hostname.replace(/^\[|\]$/g, '');
    // An address written as the host is never looked up: it is checked here, before anything is sent.
    if (isIP(host) !== 0 && !allow(host)) {
      callback(new AddressRefusedError(host), null);
      return;
    }
    base(connectOptions, (error: Error | null, socket: Socket | TLSSocket | null) => {
      if (error || !socket) {
        callback(error ?? new Error('No connection.'), null);
        return;
      }
      // The address the socket did connect to, checked once more (the lookup above already refused any other).
      const remote = socket.remoteAddress;
      if (!remote || !allow(remote)) {
        socket.destroy();
        callback(new AddressRefusedError(connectOptions.hostname), null);
        return;
      }
      callback(null, socket);
    });
  };
  const agent = new Agent({ connect, keepAliveTimeout: 4_000 });
  return {
    async get(url, { headers, signal, maxBytes }) {
      const response = await undiciFetch(url, { dispatcher: agent, redirect: 'manual', headers: { ...headers }, signal });
      const declared = Number(response.headers.get('content-length'));
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, headers: response.headers, body: Buffer.alloc(0), tooLarge: false };
      }
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, headers: response.headers, body: Buffer.alloc(0), tooLarge: true };
      }
      const { bytes, tooLarge } = await bodyOf(response.body, maxBytes);
      return { status: response.status, headers: response.headers, body: bytes, tooLarge };
    },
    close: () => agent.close(),
  };
}

let shared: ClosableSiteTransport | null = null;

/** The process's undici transport (made on first use). */
export function defaultSiteTransport(): SiteTransport {
  shared ??= createUndiciTransport();
  return shared;
}
