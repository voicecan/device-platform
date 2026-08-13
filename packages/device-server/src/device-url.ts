const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

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
