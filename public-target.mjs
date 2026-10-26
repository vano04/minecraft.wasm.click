// Shared validation for the authenticated gateway and its private TCP hop.
// DNS names stay names: Cloudflare's TCP connector rejects a DNS answer that
// resolves to private space. IP literals are canonicalised before filtering so
// numeric/octal IPv4 and compressed/mapped IPv6 cannot bypass that boundary.
const publicIpv6Cidrs = [
  // IANA IPv6 Global Unicast Address Space, last updated 2025-10-10.
  // Unlisted 2000::/3 space is reserved for future allocation.
  // https://www.iana.org/assignments/ipv6-unicast-address-assignments/
  '2001:1::1/128', '2001:1::2/128', '2001:1::3/128', '2001:3::/32',
  '2001:4:112::/48',
  '2001:200::/23', '2001:400::/23', '2001:600::/23', '2001:800::/22',
  '2001:c00::/23', '2001:e00::/23', '2001:1200::/23', '2001:1400::/22',
  '2001:1800::/23', '2001:1a00::/23', '2001:1c00::/22', '2001:2000::/19',
  '2001:4000::/23', '2001:4200::/23', '2001:4400::/23', '2001:4600::/23',
  '2001:4800::/23', '2001:4a00::/23', '2001:4c00::/23', '2001:5000::/20',
  '2001:8000::/19', '2001:a000::/20', '2001:b000::/20', '2003::/18',
  '2400::/12', '2410::/12', '2600::/12', '2610::/23', '2620::/23',
  '2630::/12', '2800::/12', '2a00::/12', '2a10::/12', '2c00::/12',
].map(cidr => {
  const [address, length] = cidr.split('/');
  const shift = 128n - BigInt(length);
  return [ipv6Number(address) >> shift, shift];
});

function ipv6Number(address) {
  const sides = address.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const parts = sides.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt('0x' + part), 0n);
}

function publicIpv6(address) {
  const value = ipv6Number(address);
  return value !== null && publicIpv6Cidrs.some(([prefix, shift]) => value >> shift === prefix);
}

export function publicTcpTarget(host, port) {
  let hostname = String(host ?? '').trim().toLowerCase();
  const portText = String(port ?? '');
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) return null;
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!hostname || hostname.length > 253 || /[\u0000-\u0020/?#%@\\]/.test(hostname)) return null;
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  try {
    const url = new URL('http://' + (hostname.includes(':') ? '[' + hostname + ']' : hostname));
    if (url.username || url.password || url.port || url.pathname !== '/') return null;
    hostname = url.hostname.replace(/^\[|\]$/g, '');
  } catch { return null; }

  if (hostname.includes(':')) {
    // Only currently allocated, globally reachable unicast IPv6. The IANA
    // protocol block above is limited to its globally reachable assignments.
    if (!publicIpv6(hostname) || /^2001:db8:/i.test(hostname)) return null;
  } else if (/^[0-9.]+$/.test(hostname)) {
    const parts = hostname.split('.').map(Number);
    if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
        || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
        || (a === 203 && b === 0 && c === 113)) return null;
  } else {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname)) return null;
    const denied = ['localhost', 'local', 'internal', 'lan', 'home', 'home.arpa', 'onion'];
    if (['metadata', 'instance-data'].includes(hostname)
        || denied.some(suffix => hostname === suffix || hostname.endsWith('.' + suffix))) return null;
  }
  return { hostname, port: Number(portText) };
}
