import { useEffect, useRef, useState } from 'react';
import { DEVICE_CONNECT_PROTOCOL, mountDeviceConnector, randomConnectValue } from '@voicecan/device-connect-web';
import type { DeviceConnectInit, DeviceConnectReady, DeviceConnectRequest, DeviceConnectResponse } from '@voicecan/device-connect-web';
import type { ProvisioningBroker } from '@voicecan/device-web';
import { api } from './api.js';
import type { Locale } from './i18n.js';
import { Button } from './ui.js';

type ClaimState = { provisioningSessionId: string; continuationToken: string };
type RemoteClaimState = { continuationToken: string; deviceId: string };
type ApiClaim = { provisioning_session_id: string; continuation_token: string; device_id: string; device_token: string; wss_url: string; recovered?: boolean };

class DeviceApiError extends Error {
  constructor(readonly code: string, message: string, readonly data?: Readonly<Record<string, unknown>>) {
    super(`${code}: ${message}`);
    this.name = 'DeviceApiError';
  }
}

function alreadyClaimedDeviceId(error: unknown): string | undefined {
  if (!(error instanceof DeviceApiError) || error.code !== 'DEVICE_ALREADY_CLAIMED') return undefined;
  return typeof error.data?.device_id === 'string' && error.data.device_id ? error.data.device_id : undefined;
}

async function resolveAccessibleClaimedDeviceId(error: unknown, manufacturer: string, serialNumber: string): Promise<string | undefined> {
  const responseId = alreadyClaimedDeviceId(error);
  if (responseId) return responseId;
  if (!(error instanceof DeviceApiError) || error.code !== 'DEVICE_ALREADY_CLAIMED') return undefined;
  try {
    const devices = await api<Array<Readonly<Record<string, unknown>>>>('/devices');
    const match = devices.find((device) => device.manufacturer === manufacturer && device.sn === serialNumber);
    return typeof match?.id === 'string' && match.id ? match.id : undefined;
  } catch {
    return undefined;
  }
}

function provisioningDebug(event: string, details?: Readonly<Record<string, unknown>>): void {
  if (details) console.debug(`[Voicecan Provisioning] ${event}`, details);
  else console.debug(`[Voicecan Provisioning] ${event}`);
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function devicePost<T>(path: string, body: unknown): Promise<T> {
  provisioningDebug('API request', { method: 'POST', path });
  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json() as { success: boolean; code: string; message: string; data?: T | Readonly<Record<string, unknown>> };
  if (!response.ok || !payload.success) throw new DeviceApiError(payload.code, payload.message, payload.data as Readonly<Record<string, unknown>> | undefined);
  provisioningDebug('API response', { method: 'POST', path, status: response.status });
  return payload.data as T;
}

function localBroker(getGrant: () => string, getDeviceWsUrl: () => string, onAlreadyClaimed: (deviceId: string) => void, onGrantUsed: () => void): ProvisioningBroker {
  const claims = new Map<string, ClaimState>();
  return {
    claim: async ({ serialNumber, manufacturer, bluetoothName }) => {
      const deviceWsUrl = getDeviceWsUrl();
      provisioningDebug('Claiming selected device', { manufacturer, bluetooth_name: bluetoothName, custom_device_ws_url: Boolean(deviceWsUrl) });
      let data: ApiClaim;
      try {
        data = await devicePost<ApiClaim>('/provisioning-sessions/claim', { provisioning_token: getGrant(), serial_number: serialNumber, manufacturer, ...(bluetoothName ? { bluetooth_name: bluetoothName } : {}), ...(deviceWsUrl ? { device_ws_url: deviceWsUrl } : {}) });
      } catch (error) {
        const deviceId = await resolveAccessibleClaimedDeviceId(error, manufacturer, serialNumber);
        if (deviceId) onAlreadyClaimed(deviceId);
        throw error;
      }
      provisioningDebug('Device claim received', { device_id: data.device_id, device_ws_url: data.wss_url, temporary_credential_recovered: Boolean(data.recovered) });
      onGrantUsed();
      claims.set(data.device_id, { provisioningSessionId: data.provisioning_session_id, continuationToken: data.continuation_token });
      return { provisioningSessionId: data.provisioning_session_id, continuationToken: data.continuation_token, deviceId: data.device_id, rawToken: decodeBase64Url(data.device_token), wssUrl: data.wss_url, ...(data.recovered === undefined ? {} : { recovered: data.recovered }) };
    },
    reportProgress: async ({ provisioningSessionId, continuationToken, stage, failureCode }) => {
      provisioningDebug('Reporting provisioning progress', { provisioning_session_id: provisioningSessionId, stage, ...(failureCode ? { failure_code: failureCode } : {}) });
      await devicePost(`/provisioning-sessions/${encodeURIComponent(provisioningSessionId)}/progress`, { continuation_token: continuationToken, stage, ...(failureCode ? { failure_code: failureCode } : {}) });
    },
    waitForOnline: async (deviceId, timeoutMs, signal) => {
      const claim = claims.get(deviceId);
      if (!claim) throw new Error('PROVISIONING_SESSION_MISSING');
      const deadline = Date.now() + timeoutMs;
      let previousStatus = '';
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const state = await devicePost<{ status: string; failure_code?: string }>(`/provisioning-sessions/${encodeURIComponent(claim.provisioningSessionId)}/observe`, { continuation_token: claim.continuationToken });
        if (state.status !== previousStatus) { provisioningDebug('Observed provisioning status', { device_id: deviceId, status: state.status }); previousStatus = state.status; }
        if (state.status === 'completed') return true;
        if (state.status === 'failed') throw new Error(state.failure_code ?? 'PROVISIONING_FAILED');
        await new Promise<void>((resolve, reject) => {
          const timer = globalThis.setTimeout(resolve, 1_000);
          signal?.addEventListener('abort', () => { globalThis.clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      }
      return false;
    },
    observeOnline: async (deviceId, signal) => {
      const claim = claims.get(deviceId);
      if (!claim) throw new Error('PROVISIONING_SESSION_MISSING');
      signal?.throwIfAborted();
      const state = await devicePost<{ online: boolean }>(`/provisioning-sessions/${encodeURIComponent(claim.provisioningSessionId)}/observe`, { continuation_token: claim.continuationToken });
      signal?.throwIfAborted();
      return state.online;
    },
  };
}

type ProvisioningGrant = { provisioning_token: string; expires_at: string };
type CreateProvisioningGrant = () => Promise<ProvisioningGrant>;
type StartEmbeddedProvisioning = (createGrant: CreateProvisioningGrant) => Promise<void>;
export type StartRemoteProvisioning = (createGrant: CreateProvisioningGrant) => Promise<void>;

export function EmbeddedDeviceProvisioner({ deviceWsUrl, bleNamePrefix, locale, hidden, registerStart, onStepChange, onProvisioned, onAlreadyClaimed, onError }: {
  deviceWsUrl: string;
  bleNamePrefix: string;
  locale: Locale;
  hidden: boolean;
  registerStart: (start: StartEmbeddedProvisioning | undefined) => void;
  onStepChange: (step: number) => void;
  onProvisioned: () => void;
  onAlreadyClaimed: (deviceId: string) => void;
  onError: (error: unknown) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const deviceWsUrlRef = useRef(deviceWsUrl);
  deviceWsUrlRef.current = deviceWsUrl;
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true; let activeGrant = ''; let destroy: (() => void) | undefined; let redirecting = false;
    const mount = mountRef.current;
    if (!mount) return;
    provisioningDebug('Mounting embedded device connector', { custom_device_ws_url: Boolean(deviceWsUrl), ble_name_prefix: bleNamePrefix });
    void mountDeviceConnector({ mount, broker: localBroker(() => activeGrant, () => deviceWsUrlRef.current, (deviceId) => { redirecting = true; onAlreadyClaimed(deviceId); }, () => { activeGrant = ''; }), locale, coreModuleUrl: '/sdk/private/semantic_core.js', compact: true, bleNamePrefix, onProvisioned: () => onProvisioned(), onError: (error) => { if (!redirecting) onError(error); } }).then((connector) => {
      if (!active) { connector.destroy(); return; }
      const stepListener = (event: Event) => onStepChange(Number((event as CustomEvent).detail));
      connector.element.addEventListener('stepchange', stepListener);
      destroy = () => { connector.element.removeEventListener('stepchange', stepListener); connector.destroy(); };
      registerStart(async (createGrant) => connector.element.startProvisioning(async () => { const created = await createGrant(); activeGrant = created.provisioning_token; return activeGrant; }));
      setLoading(false);
    }).catch(onError);
    return () => { active = false; registerStart(undefined); activeGrant = ''; destroy?.(); };
  }, [bleNamePrefix, locale]);
  return <div className="embedded-device-flow" hidden={hidden}><div ref={mountRef}/>{loading ? <div className="loading-panel" role="status"><span className="spinner"/><span>{locale === 'zh-CN' ? '正在加载设备运行时…' : 'Loading device runtime…'}</span></div> : null}</div>;
}

export function RemoteDeviceProvisioner({ deviceWsUrl, bleNamePrefix, connectorUrl, locale, hidden, registerStart, onProvisioned, onAlreadyClaimed }: {
  deviceWsUrl: string;
  bleNamePrefix: string;
  connectorUrl: string;
  locale: Locale;
  hidden: boolean;
  registerStart: (start: StartRemoteProvisioning | undefined) => void;
  onProvisioned: () => void;
  onAlreadyClaimed: (deviceId: string) => void;
}) {
  const [status, setStatus] = useState(locale === 'zh-CN' ? '请在有蓝牙的电脑上继续' : 'Continue on a computer with Bluetooth');
  const cleanupRef = useRef<() => void>(() => undefined);
  const createGrantRef = useRef<CreateProvisioningGrant | undefined>(undefined);
  const reusableGrantRef = useRef<ProvisioningGrant | undefined>(undefined);
  const reopenRef = useRef<() => void>(() => undefined);
  const bluetoothUnavailableReason = !globalThis.isSecureContext
    ? (locale === 'zh-CN' ? '当前管理页不是安全上下文。浏览器只允许 HTTPS 或本机回环地址调用 Web Bluetooth。' : 'This Admin page is not a secure context. Browsers only allow Web Bluetooth on HTTPS or loopback addresses.')
    : (typeof navigator === 'undefined' || !('bluetooth' in navigator))
      ? (locale === 'zh-CN' ? '当前浏览器没有提供 Web Bluetooth，请改用支持该功能的 Chromium 浏览器。' : 'This browser does not provide Web Bluetooth. Use a Chromium browser that supports it.')
      : (locale === 'zh-CN' ? '当前管理环境无法直接调用 Web Bluetooth，因此需要使用安全配对页。' : 'This Admin environment cannot call Web Bluetooth directly, so the secure pairing page is required.');
  useEffect(() => {
    const openConnector = async (createGrant: CreateProvisioningGrant, reuseGrant: boolean): Promise<void> => {
      cleanupRef.current();
      let publicUrl: URL;
      try { publicUrl = new URL(connectorUrl); } catch { throw new Error('DEVICE_CONNECT_URL_INVALID'); }
      if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(publicUrl.hostname))) throw new Error('DEVICE_CONNECT_URL_MUST_BE_HTTPS');
      const popup = globalThis.open('about:blank', 'voicecan-device-connect', 'popup,width=1040,height=820');
      if (!popup) throw new Error(locale === 'zh-CN' ? '浏览器阻止了连接页面，请允许弹出窗口后重试。' : 'The browser blocked the connector window. Allow popups and try again.');
      setStatus(locale === 'zh-CN' ? '正在打开安全配对页…' : 'Opening the secure pairing page…');
      let created = reuseGrant && reusableGrantRef.current && Date.parse(reusableGrantRef.current.expires_at) > Date.now() ? reusableGrantRef.current : undefined;
      try { created ??= await createGrant(); } catch (error) { popup.close(); throw error; }
      reusableGrantRef.current = created;
      const grant = created.provisioning_token; const expiresAt = created.expires_at;
      const sessionId = randomConnectValue(); const state = randomConnectValue();
      localStorage.setItem(`voicecan.connect.state.${sessionId}`, state);
      const channel = new MessageChannel();
      const claims = new Map<string, RemoteClaimState>();
      let connected = false;
      const respond = (requestId: string, ok: boolean, data?: unknown, error?: string) => channel.port1.postMessage({ type: 'voicecan-connect:response', version: DEVICE_CONNECT_PROTOCOL, requestId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) } satisfies DeviceConnectResponse);
      const handleRequest = async (request: DeviceConnectRequest): Promise<unknown> => {
        if (request.method === 'claim') {
          const serialNumber = String(request.payload.serialNumber ?? ''); const manufacturer = String(request.payload.manufacturer ?? ''); const bluetoothName = typeof request.payload.bluetoothName === 'string' ? request.payload.bluetoothName : undefined;
          let data: ApiClaim;
          try {
            data = await devicePost<ApiClaim>('/provisioning-sessions/claim', { provisioning_token: grant, serial_number: serialNumber, manufacturer, ...(bluetoothName ? { bluetooth_name: bluetoothName } : {}), ...(deviceWsUrl ? { device_ws_url: deviceWsUrl } : {}) });
          } catch (error) {
            const deviceId = await resolveAccessibleClaimedDeviceId(error, manufacturer, serialNumber);
            if (deviceId) { popup.close(); onAlreadyClaimed(deviceId); }
            throw error;
          }
          provisioningDebug('Remote connector device claim received', { device_id: data.device_id, device_ws_url: data.wss_url, temporary_credential_recovered: Boolean(data.recovered) });
          reusableGrantRef.current = undefined;
          claims.set(data.provisioning_session_id, { continuationToken: data.continuation_token, deviceId: data.device_id });
          return { provisioningSessionId: data.provisioning_session_id, continuationToken: 'managed-by-admin', deviceId: data.device_id, rawToken: [...decodeBase64Url(data.device_token)], wssUrl: data.wss_url, ...(data.recovered === undefined ? {} : { recovered: data.recovered }) };
        }
        if (request.method === 'progress') {
          const provisioningSessionId = String(request.payload.provisioningSessionId ?? ''); const claim = claims.get(provisioningSessionId); const stage = String(request.payload.stage ?? '');
          if (!claim) throw new Error('PROVISIONING_SESSION_MISSING');
          return devicePost(`/provisioning-sessions/${encodeURIComponent(provisioningSessionId)}/progress`, { continuation_token: claim.continuationToken, stage, ...(request.payload.failureCode ? { failure_code: String(request.payload.failureCode) } : {}) });
        }
        if (request.method === 'observe') {
          const provisioningSessionId = String(request.payload.provisioningSessionId ?? ''); const claim = claims.get(provisioningSessionId);
          if (!claim) throw new Error('PROVISIONING_SESSION_MISSING');
          const data = await devicePost<{ status: string; failure_code?: string; online: boolean }>(`/provisioning-sessions/${encodeURIComponent(provisioningSessionId)}/observe`, { continuation_token: claim.continuationToken });
          return { status: data.status, online: data.online, ...(data.failure_code ? { failureCode: data.failure_code } : {}) };
        }
        if (request.method === 'complete') {
          if (request.payload.sessionId !== sessionId || request.payload.state !== state) throw new Error('DEVICE_CONNECT_STATE_INVALID');
          const provisioningSessionId = String(request.payload.provisioningSessionId ?? ''); const claim = claims.get(provisioningSessionId);
          if (!claim || request.payload.deviceId !== claim.deviceId) throw new Error('PROVISIONING_SESSION_MISSING');
          onProvisioned(); setStatus(locale === 'zh-CN' ? '设备绑定流程已完成' : 'Device binding completed');
          return { accepted: true };
        }
        throw new Error('DEVICE_CONNECT_METHOD_NOT_ALLOWED');
      };
      channel.port1.addEventListener('message', (event: MessageEvent<DeviceConnectRequest>) => {
        const request = event.data;
        if (!request || request.type !== 'voicecan-connect:request' || request.version !== DEVICE_CONNECT_PROTOCOL || typeof request.requestId !== 'string') return;
        void handleRequest(request).then((data) => respond(request.requestId, true, data), (error) => respond(request.requestId, false, undefined, error instanceof Error ? error.message : String(error)));
      });
      channel.port1.start();
      const onReady = (event: MessageEvent<DeviceConnectReady>) => {
        if (connected || event.source !== popup || event.origin !== publicUrl.origin || event.data?.type !== 'voicecan-connect:ready' || event.data.version !== DEVICE_CONNECT_PROTOCOL) return;
        connected = true;
        provisioningDebug('Remote connector secure channel established', { connector_origin: publicUrl.origin });
        const init: DeviceConnectInit = { type: 'voicecan-connect:init', version: DEVICE_CONNECT_PROTOCOL, sessionId, state, locale, callbackUrl: globalThis.location.href.split('#')[0]!, expiresAt, bleNamePrefix };
        popup.postMessage(init, publicUrl.origin, [channel.port2]);
        setStatus(locale === 'zh-CN' ? '安全连接已建立，请在新窗口选择设备' : 'Secure channel established. Select the device in the new window.');
      };
      globalThis.addEventListener('message', onReady);
      cleanupRef.current = () => { globalThis.removeEventListener('message', onReady); channel.port1.close(); };
      publicUrl.hash = `session=${encodeURIComponent(sessionId)}`;
      popup.location.replace(publicUrl.href);
    };
    const startConnector = async (createGrant: CreateProvisioningGrant): Promise<void> => { createGrantRef.current = createGrant; await openConnector(createGrant, false); };
    reopenRef.current = () => {
      const createGrant = createGrantRef.current;
      if (!createGrant) return;
      void openConnector(createGrant, true).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
    };
    registerStart(startConnector);
    return () => { registerStart(undefined); reopenRef.current = () => undefined; cleanupRef.current(); };
  }, [bleNamePrefix, connectorUrl, deviceWsUrl, locale]);

  return <div className="remote-connect-card" hidden={hidden}><div className="device-visual"><span className="device-body"><span className="device-body-logo">V○</span></span><span className="connection-ring"/></div><div><span className="status-pill status-warning">{locale === 'zh-CN' ? '当前环境无法直接使用蓝牙' : 'Bluetooth unavailable in this environment'}</span><h3>{locale === 'zh-CN' ? '已打开安全设备绑定页' : 'Secure device binding page opened'}</h3><p className="remote-connect-reason"><strong>{locale === 'zh-CN' ? '为什么需要打开新页面？' : 'Why is a new page required?'}</strong>{bluetoothUnavailableReason}</p><p>{locale === 'zh-CN' ? 'Platform 将通过一次性内存通道处理授权，设备绑定凭证不会发送到公网服务；网络配置仅是绑定流程中的可选步骤。' : 'Platform uses a one-time in-memory channel for authorization. The device binding grant is never sent to the public service; network setup is only one optional step in the binding flow.'}</p><p className="hint">{status}</p><Button icon="provision" onClick={() => reopenRef.current()}>{locale === 'zh-CN' ? '重新打开配对页' : 'Reopen pairing page'}</Button></div></div>;
}
