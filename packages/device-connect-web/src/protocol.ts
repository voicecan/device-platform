export const DEVICE_CONNECT_PROTOCOL = 1 as const;

export type DeviceConnectLocale = 'zh-CN' | 'en';

export type DeviceConnectInit = {
  type: 'voicecan-connect:init';
  version: typeof DEVICE_CONNECT_PROTOCOL;
  sessionId: string;
  state: string;
  locale: DeviceConnectLocale;
  callbackUrl: string;
  expiresAt: string;
  bleNamePrefix?: string;
};

export type DeviceConnectReady = { type: 'voicecan-connect:ready'; version: typeof DEVICE_CONNECT_PROTOCOL };

export type DeviceConnectRequest = {
  type: 'voicecan-connect:request';
  version: typeof DEVICE_CONNECT_PROTOCOL;
  requestId: string;
  method: 'claim' | 'progress' | 'observe' | 'complete';
  payload: Record<string, unknown>;
};

export type DeviceConnectResponse = {
  type: 'voicecan-connect:response';
  version: typeof DEVICE_CONNECT_PROTOCOL;
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type DeviceConnectCallback = {
  version: typeof DEVICE_CONNECT_PROTOCOL;
  sessionId: string;
  state: string;
  result: 'completed' | 'failed';
  provisioningSessionId?: string;
  deviceId?: string;
  error?: string;
  completedAt: number;
};

export function supportsLocalWebBluetooth(): boolean {
  return globalThis.isSecureContext && typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export function randomConnectValue(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const item of value) binary += String.fromCharCode(item);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function encodeConnectCallback(value: DeviceConnectCallback): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const item of bytes) binary += String.fromCharCode(item);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeConnectCallback(value: string): DeviceConnectCallback | undefined {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DeviceConnectCallback>;
    if (parsed.version !== DEVICE_CONNECT_PROTOCOL || typeof parsed.sessionId !== 'string' || parsed.sessionId.length > 128 || typeof parsed.state !== 'string' || parsed.state.length > 128 || !['completed', 'failed'].includes(String(parsed.result)) || typeof parsed.completedAt !== 'number' || !Number.isFinite(parsed.completedAt)) return undefined;
    if (parsed.provisioningSessionId !== undefined && typeof parsed.provisioningSessionId !== 'string') return undefined;
    if (parsed.deviceId !== undefined && typeof parsed.deviceId !== 'string') return undefined;
    if (parsed.error !== undefined && typeof parsed.error !== 'string') return undefined;
    return parsed as DeviceConnectCallback;
  } catch { return undefined; }
}
