/**
 * Deciding whether the peer on the other end of the socket is a proxy we trust.
 *
 * crate is meant to run behind a reverse proxy, which means the client's real address
 * arrives in a header rather than on the connection. Headers are client-supplied text:
 * anyone talking to crate directly can put anything they like in `X-Forwarded-For`. The
 * only value a caller cannot choose is the address it opened the socket from, so a
 * forwarding header is worth something exactly when the socket peer is a proxy the
 * operator has told us about — and worth nothing otherwise.
 *
 * Hence this: a small CIDR matcher over `CRATE_TRUSTED_PROXIES`, with no dependency. It
 * is a handful of ranges compared a few times per request, and pulling in a package to
 * compare integers would be a supply-chain risk out of all proportion to the work.
 *
 * Addresses are compared as integers, not strings. `::1`, `0:0:0:0:0:0:0:1` and `[::1]`
 * are the same host written three ways, and a string comparison would say otherwise.
 */

/** A parsed range: the network address with host bits cleared, and how many bits count. */
export interface Cidr {
  value: bigint;
  bits: number;
  family: 4 | 6;
}

const WIDTH: Record<4 | 6, number> = { 4: 32, 6: 128 };

/** 0-255, decimal, no sign and no padding games. */
function octet(part: string): number | null {
  if (!/^\d{1,3}$/.test(part)) return null;
  const n = Number(part);
  return n <= 255 ? n : null;
}

function ipv4ToBig(input: string): bigint | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    const n = octet(part);
    if (n === null) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/**
 * Parse an address of either family into a comparable integer.
 *
 * An IPv4-mapped IPv6 address comes back as plain IPv4. A dual-stack listener reports a
 * v4 client as `::ffff:203.0.113.9`, and an operator who wrote `203.0.113.0/24` plainly
 * meant that client — so the two must compare equal or the trust list silently misses
 * every connection on such a socket.
 *
 * Returns null for anything it cannot read, rather than guessing. A misparse here would
 * mean trusting the wrong peer.
 */
export function ipToBig(input: string): { value: bigint; family: 4 | 6 } | null {
  // A bracketed literal and a zone index are both how an address is WRITTEN, not part of
  // the address: `[::1]` comes from URLs, `fe80::1%eth0` from link-local scoping.
  let text = input.trim().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text) return null;

  if (!text.includes(':')) {
    const v4 = ipv4ToBig(text);
    return v4 === null ? null : { value: v4, family: 4 };
  }

  // IPv6. "::" elides one or more all-zero groups and may appear at most once.
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (side: string): string[] | null => {
    if (!side) return [];
    const parts = side.split(':');
    return parts.some((p) => p === '') ? null : parts;
  };
  const head = groups(halves[0] ?? '');
  const tail = groups(halves[1] ?? '');
  if (!head || !tail) return null;

  // A trailing dotted quad ("::ffff:192.0.2.1") stands for the last two groups.
  const expand = (parts: string[]): string[] | null => {
    const last = parts[parts.length - 1];
    if (last === undefined || !last.includes('.')) return parts;
    const v4 = ipv4ToBig(last);
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    return [...parts.slice(0, -1), hi.toString(16), lo.toString(16)];
  };
  const headParts = expand(head);
  const tailParts = expand(tail);
  if (!headParts || !tailParts) return null;

  const present = headParts.length + tailParts.length;
  // Without "::" every group must be written out; with it, at least one must be elided.
  if (halves.length === 1 ? present !== 8 : present > 7) return null;

  const all = [...headParts, ...Array<string>(8 - present).fill('0'), ...tailParts];
  let value = 0n;
  for (const group of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }

  // ::ffff:0:0/96 is the IPv4-mapped range: everything above the low 32 bits is 0xffff.
  if (value >> 32n === 0xffffn) return { value: value & 0xffffffffn, family: 4 };
  return { value, family: 6 };
}

/** Clear the host bits, so a range written sloppily still describes the right network. */
function network(value: bigint, bits: number, family: 4 | 6): bigint {
  const width = WIDTH[family];
  if (bits === 0) return 0n;
  return value & (((1n << BigInt(bits)) - 1n) << BigInt(width - bits));
}

/**
 * One entry from the trust list: "10.0.0.0/8", "2001:db8::/32", or a bare address.
 *
 * A bare address is a single host, which is the common case — one proxy on one address.
 * Host bits below the prefix are masked off, so "10.0.0.7/24" means 10.0.0.0/24 rather
 * than being rejected for being untidy.
 */
export function parseCidr(entry: string): Cidr | null {
  const [addr, prefix, ...rest] = entry.trim().split('/');
  if (rest.length || addr === undefined) return null;

  const ip = ipToBig(addr);
  if (!ip) return null;

  const width = WIDTH[ip.family];
  let bits = width;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return null;
    bits = Number(prefix);
    if (bits > width) return null;
  }
  return { value: network(ip.value, bits, ip.family), bits, family: ip.family };
}

/**
 * Read the configured list: comma- or whitespace-separated.
 *
 * A malformed entry is skipped rather than thrown. This runs at startup, and refusing to
 * boot over one typo in a proxy list would take the whole service down to protect a
 * lockout counter. The entry simply does not grant trust, which fails closed.
 */
export function parseTrustedProxies(raw: string): Cidr[] {
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is Cidr => c !== null);
}

/** Is this address inside any configured range? An empty list trusts nobody. */
export function isTrustedProxy(ip: string | undefined, ranges: readonly Cidr[]): boolean {
  if (!ip) return false;
  const parsed = ipToBig(ip);
  if (!parsed) return false;
  return ranges.some(
    (r) => r.family === parsed.family && network(parsed.value, r.bits, r.family) === r.value,
  );
}
