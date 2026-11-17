import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

// v30 E2: the connect-time address check of the shared site reader (docs/design/part2/13-company-enrichment.md §4
// rule 7, §12 "a company domain points at an internal address"; 11 §5.3a). outbound.ts checks names only: a public
// name may still resolve to this machine, the local network or a cloud's metadata address. The reader's connections
// (transport.ts) resolve each name through publicLookup below, which refuses the name when ANY address it resolves to
// is not a public one, so the socket is only ever opened to an address that was checked: there is no gap between the
// check and the connection, and a redirect's next host is checked the same way when its connection is made. An IP
// address written as the host is checked before anything is sent, and the connected socket's own remote address is
// checked once more (transport.ts).

/**
 * Address ranges that are never a public site (RFC 6890 and its updates): private, loopback, link-local, reserved. One
 * list per family: a BlockList also matches an IPv4 address against its IPv4-mapped IPv6 rules, and ::ffff:0:0/96 is
 * refused whole below.
 */
const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata services live here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) {
  NOT_PUBLIC_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and the old IPv4-compatible form
  ['::ffff:0:0', 96], // IPv4-mapped: a public name never resolves to one; it would hide a private IPv4 address
  ['64:ff9b::', 96], // NAT64 (its IPv4 address is reached through a gateway)
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo among them)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (it embeds an IPv4 address)
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC_V6.addSubnet(network, prefix, 'ipv6');
}

/** An address with its brackets taken off ("[::1]" -> "::1"). */
function bare(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

/** Whether `address` (an IPv4 or IPv6 address) is a public one TailorIT may connect to. Anything else is not. */
export function isPublicAddress(address: string): boolean {
  const value = bare(address.trim());
  // A zone ("fe80::1%eth0") names an interface of this machine.
  if (value.includes('%')) return false;
  const family = isIP(value);
  if (family === 4) return !NOT_PUBLIC_V4.check(value, 'ipv4');
  if (family === 6) return !NOT_PUBLIC_V6.check(value, 'ipv6');
  return false;
}

/** The connection was refused before it was made: the name has an address that is not public (nothing was sent). */
export class AddressRefusedError extends Error {
  readonly code = 'ERR_TAILORIT_ADDRESS_REFUSED';
  readonly host: string;
  constructor(host: string) {
    super(`TailorIT reads no site at ${host}: it does not resolve to public addresses only.`);
    this.name = 'AddressRefusedError';
    this.host = host;
  }
}

/** Whether `error` (or any error in its `cause` chain) is an AddressRefusedError. */
export function isAddressRefused(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 8; depth += 1) {
    if (at instanceof AddressRefusedError || (at as { code?: unknown }).code === 'ERR_TAILORIT_ADDRESS_REFUSED') return true;
    if (at instanceof AggregateError && at.errors.some((each) => isAddressRefused(each))) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** A name's addresses (the system's resolver by default; tests give a fixed table). */
export type ResolveHost = (hostname: string) => Promise<readonly LookupAddress[]>;

/** The system resolver (getaddrinfo), every address of the name. */
export const systemResolve: ResolveHost = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, order: 'verbatim' }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });

/** Which addresses may be connected to: the public ones (a test may allow its own loopback server, never product code). */
export type AddressRule = (address: string) => boolean;

/**
 * net.connect's `lookup` for the reader: the name's addresses from `resolve`, refused (AddressRefusedError) when any of
 * them fails `allow`, in the form net asks for (one address, or all of them for Happy Eyeballs).
 */
export function publicLookup(resolve: ResolveHost = systemResolve, allow: AddressRule = isPublicAddress): LookupFunction {
  return (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname).then(
      (found) => {
        const family = options.family === 4 || options.family === 6 ? options.family : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0;
        const addresses = family === 0 ? [...found] : found.filter((each) => each.family === family);
        if (addresses.length === 0) {
          const missing: NodeJS.ErrnoException = new Error(`${hostname} has no address.`);
          missing.code = 'ENOTFOUND';
          return callback(missing, '', 0);
        }
        if (addresses.some((each) => !allow(each.address))) return callback(new AddressRefusedError(hostname), '', 0);
        if (options.all) return callback(null, addresses);
        return callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0),
    );
  };
}
