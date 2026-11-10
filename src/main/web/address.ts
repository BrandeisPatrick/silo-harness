// Which network addresses web_fetch and web_search may connect to: public unicast only. Loopback, private, link-local
// (the cloud metadata address 169.254.169.254 among them), CGNAT, unique-local, multicast, unspecified, reserved and
// documentation ranges are refused, as are the IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64,
// 6to4, Teredo) when that address is one of them. Odd IPv4 literals (decimal, hex, octal, short dotted) never reach
// here as such: the URL parser turns them into the dotted form, and a host name that is not an address goes through
// DNS, whose answers are checked here too. Pure functions; no I/O.

import net from 'node:net';

/** [first address, prefix length] in IPv4 */
const V4_BLOCKED: ReadonlyArray<[number, number]> = [
  [ip4('0.0.0.0'), 8], // "this network", unspecified
  [ip4('10.0.0.0'), 8], // private
  [ip4('100.64.0.0'), 10], // CGNAT
  [ip4('127.0.0.0'), 8], // loopback
  [ip4('169.254.0.0'), 16], // link-local, cloud metadata
  [ip4('172.16.0.0'), 12], // private
  [ip4('192.0.0.0'), 24], // IETF protocol assignments
  [ip4('192.0.2.0'), 24], // documentation
  [ip4('192.88.99.0'), 24], // 6to4 relay anycast
  [ip4('192.168.0.0'), 16], // private
  [ip4('198.18.0.0'), 15], // benchmarking
  [ip4('198.51.100.0'), 24], // documentation
  [ip4('203.0.113.0'), 24], // documentation
  [ip4('224.0.0.0'), 4], // multicast
  [ip4('240.0.0.0'), 4], // reserved, broadcast
];

function ip4(s: string): number {
  const p = s.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** An IPv6 address as 8 sixteen-bit groups, or null when it is not one (a zone id is dropped). */
export function parseIPv6(s: string): number[] | null {
  let a = s.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (!net.isIPv6(a)) return null;
  // A trailing dotted quad becomes two groups
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const n = ip4(dotted[1]);
    a = a.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi: number, lo: number): number => ((hi << 16) >>> 0) + lo;

/** The reason an address may not be connected to ('loopback', 'private' …), or null for a public unicast address. */
export function blockedReason(address: string): string | null {
  const a = address.replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) {
    const n = ip4(a);
    if (!v4Blocked(n)) return null;
    if (n >>> 24 === 127) return 'loopback';
    if (n >>> 24 === 10 || n >>> 20 === ip4('172.16.0.0') >>> 20 || n >>> 16 === ip4('192.168.0.0') >>> 16) return 'private';
    if (n >>> 16 === ip4('169.254.0.0') >>> 16) return 'link-local';
    if (n >>> 22 === ip4('100.64.0.0') >>> 22) return 'shared (CGNAT)';
    if (n >>> 28 === 0xe) return 'multicast';
    if (n >>> 24 === 0) return 'unspecified';
    return 'reserved';
  }
  const g = parseIPv6(a);
  if (!g) return 'not an IP address';
  const zeroUpTo = (k: number) => g.slice(0, k).every((x) => x === 0);
  if (zeroUpTo(8)) return 'unspecified';
  if (zeroUpTo(7) && g[7] === 1) return 'loopback';
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), ::ffff:0:a.b.c.d (translated)
  if ((zeroUpTo(5) && g[5] === 0xffff) || zeroUpTo(6) || (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0)) {
    const inner = blockedReason(v4String(v4From(g[6], g[7])));
    return inner ? `${inner} (IPv4 in IPv6)` : null;
  }
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    const inner = blockedReason(v4String(v4From(g[6], g[7])));
    return inner ? `${inner} (NAT64)` : null;
  }
  // 6to4 2002::/16 carries the IPv4 address in groups 1 and 2
  if (g[0] === 0x2002) {
    const inner = blockedReason(v4String(v4From(g[1], g[2])));
    return inner ? `${inner} (6to4)` : null;
  }
  // Teredo 2001::/32: the client address is obfuscated; refuse it all
  if (g[0] === 0x2001 && g[1] === 0) return 'reserved (Teredo)';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'documentation';
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return 'discard';
  // Everything outside global unicast 2000::/3 is reserved
  if ((g[0] & 0xe000) !== 0x2000) return 'reserved';
  return null;
}

function v4String(n: number): string {
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** True for a host name that is a local name by its look: localhost, *.localhost, *.local, *.internal, *.home.arpa, a bare name. */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (net.isIP(h.replace(/^\[|\]$/g, ''))) return false;
  return h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa|intranet)$/.test(h) || !h.includes('.');
}

// ---------- Sites as registrable domains ----------

/** Suffixes under which each name is a site of its own (a small part of the Public Suffix List: the common ones). */
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ac.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.tw', 'org.tw', 'edu.tw', 'gov.tw', 'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'com.sg', 'edu.sg', 'gov.sg',
  'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'com.tr', 'org.tr', 'gov.tr', 'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.my', 'com.ph', 'com.vn', 'co.id', 'co.il', 'org.il', 'ac.il', 'co.th', 'ac.th', 'com.ua', 'com.pl', 'com.es', 'com.pt',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'blogspot.com',
  'appspot.com', 'web.app', 'firebaseapp.com', 'cloudfront.net', 'azurewebsites.net', 's3.amazonaws.com', 'fly.dev',
  'onrender.com', 'glitch.me', 'repl.co', 'readthedocs.io', 'substack.com', 'wordpress.com', 'tumblr.com',
]);

/**
 * The registrable domain of a host ("example.co.uk" for "www.example.co.uk"): what decides whether a redirect stays on
 * the same site. An IP address is its own site.
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  for (let take = 4; take >= 2; take--) {
    if (labels.length > take && MULTI_SUFFIXES.has(labels.slice(-take).join('.'))) return labels.slice(-(take + 1)).join('.');
  }
  return labels.slice(-2).join('.');
}
