import { connectionReading, connectionReport, type ConnectionReading } from './connection-reading.js';
import { advanceConnection, connectionAdvice, connectionErrorCode, stageLabels, type ConnectionEvent, type ConnectionStage } from './connection-diagnostics.js';
import { connectDeviceNetwork } from './connect-device-network.js';
import { useEffect, useRef, useState } from 'react';
import { connectBoundDevice, type BluetoothDeviceHandle, type BoundDeviceMaintenance, type DeviceControl } from '@voicecan/device-connect-web';
import { api, apiBinary, apiBinaryUpload, errorMessage } from './api.js';
import { randomUuidV4 } from './random.js';
import { formatIsoTimestamp, formatSessionTimestamp, isoTimestampTitle, sessionTimestamp, sessionTimestampTitle } from './recording-timestamp.js';
import { deviceConnectionState, recordingSyncCounts, currentDeviceOptions } from './device-connection-state.js';
import { Button, DataTable, Field, Icon, Select, collectionOf, formatLocalDateTime, type Translate } from './ui.js';

type DeviceRow = Record<string, unknown>;
type BleInfo = { model: string; serialNumber: string; hardwareVersion: string; firmwareVersion: string };
type BleIdentity = { id?: string; name?: string };
type BleConnectOptions = { device?: BluetoothDeviceHandle; deviceId?: string; deviceName?: string; skipTimeSync?: boolean; allowPrompt?: boolean; silent?: boolean };
type SyncFile = {
  id: string; session_id: number; attribute: number; expected_size: number; actual_size: number | null;
  status: string; transport: string | null; error_code: string | null; created_at: string; updated_at: string; synced_at?: string | null;
  media?: { content_type?: string | null; filename_extension?: string | null; codec?: string | null };
};
type ActiveTransfer = {
  file_id: string; expected_size: number; transferred_bytes: number | null; started_at: string;
  bytes_per_second: number | null; transport: string | null;
};
type SyncWorkspace = {
  device: DeviceRow & { connection_epoch: number; connection_status: string };
  summary: { total: number; pending: number; syncing: number; synced: number; failed: number; identity_conflict: number; discovered_bytes: number; synced_bytes: number; queued_bytes: number; round_total: number; round_completed: number; round_started_at: string | null; oldest_incomplete_at: string | null; last_synced_at: string | null };
  files: SyncFile[];
  active_transfer: ActiveTransfer | null;
  latest_command: Record<string, unknown> | null;
  reset_policy: { deletes_recordings: false; default_scope: string; stale_after_seconds: number };
};
type SyncProgress = {
  device: { id: string; online: boolean; connection_epoch: number; claim_status: string; last_seen_at: string | null };
  summary: SyncWorkspace['summary'];
  active_transfer: ActiveTransfer | null;
};
type DeviceStatusSnapshot = {
  source: 'ws' | 'ble'; record_state: number | null; record_mode: number | null; microphone_mode: number | null; microphone_gain_db: number | null;
  usb_state: number | null; wifi_state: number | null; wifi_mode: number | null; relay_state: number | null; privacy_mode: boolean | null; earphone_recording: boolean | null;
  storage_total_kb: number | null; storage_free_kb: number | null; recording_hours: number | null; battery_state: string | null; battery_percent: number | null; battery_temperature_c: number | null; battery_voltage_mv: number | null; work_time_seconds: number | null; accumulated_work_time_seconds: number | null; status_updated_at: string | null; storage_updated_at: string | null; battery_updated_at: string | null; updated_at: string;
};
type DeviceStatusWorkspace = { device: DeviceRow; status: DeviceStatusSnapshot | null; auto_shutdown: { interval: string; updated_at: string | null } | null; refresh_available: boolean; polling_interval_seconds: number };
type BleSessionGrant = { device_id: string; serial_number: string; device_token: string; ble_service_uuid: string };
type FirmwareWorkspace = { device: DeviceRow; firmware: { id: string | number; version: string; hw_version: string; release_channel: 'production' | 'developer'; source: 'uploaded' | 'official'; release_notes: string; package_size: number; checksum: string; crc16: number; max_ble_chunk: number; is_required: boolean; published_at: string | null; up_to_date: boolean } };

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/'); const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB']; let size = value; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatSpeed(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) || value <= 0 ? '—' : `${formatBytes(value)}/s`;
}

function releaseNoteLines(notes: string): string[] {
  return notes.trim().split(/(?:\r?\n)+|\s+(?=\d+[.)]\s+)/).map((line) => line.trim()).filter(Boolean);
}

function percentage(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
}

function percentageLabel(value: number | null): string {
  if (value === null) return '—';
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function DeviceManagement({ devices, t, canEdit, canRelease, onDevicesRefresh }: { devices: unknown; t: Translate; canEdit: boolean; canRelease: boolean; onDevicesRefresh: () => void }) {
  const items = collectionOf(devices);
  const requested = new URLSearchParams(globalThis.location.search).get('device') ?? '';
  const [deviceId, setDeviceId] = useState(requested);
  const selectedDevice = useRef(deviceId);
  selectedDevice.current = deviceId;
  const [workspace, setWorkspace] = useState<SyncWorkspace>();
  const loadSequence = useRef(0);
  const [refreshError, setRefreshError] = useState('');
  const [capabilities, setCapabilities] = useState<unknown>();
  const [commands, setCommands] = useState<unknown>();
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatusWorkspace>();
  const [bleConnected, setBleConnected] = useState(false);
  const [bleInfo, setBleInfo] = useState<BleInfo>();
  const [connectionReadings, setConnectionReadings] = useState<ConnectionReading[]>([]);
  const [wifiEditorOpen, setWifiEditorOpen] = useState(false);
  const [autoShutdown, setAutoShutdown] = useState('never');
  const autoShutdownTouched = useRef(false);
  const bleSession = useRef<BoundDeviceMaintenance | undefined>(undefined);
  const bleDevice = useRef<BluetoothDeviceHandle | undefined>(undefined);
  const bleIdentity = useRef<BleIdentity>({});
  const bleReconnectTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const bleReconnectAttempts = useRef(0);
  const bleManualDisconnect = useRef(false);
  const bleConnecting = useRef(false);
  const bleNameAutoAttempt = useRef('');
  const statusRefreshAttempt = useRef('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionEvents, setConnectionEvents] = useState<ConnectionEvent[]>([]);
  const [diagnosticNotice, setDiagnosticNotice] = useState('');
  const connectionStep = (stage: ConnectionStage): void => setConnectionEvents((events) => advanceConnection(events, stage));
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [recordingPage, setRecordingPage] = useState(0);
  const speedSample = useRef<{ at: number; bytes: number } | undefined>(undefined);
  const progressCounts = useRef<string | undefined>(undefined);
  const [transferSpeed, setTransferSpeed] = useState<number | null>(null);
  const [firmwareChannel, setFirmwareChannel] = useState<'production' | 'developer'>('production');
  const [firmware, setFirmware] = useState<FirmwareWorkspace>();
  const [otaProgress, setOtaProgress] = useState<number | null>(null);
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadCrc16, setUploadCrc16] = useState('');
  const [uploadMaxBleChunk, setUploadMaxBleChunk] = useState('0');
  const [uploadNotes, setUploadNotes] = useState('');
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [wifiEncryption, setWifiEncryption] = useState<'open' | 'wpa2' | 'wpa3'>('wpa2');

  useEffect(() => {
    if (requested) {
      if (requested !== deviceId) setDeviceId(requested);
      return;
    }

  }, [deviceId, items, requested]);

  const load = async (selected = deviceId, quiet = false): Promise<void> => {
    if (!selected || selected !== selectedDevice.current) return;
    if (quiet && globalThis.document?.visibilityState === 'hidden') return;
    const sequence = ++loadSequence.current;
    if (!quiet) setBusy('loading');
    try {
      if (quiet) {
        const [nextWorkspace, nextStatus] = await Promise.all([
          api<SyncWorkspace>(`/devices/${encodeURIComponent(selected)}/recording-sync`),
          api<DeviceStatusWorkspace>(`/devices/${encodeURIComponent(selected)}/status`),
        ]);
        if (sequence !== loadSequence.current || selected !== selectedDevice.current) return;
        setWorkspace(nextWorkspace); setDeviceStatus(nextStatus); setRefreshError('');
        return;
      }
      const [nextWorkspace, nextCapabilities, nextCommands, nextStatus] = await Promise.all([
        api<SyncWorkspace>(`/devices/${encodeURIComponent(selected)}/recording-sync`),
        api(`/devices/${encodeURIComponent(selected)}/capabilities`),
        api(`/devices/${encodeURIComponent(selected)}/commands`),
        api<DeviceStatusWorkspace>(`/devices/${encodeURIComponent(selected)}/status`),
      ]);
      if (sequence !== loadSequence.current || selected !== selectedDevice.current) return;
      setWorkspace(nextWorkspace); setCapabilities(nextCapabilities); setCommands(nextCommands); setDeviceStatus(nextStatus); setRefreshError('');
    } catch (cause) { if (sequence === loadSequence.current) setRefreshError(errorMessage(cause)); }
    finally { if (sequence === loadSequence.current) setBusy((value) => value === 'loading' ? '' : value); }
  };

  const loadProgress = async (selected = deviceId): Promise<void> => {
    if (!selected || selected !== selectedDevice.current || globalThis.document?.visibilityState === 'hidden') return;
    try {
      const progress = await api<SyncProgress>(`/devices/${encodeURIComponent(selected)}/recording-progress`);
      if (selected !== selectedDevice.current) return;
      setWorkspace((current) => current && String(current.device.id) === selected
        ? { ...current, device: { ...current.device, online: progress.device.online, connection_epoch: progress.device.connection_epoch, claim_status: progress.device.claim_status, last_seen_at: progress.device.last_seen_at }, summary: progress.summary, active_transfer: progress.active_transfer }
        : current);
      const next = `${progress.summary.total}:${progress.summary.pending}:${progress.summary.syncing}:${progress.summary.synced}:${progress.summary.failed}`;
      if (progressCounts.current !== undefined && progressCounts.current !== next) void load(selected, true);
      progressCounts.current = next;
    } catch { /* the slower workspace refresh owns the visible error state */ }
  };

  useEffect(() => {
    bleManualDisconnect.current = true;
    if (bleReconnectTimer.current) { globalThis.clearTimeout(bleReconnectTimer.current); bleReconnectTimer.current = undefined; }
    bleReconnectAttempts.current = 0; bleNameAutoAttempt.current = ''; statusRefreshAttempt.current = ''; bleDevice.current = undefined; bleSession.current = undefined;
    try { const saved = deviceId ? globalThis.sessionStorage?.getItem(`voicecan.ble.device.${deviceId}`) : null; bleIdentity.current = saved ? JSON.parse(saved) as BleIdentity : {}; }
    catch { bleIdentity.current = {}; }
    setBleInfo(undefined); setBleConnected(false);
    setConnectionReadings([]); setWifiEditorOpen(false); setRefreshError(''); setConnectionEvents([]); setDiagnosticNotice('');
    setWorkspace(undefined); setCapabilities(undefined); setCommands(undefined); setDeviceStatus(undefined); setFirmware(undefined); setOtaProgress(null); setError(''); setNotice(''); setRecordingPage(0); autoShutdownTouched.current = false; setAutoShutdown('never');
    speedSample.current = undefined; setTransferSpeed(null); progressCounts.current = undefined;
    bleManualDisconnect.current = false;
    if (!deviceId) return;
    void load(deviceId);
    if (bleIdentity.current.id || bleIdentity.current.name) {
      const options: BleConnectOptions = { ...(bleIdentity.current.id ? { deviceId: bleIdentity.current.id } : {}), ...(bleIdentity.current.name ? { deviceName: bleIdentity.current.name } : {}), skipTimeSync: true, silent: true, allowPrompt: false };
      void connectBle(options).catch(() => undefined);
    }
    const progressTimer = globalThis.setInterval(() => void loadProgress(deviceId), 250);
    const listTimer = globalThis.setInterval(() => void load(deviceId, true), 15_000);
    return () => { ++loadSequence.current; bleManualDisconnect.current = true; if (bleReconnectTimer.current) { globalThis.clearTimeout(bleReconnectTimer.current); bleReconnectTimer.current = undefined; } globalThis.clearInterval(progressTimer); globalThis.clearInterval(listTimer); void bleSession.current?.close(); bleSession.current = undefined; };
  }, [deviceId]);

  useEffect(() => {
    if (!wifiEditorOpen || bleSession.current || busy) return;
    const options: BleConnectOptions = bleDevice.current
      ? { device: bleDevice.current }
      : { ...(bleIdentity.current.id ? { deviceId: bleIdentity.current.id } : {}), ...(bleIdentity.current.name ? { deviceName: bleIdentity.current.name } : {}) };
    if (!options.device && !options.deviceId && !options.deviceName) return;
    bleManualDisconnect.current = false;
    void connectBle({ ...options, skipTimeSync: true, silent: true, allowPrompt: false }).catch(() => undefined);
  }, [wifiEditorOpen]);

  // After binding, the detail page may not have a saved handle yet. The
  // device was just granted to this origin, so getDevices() can reconnect by
  // its advertised name without opening the chooser again.
  useEffect(() => {
    if (!deviceId || busy || bleConnected || bleSession.current || bleConnecting.current || bleManualDisconnect.current) return;
    if (bleIdentity.current.id || bleIdentity.current.name) return;
    const name = String(workspace?.device?.display_name ?? workspace?.device?.model ?? items.find((device) => String(device.id) === deviceId)?.display_name ?? '').trim();
    if (!name || bleNameAutoAttempt.current === `${deviceId}:${name}`) return;
    bleNameAutoAttempt.current = `${deviceId}:${name}`;
    void connectBle({ deviceName: name, skipTimeSync: true, silent: true, allowPrompt: false }).catch(() => undefined);
  }, [deviceId, workspace?.device?.display_name, workspace?.device?.model, busy, bleConnected]);

  useEffect(() => {
    if (!deviceId || !canEdit || !workspace?.device?.online || deviceStatus === undefined || deviceStatus.status || statusRefreshAttempt.current === deviceId) return;
    statusRefreshAttempt.current = deviceId;
    void (async () => {
      try { await api(`/devices/${encodeURIComponent(deviceId)}/status/refresh`, { method: 'POST', body: '{}' }); }
      catch { return; }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 2_000));
        if (deviceId !== selectedDevice.current) return;
        try {
          const next = await api<DeviceStatusWorkspace>(`/devices/${encodeURIComponent(deviceId)}/status`);
          if (next.status) { setDeviceStatus(next); return; }
        } catch { return; }
      }
    })().catch(() => undefined);
  }, [deviceId, canEdit, workspace?.device?.online, deviceStatus]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (globalThis.document?.visibilityState !== 'visible' || !deviceId) return;
      void loadProgress(deviceId);
      void load(deviceId, true);
    };
    globalThis.document?.addEventListener('visibilitychange', onVisibility);
    return () => globalThis.document?.removeEventListener('visibilitychange', onVisibility);
  }, [deviceId]);

  useEffect(() => {
    if (autoShutdownTouched.current) return;
    const interval = deviceStatus?.auto_shutdown?.interval;
    if (interval && ['never', '15min', '30min', '1h', '5h'].includes(interval)) setAutoShutdown(interval);
  }, [deviceStatus?.auto_shutdown?.interval]);

  useEffect(() => {
    if (!workspace) { speedSample.current = undefined; setTransferSpeed(null); return; }
    const at = Date.now();
    const bytes = workspace.summary.synced_bytes + (workspace.active_transfer?.transferred_bytes ?? 0);
    const previous = speedSample.current;
    if (!previous) { speedSample.current = { at, bytes }; return; }
    const elapsed = (at - previous.at) / 1_000;
    if (elapsed < 0.45) return;
    const speed = Math.max(0, (bytes - previous.bytes) / elapsed);
    setTransferSpeed(speed > 0 ? speed : null);
    speedSample.current = { at, bytes };
  }, [workspace]);

  const chooseDevice = (next: string): void => {
    setDeviceId(next);
    const url = new URL(globalThis.location.href); url.searchParams.set('device', next);
    globalThis.history.replaceState({ view: 'devices', deviceId: next }, '', url);
  };

  const beginEdit = (): void => { setDisplayName(String(current?.display_name ?? '')); setEditing(true); };
  const saveName = (): void => { void run('rename', () => api(`/devices/${encodeURIComponent(deviceId)}`, { method: 'PATCH', body: JSON.stringify({ display_name: displayName.trim() || null, reason: 'Administrator updated device display name' }) }), t('Device name updated.')).then(() => setEditing(false)); };

  const run = async (key: string, operation: () => Promise<unknown>, success: string): Promise<void> => {
    if (busy && busy !== 'loading') return;
    setBusy(key); setError(''); setNotice('');
    const connectionOperation = ['ble-connect', 'wifi-configure'].includes(key);
    if (connectionOperation) { setConnectionEvents([]); setDiagnosticNotice(''); }
    try { await operation(); if (connectionOperation) setConnectionEvents((events) => events.map((event) => event.state === 'running' ? { ...event, state: 'done' } : event)); if (deviceId !== selectedDevice.current) return; setNotice(success); await load(deviceId, true); onDevicesRefresh(); }
    catch (cause) { if (connectionOperation) { const code = connectionErrorCode(cause); setConnectionEvents((events) => (events.length ? events : [{ stage: key === 'ble-connect' ? 'backup' : 'configure_wifi', at: Date.now(), state: 'running' } as ConnectionEvent]).map((event) => event.state === 'running' ? { ...event, state: 'failed', code } : event)); setError(''); } else setError(errorMessage(cause)); }
    finally { setBusy(''); }
  };

  const reportBleStatus = async (session: BoundDeviceMaintenance, serialNumber: string, status = session.status): Promise<void> => {
    if (deviceId === selectedDevice.current) { const reading = connectionReading(status); setConnectionReadings((readings) => [...readings, reading].slice(-24)); }
    await api(`/devices/${encodeURIComponent(deviceId)}/ble-status`, { method: 'POST', body: JSON.stringify({ serial_number: serialNumber, info: session.info, status }) });
  };
  function scheduleBleReconnect(): void {
    if (bleManualDisconnect.current || bleReconnectTimer.current) return;
    if (bleReconnectAttempts.current >= 6) { setDiagnosticNotice(t('Bluetooth reconnection failed. Open Wi-Fi configuration to reconnect.')); return; }
    const options: BleConnectOptions = bleDevice.current
      ? { device: bleDevice.current }
      : { ...(bleIdentity.current.id ? { deviceId: bleIdentity.current.id } : {}), ...(bleIdentity.current.name ? { deviceName: bleIdentity.current.name } : {}) };
    if (!options.device && !options.deviceId && !options.deviceName) return;
    const delay = Math.min(30_000, 1_000 * 2 ** bleReconnectAttempts.current);
    bleReconnectTimer.current = globalThis.setTimeout(() => {
      bleReconnectTimer.current = undefined;
      if (bleManualDisconnect.current || deviceId !== selectedDevice.current) return;
      bleReconnectAttempts.current += 1;
      void connectBle({ ...options, skipTimeSync: true, silent: true, allowPrompt: false })
        .then(() => { bleReconnectAttempts.current = 0; setDiagnosticNotice(''); })
        .catch(() => { if (bleReconnectAttempts.current >= 2) bleDevice.current = undefined; scheduleBleReconnect(); });
    }, delay);
  }

  const clearDisconnectedBleSession = (cause: unknown): void => {
    if (!/(?:device|gatt|bluetooth).*(?:disconnect|not connected)|(?:disconnect|not connected).*(?:device|gatt|bluetooth)/i.test(errorMessage(cause))) return;
    bleSession.current = undefined; setBleConnected(false); setBleInfo(undefined);
    scheduleBleReconnect();
  };

  async function establishBle(options: BleConnectOptions = {}): Promise<BoundDeviceMaintenance> {
    if (bleConnecting.current) throw new Error('BLUETOOTH_CONNECTION_PENDING');
    bleConnecting.current = true;
    try { return await establishBleUnlocked(options); }
    finally { bleConnecting.current = false; }
  }

  async function establishBleUnlocked(options: BleConnectOptions = {}): Promise<BoundDeviceMaintenance> {
    if (!options.silent) connectionStep('backup');
    const grant = await api<BleSessionGrant>(`/devices/${encodeURIComponent(deviceId)}/ble-maintenance-session`, { method: 'POST', body: '{}' });
    if (!options.silent) globalThis.dispatchEvent(new Event('voicecan:backup-saved'));
    const rawToken = decodeBase64Url(grant.device_token);
    try {
      let disconnected = false;
      let maintenance: BoundDeviceMaintenance | undefined;
      const session = await connectBoundDevice({
        rawToken, expectedSerialNumber: grant.serial_number, bleServiceUuid: grant.ble_service_uuid, coreModuleUrl: '/sdk/private/semantic_core.js',
        ...(options.device ? { device: options.device } : {}),
        ...(options.deviceId ? { deviceId: options.deviceId } : {}),
        ...(options.deviceName ? { deviceName: options.deviceName } : {}),
        skipTimeSync: options.skipTimeSync === true,
        allowPrompt: options.allowPrompt !== false,
        ...(options.silent ? {} : { onStage: connectionStep }),
        onDisconnected: () => {
          disconnected = true;
          if (maintenance && bleSession.current === maintenance) {
            bleSession.current = undefined; setBleConnected(false); setBleInfo(undefined); setNotice('');
            void maintenance.close().catch(() => undefined);
            if (!bleManualDisconnect.current) { setDiagnosticNotice(t('The Bluetooth connection ended. Reconnecting…')); scheduleBleReconnect(); }
          }
        },
      });
      maintenance = session;
      if (disconnected) { await session.close(); throw new Error('DEVICE_DISCONNECTED'); }
      if (deviceId !== selectedDevice.current) { await session.close(); throw new Error('DEVICE_SWITCHED'); }
      bleSession.current = session; setBleConnected(true); setBleInfo(session.info);
      bleDevice.current = session.device;
      const identity: BleIdentity = { ...(session.device.id ? { id: session.device.id } : {}), ...(session.device.name ? { name: session.device.name } : {}) };
      bleIdentity.current = identity;
      try { globalThis.sessionStorage?.setItem(`voicecan.ble.device.${deviceId}`, JSON.stringify(identity)); } catch { /* optional browser storage */ }
      try {
        const status = await session.refresh();
        await reportBleStatus(session, grant.serial_number, status);
        if (status.wifiConfigured && !options.silent) connectionStep('wifi_connected');
      } catch (cause) {
        if (bleSession.current === session) { bleSession.current = undefined; setBleConnected(false); setBleInfo(undefined); }
        await session.close().catch(() => undefined);
        throw cause;
      }
      return session;
    } finally { rawToken.fill(0); }
  }

  async function connectBle(options: BleConnectOptions = {}): Promise<void> {
    if (bleConnecting.current) throw new Error('BLUETOOTH_CONNECTION_PENDING');
    if (options.silent) {
      setBusy('ble-connect');
      try { await establishBle(options); await load(deviceId, true); }
      finally { setBusy(''); }
      return;
    }
    await run('ble-connect', async () => { await establishBle(options); }, t('Bluetooth maintenance connection established.'));
  }

  const disconnectBle = async (): Promise<void> => {
    bleManualDisconnect.current = true;
    if (bleReconnectTimer.current) { globalThis.clearTimeout(bleReconnectTimer.current); bleReconnectTimer.current = undefined; }
    bleReconnectAttempts.current = 0;
    await bleSession.current?.close();
    bleSession.current = undefined; bleDevice.current = undefined; setBleConnected(false); setBleInfo(undefined); setDiagnosticNotice(''); setNotice(t('Bluetooth maintenance connection closed.'));
  };

  const toggleBle = async (): Promise<void> => {
    if (bleConnected) { await disconnectBle(); return; }
    if (bleReconnectTimer.current) { globalThis.clearTimeout(bleReconnectTimer.current); bleReconnectTimer.current = undefined; }
    bleReconnectAttempts.current = 0;
    bleManualDisconnect.current = false;
    const known = Boolean(bleDevice.current || bleIdentity.current.id || bleIdentity.current.name);
    const options: BleConnectOptions = bleDevice.current
      ? { device: bleDevice.current }
      : { ...(bleIdentity.current.id ? { deviceId: bleIdentity.current.id } : {}), ...(bleIdentity.current.name ? { deviceName: bleIdentity.current.name } : {}) };
    await connectBle({ ...options, skipTimeSync: known, allowPrompt: true });
  };

  const runControl = async (control: DeviceControl, success: string): Promise<void> => run(`control:${control.kind}`, async () => {
    const session = bleSession.current;
    if (session) {
      try {
        const status = await session.control(control); const serialNumber = String(workspace?.device.sn ?? current?.sn ?? '');
        if (serialNumber && control.kind !== 'power' && control.kind !== 'factory_reset') await reportBleStatus(session, serialNumber, status);
        return status;
      } catch (cause) { clearDisconnectedBleSession(cause); throw cause; }
    }
    if (current?.online !== true) throw new Error(t('Connect the device through WebSocket or BLE before sending controls.'));
    return api(`/devices/${encodeURIComponent(deviceId)}/control`, { method: 'POST', headers: { 'idempotency-key': randomUuidV4() }, body: JSON.stringify({ control, reason: 'Administrator requested reviewed device control' }) });
  }, success);
  const configureWifiOperation = async (): Promise<void> => {
    const session = bleSession.current; if (!session) throw new Error(t('Connect with BLE before using nearby maintenance.'));
    if (!wifiSsid.trim()) throw new Error(t('Wi-Fi SSID is required.'));
    const settings = await api<{ preferred_device_ws_url: string }>('/settings/device-access');
    let target: URL;
    try { target = new URL(settings.preferred_device_ws_url); } catch { throw new Error(t('Enter a valid ws:// or wss:// server URL.')); }
    if (!['ws:', 'wss:'].includes(target.protocol)) throw new Error(t('Enter a valid ws:// or wss:// server URL.'));
    try {
      await connectDeviceNetwork({ session, wifi: { ssid: wifiSsid.trim(), password: wifiPassword, encryption: wifiEncryption }, serverUrl: target.toString(), onStatus: (status) => reportBleStatus(session, String(bleInfo?.serialNumber ?? current?.sn ?? ''), status), onComplete: () => { setWifiPassword(''); setWifiEditorOpen(false); }, onStage: connectionStep, confirmOnline: async () => (await api<{ online: boolean }>(`/devices/${encodeURIComponent(deviceId)}`)).online === true });
    }
    catch (cause) { clearDisconnectedBleSession(cause); throw cause; }
  };
  const confirmWifi = async (): Promise<void> => {
    if (busy) return;
    const known = Boolean(bleSession.current || bleDevice.current || bleIdentity.current.id || bleIdentity.current.name);
    await run('wifi-configure', async () => {
      if (!bleSession.current) {
        bleManualDisconnect.current = false;
        const options: BleConnectOptions = bleDevice.current
          ? { device: bleDevice.current }
          : { ...(bleIdentity.current.id ? { deviceId: bleIdentity.current.id } : {}), ...(bleIdentity.current.name ? { deviceName: bleIdentity.current.name } : {}) };
        await establishBle({ ...options, skipTimeSync: known, allowPrompt: true });
      }
      await configureWifiOperation();
    }, t('The server confirmed this device online. You can now sync recordings.'));
  };
  const refreshDeviceStatus = async (): Promise<void> => {
    if (busy) return;
    setBusy('status-refresh'); setError('');
    try {
      const session = bleSession.current;
      if (session) {
        const status = await session.refresh();
        await reportBleStatus(session, String(workspace?.device.sn ?? current?.sn ?? ''), status);
      } else if (wsConnected) {
        await api(`/devices/${encodeURIComponent(deviceId)}/status/refresh`, { method: 'POST', body: '{}' }).catch(() => undefined);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
      }
      await load(deviceId);
    } catch (cause) {
      clearDisconnectedBleSession(cause);
      setError(errorMessage(cause));
    } finally { setBusy(''); }
  };
  const checkFirmware = (): Promise<void> => run('firmware-check', async () => { const result = await api<FirmwareWorkspace>(`/devices/${encodeURIComponent(deviceId)}/firmware/latest?channel=${firmwareChannel}`); setFirmware(result); return result; }, t('Firmware information refreshed.'));
  const importOfficialFirmware = (): Promise<void> => run('firmware-import', async () => {
    const hardwareVersion = String(current?.hardware_version ?? ''); if (!hardwareVersion) throw new Error('DEVICE_HARDWARE_VERSION_UNKNOWN');
    await api('/admin/firmware-packages/import-official', { method: 'POST', body: JSON.stringify({ hardware_version: hardwareVersion, channel: firmwareChannel }) });
    const result = await api<FirmwareWorkspace>(`/devices/${encodeURIComponent(deviceId)}/firmware/latest?channel=${firmwareChannel}`); setFirmware(result); return result;
  }, t('Official firmware was imported into the local repository.'));
  const uploadFirmware = (): Promise<void> => run('firmware-upload', async () => {
    const hardwareVersion = String(current?.hardware_version ?? ''); if (!hardwareVersion || !uploadFile || !uploadVersion.trim()) throw new Error('FIRMWARE_UPLOAD_INCOMPLETE: Select a file and provide its version and CRC16.');
    const crc16 = Number(uploadCrc16); const maxBleChunk = Number(uploadMaxBleChunk || 0); if (!Number.isSafeInteger(crc16) || crc16 < 0 || crc16 > 65_535) throw new Error('INVALID_FIRMWARE_CRC16: CRC16 must be between 0 and 65535.');
    const query = new URLSearchParams({ hardware_version: hardwareVersion, channel: firmwareChannel, version: uploadVersion.trim(), crc16: String(crc16), max_ble_chunk: String(maxBleChunk), ...(uploadNotes.trim() ? { release_notes: uploadNotes.trim() } : {}) });
    await apiBinaryUpload(`/admin/firmware-packages/upload?${query}`, uploadFile); setUploadFile(undefined);
    const result = await api<FirmwareWorkspace>(`/devices/${encodeURIComponent(deviceId)}/firmware/latest?channel=${firmwareChannel}`); setFirmware(result); return result;
  }, t('Firmware was uploaded to the local repository.'));
  const installFirmware = (): Promise<void> => {
    const session = bleSession.current;
    if (!session) return run('firmware-install', () => api(`/devices/${encodeURIComponent(deviceId)}/ota`, { method: 'POST', headers: { 'idempotency-key': randomUuidV4() }, body: JSON.stringify({ channel: firmwareChannel, force: firmware?.firmware.up_to_date === true, reason: 'Administrator approved official firmware OTA' }) }), t('Firmware update started. Keep the device online and powered.'));
    return run('firmware-install', async () => {
      setOtaProgress(0);
      try {
        const response = await apiBinary(`/devices/${encodeURIComponent(deviceId)}/firmware/package?channel=${firmwareChannel}`);
        const version = response.headers.get('x-voicecan-firmware-version') ?? ''; const size = Number(response.headers.get('x-voicecan-firmware-size')); const crc16 = Number(response.headers.get('x-voicecan-firmware-crc16')); const advertisedChunk = Number(response.headers.get('x-voicecan-firmware-max-ble-chunk'));
        const content = new Uint8Array(await response.arrayBuffer());
        if (!version || !Number.isSafeInteger(size) || size !== content.byteLength || !Number.isSafeInteger(crc16) || crc16 < 0 || crc16 > 65_535) throw new Error('FIRMWARE_PACKAGE_INVALID: Firmware package headers do not match the downloaded file.');
        await session.installFirmware({ version, size, crc16, content, force: firmware?.firmware.up_to_date === true, maxChunkSize: advertisedChunk > 0 ? Math.min(180, advertisedChunk) : 180 }, setOtaProgress);
        await session.close().catch(() => undefined); bleSession.current = undefined; setBleConnected(false);
      } finally { setOtaProgress(null); }
    }, t('Firmware was verified through BLE and the device is restarting.'));
  };

  if (items.length === 0 && !deviceId) return <div className="empty-state"><div className="empty-orbit"><Icon name="device" size={24}/></div><h3>{t('No bound devices')}</h3><p>{t('Bind a device to start monitoring its connection and recording synchronization.')}</p></div>;
  const summary = workspace?.summary;
  const current = workspace?.device ?? items.find((device) => String(device.id) === deviceId);
  const recordingPageSize = 10;
  const recordingPageCount = Math.max(1, Math.ceil((workspace?.files.length ?? 0) / recordingPageSize));
  const currentRecordingPage = Math.min(recordingPage, recordingPageCount - 1);
  const visibleFiles = workspace?.files.slice(currentRecordingPage * recordingPageSize, (currentRecordingPage + 1) * recordingPageSize) ?? [];
  const optionDevices = currentDeviceOptions(items, current);
  const deviceOptions = optionDevices.map((device) => ({ value: String(device.id), label: String(device.display_name ?? device.sn ?? t('Unnamed resource')), description: [device.display_name ? device.sn : null, device.model, device.manufacturer].filter(Boolean).map(String).join(' · '), meta: t(device.online ? 'Server online' : 'Server offline') }));
  const connection = deviceConnectionState(current?.online, bleConnected, deviceStatus?.status?.wifi_state);
  const counts = recordingSyncCounts(summary);
  const wsConnected = connection.canSync;
  const controlConnected = connection.canControl;
  const controlDisabled = !controlConnected || Boolean(busy);
  const latestSyncStatus = String(workspace?.latest_command?.status ?? '');
  const syncActive = ['queued', 'dispatched', 'running'].includes(latestSyncStatus);

  const status = deviceStatus?.status;
  const storageUsedKb = status?.storage_total_kb !== null && status?.storage_total_kb !== undefined && status.storage_free_kb !== null && status.storage_free_kb !== undefined ? Math.max(0, status.storage_total_kb - status.storage_free_kb) : null;
  const batteryPercent = percentage(status?.battery_percent);
  const storageUsedPercent = status?.storage_total_kb && storageUsedKb !== null ? percentage(storageUsedKb / status.storage_total_kb * 100) : null;
  const storageBarWidth = storageUsedPercent !== null && storageUsedPercent > 0 ? Math.max(1.5, storageUsedPercent) : storageUsedPercent ?? 0;
  const firmwareNotes = firmware && !firmware.firmware.up_to_date ? releaseNoteLines(firmware.firmware.release_notes) : [];
  const wifiConnected = connection.wifi === 'connected';
  const statusModel = bleInfo?.model ?? current?.model;
  const statusSn = bleInfo?.serialNumber ?? current?.sn;
  const statusFirmware = bleInfo?.firmwareVersion ?? current?.firmware_version;
  const statusHardware = bleInfo?.hardwareVersion ?? current?.hardware_version;
  const batteryState = status?.battery_state;
  const batteryTone = batteryState === 'charging' ? 'charging' : batteryState === 'full' ? 'full' : batteryState === 'low' ? 'low' : batteryState ? 'normal' : 'unknown';
  const batteryStateLabel = batteryState === 'charging' ? t('Charging') : batteryState === 'full' ? t('Fully charged') : batteryState === 'low' ? t('Low battery') : batteryState === 'normal' ? t('Discharging') : '—';
  const activeTransfer = workspace?.active_transfer;
  const activeBytes = activeTransfer?.transferred_bytes ?? 0;
  const currentFilePercent = activeTransfer && activeTransfer.transferred_bytes !== null && activeTransfer.expected_size > 0 ? percentage(activeBytes / activeTransfer.expected_size * 100) : null;
  const roundTotal = summary?.round_total ?? 0;
  const roundCompleted = summary?.round_completed ?? 0;
  const waitingFiles = (summary?.pending ?? 0) + (summary?.syncing ?? 0) + (summary?.failed ?? 0);
  const overallPercent = summary
    ? roundTotal > 0
      ? percentage(roundCompleted / roundTotal * 100)
      : waitingFiles > 0 ? 0 : summary.total > 0 ? 100 : null
    : null;

  const syncFile = (file: SyncFile): void => {
    if (file.status === 'failed') {
      void run(`retry:${file.id}`, () => api(`/recordings/${encodeURIComponent(file.id)}/retry`, { method: 'POST', body: JSON.stringify({ reason: 'Administrator retried recording synchronization' }) }), t('Recording retry requested.'));
      return;
    }
    void run('sync', () => api(`/devices/${encodeURIComponent(deviceId)}/sync`, { method: 'POST', headers: { 'idempotency-key': randomUuidV4() }, body: '{}' }), t('Device synchronization requested.'));
  };
  const deleteFile = (file: SyncFile): void => {
    if (!canRelease) return;
    if (!globalThis.confirm(t('Delete this synchronized recording object? The original file on the device is not deleted.'))) return;
    void run(`delete:${file.id}`, async () => {
      const preview = await api<{ resource_version: string; confirmation_token: string }>(`/files/${encodeURIComponent(file.id)}/deletion-preview`, { method: 'POST', body: '{}' });
      return api(`/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', body: JSON.stringify({ reason: 'Administrator deleted the synchronized recording object', resource_version: preview.resource_version, confirmation_token: preview.confirmation_token }) });
    }, t('Recording object deleted. The original on the device was not deleted.'));
  };

  const diagnostics = connectionEvents.length ? <section className="connection-diagnostics" aria-label={t('Connection diagnostics')} aria-live="polite">
      <header><h3>{t('Connection diagnostics')}</h3><Button kind="ghost" onClick={() => { const report = JSON.stringify(connectionReport(deviceId, typeof current?.firmware_version === 'string' ? current.firmware_version : null, connectionEvents, connectionReadings), null, 2); const url = URL.createObjectURL(new Blob([report], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'voicecan-connection-diagnostics.json'; link.click(); globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000); setDiagnosticNotice(t('Diagnostics downloaded without passwords or device credentials.')); }}>{t('Download diagnostics')}</Button></header>
      <ol>{connectionEvents.map((event, index) => <li key={index} data-state={event.state}><span>{t(event.state === 'done' ? 'Completed' : event.state === 'failed' ? 'Failed' : 'In progress')}</span><div><strong>{t(stageLabels[event.stage])}</strong>{event.state === 'running' ? <p>{t(event.stage === 'select_device' ? 'Select your device in the browser Bluetooth chooser.' : event.stage === 'wait_server' ? 'Waiting up to 60 seconds for this server to receive the device connection.' : 'Keep this page open while this step completes.')}</p> : null}{event.code ? <div role="alert"><p>{t(connectionAdvice(event.code))}</p><code>{event.stage} · {event.code}</code></div> : null}</div><time>{new Date(event.at).toLocaleTimeString()}</time></li>)}</ol>
      {diagnosticNotice ? <p role="status">{diagnosticNotice}</p> : null}
    </section> : null;

  return <div className="device-workspace">
    <section className="device-workspace-toolbar">
      {editing ? <div className="device-name-editor">
        <input aria-label={t('Device name')} value={displayName} autoFocus maxLength={80} onChange={(event) => setDisplayName(event.target.value)} />
        <Button kind="secondary" disabled={Boolean(busy)} onClick={saveName}>{t('Save')}</Button>
        <Button kind="secondary" onClick={() => setEditing(false)}>{t('Cancel')}</Button>
      </div> : <div className="device-name-heading">
        <h2>{String(current?.display_name ?? current?.sn ?? t('Unnamed resource'))}</h2>
        {canEdit ? <button type="button" className="icon-button" aria-label={t('Edit device name')} title={t('Edit device name')} onClick={beginEdit}><Icon name="edit" size={16}/></button> : null}
      </div>}
    </section>
    {refreshError ? <div className="inline-alert inline-alert-error" role="alert">{refreshError}</div> : null}
    {error ? <div className="inline-alert inline-alert-error" role="alert">{error}</div> : null}
    {notice ? <div className="inline-alert inline-alert-success" role="status">{notice}</div> : null}
    <section className="device-status-card device-status-live">
      <header>
        <div><p className="eyebrow">{t('Live device status')}</p><h3>{t('Device status')}</h3></div>
        <span className={`status-pill ${bleConnected ? 'status-ready' : 'status-neutral'}`}>{bleConnected ? t('BLE connected') : !status ? t('Not read yet') : t(status.source === 'ble' ? 'Last read by BLE' : 'Last read through server')}</span>
      </header>
      <div className="device-status-grid">
        <div className="device-status-overview">
          <div className="device-vitals">
            <article className={`device-vital device-vital-battery is-${batteryTone}`}>
              <div className="device-vital-heading"><span className="device-vital-icon"><Icon name="battery" size={21}/></span><div><span>{t('Battery')}</span><strong>{percentageLabel(batteryPercent)} <small>{batteryStateLabel}</small></strong></div></div>
              <div className="device-meter" role="progressbar" aria-label={t('Battery')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={batteryPercent ?? undefined}><span style={{ width: `${batteryPercent ?? 0}%` }}/></div>
              <footer><span>{status?.battery_temperature_c === null || status?.battery_temperature_c === undefined ? '—' : `${status.battery_temperature_c} °C`}</span><span>{status?.battery_voltage_mv === null || status?.battery_voltage_mv === undefined ? '—' : `${status.battery_voltage_mv} mV`}</span></footer>
            </article>
            <article className="device-vital device-vital-storage">
              <div className="device-vital-heading"><span className="device-vital-icon"><Icon name="storage" size={21}/></span><div><span>{t('Storage')}</span><strong>{percentageLabel(storageUsedPercent)} <small>{t('used')}</small></strong></div></div>
              <div className="device-meter" role="progressbar" aria-label={t('Storage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={storageUsedPercent ?? undefined}><span style={{ width: `${storageBarWidth}%` }}/></div>
              <footer><span>{status?.storage_total_kb === null || status?.storage_total_kb === undefined || storageUsedKb === null ? '—' : t('{used} used of {total}', { used: formatBytes(storageUsedKb * 1024), total: formatBytes(status.storage_total_kb * 1024) })}</span><span>{status?.recording_hours === null || status?.recording_hours === undefined ? '—' : t('{count} hours', { count: status.recording_hours })}</span></footer>
            </article>
          </div>
          <dl className="device-protocol-status">
            <div><dt><Icon name="device"/>{t('Bluetooth name')}</dt><dd>{String(current?.display_name ?? statusModel ?? statusSn ?? '—')}</dd></div>
            <div><dt><Icon name="code"/>{t('Serial number')}</dt><dd><code>{String(statusSn ?? '—')}</code></dd></div>
            <div><dt><Icon name="server"/>{t('Firmware')}</dt><dd>{String(statusFirmware ?? '—')}</dd></div>
            <div><dt><Icon name="server"/>{t('Hardware')}</dt><dd>{String(statusHardware ?? statusModel ?? '—')}</dd></div>
            <div><dt><Icon name="pulse"/>{t('Connection')}</dt><dd className={`device-connection ${wsConnected ? 'is-online' : 'is-offline'}`}>{wsConnected ? t('Online') : t('Offline')}{!wsConnected && current?.last_seen_at ? <small>{t('Last seen')} {formatLocalDateTime(current.last_seen_at)}</small> : null}</dd></div>
            <div><dt><Icon name="wifi"/>Wi-Fi</dt><dd>{connection.wifi === 'unknown' ? t('Not read yet') : wifiConnected ? t('Connected') : t('Disconnected')}</dd></div>
          </dl>
        </div>
        <aside className="device-control-stack">
          <header><span className="device-vital-icon"><Icon name="pulse" size={20}/></span><div><strong>{t('Device controls')}</strong><small>{controlConnected ? t('Connection ready') : t('Connection required')}</small></div></header>
          <div className="device-control-actions"><Button kind="secondary" icon="refresh" disabled={Boolean(busy)} onClick={() => void refreshDeviceStatus()}>{busy === 'status-refresh' ? t('Refreshing…') : t('Refresh')}</Button><Button kind="secondary" disabled={Boolean(busy)} onClick={() => void toggleBle()}>{bleConnected ? t('Disconnect BLE') : t('Connect BLE')}</Button></div>
          {canEdit ? <div className="device-control-actions"><Button kind="secondary" disabled={controlDisabled} onClick={() => void runControl({ kind: 'usb', enabled: !(status?.usb_state === 1 || status?.usb_state === 2) }, status?.usb_state === 1 || status?.usb_state === 2 ? t('USB mode disabled.') : t('USB mode enabled.'))}>{status?.usb_state === 1 || status?.usb_state === 2 ? t('Disable USB') : t('Enable USB')}</Button></div> : null}
          {canEdit ? <div className="device-control-actions device-auto-shutdown-actions"><Select ariaLabel={t('Auto shutdown')} value={autoShutdown} onChange={(value) => { autoShutdownTouched.current = true; setAutoShutdown(value); }} options={[['never', 'Never'], ['15min', '15 minutes'], ['30min', '30 minutes'], ['1h', '1 hour'], ['5h', '5 hours']].map(([value, label]) => ({ value: value!, label: t(label!) }))}/><Button kind="secondary" disabled={controlDisabled} onClick={() => { autoShutdownTouched.current = true; void runControl({ kind: 'auto_shutdown', interval: autoShutdown as 'never' | '15min' | '30min' | '1h' | '5h' }, t('Auto shutdown setting updated.')); }}>{t('Apply auto shutdown')}</Button></div> : null}
          {canRelease ? <div className="device-control-actions"><Button kind="secondary" disabled={controlDisabled} onClick={() => { if (globalThis.confirm(t('Restart this device now?'))) void runControl({ kind: 'power', action: 'reboot' }, t('Restart requested.')); }}>{t('Restart')}</Button><Button kind="danger" disabled={controlDisabled} onClick={() => { if (globalThis.confirm(t('Shut down this device now?'))) void runControl({ kind: 'power', action: 'shutdown' }, t('Shutdown requested.')); }}>{t('Shut down')}</Button><Button kind="danger" disabled={controlDisabled} onClick={() => { if (globalThis.confirm(t('Reset device configuration? Recordings are preserved.'))) void runControl({ kind: 'factory_reset', scope: 'configuration' }, t('Configuration reset requested.')); }}>{t('Reset configuration')}</Button></div> : null}
          {canRelease ? <div className="device-control-actions"><Button kind="secondary" disabled={Boolean(busy)} onClick={() => setWifiEditorOpen((open) => !open)}>{wifiEditorOpen ? t('Cancel') : t('Configure Wi-Fi')}</Button></div> : null}
        </aside>
      </div>
      {wifiEditorOpen ? <form className="device-wifi-form" onSubmit={(event) => { event.preventDefault(); void confirmWifi(); }}>
        <div className="device-wifi-fields">
          <Field id="device-wifi-ssid" label={t('Wi-Fi name')} value={wifiSsid} onChange={setWifiSsid} maxLength={32} required/>
          <Field id="device-wifi-password" label={t('Wi-Fi password')} value={wifiPassword} onChange={setWifiPassword} type="password" maxLength={32}/>
          <Field label={t('Security')}><Select ariaLabel={t('Security')} value={wifiEncryption} onChange={(value) => setWifiEncryption(value as 'open' | 'wpa2' | 'wpa3')} options={[{ value: 'wpa2', label: 'WPA2' }, { value: 'wpa3', label: 'WPA3' }, { value: 'open', label: t('Open network') }]}/></Field>
        </div>
        <div className="form-actions"><Button type="submit" disabled={Boolean(busy) || !wifiSsid.trim()}>{busy === 'wifi-configure' ? t('Configuring…') : t('Confirm')}</Button><Button type="button" kind="secondary" disabled={Boolean(busy)} onClick={() => setWifiEditorOpen(false)}>{t('Cancel')}</Button></div>
      </form> : null}
      {diagnostics ? <details className="device-maintenance-disclosure" open={connectionEvents.some((event) => event.state === 'failed' || event.state === 'running')}><summary>{t('Connection diagnostics')}</summary>{diagnostics}</details> : null}
    </section>
    <section className="sync-overview">
      <div className="sync-progress-panel">
        <div className="sync-progress-header"><span>{t('Transfer speed')}</span><strong>{formatSpeed(transferSpeed)}</strong></div>
        <div className="sync-progress-item">
          <div className="sync-progress-label"><span>{t('Current transfer')}</span><strong>{percentageLabel(currentFilePercent)}</strong></div>
          <div className="sync-progress-track" role="progressbar" aria-label={t('Current transfer')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={currentFilePercent ?? undefined}><span style={{ width: `${currentFilePercent ?? 0}%` }}/></div>
        </div>
        <div className="sync-progress-item">
          <div className="sync-progress-label"><span>{t('Overall progress')}</span><strong>{percentageLabel(overallPercent)}</strong></div>
          <div className="sync-progress-track" role="progressbar" aria-label={t('Overall progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={overallPercent ?? undefined}><span style={{ width: `${overallPercent ?? 0}%` }}/></div>
        </div>
      </div>
      <div className="sync-metrics">
        {[['Pending synchronization', counts.pending, 'neutral'], ['Synced', counts.synced, 'ready'], ['Synced bytes', formatBytes(summary?.synced_bytes ?? 0), 'neutral']].map(([label, value, tone]) => <article key={String(label)} className={`sync-metric sync-metric-${tone}`}><span>{t(String(label))}</span><strong>{String(value)}</strong></article>)}
      </div>
    </section>
    <section className="recording-sync-card"><header><div><p className="eyebrow">{t('Recording synchronization')}</p><h3>{t('Device recordings')}</h3></div><span>{t('{count} recordings', { count: summary?.total ?? 0 })}</span></header>
      {!workspace ? <div className="loading-panel"><span className="spinner"/><span>{t('Loading…')}</span></div> : workspace.files.length === 0 ? <div className="empty-state"><h3>{t('No recordings discovered')}</h3><p>{t('Run a recording scan while the device is online.')}</p></div> : <div className="table-wrap"><table className="data-table sync-table"><colgroup><col className="sync-col-status"/><col className="sync-col-session"/><col className="sync-col-size"/><col className="sync-col-timestamp"/><col className="sync-col-upload"/><col className="sync-col-actions"/></colgroup><thead><tr><th>{t('Status')}</th><th>{t('Session')}</th><th>{t('Size')}</th><th>{t('Timestamp')}</th><th>{t('Upload time')}</th><th>{t('Actions')}</th></tr></thead><tbody>{visibleFiles.map((file) => {
        const stamp = sessionTimestamp(file.session_id); const language = globalThis.document?.documentElement.lang;
        return <tr key={file.id} title={file.id}><td><span className={`status-pill status-${file.status}`} title={file.error_code ?? undefined}>{t(file.status)}</span></td><td><strong>{file.session_id}</strong></td><td>{formatBytes(file.actual_size ?? file.expected_size)}</td><td><time dateTime={stamp?.iso} title={sessionTimestampTitle(file.session_id, language)}>{formatSessionTimestamp(file.session_id, language)}</time></td><td><time dateTime={file.synced_at ?? undefined} title={isoTimestampTitle(file.synced_at, language)}>{formatIsoTimestamp(file.synced_at, language)}</time></td><td><div className="sync-row-actions">
          {file.status === 'pending' ? <Button kind="secondary" disabled={!wsConnected || syncActive || Boolean(busy)} onClick={() => syncFile(file)}>{busy === 'sync' ? t('Requesting…') : t('Sync now')}</Button> : null}
          {file.status === 'failed' ? <Button kind="secondary" disabled={Boolean(busy)} onClick={() => syncFile(file)}>{busy === `retry:${file.id}` ? t('Retrying…') : t('Retry')}</Button> : null}
          {file.status === 'synced' && canRelease ? <Button kind="danger" disabled={Boolean(busy)} onClick={() => deleteFile(file)}>{busy === `delete:${file.id}` ? t('Deleting…') : t('Delete')}</Button> : null}
        </div></td></tr>;
      })}</tbody></table>{recordingPageCount > 1 ? <nav className="table-pagination" aria-label={t('Pagination')}><Button kind="ghost" disabled={currentRecordingPage === 0} onClick={() => setRecordingPage((page) => Math.max(0, page - 1))}>{t('Previous')}</Button><span>{t('Page {page} of {total}', { page: currentRecordingPage + 1, total: recordingPageCount })}</span><Button kind="ghost" disabled={currentRecordingPage >= recordingPageCount - 1} onClick={() => setRecordingPage((page) => Math.min(recordingPageCount - 1, page + 1))}>{t('Next')}</Button></nav> : null}</div>}
    </section>
    <details className="device-maintenance-disclosure"><summary>{t('Device settings and diagnostics')}</summary>
    <section className="firmware-card">
      <div className="firmware-summary"><p className="eyebrow">{t('Firmware repository')}</p><h3>{firmware ? `${firmware.firmware.version} · ${t(firmware.firmware.release_channel === 'developer' ? 'Developer' : 'Production')}` : t('Check for firmware updates')}</h3>{firmwareNotes.length > 0 ? <div className="firmware-release-notes">{firmwareNotes.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div> : <p>{firmware ? (firmware.firmware.up_to_date ? t('This device is up to date in the selected channel.') : t('A newer firmware version is available in the local repository.')) : t('OTA uses a verified local copy. Upload custom firmware or explicitly import it from the configured official source.')}</p>}{firmware ? <small>{t(firmware.firmware.source === 'official' ? 'Official import' : 'Custom upload')} · {formatBytes(firmware.firmware.package_size)} · SHA-256 {firmware.firmware.checksum.replace(/^sha256:/, '').slice(0, 12)}… · {bleConnected ? t('Install through BLE') : t('Install through server')}</small> : null}{otaProgress !== null ? <div className="ota-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={otaProgress}><span style={{ width: `${otaProgress}%` }}/><small>{t('Transferring firmware… {percent}%', { percent: otaProgress })}</small></div> : null}</div>
      <div className="firmware-actions"><Select ariaLabel={t('Release channel')} value={firmwareChannel} onChange={(value) => { setFirmwareChannel(value as 'production' | 'developer'); setFirmware(undefined); }} options={[{ value: 'production', label: t('Production'), description: t('Stable firmware intended for end users.') }, { value: 'developer', label: t('Developer'), description: t('Developer firmware for explicit testing and integration.') }]}/><Button kind="secondary" disabled={!current?.hardware_version || Boolean(busy)} title={!current?.hardware_version ? t('Connect through WebSocket or BLE first so the hardware version can be identified.') : undefined} onClick={() => void checkFirmware()}>{busy === 'firmware-check' ? t('Checking…') : t('Check local')}</Button>{canRelease ? <Button kind="secondary" disabled={!current?.hardware_version || Boolean(busy)} title={!current?.hardware_version ? t('Connect through WebSocket or BLE first so the hardware version can be identified.') : undefined} onClick={() => void importOfficialFirmware()}>{busy === 'firmware-import' ? t('Importing…') : t('Import official')}</Button> : null}{canRelease && firmware ? <Button disabled={!controlConnected || Boolean(busy)} onClick={() => { if (globalThis.confirm(t('Install firmware {version} from the {channel} channel now?', { version: firmware.firmware.version, channel: t(firmwareChannel === 'developer' ? 'Developer' : 'Production') }))) void installFirmware(); }}>{busy === 'firmware-install' ? (otaProgress === null ? t('Starting…') : `${otaProgress}%`) : firmware.firmware.up_to_date ? t('Reinstall') : t('Install update')}</Button> : null}</div>
      {!current?.hardware_version ? <div className="firmware-requirement-note"><strong>{t('Hardware version is not available yet')}</strong><span>{t('Bring the device online through WebSocket, or connect it through BLE below. Firmware actions will unlock after device information is refreshed.')}</span></div> : null}
    </section>
    {canRelease ? <details className="firmware-repository-card"><summary>{t('Upload custom firmware')}</summary><div className="firmware-upload-grid"><div className="file-input-field"><label htmlFor="firmware-file">{t('Firmware file')}</label><input id="firmware-file" type="file" accept=".bin,application/octet-stream" onChange={(event) => setUploadFile(event.target.files?.[0])}/><small>{uploadFile ? `${uploadFile.name} · ${formatBytes(uploadFile.size)}` : t('The uploaded package is stored locally and verified again before every OTA transfer.')}</small></div><Field id="firmware-version" label={t('Firmware version')} value={uploadVersion} onChange={setUploadVersion} placeholder="v0.5.4-dev"/><Field id="firmware-crc16" label="CRC16" value={uploadCrc16} onChange={setUploadCrc16} placeholder="0–65535"/><Field id="firmware-max-chunk" label={t('Maximum BLE chunk')} value={uploadMaxBleChunk} onChange={setUploadMaxBleChunk} placeholder="0"/><Field id="firmware-notes" label={t('Release notes')} value={uploadNotes} onChange={setUploadNotes}/><div className="firmware-upload-action"><small>{t('Hardware {hardware} · {channel} channel', { hardware: String(current?.hardware_version ?? '—'), channel: t(firmwareChannel === 'developer' ? 'Developer' : 'Production') })}</small><Button disabled={!uploadFile || !uploadVersion.trim() || !uploadCrc16.trim() || Boolean(busy)} onClick={() => void uploadFirmware()}>{busy === 'firmware-upload' ? t('Uploading…') : t('Upload to local repository')}</Button></div></div></details> : null}
    <section className="sync-control-card">
      <div><h3>{t('Synchronization recovery')}</h3><p>{t('Reset failed or stale synchronization attempts without deleting recordings, then request a fresh device inventory.')}</p></div>
      <div><Button kind="secondary" disabled={!summary?.failed || Boolean(busy)} onClick={() => { if (globalThis.confirm(t('Reset failed synchronization attempts and scan again?'))) void run('reset-failed', () => api(`/devices/${encodeURIComponent(deviceId)}/recording-sync/reset`, { method: 'POST', body: JSON.stringify({ mode: 'failed', reason: 'Administrator reset failed synchronization attempts' }) }), t('Failed synchronization attempts were reset.')); }}>{t('Reset failed')}</Button><Button kind="danger" disabled={Boolean(busy)} onClick={() => { if (globalThis.confirm(t('Reset failed and stale synchronization attempts? Recording objects will not be deleted.'))) void run('reset-stale', () => api(`/devices/${encodeURIComponent(deviceId)}/recording-sync/reset`, { method: 'POST', body: JSON.stringify({ mode: 'failed_and_stale', reason: 'Administrator reset failed and stale synchronization attempts' }) }), t('Failed and stale synchronization attempts were reset.')); }}>{t('Reset failed and stale')}</Button></div>
    </section>
    <section className="device-lower-grid"><article><p className="eyebrow">{t('Latest semantic command')}</p><DataTable data={workspace?.latest_command ?? commands} t={t} emptyMessage={t('No reviewed commands have been requested for this device.')}/></article><article><p className="eyebrow">{t('Public capability manifest')}</p><DataTable data={capabilities} t={t}/></article></section>
    </details>
  </div>;
}
