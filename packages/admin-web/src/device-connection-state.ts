type ConnectionState = 'online' | 'offline' | 'unknown';
type ObservationState = 'connected' | 'disconnected' | 'unknown';

export function deviceConnectionState(serverOnline: unknown, bluetoothConnected: boolean, wifiState: number | null | undefined): {
  server: ConnectionState; bluetooth: ObservationState; wifi: ObservationState; canControl: boolean; canSync: boolean;
} {
  const server = serverOnline === true ? 'online' : serverOnline === false ? 'offline' : 'unknown';
  return {
    server,
    bluetooth: bluetoothConnected ? 'connected' : 'disconnected',
    wifi: wifiState === 1 ? 'connected' : wifiState === 0 ? 'disconnected' : 'unknown',
    canControl: server === 'online' || bluetoothConnected,
    canSync: server === 'online',
  };
}

export function recordingSyncCounts(summary: { pending: number; syncing: number; synced: number; failed: number } | undefined): {
  pending: number; syncing: number; synced: number; failed: number;
} {
  return { pending: summary?.pending ?? 0, syncing: summary?.syncing ?? 0, synced: summary?.synced ?? 0, failed: summary?.failed ?? 0 };
}

/** Once opened after a verified connection, details remain available for inspection. */
export function needsDeviceSetup(canConfigure: boolean, online: boolean, deviceId: string, verifiedDeviceId: string): boolean {
  return canConfigure && !online && (!deviceId || deviceId !== verifiedDeviceId);
}


/** Keep picker metadata consistent with the selected device's refreshed workspace. */
export function currentDeviceOptions(items: readonly Record<string, unknown>[], current: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  if (!current) return items;
  return items.some((device) => String(device.id) === String(current.id)) ? items.map((device) => String(device.id) === String(current.id) ? current : device) : [current, ...items];
}
