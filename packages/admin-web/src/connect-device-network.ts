import { connectionErrorCode } from './connection-diagnostics.js';
import type { ConnectionStage } from './connection-diagnostics.js';
type WifiSettings = { ssid: string; password: string; encryption: 'open' | 'wpa2' | 'wpa3' };
type NetworkStatus = { wifiConfigured: boolean };

/** Keep server configuration after a positive network reading, using the current binding. */
export async function connectDeviceNetwork<T extends NetworkStatus>(input: {
  session: { configureWifi(settings: WifiSettings): Promise<T>; refresh(): Promise<T>; configureServer(url: string): Promise<void> };
  wifi?: WifiSettings | undefined;
  serverUrl: string;
  onStatus(status: T): Promise<void>;
  onWifiConnected?(): void;
  onComplete?(): void;
  onStage?: (stage: ConnectionStage) => void;
  confirmOnline?: () => Promise<boolean>;
  pause?: () => Promise<void>;
}): Promise<void> {
  let url: URL;
  try { url = new URL(input.serverUrl); } catch { throw new Error('INVALID_DEVICE_SERVER_URL'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) throw new Error('INVALID_DEVICE_SERVER_URL');
  let status: T;
  if (input.wifi) {
    input.onStage?.('configure_wifi');
    try { status = await input.session.configureWifi(input.wifi); }
    catch (cause) {
      if (connectionErrorCode(cause) !== 'WIFI_CONFIGURATION_REJECTED') throw cause;
      // A rejected write says nothing about an already configured network.
      // Never silently claim that the requested settings were accepted.
      const observed = await input.session.refresh();
      await input.onStatus(observed);
      if (observed.wifiConfigured) {
        input.onStage?.('wifi_connected');
        throw new Error('WIFI_SETTINGS_REJECTED_NETWORK_CONNECTED');
      }
      throw cause;
    }
  } else {
    input.onStage?.('check_wifi');
    status = await input.session.refresh();
  }
  input.onStage?.('wait_wifi');
  for (let attempt = 0; attempt < 15 && !status.wifiConfigured; attempt += 1) {
    await (input.pause?.() ?? new Promise((resolve) => globalThis.setTimeout(resolve, 2_000)));
    status = await input.session.refresh();
  }
  input.onStage?.('report_status');
  await input.onStatus(status);
  if (!status.wifiConfigured) { input.onStage?.('wait_wifi'); throw new Error('DEVICE_WIFI_NOT_CONNECTED'); }
  input.onStage?.('wifi_connected');
  input.onWifiConnected?.();
  input.onStage?.('configure_server');
  await input.session.configureServer(url.toString());
  if (input.confirmOnline) {
    input.onStage?.('wait_server');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await input.confirmOnline()) { input.onStage?.('server_connected'); input.onComplete?.(); return; }
      await (input.pause?.() ?? new Promise((resolve) => globalThis.setTimeout(resolve, 2_000)));
    }
    throw new Error('SERVER_ONLINE_TIMEOUT');
  }
  input.onComplete?.();
}
