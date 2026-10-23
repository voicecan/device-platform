export type ConnectionStage = 'backup' | 'load_sdk' | 'select_device' | 'authenticate' | 'reconnect' | 'read_status' | 'check_wifi' | 'configure_wifi' | 'wait_wifi' | 'report_status' | 'wifi_connected' | 'configure_server' | 'wait_server' | 'server_connected';
export type ConnectionEvent = { stage: ConnectionStage; state: 'running' | 'done' | 'failed'; at: number; code?: string };
export const stageLabels: Record<ConnectionStage, string> = {
  backup: 'Save recovery backup', load_sdk: 'Load device support', select_device: 'Select nearby Bluetooth device', authenticate: 'Verify device binding', reconnect: 'Reconnect nearby device', read_status: 'Read device status', check_wifi: 'Check existing Wi-Fi connection', configure_wifi: 'Send Wi-Fi settings', wait_wifi: 'Wait for device Wi-Fi', report_status: 'Save device status', wifi_connected: 'Device confirmed Wi-Fi connected', configure_server: 'Send server address', wait_server: 'Confirm server connection', server_connected: 'Server confirmed device online',
};
const codes = new Set(['BLUETOOTH_SELECTION_CANCELLED', 'BLUETOOTH_NOT_SUPPORTED', 'BLUETOOTH_PAIRING_STALE', 'GATT_DISCONNECTED_DURING_SERVICE_DISCOVERY', 'WIFI_SETTINGS_REJECTED_NETWORK_CONNECTED', 'WIFI_CONFIGURATION_REJECTED', 'DEVICE_WIFI_NOT_CONNECTED', 'NETWORK_AVAILABLE_TIMEOUT', 'SERVER_ONLINE_TIMEOUT', 'RESPONSE_MISMATCH', 'RECOVERY_BACKUP_FAILED', 'BLE_DEVICE_MISMATCH', 'BINDING_SESSION_REQUIRED', 'INVALID_DEVICE_SERVER_URL', 'CSRF_FAILED', 'STORAGE_LOW_SPACE', 'DEVICE_DISCONNECTED', 'TIMEOUT', 'AUTHENTICATION_FAILED', 'GATT_OPERATION_TIMEOUT']);
export function connectionErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  const explicit = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  for (const code of codes) if (explicit === code || new RegExp(`\\b${code}\\b`).test(value)) return code;
  if (error instanceof Error && error.name === 'NotFoundError') return 'BLUETOOTH_SELECTION_CANCELLED';
  if (error instanceof Error && error.name === 'NotSupportedError') return 'BLUETOOTH_NOT_SUPPORTED';
  if (/disconnect|not connected/i.test(value)) return 'DEVICE_DISCONNECTED';
  if (/timeout|timed out/i.test(value)) return 'TIMEOUT';
  return 'CONNECTION_FAILED';
}
export function connectionAdvice(code: string): string {
  if (code === 'WIFI_SETTINGS_REJECTED_NETWORK_CONNECTED') return 'The new Wi-Fi settings were rejected, but a fresh device reading confirms an existing connection. Use the current Wi-Fi to finish setup, or change the network in advanced options.';
  if (code === 'WIFI_CONFIGURATION_REJECTED') return 'The device runtime reported that Wi-Fi settings were rejected. A connection was not confirmed. This error does not identify a wrong password or an incompatible mixed-security network.';
  if (code === 'SERVER_ONLINE_TIMEOUT') return 'The device confirmed Wi-Fi connected, but this server received no device connection within 60 seconds. Keep the computer and service running. Check that the device can reach the server address, and check firewall or guest-network isolation. If it still does not connect, long-press the device button for 8 seconds to restart it.';
  if (['DEVICE_WIFI_NOT_CONNECTED', 'NETWORK_AVAILABLE_TIMEOUT'].includes(code)) return 'The latest device reading did not confirm a Wi-Fi connection. Check network security, signal and credentials before retrying.';
  if (code === 'RECOVERY_BACKUP_FAILED') return 'Recovery backup failed. Check server disk space and recovery key files. No device credential was sent.';
  if (code === 'BLUETOOTH_SELECTION_CANCELLED') return 'No Bluetooth device was selected. Select the device in the browser chooser to continue.';
  if (code === 'BLUETOOTH_NOT_SUPPORTED') return 'This browser could not complete the Bluetooth operation. Use a browser with Web Bluetooth and check Bluetooth permissions.';
  if (code === 'DEVICE_DISCONNECTED') return 'The Bluetooth connection ended. Keep the device awake and nearby, then reconnect.';
  if (code === 'RESPONSE_MISMATCH') return 'The device reply did not match the current command. Close other device connections and retry; persistent failures require a runtime compatibility check.';
  if (code === 'BLUETOOTH_PAIRING_STALE' || code === 'GATT_DISCONNECTED_DURING_SERVICE_DISCOVERY') return 'The device may still be paired to this computer with an old key after unbinding. Open the system Bluetooth settings, remove or forget the device, pair it again, then retry.';
  if (code === 'STORAGE_LOW_SPACE') return 'The server cannot accept recordings because its disk is too full. Free space or change the storage location, then retry.';
  return 'This step did not complete. Retry after checking the device and local service. The stage and error code below identify where it stopped.';
}
export function advanceConnection(events: ConnectionEvent[], stage: ConnectionStage, at = Date.now()): ConnectionEvent[] {
  return [...events.map((event) => event.state === 'running' ? { ...event, state: 'done' as const } : event), { stage, state: 'running' as const, at }].slice(-24);
}

export type NetworkCheckState = 'waiting' | 'checking' | 'connected' | 'disconnected' | 'failed';
/** Only explicit positive device/server observations prove connection. A finished command does not. */
export function connectionChecks(events: ConnectionEvent[]): { wifi: NetworkCheckState; server: NetworkCheckState } {
  const start = events.findLastIndex((event) => event.stage === 'configure_wifi' || event.stage === 'check_wifi');
  if (start < 0) return { wifi: events.some((event) => event.stage === 'wifi_connected') ? 'connected' : 'waiting', server: 'waiting' };
  const attempt = events.slice(start);
  const wifiConfirmed = attempt.some((event) => event.stage === 'wifi_connected');
  const serverConfirmed = attempt.some((event) => event.stage === 'server_connected');
  const failed = attempt.some((event) => event.state === 'failed');
  const serverStarted = attempt.some((event) => event.stage === 'configure_server' || event.stage === 'wait_server');
  return {
    wifi: wifiConfirmed ? 'connected' : failed ? 'failed' : 'checking',
    server: serverConfirmed ? 'connected' : serverStarted ? failed ? 'failed' : 'checking' : 'waiting',
  };
}
export const checkLabels: Record<NetworkCheckState, string> = {
  disconnected: 'Not connected', waiting: 'Waiting for check', checking: 'Checking connection…', connected: 'Connection confirmed', failed: 'Connection not confirmed',
};
