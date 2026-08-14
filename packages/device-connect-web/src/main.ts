import './style.css';
import { DEVICE_CONNECT_PROTOCOL, encodeConnectCallback, mountDeviceConnector } from './index.js';
import type { DeviceConnectCallback, DeviceConnectInit, DeviceConnectReady, DeviceConnectRequest, DeviceConnectResponse } from './index.js';
import type { ProvisioningBroker } from '@voicecan/device-web';

const mount = document.querySelector<HTMLElement>('#connect-mount');
const stateLabel = document.querySelector<HTMLElement>('#connection-state');
if (!mount || !stateLabel) throw new Error('CONNECT_PAGE_INVALID');
const connectorMount: HTMLElement = mount;
const connectionStateLabel: HTMLElement = stateLabel;

let initialized = false;
let locale: 'zh-CN' | 'en' = globalThis.navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
const provisioningStatusPollMs = 10_000;

const pageText = {
  'zh-CN': { title: 'Voicecan 设备绑定', state: '等待管理端连接', connected: '安全会话已连接', heading: '在这台电脑上绑定附近设备', description: '蓝牙操作只发生在当前浏览器。授权和设备归属仍由你的 Voicecan Platform 决定，网络配置仅是绑定流程中需要时执行的一步。', waiting: '正在建立安全会话', openFromAdmin: '请从 Voicecan 管理端打开此页面。', startTitle: '选择要绑定的 Voicecan 设备', startDescription: '点击后浏览器会打开系统蓝牙设备选择器。出于浏览器安全限制，必须由你在此页面主动触发这一步。', startButton: '选择设备并开始绑定', selecting: '正在选择附近设备', footer: '一次性会话 · 凭证不写入 URL · 无第三方脚本' },
  en: { title: 'Voicecan Device Binding', state: 'Waiting for Admin', connected: 'Secure session connected', heading: 'Bind a nearby device on this computer', description: 'Bluetooth runs only in this browser. Authorization and ownership remain controlled by your Voicecan Platform; network setup is only one step when needed.', waiting: 'Establishing a secure session', openFromAdmin: 'Open this page from Voicecan Admin.', startTitle: 'Choose a Voicecan device to bind', startDescription: 'Click to open the browser Bluetooth device picker. Browser security requires you to trigger this step directly on this page.', startButton: 'Choose device and start binding', selecting: 'Choosing a nearby device', footer: 'One-time session · No credentials in URLs · No third-party scripts' },
} as const;

function applyLocale(nextLocale: 'zh-CN' | 'en'): void {
  locale = nextLocale;
  const text = pageText[locale];
  document.documentElement.lang = locale;
  document.title = text.title;
  const values: ReadonlyArray<[string, string]> = [['connect-title', text.heading], ['connect-description', text.description], ['waiting-title', text.waiting], ['waiting-description', text.openFromAdmin], ['connect-footer', text.footer]];
  for (const [id, value] of values) { const element = document.getElementById(id); if (element) element.textContent = value; }
  if (!initialized) connectionStateLabel.textContent = text.state;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function callbackUrl(init: DeviceConnectInit, result: DeviceConnectCallback): string {
  const target = new URL(init.callbackUrl);
  target.hash = `vc_connect=${encodeURIComponent(encodeConnectCallback(result))}`;
  return target.href;
}

function remoteBroker(port: MessagePort): { broker: ProvisioningBroker; request<T>(method: DeviceConnectRequest['method'], payload: Record<string, unknown>, timeoutMs?: number): Promise<T> } {
  let sequence = 0;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof globalThis.setTimeout> }>();
  port.addEventListener('message', (event: MessageEvent<DeviceConnectResponse>) => {
    const response = event.data;
    if (!response || response.type !== 'voicecan-connect:response' || response.version !== DEVICE_CONNECT_PROTOCOL) return;
    const operation = pending.get(response.requestId);
    if (!operation) return;
    pending.delete(response.requestId); globalThis.clearTimeout(operation.timer);
    if (response.ok) operation.resolve(response.data); else operation.reject(new Error(response.error ?? 'Remote operation failed'));
  });
  port.start();
  const request = <T>(method: DeviceConnectRequest['method'], payload: Record<string, unknown>, timeoutMs = 20_000): Promise<T> => new Promise((resolve, reject) => {
    const requestId = `connect_${Date.now()}_${sequence += 1}`;
    const timer = globalThis.setTimeout(() => { pending.delete(requestId); reject(new Error('本地管理端响应超时')); }, timeoutMs);
    pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
    port.postMessage({ type: 'voicecan-connect:request', version: DEVICE_CONNECT_PROTOCOL, requestId, method, payload } satisfies DeviceConnectRequest);
  });
  const claims = new Map<string, { provisioningSessionId: string; continuationToken: string }>();
  const broker: ProvisioningBroker = {
    claim: async ({ serialNumber, manufacturer, bluetoothName }) => {
      const data = await request<{ provisioningSessionId: string; continuationToken: string; deviceId: string; rawToken: number[]; wssUrl: string }>('claim', { serialNumber, manufacturer, ...(bluetoothName ? { bluetoothName } : {}) });
      claims.set(data.deviceId, { provisioningSessionId: data.provisioningSessionId, continuationToken: data.continuationToken });
      return { ...data, rawToken: Uint8Array.from(data.rawToken) };
    },
    reportProgress: async (payload) => { await request('progress', payload); },
    waitForOnline: async (deviceId, timeoutMs, signal) => {
      const claim = claims.get(deviceId);
      if (!claim) throw new Error('PROVISIONING_SESSION_MISSING');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const data = await request<{ status: string; failureCode?: string }>('observe', { ...claim }, 10_000);
        if (data.status === 'completed') return true;
        if (data.status === 'failed') throw new Error(data.failureCode ?? 'PROVISIONING_FAILED');
        await new Promise((resolve) => globalThis.setTimeout(resolve, provisioningStatusPollMs));
      }
      return false;
    },
    observeOnline: async (deviceId, signal) => {
      const claim = claims.get(deviceId);
      if (!claim) throw new Error('PROVISIONING_SESSION_MISSING');
      signal?.throwIfAborted();
      const data = await request<{ online: boolean }>('observe', { ...claim }, 10_000);
      signal?.throwIfAborted();
      return data.online;
    },
  };
  return { broker, request };
}

async function initialize(init: DeviceConnectInit, port: MessagePort): Promise<void> {
  if (initialized || init.version !== DEVICE_CONNECT_PROTOCOL || Date.parse(init.expiresAt) <= Date.now()) return;
  initialized = true;
  applyLocale(init.locale);
  connectionStateLabel.textContent = pageText[locale].connected;
  connectionStateLabel.classList.add('connected');
  const remote = remoteBroker(port);
  let provisioningSessionId: string | undefined;
  let deviceId: string | undefined;
  const sendFallback = (result: 'completed' | 'failed', error?: string) => {
    const payload: DeviceConnectCallback = { version: DEVICE_CONNECT_PROTOCOL, sessionId: init.sessionId, state: init.state, result, ...(provisioningSessionId ? { provisioningSessionId } : {}), ...(deviceId ? { deviceId } : {}), ...(error ? { error: error.slice(0, 300) } : {}), completedAt: Date.now() };
    globalThis.location.replace(callbackUrl(init, payload));
  };
  const connector = await mountDeviceConnector({
    mount: connectorMount,
    broker: {
      ...remote.broker,
      claim: async (input) => {
        const claim = await remote.broker.claim(input);
        provisioningSessionId = claim.provisioningSessionId; deviceId = claim.deviceId;
        return claim;
      },
    },
    locale: init.locale,
    coreModuleUrl: new URL('semantic_core.js', globalThis.location.href).href,
    compact: true,
    bleNamePrefix: typeof init.bleNamePrefix === 'string' && init.bleNamePrefix ? init.bleNamePrefix : 'CAPSO-',
    onProvisioned: (result) => {
      deviceId = result.deviceId;
      void remote.request('complete', { sessionId: init.sessionId, state: init.state, result: 'completed', provisioningSessionId, deviceId }, 5_000).then(() => sendFallback('completed'), () => sendFallback('completed'));
    },
    onError: (error) => {
      connectionStateLabel.textContent = errorMessage(error);
    },
  });

  const startCard = document.createElement('section');
  startCard.className = 'connect-start-card';
  const startCopy = document.createElement('div');
  startCopy.className = 'connect-start-copy';
  const startTitle = document.createElement('h2');
  startTitle.textContent = pageText[locale].startTitle;
  const startDescription = document.createElement('p');
  startDescription.textContent = pageText[locale].startDescription;
  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'connect-start-button';
  startButton.textContent = pageText[locale].startButton;
  startCopy.append(startTitle, startDescription);
  startCard.append(startCopy, startButton);
  connector.element.hidden = true;
  connectorMount.prepend(startCard);

  let starting = false;
  connector.element.addEventListener('provisionerror', () => {
    startCard.hidden = false;
    connector.element.hidden = true;
    startButton.disabled = false;
    starting = false;
  });
  startButton.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    startButton.disabled = true;
    startCard.hidden = true;
    connector.element.hidden = false;
    connectionStateLabel.textContent = pageText[locale].selecting;
    await connector.element.startProvisioning();
    starting = false;
    startButton.disabled = false;
    if (startCard.hidden) connectionStateLabel.textContent = pageText[locale].connected;
  });
  try { globalThis.opener = null; } catch { /* cross-browser hardening */ }
}

globalThis.addEventListener('message', (event: MessageEvent<DeviceConnectInit>) => {
  if (initialized || event.source !== globalThis.opener || event.data?.type !== 'voicecan-connect:init' || event.data.version !== DEVICE_CONNECT_PROTOCOL || event.ports.length !== 1) return;
  void initialize(event.data, event.ports[0]!);
});

applyLocale(locale);
if (globalThis.opener) globalThis.opener.postMessage({ type: 'voicecan-connect:ready', version: DEVICE_CONNECT_PROTOCOL } satisfies DeviceConnectReady, '*');
else connectionStateLabel.textContent = pageText[locale].openFromAdmin;
