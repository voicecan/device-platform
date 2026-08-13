const SERVICE_UUID = '00001a10-0000-1000-8000-00805f9b34fb';
const WRITE_UUID = '00002dd1-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '00002dd0-0000-1000-8000-00805f9b34fb';

type DiagnosticMode = 'legacy' | 'current';
type DiagnosticCharacteristic = EventTarget & {
  uuid: string;
  startNotifications(): Promise<DiagnosticCharacteristic>;
  stopNotifications(): Promise<DiagnosticCharacteristic>;
};
type DiagnosticService = {
  uuid: string;
  getCharacteristic(uuid: string): Promise<DiagnosticCharacteristic>;
};
type DiagnosticGattServer = {
  connected: boolean;
  connect(): Promise<DiagnosticGattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<DiagnosticService>;
};
type DiagnosticDevice = EventTarget & {
  id: string;
  name?: string;
  gatt?: DiagnosticGattServer;
};
type BluetoothWithDevices = {
  requestDevice(options: { filters: Array<{ namePrefix: string }>; optionalServices: string[] }): Promise<DiagnosticDevice>;
};
type NavigatorWithBluetooth = Navigator & { bluetooth?: BluetoothWithDevices };

const logNode = document.querySelector<HTMLPreElement>('#log');
const summaryNode = document.querySelector<HTMLElement>('#summary');
const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
if (!logNode || !summaryNode) throw new Error('BLE_DIAGNOSTICS_PAGE_INVALID');
const logElement: HTMLPreElement = logNode;
const summaryElement: HTMLElement = summaryNode;

let activeDevice: DiagnosticDevice | undefined;
let activeCharacteristic: DiagnosticCharacteristic | undefined;
let sequence = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function errorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { value: String(error) };
}

function writeLog(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(details)}`;
  logElement.textContent += `${line}\n`;
  logElement.scrollTop = logElement.scrollHeight;
  console.debug('[Voicecan BLE A/B]', event, details);
}

function setSummary(message: string, state?: 'success' | 'error'): void {
  summaryElement.textContent = message;
  if (state) summaryElement.dataset.state = state;
  else delete summaryElement.dataset.state;
}

function setBusy(busy: boolean): void {
  for (const button of buttons) {
    if (button.id !== 'disconnect' && button.id !== 'clear') button.disabled = busy;
  }
}

async function disconnect(): Promise<void> {
  try { await activeCharacteristic?.stopNotifications(); } catch (error) { writeLog('stop-notifications-failed', errorDetails(error)); }
  activeCharacteristic = undefined;
  const connectedBefore = activeDevice?.gatt?.connected ?? false;
  activeDevice?.gatt?.disconnect();
  writeLog('disconnected-by-test-page', { connectedBefore, connectedAfter: activeDevice?.gatt?.connected ?? false });
}

async function initializeGatt(device: DiagnosticDevice, postConnectDelayMs: number, attempt: number): Promise<void> {
  const startedAt = performance.now();
  let phase = 'connecting';
  const disconnected = () => writeLog('gatt-disconnected-event', { phase, attempt, elapsedMs: Math.round(performance.now() - startedAt) });
  device.addEventListener('gattserverdisconnected', disconnected);
  try {
    writeLog('gatt-connect-start', { attempt, connectedBefore: device.gatt?.connected ?? false });
    const server = await device.gatt?.connect();
    if (!server) throw new Error('GATT_UNAVAILABLE');
    writeLog('gatt-connect-success', { attempt, elapsedMs: Math.round(performance.now() - startedAt), connected: server.connected });

    phase = 'post-connect-wait';
    if (postConnectDelayMs > 0) await delay(postConnectDelayMs);
    writeLog('post-connect-wait-complete', { attempt, delayMs: postConnectDelayMs, elapsedMs: Math.round(performance.now() - startedAt), connected: server.connected });

    phase = 'discover-service';
    const serviceStartedAt = performance.now();
    const service = await server.getPrimaryService(SERVICE_UUID);
    writeLog('service-discovered', { attempt, operationMs: Math.round(performance.now() - serviceStartedAt), elapsedMs: Math.round(performance.now() - startedAt), connected: server.connected, uuid: service.uuid });

    phase = 'discover-characteristics';
    const characteristicsStartedAt = performance.now();
    const [writer, reader] = await Promise.all([service.getCharacteristic(WRITE_UUID), service.getCharacteristic(NOTIFY_UUID)]);
    writeLog('characteristics-discovered', { attempt, operationMs: Math.round(performance.now() - characteristicsStartedAt), elapsedMs: Math.round(performance.now() - startedAt), writeUuid: writer.uuid, notifyUuid: reader.uuid });

    phase = 'start-notifications';
    const notificationsStartedAt = performance.now();
    activeCharacteristic = await reader.startNotifications();
    writeLog('notifications-started', { attempt, operationMs: Math.round(performance.now() - notificationsStartedAt), elapsedMs: Math.round(performance.now() - startedAt), connected: server.connected });
  } catch (error) {
    writeLog('gatt-attempt-failed', { phase, attempt, elapsedMs: Math.round(performance.now() - startedAt), connected: device.gatt?.connected ?? false, ...errorDetails(error) });
    throw error;
  } finally {
    device.removeEventListener('gattserverdisconnected', disconnected);
  }
}

async function run(mode: DiagnosticMode): Promise<void> {
  sequence += 1;
  const runId = sequence;
  setBusy(true);
  setSummary(`测试 ${mode === 'legacy' ? 'A' : 'B'} 进行中`);
  const bluetooth = (navigator as NavigatorWithBluetooth).bluetooth;
  writeLog('run-start', { runId, mode, secureContext: globalThis.isSecureContext, bluetoothAvailable: Boolean(bluetooth) });
  try {
    if (!bluetooth) throw new Error('WEB_BLUETOOTH_UNAVAILABLE');
    await disconnect();
    activeDevice = await bluetooth.requestDevice({ filters: [{ namePrefix: 'CAPSO-' }], optionalServices: [SERVICE_UUID] });
    writeLog('device-selected', { runId, mode, name: activeDevice.name ?? 'unknown', id: activeDevice.id, connected: activeDevice.gatt?.connected ?? false });

    const scanDelayMs = mode === 'legacy' ? 0 : 800;
    const postConnectDelayMs = mode === 'legacy' ? 0 : 400;
    const maxAttempts = mode === 'legacy' ? 1 : 2;
    if (scanDelayMs > 0) await delay(scanDelayMs);
    writeLog('scan-wait-complete', { runId, mode, delayMs: scanDelayMs });

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await initializeGatt(activeDevice, postConnectDelayMs, attempt);
        setSummary(`测试 ${mode === 'legacy' ? 'A' : 'B'} 成功：服务、特征和通知均可用`, 'success');
        writeLog('run-success', { runId, mode, attempt });
        return;
      } catch (error) {
        lastError = error;
        activeDevice.gatt?.disconnect();
        if (attempt < maxAttempts) {
          writeLog('retry-wait-start', { runId, mode, delayMs: 1000, nextAttempt: attempt + 1 });
          await delay(1000);
        }
      }
    }
    throw lastError;
  } catch (error) {
    setSummary(`测试 ${mode === 'legacy' ? 'A' : 'B'} 失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, 'error');
    writeLog('run-failed', { runId, mode, ...errorDetails(error) });
  } finally {
    setBusy(false);
  }
}

document.querySelector<HTMLButtonElement>('#legacy')?.addEventListener('click', () => void run('legacy'));
document.querySelector<HTMLButtonElement>('#current')?.addEventListener('click', () => void run('current'));
document.querySelector<HTMLButtonElement>('#disconnect')?.addEventListener('click', () => void disconnect());
document.querySelector<HTMLButtonElement>('#clear')?.addEventListener('click', () => { logElement.textContent = ''; setSummary('等待测试'); });
