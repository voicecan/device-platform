import { BlockList, isIP } from 'node:net';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
const nonPublicAddresses = new BlockList();
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
] as const) nonPublicAddresses.addSubnet(network, prefix, family);

export function validateDeviceWsUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Device WebSocket URL must be absolute'); }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('Device WebSocket URL must use ws:// or wss://');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Device WebSocket URL must not contain credentials, query, or fragment');
  return parsed.href;
}

function authority(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ? undefined : parsed;
  } catch { return undefined; }
}

function hostForUrl(hostname: string): string {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}

function bareHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Returns the current request address only when Host contains a publicly routable IP. */
export function publicRequestDeviceWsUrl(input: { requestHost?: string; secure: boolean }): string | undefined {
  const requestAuthority = authority(input.requestHost);
  if (!requestAuthority) return undefined;
  const hostname = bareHostname(requestAuthority.hostname);
  const family = isIP(hostname);
  if (!family || nonPublicAddresses.check(hostname, family === 4 ? 'ipv4' : 'ipv6')) return undefined;
  return `${input.secure ? 'wss' : 'ws'}://${requestAuthority.host}/device/v1/ws`;
}

export function resolveDeviceWsUrl(input: {
  requested?: string | null;
  configured?: string;
  requestHost?: string;
  advertiseHost: string;
  port: number;
}): string {
  if (input.requested) return validateDeviceWsUrl(input.requested);
  if (input.configured) return validateDeviceWsUrl(input.configured);
  const requestAuthority = authority(input.requestHost);
  if (requestAuthority && !loopbackHosts.has(requestAuthority.hostname)) {
    // Some firmware connects to a non-default TCP port but omits that port
    // from the WebSocket Host header. Keep the explicit Host port when it is
    // present; otherwise use the Server listener port so the derived HTTP
    // recording-upload origin remains reachable by the Device.
    const host = requestAuthority.port
      ? requestAuthority.host
      : `${hostForUrl(requestAuthority.hostname)}:${input.port}`;
    return `ws://${host}/device/v1/ws`;
  }
  return `ws://${hostForUrl(input.advertiseHost)}:${input.port}/device/v1/ws`;
}

export function deviceHttpBaseUrl(deviceWsUrl: string): string {
  const parsed = new URL(validateDeviceWsUrl(deviceWsUrl));
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href.replace(/\/$/, '');
}
