import { connectionErrorCode, type ConnectionEvent } from './connection-diagnostics.js';

export type ConnectionReading = {
  at: string; wifiConnected: boolean | null; batteryPercent: number | null;
  batteryState: 'normal' | 'low' | 'charging' | 'full' | 'unknown';
};

/** Export only observed, non-secret facts. Do not infer why a command failed. */
export function connectionReading(status: { wifiConfigured?: boolean; battery?: { percent?: number; state?: string } }, at = Date.now()): ConnectionReading {
  const percent = status.battery?.percent;
  const state = status.battery?.state;
  return {
    at: new Date(at).toISOString(),
    wifiConnected: typeof status.wifiConfigured === 'boolean' ? status.wifiConfigured : null,
    batteryPercent: typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
    batteryState: state === 'normal' || state === 'low' || state === 'charging' || state === 'full' ? state : 'unknown',
  };
}

export function connectionReport(device: string, firmware: string | null, events: ConnectionEvent[], readings: ConnectionReading[]) {
  return {
    device, firmware,
    events: events.map((event) => ({ stage: event.stage, state: event.state, at: new Date(event.at).toISOString(), ...(event.code ? { code: connectionErrorCode({ code: event.code }) } : {}) })),
    readings: readings.map((reading) => ({ at: reading.at, wifiConnected: reading.wifiConnected, batteryPercent: reading.batteryPercent, batteryState: reading.batteryState })),
  };
}
