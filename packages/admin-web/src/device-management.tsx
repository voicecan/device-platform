import { useEffect, useRef, useState } from 'react';
import { connectBoundDevice, type BoundDeviceMaintenance, type DeviceControl } from '@voicecan/device-connect-web';
import { api, apiBinary, apiBinaryUpload, errorMessage } from './api.js';
import { Button, DataTable, DeviceWsCandidatePicker, Field, Icon, Select, collectionOf, formatLocalDateTime, type DeviceWsCandidate, type Translate } from './ui.js';

type DeviceRow = Record<string, unknown>;
type SyncFile = {
  id: string; session_id: number; attribute: number; expected_size: number; actual_size: number | null;
  status: string; transport: string | null; error_code: string | null; created_at: string; updated_at: string;
};
type SyncWorkspace = {
  device: DeviceRow & { connection_epoch: number; connection_status: string };
  summary: { total: number; pending: number; syncing: number; synced: number; failed: number; identity_conflict: number; discovered_bytes: number; synced_bytes: number; oldest_incomplete_at: string | null; last_synced_at: string | null };
  files: SyncFile[];
  latest_command: Record<string, unknown> | null;
  reset_policy: { deletes_recordings: false; default_scope: string; stale_after_seconds: number };
};
type DeviceStatusSnapshot = {
  source: 'ws' | 'ble'; record_state: number | null; record_mode: number | null; microphone_mode: number | null; microphone_gain_db: number | null;
  usb_state: number | null; wifi_state: number | null; wifi_mode: number | null; relay_state: number | null; privacy_mode: boolean | null; earphone_recording: boolean | null;
  storage_total_kb: number | null; storage_free_kb: number | null; recording_hours: number | null; battery_state: string | null; battery_percent: number | null; battery_temperature_c: number | null; battery_voltage_mv: number | null; work_time_seconds: number | null; accumulated_work_time_seconds: number | null; status_updated_at: string | null; storage_updated_at: string | null; battery_updated_at: string | null; updated_at: string;
};
type DeviceStatusWorkspace = { device: DeviceRow; status: DeviceStatusSnapshot | null; refresh_available: boolean; polling_interval_seconds: number };
type BleSessionGrant = { device_id: string; serial_number: string; device_token: string; ble_name_prefix: string };
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

function formatDuration(seconds: number | null | undefined, t: Translate): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86_400); const hours = Math.floor(seconds % 86_400 / 3_600); const minutes = Math.floor(seconds % 3_600 / 60);
  return [days ? t('{count} days', { count: days }) : '', hours ? t('{count} hours', { count: hours }) : '', !days && minutes ? t('{count} minutes', { count: minutes }) : ''].filter(Boolean).join(' ') || t('Less than one minute');
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

function syncError(errorCode: string | null, t: Translate): string {
  if (!errorCode) return '—';
  if (errorCode === 'DEVICE_TRANSFER_RESULT_0C') return t('The device aborted the upload. Check that the upload address is reachable, then retry.');
  if (errorCode === 'UPLOAD_TICKET_EXPIRED') return t('The upload ticket expired before the device completed the transfer.');
  if (errorCode === 'CONTENT_LENGTH_MISMATCH' || errorCode === 'UPLOAD_SIZE_MISMATCH') return t('The uploaded byte count did not match the device file size.');
  return errorCode;
}

export function DeviceManagement({ devices, t, canEdit, canRelease, onRelease, onDevicesRefresh }: { devices: unknown; t: Translate; canEdit: boolean; canRelease: boolean; onRelease: (deviceId: string) => void; onDevicesRefresh: () => void }) {
  const items = collectionOf(devices);
  const requested = new URLSearchParams(globalThis.location.search).get('device') ?? '';
  const [deviceId, setDeviceId] = useState(requested);
  const [workspace, setWorkspace] = useState<SyncWorkspace>();
  const [capabilities, setCapabilities] = useState<unknown>();
  const [commands, setCommands] = useState<unknown>();
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatusWorkspace>();
  const [bleConnected, setBleConnected] = useState(false);
  const [autoShutdown, setAutoShutdown] = useState('never');
  const bleSession = useRef<BoundDeviceMaintenance | undefined>(undefined);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [recordingPage, setRecordingPage] = useState(0);
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
  const [serverAddress, setServerAddress] = useState('');
  const [serverCandidates, setServerCandidates] = useState<DeviceWsCandidate[]>([]);

  useEffect(() => {
    let active = true;
    void api<{ preferred_device_ws_url: string; device_ws_urls: DeviceWsCandidate[] }>('/settings/device-access').then((settings) => {
      if (!active) return; setServerCandidates(settings.device_ws_urls); setServerAddress((currentAddress) => currentAddress || settings.preferred_device_ws_url);
    }, () => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (requested) {
      if (requested !== deviceId) setDeviceId(requested);
      return;
    }
    if (!items.some((device) => String(device.id) === deviceId) && items[0]?.id) setDeviceId(String(items[0].id));
  }, [deviceId, items, requested]);

  const load = async (selected = deviceId, quiet = false): Promise<void> => {
    if (!selected) return;
    if (!quiet) setBusy('loading');
    try {
      const [nextWorkspace, nextCapabilities, nextCommands, nextStatus] = await Promise.all([
        api<SyncWorkspace>(`/devices/${encodeURIComponent(selected)}/recording-sync`),
        api(`/devices/${encodeURIComponent(selected)}/capabilities`),
        api(`/devices/${encodeURIComponent(selected)}/commands`),
        api<DeviceStatusWorkspace>(`/devices/${encodeURIComponent(selected)}/status`),
      ]);
      setWorkspace(nextWorkspace); setCapabilities(nextCapabilities); setCommands(nextCommands); setDeviceStatus(nextStatus); setError('');
    } catch (cause) { if (!quiet) setError(errorMessage(cause)); }
    finally { if (!quiet) setBusy(''); }
  };

  useEffect(() => {
    void bleSession.current?.close(); bleSession.current = undefined; setBleConnected(false);
    setWorkspace(undefined); setCapabilities(undefined); setCommands(undefined); setDeviceStatus(undefined); setFirmware(undefined); setOtaProgress(null); setError(''); setNotice(''); setRecordingPage(0);
    if (!deviceId) return;
    void load(deviceId);
    const timer = globalThis.setInterval(() => void load(deviceId, true), 5_000);
    return () => { globalThis.clearInterval(timer); void bleSession.current?.close(); bleSession.current = undefined; };
  }, [deviceId]);

  const chooseDevice = (next: string): void => {
    setDeviceId(next);
    const url = new URL(globalThis.location.href); url.searchParams.set('device', next);
    globalThis.history.replaceState({ view: 'devices', deviceId: next }, '', url);
  };

  const beginEdit = (): void => { setDisplayName(String(current?.display_name ?? '')); setEditing(true); };

  const run = async (key: string, operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(key); setError(''); setNotice('');
    try { await operation(); setNotice(success); await load(deviceId, true); onDevicesRefresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(''); }
  };

  const reportBleStatus = async (session: BoundDeviceMaintenance, serialNumber: string, status = session.status): Promise<void> => {
    await api(`/devices/${encodeURIComponent(deviceId)}/ble-status`, { method: 'POST', body: JSON.stringify({ serial_number: serialNumber, info: session.info, status }) });
  };
  const clearDisconnectedBleSession = (cause: unknown): void => {
    if (!/(?:device|gatt|bluetooth).*(?:disconnect|not connected)|(?:disconnect|not connected).*(?:device|gatt|bluetooth)/i.test(errorMessage(cause))) return;
    bleSession.current = undefined; setBleConnected(false);
  };
  const connectBle = async (): Promise<void> => run('ble-connect', async () => {
    const grant = await api<BleSessionGrant>(`/devices/${encodeURIComponent(deviceId)}/ble-maintenance-session`, { method: 'POST', body: '{}' });
    const rawToken = decodeBase64Url(grant.device_token);
    try {
      const session = await connectBoundDevice({ rawToken, expectedSerialNumber: grant.serial_number, bleNamePrefix: grant.ble_name_prefix, coreModuleUrl: '/sdk/private/semantic_core.js' });
      bleSession.current = session; setBleConnected(true);
      try { await reportBleStatus(session, grant.serial_number, await session.refresh()); }
      catch (cause) { clearDisconnectedBleSession(cause); throw cause; }
    } finally { rawToken.fill(0); }
  }, t('Bluetooth maintenance connection established.'));
  const disconnectBle = async (): Promise<void> => { await bleSession.current?.close(); bleSession.current = undefined; setBleConnected(false); setNotice(t('Bluetooth maintenance connection closed.')); };
  const refreshBle = async (): Promise<void> => run('ble-refresh', async () => {
    const session = bleSession.current; if (!session) throw new Error(t('Connect with BLE before using nearby maintenance.'));
    const serialNumber = String(workspace?.device.sn ?? current?.sn ?? '');
    try { const status = await session.refresh(); await reportBleStatus(session, serialNumber, status); return status; }
    catch (cause) { clearDisconnectedBleSession(cause); throw cause; }
  }, t('Device status refreshed through BLE.'));
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
    return api(`/devices/${encodeURIComponent(deviceId)}/control`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ control, reason: 'Administrator requested reviewed device control' }) });
  }, success);
  const configureWifi = async (): Promise<void> => run('wifi-configure', async () => {
    const session = bleSession.current; if (!session) throw new Error(t('Connect with BLE before using nearby maintenance.'));
    if (!wifiSsid.trim()) throw new Error(t('Wi-Fi SSID is required.'));
    try {
      let nextStatus = await session.configureWifi({ ssid: wifiSsid.trim(), password: wifiPassword, encryption: wifiEncryption });
      for (let attempt = 0; attempt < 5 && !nextStatus.wifiConfigured; attempt += 1) { await new Promise((resolve) => globalThis.setTimeout(resolve, 2_000)); nextStatus = await session.refresh(); }
      await reportBleStatus(session, String(current?.sn ?? ''), nextStatus); setWifiPassword(''); return nextStatus;
    }
    catch (cause) { clearDisconnectedBleSession(cause); throw cause; }
  }, t('Wi-Fi settings were sent and device status was refreshed.'));
  const configureServer = async (): Promise<void> => run('server-configure', async () => {
    const session = bleSession.current; if (!session) throw new Error(t('Connect with BLE before using nearby maintenance.'));
    let url: URL; try { url = new URL(serverAddress.trim()); } catch { throw new Error(t('Enter a valid ws:// or wss:// server URL.')); }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(t('Enter a valid ws:// or wss:// server URL.'));
    try { await session.configureServer(url.toString()); }
    catch (cause) { clearDisconnectedBleSession(cause); throw cause; }
  }, t('Server address and device credential were updated securely through BLE.'));
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
    if (!session) return run('firmware-install', () => api(`/devices/${encodeURIComponent(deviceId)}/ota`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ channel: firmwareChannel, force: firmware?.firmware.up_to_date === true, reason: 'Administrator approved official firmware OTA' }) }), t('Firmware update started. Keep the device online and powered.'));
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
  const optionDevices = current && !items.some((device) => String(device.id) === String(current.id)) ? [current, ...items] : items;
  const deviceOptions = optionDevices.map((device) => ({ value: String(device.id), label: String(device.display_name ?? device.sn ?? t('Unnamed resource')), description: [device.display_name ? device.sn : null, device.model, device.manufacturer].filter(Boolean).map(String).join(' · '), meta: t(device.online ? 'Online' : 'Offline') }));
  const wsConnected = current?.online === true;
  const controlConnected = wsConnected || bleConnected;
  const controlDisabled = !controlConnected || Boolean(busy);
  const latestSyncStatus = String(workspace?.latest_command?.status ?? '');
  const syncActive = ['queued', 'dispatched', 'running'].includes(latestSyncStatus);
  const status = deviceStatus?.status;
  const storageUsedKb = status?.storage_total_kb !== null && status?.storage_total_kb !== undefined && status.storage_free_kb !== null && status.storage_free_kb !== undefined ? Math.max(0, status.storage_total_kb - status.storage_free_kb) : null;
  const batteryPercent = percentage(status?.battery_percent);
  const storageUsedPercent = status?.storage_total_kb && storageUsedKb !== null ? percentage(storageUsedKb / status.storage_total_kb * 100) : null;
  const storageBarWidth = storageUsedPercent !== null && storageUsedPercent > 0 ? Math.max(1.5, storageUsedPercent) : storageUsedPercent ?? 0;
  const firmwareNotes = firmware && !firmware.firmware.up_to_date ? releaseNoteLines(firmware.firmware.release_notes) : [];
  const wifiConnected = status?.wifi_state === 1;
  const wifiMode = status?.wifi_mode === 1 ? 'AP' : status?.wifi_mode === 2 ? 'STA' : status?.wifi_mode === 0 ? t('Off') : '—';

  return <div className="device-workspace">
    <section className="device-workspace-toolbar">
      <div><p className="eyebrow">{t('Device control center')}</p><h2>{String(current?.display_name ?? current?.sn ?? t('Unnamed resource'))}</h2><p>{current?.display_name ? String(current.sn ?? '') : t('Connection, commands and recording synchronization in one workspace.')}</p></div>
      <div className="device-workspace-actions"><Select searchable ariaLabel={t('Device')} value={deviceId} options={deviceOptions} onChange={chooseDevice}/>{canEdit ? <Button kind="secondary" onClick={beginEdit}>{t('Edit device')}</Button> : null}<Button kind="secondary" icon="refresh" disabled={Boolean(busy)} onClick={() => void load()}>{t('Refresh')}</Button></div>
    </section>
    {error ? <div className="inline-alert inline-alert-error" role="alert">{error}</div> : null}
    {notice ? <div className="inline-alert inline-alert-success" role="status">{notice}</div> : null}
    {editing ? <section className="device-edit-card"><div><h3>{t('Edit device')}</h3><p>{t('Use a friendly name that people can recognize. The serial number remains available in details.')}</p></div><Field id="device-display-name" label={t('Device name')} value={displayName} onChange={setDisplayName} placeholder={String(current?.sn ?? '')}/><div className="device-edit-actions"><Button kind="secondary" onClick={() => setEditing(false)}>{t('Cancel')}</Button><Button disabled={Boolean(busy)} onClick={() => void run('rename', () => api(`/devices/${encodeURIComponent(deviceId)}`, { method: 'PATCH', body: JSON.stringify({ display_name: displayName.trim() || null, reason: 'Administrator updated device display name' }) }), t('Device name updated.')).then(() => setEditing(false))}>{t('Save')}</Button>{canRelease ? <Button kind="danger" onClick={() => onRelease(deviceId)}>{t('Safely unbind')}</Button> : null}</div></section> : null}
    <section className="connection-strip">
      <div><span className={`connection-beacon ${current?.online ? 'is-online' : ''}`}/><div><strong>{t(current?.online ? 'Online' : 'Offline')}</strong><small>{t('WebSocket connection')}</small></div></div>
      <dl><div><dt>{t('Connection epoch')}</dt><dd>{String(current?.connection_epoch ?? '—')}</dd></div><div><dt>{t('Last seen')}</dt><dd>{formatLocalDateTime(current?.last_seen_at)}</dd></div><div><dt>{t('Firmware')}</dt><dd>{String(current?.firmware_version ?? '—')}</dd></div><div><dt>{t('Hardware')}</dt><dd>{String(current?.hardware_version ?? current?.model ?? '—')}</dd></div></dl>
      <div className="sync-trigger"><Button disabled={!deviceId || !wsConnected || syncActive || Boolean(busy)} title={!wsConnected ? t('A WebSocket connection is required to scan recordings.') : syncActive ? t('A synchronization request is already active.') : undefined} onClick={() => void run('sync', () => api(`/devices/${encodeURIComponent(deviceId)}/sync`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: '{}' }), t('Device synchronization requested.'))}>{busy === 'sync' ? t('Requesting…') : syncActive ? t('Synchronization in progress') : t('Sync now')}</Button>{syncActive ? <small>{t('The current request is shown in command details below.')}</small> : null}</div>
    </section>
    <section className="firmware-card">
      <div className="firmware-summary"><p className="eyebrow">{t('Firmware repository')}</p><h3>{firmware ? `${firmware.firmware.version} · ${t(firmware.firmware.release_channel === 'developer' ? 'Developer' : 'Production')}` : t('Check for firmware updates')}</h3>{firmwareNotes.length > 0 ? <div className="firmware-release-notes">{firmwareNotes.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div> : <p>{firmware ? (firmware.firmware.up_to_date ? t('This device is up to date in the selected channel.') : t('A newer firmware version is available in the local repository.')) : t('OTA uses a verified local copy. Upload custom firmware or explicitly import it from the configured official source.')}</p>}{firmware ? <small>{t(firmware.firmware.source === 'official' ? 'Official import' : 'Custom upload')} · {formatBytes(firmware.firmware.package_size)} · SHA-256 {firmware.firmware.checksum.replace(/^sha256:/, '').slice(0, 12)}… · {bleConnected ? t('Install through BLE') : t('Install through server')}</small> : null}{otaProgress !== null ? <div className="ota-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={otaProgress}><span style={{ width: `${otaProgress}%` }}/><small>{t('Transferring firmware… {percent}%', { percent: otaProgress })}</small></div> : null}</div>
      <div className="firmware-actions"><Select ariaLabel={t('Release channel')} value={firmwareChannel} onChange={(value) => { setFirmwareChannel(value as 'production' | 'developer'); setFirmware(undefined); }} options={[{ value: 'production', label: t('Production'), description: t('Stable firmware intended for end users.') }, { value: 'developer', label: t('Developer'), description: t('Developer firmware for explicit testing and integration.') }]}/><Button kind="secondary" disabled={!current?.hardware_version || Boolean(busy)} title={!current?.hardware_version ? t('Connect through WebSocket or BLE first so the hardware version can be identified.') : undefined} onClick={() => void checkFirmware()}>{busy === 'firmware-check' ? t('Checking…') : t('Check local')}</Button>{canRelease ? <Button kind="secondary" disabled={!current?.hardware_version || Boolean(busy)} title={!current?.hardware_version ? t('Connect through WebSocket or BLE first so the hardware version can be identified.') : undefined} onClick={() => void importOfficialFirmware()}>{busy === 'firmware-import' ? t('Importing…') : t('Import official')}</Button> : null}{canRelease && firmware ? <Button disabled={!controlConnected || Boolean(busy)} onClick={() => { if (globalThis.confirm(t('Install firmware {version} from the {channel} channel now?', { version: firmware.firmware.version, channel: t(firmwareChannel === 'developer' ? 'Developer' : 'Production') }))) void installFirmware(); }}>{busy === 'firmware-install' ? (otaProgress === null ? t('Starting…') : `${otaProgress}%`) : firmware.firmware.up_to_date ? t('Reinstall') : t('Install update')}</Button> : null}</div>
      {!current?.hardware_version ? <div className="firmware-requirement-note"><strong>{t('Hardware version is not available yet')}</strong><span>{t('Bring the device online through WebSocket, or connect it through BLE below. Firmware actions will unlock after device information is refreshed.')}</span></div> : null}
    </section>
    {canRelease ? <details className="firmware-repository-card"><summary>{t('Upload custom firmware')}</summary><div className="firmware-upload-grid"><div className="file-input-field"><label htmlFor="firmware-file">{t('Firmware file')}</label><input id="firmware-file" type="file" accept=".bin,application/octet-stream" onChange={(event) => setUploadFile(event.target.files?.[0])}/><small>{uploadFile ? `${uploadFile.name} · ${formatBytes(uploadFile.size)}` : t('The uploaded package is stored locally and verified again before every OTA transfer.')}</small></div><Field id="firmware-version" label={t('Firmware version')} value={uploadVersion} onChange={setUploadVersion} placeholder="v0.5.4-dev"/><Field id="firmware-crc16" label="CRC16" value={uploadCrc16} onChange={setUploadCrc16} placeholder="0–65535"/><Field id="firmware-max-chunk" label={t('Maximum BLE chunk')} value={uploadMaxBleChunk} onChange={setUploadMaxBleChunk} placeholder="0"/><Field id="firmware-notes" label={t('Release notes')} value={uploadNotes} onChange={setUploadNotes}/><div className="firmware-upload-action"><small>{t('Hardware {hardware} · {channel} channel', { hardware: String(current?.hardware_version ?? '—'), channel: t(firmwareChannel === 'developer' ? 'Developer' : 'Production') })}</small><Button disabled={!uploadFile || !uploadVersion.trim() || !uploadCrc16.trim() || Boolean(busy)} onClick={() => void uploadFirmware()}>{busy === 'firmware-upload' ? t('Uploading…') : t('Upload to local repository')}</Button></div></div></details> : null}
    <section className="device-status-card">
      <header><div><p className="eyebrow">{t('Live device status')}</p><h3>{t('Status and controls')}</h3></div><span className={`status-pill ${bleConnected ? 'status-ready' : 'status-neutral'}`}>{bleConnected ? t('BLE connected') : t(deviceStatus?.status?.source === 'ble' ? 'Last read by BLE' : 'Server polling')}</span></header>
      {!controlConnected ? <div className="control-connection-notice" role="status"><Icon name="pulse"/><div><strong>{t('Connect the device to use controls')}</strong><span>{t('Controls become available when the device is online through WebSocket or connected to this browser through BLE.')}</span></div></div> : null}
      <div className="device-status-grid">
        <div className="device-status-overview">
          <div className="device-vitals">
            <article className="device-vital device-vital-battery">
              <div className="device-vital-heading"><span className="device-vital-icon"><Icon name="battery" size={21}/></span><div><span>{t('Battery')}</span><strong>{percentageLabel(batteryPercent)}{status?.battery_state ? <small> · {t(status.battery_state)}</small> : null}</strong></div></div>
              <div className="device-meter" role="progressbar" aria-label={t('Battery')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={batteryPercent ?? undefined}><span style={{ width: `${batteryPercent ?? 0}%` }}/></div>
              <footer><span>{status?.battery_temperature_c === null || status?.battery_temperature_c === undefined ? '—' : `${status.battery_temperature_c} °C`}</span><span>{status?.battery_voltage_mv === null || status?.battery_voltage_mv === undefined ? '—' : `${status.battery_voltage_mv} mV`}</span></footer>
            </article>
            <article className="device-vital device-vital-storage">
              <div className="device-vital-heading"><span className="device-vital-icon"><Icon name="storage" size={21}/></span><div><span>{t('Storage')}</span><strong>{percentageLabel(storageUsedPercent)} <small>{t('used')}</small></strong></div></div>
              <div className="device-meter" role="progressbar" aria-label={t('Storage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={storageUsedPercent ?? undefined}><span style={{ width: `${storageBarWidth}%` }}/></div>
              <footer><span>{status?.storage_total_kb === null || status?.storage_total_kb === undefined ? '—' : t('{used} used of {total}', { used: formatBytes((storageUsedKb ?? 0) * 1024), total: formatBytes(status.storage_total_kb * 1024) })}</span><span>{status?.recording_hours === null || status?.recording_hours === undefined ? '—' : t('{count} hours', { count: status.recording_hours })}</span></footer>
            </article>
          </div>
          <dl className="device-protocol-status">
            <div><dt><Icon name="microphone"/>{t('Recording status')}</dt><dd>{status?.record_state === 0 ? t('Idle') : status?.record_state === 1 ? t('Recording') : status?.record_state === 2 ? t('Paused') : '—'} · {status?.record_mode === 0 ? t('Normal') : status?.record_mode === 16 ? t('Back-glance') : status?.record_mode === 32 ? t('Event') : status?.record_mode ?? '—'}</dd></div>
            <div><dt><Icon name="microphone"/>{t('Microphone')}</dt><dd>{status?.microphone_mode === 0 ? t('Normal') : status?.microphone_mode === 1 ? t('Noise reduction') : status?.microphone_mode === 2 ? t('Voice enhancement') : '—'}{status?.microphone_gain_db === null || status?.microphone_gain_db === undefined ? '' : ` · ${status.microphone_gain_db} dB`}</dd></div>
            <div><dt><Icon name="wifi"/>Wi-Fi</dt><dd>{status?.wifi_state === 1 ? t('Connected') : status?.wifi_state === 0 ? t('Disconnected') : '—'} · {wifiMode}</dd></div>
            <div><dt><Icon name="device"/>USB</dt><dd>{status?.usb_state === 0 ? t('Disabled') : status?.usb_state === 1 ? t('Enabled') : status?.usb_state === 2 ? t('Enabled and connected') : '—'}</dd></div>
            <div><dt><Icon name="shield"/>{t('Privacy and calls')}</dt><dd>{t('Privacy')} {status?.privacy_mode === null || status?.privacy_mode === undefined ? '—' : t(status.privacy_mode ? 'On' : 'Off')} · {t('Call recording')} {status?.earphone_recording === null || status?.earphone_recording === undefined ? '—' : t(status.earphone_recording ? 'On' : 'Off')}</dd></div>
            <div><dt><Icon name="pulse"/>{t('Bluetooth relay')}</dt><dd>{status?.relay_state === 0 ? t('Off') : status?.relay_state === 1 ? t('On') : status?.relay_state === 2 ? t('Relaying') : '—'}</dd></div>
            <div><dt><Icon name="clock"/>{t('Uptime')}</dt><dd>{formatDuration(status?.work_time_seconds, t)} · {t('Total')} {formatDuration(status?.accumulated_work_time_seconds, t)}</dd></div>
            <div><dt><Icon name="server"/>{t('Status source')}</dt><dd>{status ? t(status.source === 'ble' ? 'Bluetooth' : 'WebSocket') : '—'} · {formatLocalDateTime(status?.updated_at)}</dd></div>
          </dl>
        </div>
        <aside className="device-control-stack">
          <header><span className="device-vital-icon"><Icon name="pulse" size={20}/></span><div><strong>{t('Device controls')}</strong><small>{controlConnected ? t('Connection ready') : t('Connection required')}</small></div></header>
          <div className="device-control-actions"><Button kind="secondary" disabled={!wsConnected || Boolean(busy)} onClick={() => void run('status-refresh', () => api(`/devices/${encodeURIComponent(deviceId)}/status/refresh`, { method: 'POST', body: '{}' }), t('Device status refresh requested.'))}>{t('Refresh through server')}</Button>{canRelease && !bleConnected ? <Button kind="secondary" disabled={Boolean(busy)} onClick={() => void connectBle()}>{busy === 'ble-connect' ? t('Connecting…') : t('Connect with BLE')}</Button> : null}{bleConnected ? <><Button kind="secondary" disabled={Boolean(busy)} onClick={() => void refreshBle()}>{busy === 'ble-refresh' ? t('Refreshing…') : t('Refresh through BLE')}</Button><Button kind="secondary" disabled={Boolean(busy)} onClick={() => void disconnectBle()}>{t('Disconnect BLE')}</Button></> : null}</div>
          {canEdit ? <div className="device-control-actions"><Button kind="secondary" disabled={controlDisabled} onClick={() => void runControl({ kind: 'usb', enabled: status?.usb_state !== 1 }, status?.usb_state === 1 ? t('USB mode disabled.') : t('USB mode enabled.'))}>{status?.usb_state === 1 ? t('Disable USB') : t('Enable USB')}</Button><Button kind="secondary" disabled={controlDisabled} onClick={() => void runControl({ kind: 'privacy', enabled: !status?.privacy_mode }, status?.privacy_mode ? t('Privacy mode disabled.') : t('Privacy mode enabled.'))}>{status?.privacy_mode ? t('Disable privacy') : t('Enable privacy')}</Button><Button kind="secondary" disabled={controlDisabled} onClick={() => void runControl({ kind: 'earphone_recording', enabled: !status?.earphone_recording }, t('Earphone recording setting updated.'))}>{status?.earphone_recording ? t('Disable earphone recording') : t('Enable earphone recording')}</Button></div> : null}
          {canEdit ? <div className="device-control-actions"><Select ariaLabel={t('Auto shutdown')} value={autoShutdown} onChange={setAutoShutdown} options={[['never', 'Never'], ['15min', '15 minutes'], ['30min', '30 minutes'], ['1h', '1 hour'], ['5h', '5 hours']].map(([value, label]) => ({ value: value!, label: t(label!) }))}/><Button kind="secondary" disabled={controlDisabled} onClick={() => void runControl({ kind: 'auto_shutdown', interval: autoShutdown as 'never' | '15min' | '30min' | '1h' | '5h' }, t('Auto shutdown setting updated.'))}>{t('Apply auto shutdown')}</Button></div> : null}
          {canRelease ? <details className="inline-details"><summary>{t('Power and reset')}</summary><div className="device-control-actions"><Button kind="secondary" disabled={controlDisabled} onClick={() => { if (globalThis.confirm(t('Restart this device now?'))) void runControl({ kind: 'power', action: 'reboot' }, t('Restart requested.')); }}>{t('Restart')}</Button><Button kind="danger" disabled={controlDisabled} onClick={() => { if (globalThis.confirm(t('Shut down this device now?'))) void runControl({ kind: 'power', action: 'shutdown' }, t('Shutdown requested.')); }}>{t('Shut down')}</Button><Button kind="danger" disabled={controlDisabled} onClick={() => { if (globalThis.confirm(t('Reset device configuration? Recordings are preserved.'))) void runControl({ kind: 'factory_reset', scope: 'configuration' }, t('Configuration reset requested.')); }}>{t('Reset configuration')}</Button></div></details> : null}
        </aside>
      </div>
    </section>
    {canRelease ? <section className="device-network-card">
      <header><div><p className="eyebrow">{t('Nearby maintenance')}</p><h3>{t('Network and server settings')}</h3><p>{t('Sensitive Wi-Fi credentials and the device token are sent directly from this browser to the authenticated device and are never stored in the platform command log.')}</p></div><span className={`status-pill ${bleConnected ? 'status-ready' : 'status-neutral'}`}>{bleConnected ? t('BLE connected') : t('BLE required')}</span></header>
      <div className="network-live-state"><span className={`network-state-icon ${wifiConnected ? 'is-online' : ''}`}><Icon name="wifi" size={22}/></span><div><strong>{wifiConnected ? t('Wi-Fi connected') : t('Wi-Fi not connected')}</strong><small>{t('Mode')} {wifiMode} · {t('Updated')} {formatLocalDateTime(status?.updated_at)}</small></div>{!wifiConnected ? <span>{t('The device needs a network address before it can connect to WebSocket.')}</span> : null}</div>
      <div className="device-network-grid">
        <form onSubmit={(event) => { event.preventDefault(); void configureWifi(); }}><div className="form-title"><Icon name="wifi"/><div><h4>{t('Connect device to Wi-Fi')}</h4><small>{wifiConnected ? t('The device currently reports an active network connection.') : t('Enter the network used by this device.')}</small></div></div><Field id="maintenance-wifi-ssid" label="Wi-Fi SSID" value={wifiSsid} onChange={setWifiSsid} maxLength={32} required/><Field id="maintenance-wifi-password" label={t('Wi-Fi password')} value={wifiPassword} onChange={setWifiPassword} type="password" maxLength={32}/><Select ariaLabel={t('Security')} value={wifiEncryption} onChange={(value) => setWifiEncryption(value as 'open' | 'wpa2' | 'wpa3')} options={[{ value: 'wpa2', label: 'WPA2' }, { value: 'wpa3', label: 'WPA3' }, { value: 'open', label: t('Open network') }]}/><Button disabled={!bleConnected || !wifiSsid.trim() || Boolean(busy)}>{busy === 'wifi-configure' ? t('Configuring…') : t('Set network')}</Button></form>
        <form onSubmit={(event) => { event.preventDefault(); void configureServer(); }}><div className="form-title"><Icon name="server"/><div><h4>{t('Set device server address')}</h4><small>{t('Choose a detected LAN address or enter another reachable URL.')}</small></div></div><DeviceWsCandidatePicker candidates={serverCandidates} value={serverAddress} onChange={setServerAddress} t={t}/><Field id="maintenance-server-address" label={t('WebSocket server URL')} hint={t('Use an address reachable from the device network, for example a LAN IP or public domain.')} value={serverAddress} onChange={setServerAddress} placeholder="ws://192.168.0.180:8787/device/v1/ws" type="url" required/><Button disabled={!bleConnected || !serverAddress.trim() || Boolean(busy)}>{busy === 'server-configure' ? t('Updating…') : t('Set server address')}</Button></form>
      </div>
    </section> : null}
    <section className="sync-metrics">
      {[['Synced', summary?.synced ?? 0, 'ready'], ['Syncing', (summary?.syncing ?? 0) + (summary?.pending ?? 0), 'syncing'], ['Failed', summary?.failed ?? 0, 'failed'], ['Synced bytes', formatBytes(summary?.synced_bytes ?? 0), 'neutral']].map(([label, value, tone]) => <article key={String(label)} className={`sync-metric sync-metric-${tone}`}><span>{t(String(label))}</span><strong>{String(value)}</strong></article>)}
    </section>
    <section className="sync-control-card">
      <div><h3>{t('Synchronization recovery')}</h3><p>{t('Reset failed or stale synchronization attempts without deleting recordings, then request a fresh device inventory.')}</p></div>
      <div><Button kind="secondary" disabled={!summary?.failed || Boolean(busy)} onClick={() => { if (globalThis.confirm(t('Reset failed synchronization attempts and scan again?'))) void run('reset-failed', () => api(`/devices/${encodeURIComponent(deviceId)}/recording-sync/reset`, { method: 'POST', body: JSON.stringify({ mode: 'failed', reason: 'Administrator reset failed synchronization attempts' }) }), t('Failed synchronization attempts were reset.')); }}>{t('Reset failed')}</Button><Button kind="danger" disabled={Boolean(busy)} onClick={() => { if (globalThis.confirm(t('Reset failed and stale synchronization attempts? Recording objects will not be deleted.'))) void run('reset-stale', () => api(`/devices/${encodeURIComponent(deviceId)}/recording-sync/reset`, { method: 'POST', body: JSON.stringify({ mode: 'failed_and_stale', reason: 'Administrator reset failed and stale synchronization attempts' }) }), t('Failed and stale synchronization attempts were reset.')); }}>{t('Reset failed and stale')}</Button></div>
    </section>
    <section className="recording-sync-card"><header><div><p className="eyebrow">{t('Recording synchronization')}</p><h3>{t('Recent device recordings')}</h3></div><span>{t('{count} recordings', { count: summary?.total ?? 0 })}</span></header>
      {!workspace ? <div className="loading-panel"><span className="spinner"/><span>{t('Loading…')}</span></div> : workspace.files.length === 0 ? <div className="empty-state"><h3>{t('No recordings discovered')}</h3><p>{t('Run a recording scan while the device is online.')}</p></div> : <div className="table-wrap"><table className="data-table sync-table"><thead><tr><th>{t('Status')}</th><th>{t('Session')}</th><th>{t('Size')}</th><th>{t('Transport')}</th><th>{t('Updated')}</th><th>{t('Failure detail')}</th><th>{t('Actions')}</th></tr></thead><tbody>{visibleFiles.map((file) => <tr key={file.id}><td><span className={`status-pill status-${file.status}`}>{t(file.status)}</span></td><td><strong>{file.session_id}</strong></td><td>{formatBytes(file.actual_size ?? file.expected_size)}</td><td>{file.transport ? t(file.transport) : '—'}</td><td>{formatLocalDateTime(file.updated_at)}</td><td className="sync-error-cell">{syncError(file.error_code, t)}</td><td><div className="sync-row-actions">{file.status === 'failed' ? <Button kind="ghost" disabled={Boolean(busy)} onClick={() => void run(`retry:${file.id}`, () => api(`/recordings/${encodeURIComponent(file.id)}/retry`, { method: 'POST', body: JSON.stringify({ reason: 'Administrator retried recording synchronization' }) }), t('Recording retry requested.'))}>{busy === `retry:${file.id}` ? t('Retrying…') : t('Retry')}</Button> : null}<details className="inline-details"><summary>{t('Details')}</summary><dl><div><dt>ID</dt><dd><code>{file.id}</code></dd></div><div><dt>{t('attribute')}</dt><dd>{file.attribute}</dd></div></dl></details></div></td></tr>)}</tbody></table>{recordingPageCount > 1 ? <nav className="table-pagination" aria-label={t('Pagination')}><Button kind="ghost" disabled={currentRecordingPage === 0} onClick={() => setRecordingPage((page) => Math.max(0, page - 1))}>{t('Previous')}</Button><span>{t('Page {page} of {total}', { page: currentRecordingPage + 1, total: recordingPageCount })}</span><Button kind="ghost" disabled={currentRecordingPage >= recordingPageCount - 1} onClick={() => setRecordingPage((page) => Math.min(recordingPageCount - 1, page + 1))}>{t('Next')}</Button></nav> : null}</div>}
    </section>
    <section className="device-lower-grid"><article><p className="eyebrow">{t('Latest semantic command')}</p><DataTable data={workspace?.latest_command ?? commands} t={t} emptyMessage={t('No reviewed commands have been requested for this device.')}/></article><article><p className="eyebrow">{t('Public capability manifest')}</p><DataTable data={capabilities} t={t}/></article></section>
  </div>;
}
