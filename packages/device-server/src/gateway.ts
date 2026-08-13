import { randomUUID } from 'node:crypto';
import type { DeviceControl, FileDescriptor, GatewayEvent, GatewayProtocolCore } from '@voicecan/device-core';
import type { Database } from './database.js';
import { capabilityVersion, mapPublicCommand, recordingEventFacts, reviewedRecordingMedia } from './public-contract.js';

type Row = Record<string, unknown>;
type GatewaySocket = {
  close(code?: number, reason?: string): void;
  pause(): void;
  resume(): void;
  send(data: Uint8Array): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
};
type EmitEvent = (device: Row, type: string, payload: Record<string, unknown>) => Promise<string>;
type UploadPlan = { fileId: string; uploadUrl: string; offset?: number };
type PlanUpload = (device: Row, file: Row, deviceHttpBaseUrl: string) => Promise<UploadPlan | null>;
type CompleteUpload = (fileId: string, reportedSize: number) => Promise<void>;
type AppendRelay = (fileId: string, offset: number, content: Uint8Array, reportedSize: number) => Promise<void>;
type DebugLog = (event: string, details: Record<string, unknown>, level?: 'debug' | 'info' | 'warn') => void;
export type GatewayOtaPackage = { version: string; size: number; crc16: number; content: Uint8Array; force?: boolean };
type StatusEventKind = 'device_info' | 'device_status' | 'device_storage' | 'device_battery';
type GatewayTimingOptions = { inventoryTimeoutMs?: number; statusQueryTimeoutMs?: number; transferTimeoutMs?: number };
type InventoryState = { commandId: string | null; requestStart: number; total: number | null; nextOffset: number; files: FileDescriptor[] };
type ActiveTransfer = { fileId: string; sessionId: number; attribute: number; expectedSize: number };

const fileListPageSize = 120;
const inventoryTimeoutDefaultMs = 30_000;
const statusQueryTimeoutDefaultMs = 10_000;
const transferTimeoutFloorMs = 2 * 60_000;
const transferTimeoutCeilingMs = 45 * 60_000;
const transferMinimumBytesPerSecond = 16 * 1_024;
const inboundQueueHighWatermarkBytes = 128 * 1024;
const inboundQueueLowWatermarkBytes = 64 * 1024;
const inboundQueueHardLimitBytes = 512 * 1024;

function timestamp(): string { return new Date().toISOString(); }

export function parseDeviceControl(value: unknown): DeviceControl | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind === 'auto_shutdown' && ['never', '15min', '30min', '1h', '5h'].includes(String(input.interval))) return { kind: 'auto_shutdown', interval: input.interval as 'never' | '15min' | '30min' | '1h' | '5h' };
  if (['usb', 'privacy', 'earphone_recording'].includes(String(input.kind)) && typeof input.enabled === 'boolean') return { kind: input.kind, enabled: input.enabled } as DeviceControl;
  if (input.kind === 'power' && ['reboot', 'shutdown', 'shipmode'].includes(String(input.action))) return { kind: input.kind, action: input.action } as DeviceControl;
  if (input.kind === 'factory_reset' && ['configuration', 'recordings', 'all'].includes(String(input.scope))) return { kind: input.kind, scope: input.scope } as DeviceControl;
  return null;
}

// Current firmware reports this page's entry count, while legacy firmware
// reports every entry remaining after requestStart but still honors COUNT.
function fileListPageEntryTarget(totalCount: number): number {
  return Math.min(totalCount, fileListPageSize);
}

function bytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data) && data.every((part) => part instanceof Uint8Array)) {
    const output = new Uint8Array(data.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0; for (const part of data) { output.set(part, offset); offset += part.byteLength; }
    return output;
  }
  throw new Error('BINARY_FRAME_REQUIRED');
}

class DeviceActor {
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #queuedBytes = 0;
  #inboundPaused = false;
  #closed = false;
  #confirmed = false;
  #bindTimer: ReturnType<typeof setTimeout>;
  #inventory: InventoryState | null = null;
  #inventoryTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingInventories: Array<string | null> = [];
  #transferQueue: FileDescriptor[] = [];
  #queuedTransferKeys = new Set<string>();
  #activeTransfer: ActiveTransfer | null = null;
  #transferTimer: ReturnType<typeof setTimeout> | null = null;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #statusQueryTimer: ReturnType<typeof setTimeout> | null = null;
  #statusQueue: Array<{ eventKind: StatusEventKind; request: Uint8Array }> = [];
  #activeStatusQuery: StatusEventKind | null = null;
  #controlTimer: ReturnType<typeof setTimeout> | null = null;
  #controlQueue: Array<{ commandId: string; input: DeviceControl }> = [];
  #activeControl: { commandId: string; input: DeviceControl } | null = null;
  #activeOta: { commandId: string; firmware: GatewayOtaPackage } | null = null;
  #otaTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly deviceId: string,
    readonly connectionEpoch: number,
    private readonly socket: GatewaySocket,
    private readonly core: GatewayProtocolCore,
    private readonly db: Database,
    private readonly emitEvent: EmitEvent,
    private readonly planUpload: PlanUpload,
    private readonly completeUpload: CompleteUpload,
    private readonly appendRelay: AppendRelay,
    private readonly maxFileBytes: number,
    private readonly debug: DebugLog,
    private readonly deviceHttpBaseUrl: string,
    private readonly inventoryTimeoutMs: number,
    private readonly statusQueryTimeoutMs: number,
    private readonly transferTimeoutMs: number | undefined,
    rawToken: Buffer,
  ) {
    try { const request = this.core.createBindRequest(rawToken); this.socket.send(request); this.debug('device bind request sent', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, bytes: request.byteLength }); } finally { rawToken.fill(0); }
    this.#bindTimer = setTimeout(() => {
      if (!this.#confirmed) this.socket.close(1008, 'device bind confirmation timeout');
    }, 10_000);
  }

  enqueue(raw: unknown): void {
    if (this.#closed) return;
    let frame: Uint8Array;
    try { frame = bytes(raw); } catch { this.socket.close(1003, 'binary frame required'); return; }
    if (frame.byteLength > 2_048) { this.socket.close(1009, 'frame too large'); return; }
    if (this.#queuedBytes + frame.byteLength > inboundQueueHardLimitBytes) { this.socket.close(1013, 'device queue overloaded'); return; }
    this.debug('device gateway frame received', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, bytes: frame.byteLength, queued: this.#queued, queued_bytes: this.#queuedBytes });
    this.#queued += 1;
    this.#queuedBytes += frame.byteLength;
    if (!this.#inboundPaused && this.#queuedBytes >= inboundQueueHighWatermarkBytes) {
      this.#inboundPaused = true;
      this.socket.pause();
      this.debug('device gateway inbound flow paused', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, queued: this.#queued, queued_bytes: this.#queuedBytes }, 'warn');
    }
    this.#tail = this.#tail.then(() => this.#process(frame)).catch(() => this.socket.close(1002, 'invalid device frame')).finally(() => {
      this.#queued -= 1;
      this.#queuedBytes -= frame.byteLength;
      if (this.#inboundPaused && !this.#closed && this.#queuedBytes <= inboundQueueLowWatermarkBytes) {
        this.#inboundPaused = false;
        this.socket.resume();
        this.debug('device gateway inbound flow resumed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, queued: this.#queued, queued_bytes: this.#queuedBytes });
      }
    });
  }

  close(): void { this.#closed = true; clearTimeout(this.#bindTimer); if (this.#inventoryTimer) clearTimeout(this.#inventoryTimer); if (this.#transferTimer) clearTimeout(this.#transferTimer); if (this.#statusTimer) clearInterval(this.#statusTimer); if (this.#statusQueryTimer) clearTimeout(this.#statusQueryTimer); if (this.#controlTimer) clearTimeout(this.#controlTimer); if (this.#otaTimer) clearTimeout(this.#otaTimer); this.debug('device gateway actor closed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, confirmed: this.#confirmed }); }
  supersede(): void { this.close(); this.socket.close(4001, 'connection superseded'); }

  requestInventory(commandId: string | null): boolean {
    if (this.#closed) return false;
    if (this.#inventory) {
      if (!commandId || this.#inventory.commandId === commandId) return true;
      if (this.#inventory.commandId === null) {
        this.#inventory.commandId = commandId;
        this.debug('sync command attached to active device inventory', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, command_id: commandId, request_start: this.#inventory.requestStart });
        return true;
      }
    }
    if (commandId && this.#pendingInventories.includes(commandId)) return true;
    if (!commandId && this.#pendingInventories.includes(null)) return true;
    const automaticInventory = this.#pendingInventories.indexOf(null);
    if (commandId && automaticInventory >= 0) { this.#pendingInventories[automaticInventory] = commandId; return true; }
    this.#pendingInventories.push(commandId);
    // Status snapshots are best-effort. Once a synchronization request is
    // waiting, finish only the in-flight status query and yield the lane.
    this.#statusQueue = [];
    this.#startNextInventory();
    return true;
  }

  requestStatus(): boolean {
    if (this.#closed || !this.#confirmed || this.#activeStatusQuery || this.#statusQueue.length > 0 || this.#activeTransfer || this.#transferQueue.length > 0 || this.#inventory || this.#pendingInventories.length > 0 || this.#activeControl || this.#activeOta || this.#controlQueue.length > 0) return false;
    this.#statusQueue = [
      { eventKind: 'device_info', request: this.core.requestDeviceInfo() },
      { eventKind: 'device_status', request: this.core.requestDeviceStatus() },
      { eventKind: 'device_storage', request: this.core.requestDeviceStorage() },
      { eventKind: 'device_battery', request: this.core.requestDeviceBattery() },
    ];
    this.#startNextStatusQuery();
    this.debug('device status refresh queued', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, transport: 'ws', query_count: this.#statusQueue.length + (this.#activeStatusQuery ? 1 : 0) });
    return true;
  }

  requestControl(commandId: string, input: DeviceControl): boolean {
    if (this.#closed || this.#activeOta || this.#controlQueue.some((candidate) => candidate.commandId === commandId) || this.#activeControl?.commandId === commandId) return false;
    this.#controlQueue.push({ commandId, input });
    this.#statusQueue = [];
    void this.#startNextControl();
    return true;
  }

  async requestOta(commandId: string, firmware: GatewayOtaPackage): Promise<boolean> {
    if (this.#closed || !this.#confirmed || this.#activeOta || this.#activeStatusQuery || this.#statusQueue.length > 0 || this.#activeControl || this.#controlQueue.length > 0 || this.#activeTransfer || this.#inventory || this.#pendingInventories.length > 0 || this.#transferQueue.length > 0) return false;
    if (firmware.size !== firmware.content.byteLength || firmware.size <= 0 || firmware.size > 128 * 1024 * 1024) return false;
    const startedAt = timestamp();
    const changed = await this.db.run("UPDATE commands SET status='running',started_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='dispatched' AND connection_epoch=?", [startedAt, startedAt, commandId, this.connectionEpoch]);
    if (changed.changes !== 1) return false;
    this.#activeOta = { commandId, firmware };
    this.socket.send(this.core.requestOta({ version: firmware.version, size: firmware.size, crc16: firmware.crc16, ...(firmware.force === undefined ? {} : { force: firmware.force }) }));
    this.#otaTimer = setTimeout(() => { void this.#finishOta(false, 'DEVICE_OTA_TIMEOUT'); }, 15 * 60_000); this.#otaTimer.unref();
    this.debug('device OTA requested', { device_id: this.deviceId, command_id: commandId, version: firmware.version, firmware_size: firmware.size, firmware_crc16: firmware.crc16, connection_epoch: this.connectionEpoch });
    return true;
  }

  #startNextInventory(): void {
    if (!this.#confirmed || this.#inventory || this.#activeStatusQuery || this.#activeTransfer || this.#activeControl || this.#activeOta || this.#controlQueue.length > 0 || this.#pendingInventories.length === 0) return;
    this.#inventory = { commandId: this.#pendingInventories.shift() ?? null, requestStart: 0, total: null, nextOffset: 0, files: [] };
    this.#sendInventoryPage();
  }

  #sendInventoryPage(): void {
    const inventory = this.#inventory; if (!inventory || this.#closed) return;
    const request = this.core.requestFileList(inventory.requestStart, fileListPageSize);
    this.socket.send(request);
    this.#armInventoryTimeout(inventory);
    this.debug('device file inventory requested', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, command_id: inventory.commandId, request_start: inventory.requestStart, count: fileListPageSize, request_bytes: request.byteLength, pending_inventories: this.#pendingInventories.length }, 'info');
  }

  #armInventoryTimeout(inventory: InventoryState): void {
    if (this.#inventoryTimer) clearTimeout(this.#inventoryTimer);
    this.#inventoryTimer = setTimeout(() => { void this.#expireInventory(inventory); }, this.inventoryTimeoutMs);
    this.#inventoryTimer.unref();
  }

  async #expireInventory(inventory: InventoryState): Promise<void> {
    if (this.#closed || this.#inventory !== inventory) return;
    this.#inventoryTimer = null; this.#inventory = null;
    const completedAt = timestamp();
    this.debug('device file inventory timed out', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, command_id: inventory.commandId, request_start: inventory.requestStart, batch_offset: inventory.nextOffset, timeout_ms: this.inventoryTimeoutMs }, 'warn');
    try {
      if (inventory.commandId) {
        const changed = await this.db.run("UPDATE commands SET status='failed',error_code='FILE_LIST_TIMEOUT',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('dispatched','running') AND connection_epoch=?", [completedAt, completedAt, inventory.commandId, this.connectionEpoch]);
        if (changed.changes === 1) {
          const [command, device] = await Promise.all([this.db.get<Row>('SELECT * FROM commands WHERE id=?', [inventory.commandId]), this.db.get<Row>('SELECT * FROM devices WHERE id=?', [this.deviceId])]);
          if (command && device) await this.emitEvent(device, 'command.failed', { command: mapPublicCommand(command) });
        }
      }
    } catch (error) {
      this.debug('device file inventory timeout persistence failed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, command_id: inventory.commandId, error: error instanceof Error ? error.message : String(error) }, 'warn');
    } finally {
      this.#startNextInventory(); await this.#startNextControl(); await this.#startNextTransfer(); this.#startNextStatusQuery();
    }
  }

  #startNextStatusQuery(): void {
    if (this.#closed || !this.#confirmed || this.#activeStatusQuery || this.#inventory || this.#pendingInventories.length > 0 || this.#activeTransfer || this.#transferQueue.length > 0 || this.#activeControl || this.#controlQueue.length > 0 || this.#activeOta) return;
    const next = this.#statusQueue.shift(); if (!next) return;
    this.#activeStatusQuery = next.eventKind;
    this.socket.send(next.request);
    this.#statusQueryTimer = setTimeout(() => { void this.#expireStatusQuery(next.eventKind); }, this.statusQueryTimeoutMs);
    this.#statusQueryTimer.unref();
    this.debug('device status query requested', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, event_kind: next.eventKind, timeout_ms: this.statusQueryTimeoutMs });
  }

  async #completeStatusQuery(eventKind: GatewayEvent['kind']): Promise<void> {
    if (eventKind !== this.#activeStatusQuery) return;
    if (this.#statusQueryTimer) clearTimeout(this.#statusQueryTimer);
    this.#statusQueryTimer = null; this.#activeStatusQuery = null;
    if (this.#pendingInventories.length > 0 || this.#transferQueue.length > 0 || this.#controlQueue.length > 0) this.#statusQueue = [];
    this.#startNextInventory(); await this.#startNextControl(); await this.#startNextTransfer(); this.#startNextStatusQuery();
  }

  async #expireStatusQuery(eventKind: StatusEventKind): Promise<void> {
    if (this.#closed || this.#activeStatusQuery !== eventKind) return;
    this.#statusQueryTimer = null; this.#activeStatusQuery = null; this.#statusQueue = [];
    this.debug('device status query timed out', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, event_kind: eventKind, timeout_ms: this.statusQueryTimeoutMs }, 'warn');
    this.#startNextInventory(); await this.#startNextControl(); await this.#startNextTransfer();
  }

  async #process(frame: Uint8Array): Promise<void> {
    const result = this.core.process(frame);
    this.debug('device gateway event decoded', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, event_kind: result.event.kind, response_bytes: result.response?.byteLength ?? 0 });
    if (!this.#confirmed && result.event.kind !== 'bind_confirmed' && result.event.kind !== 'heartbeat') throw new Error('DEVICE_BIND_REQUIRED');
    await this.#persist(result.event);
    await this.#completeStatusQuery(result.event.kind);
    if (result.response) this.socket.send(result.response);
  }

  async #persist(event: GatewayEvent): Promise<void> {
    if (event.kind === 'bind_confirmed') {
      if (this.#confirmed) return;
      this.#confirmed = true; clearTimeout(this.#bindTimer);
      const current = await this.db.get<Row>('SELECT * FROM devices WHERE id=? AND connection_epoch=? AND deleted_at IS NULL', [this.deviceId, this.connectionEpoch]);
      if (!current) throw new Error('DEVICE_CONNECTION_STALE');
      const firstClaim = current.claim_status === 'reserved'; const now = timestamp();
      const nextDevice = { ...current, claim_status: 'active', online: 1, firmware_version: event.firmwareVersion ?? current.firmware_version };
      const previousCapabilityVersion = capabilityVersion(current);
      const nextCapabilityVersion = capabilityVersion(nextDevice);
      const capabilityChanged = previousCapabilityVersion !== nextCapabilityVersion;
      const capabilityChangedAt = capabilityChanged || !current.capability_changed_at ? now : current.capability_changed_at;
      const updated = await this.db.batch([
        { sql: "UPDATE devices SET claim_status='active',online=1,firmware_version=COALESCE(?,firmware_version),capability_version=?,capability_changed_at=?,last_seen_at=?,updated_at=? WHERE id=? AND connection_epoch=?", params: [event.firmwareVersion, nextCapabilityVersion, capabilityChangedAt, now, now, this.deviceId, this.connectionEpoch] },
        { sql: "UPDATE device_credentials SET status='active',expires_at=NULL WHERE device_id=? AND credential_epoch=? AND revoked_at IS NULL", params: [this.deviceId, current.credential_epoch] },
        { sql: "UPDATE provisioning_sessions SET status='completed',completed_at=?,failed_at=NULL,failure_code=NULL,updated_at=? WHERE id=(SELECT id FROM provisioning_sessions WHERE device_id=? AND status IN ('reserved','ble_authenticated','configured','online','failed') ORDER BY created_at DESC LIMIT 1)", params: [now, now, this.deviceId] },
      ]);
      if (updated[0]?.changes !== 1) throw new Error('DEVICE_CONNECTION_STALE');
      const device = { ...nextDevice, capability_version: nextCapabilityVersion, capability_changed_at: capabilityChangedAt };
      if (firstClaim) await this.emitEvent(device, 'device.claimed', { device_id: this.deviceId });
      await this.emitEvent(device, 'device.online', { device_id: this.deviceId, connection_epoch: this.connectionEpoch });
      if (capabilityChanged) await this.emitEvent(device, 'device.capabilities_changed', { device_id: this.deviceId, previous_capability_version: previousCapabilityVersion, capability_version: nextCapabilityVersion });
      this.debug('device bind confirmed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, first_claim: firstClaim, firmware_version: event.firmwareVersion ?? 'unknown' });
      const timezoneOffsetHours = Math.max(-12, Math.min(14, Math.trunc(-new Date().getTimezoneOffset() / 60)));
      const unixTimeSeconds = Math.floor(Date.now() / 1_000);
      const timeRequest = this.core.requestTimeSync({ unixTimeSeconds, timezoneOffsetHours });
      this.socket.send(timeRequest);
      this.debug('device time synchronization requested', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, unix_time_seconds: unixTimeSeconds, timezone_offset_hours: timezoneOffsetHours, request_bytes: timeRequest.byteLength });
      const resumedSync = await this.#resumeQueuedCommands();
      if (!resumedSync) this.requestInventory(null);
      // Status is deliberately low priority. Starting the timer only after the
      // inventory lane is claimed prevents older firmware from starving the
      // file-list request behind a burst of device-management queries.
      this.#statusTimer = setInterval(() => { this.requestStatus(); }, 60_000);
      this.#statusTimer.unref();
      return;
    }
    if (event.kind === 'heartbeat') {
      if (!this.#confirmed) return;
      const now = timestamp();
      await this.db.run('UPDATE devices SET online=1,last_seen_at=?,updated_at=? WHERE id=? AND connection_epoch=?', [now, now, this.deviceId, this.connectionEpoch]);
      return;
    }
    if (event.kind === 'time_synced') {
      this.debug('device time synchronization confirmed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, unix_time_seconds: event.unixTimeSeconds, timezone_offset_hours: event.timezoneOffsetHours });
      return;
    }
    if (event.kind === 'device_info') {
      const now = timestamp();
      await this.db.batch([
        { sql: 'UPDATE devices SET model=COALESCE(NULLIF(?,\'\'),model),hardware_version=COALESCE(NULLIF(?,\'\'),hardware_version),firmware_version=COALESCE(NULLIF(?,\'\'),firmware_version),last_seen_at=?,updated_at=? WHERE id=? AND connection_epoch=?', params: [event.model, event.hardwareVersion, event.firmwareVersion, now, now, this.deviceId, this.connectionEpoch] },
        { sql: `INSERT INTO device_status(device_id,source,info_updated_at,updated_at) VALUES(?,'ws',?,?) ON CONFLICT(device_id) DO UPDATE SET source='ws',info_updated_at=excluded.info_updated_at,updated_at=excluded.updated_at`, params: [this.deviceId, now, now] },
      ]);
      return;
    }
    if (event.kind === 'device_status') {
      const now = timestamp(); const status = event.status;
      await this.db.run(`INSERT INTO device_status(device_id,source,record_state,record_mode,microphone_mode,microphone_gain_db,usb_state,wifi_state,wifi_mode,relay_state,privacy_mode,earphone_recording,status_updated_at,updated_at)
        VALUES(?,'ws',?,?,?,?,?,?,?,?,?,?,?, ?,?) ON CONFLICT(device_id) DO UPDATE SET source='ws',record_state=excluded.record_state,record_mode=excluded.record_mode,microphone_mode=excluded.microphone_mode,microphone_gain_db=excluded.microphone_gain_db,usb_state=excluded.usb_state,wifi_state=excluded.wifi_state,wifi_mode=excluded.wifi_mode,relay_state=excluded.relay_state,privacy_mode=excluded.privacy_mode,earphone_recording=excluded.earphone_recording,status_updated_at=excluded.status_updated_at,updated_at=excluded.updated_at`,
      [this.deviceId, status.recordState, status.recordMode, status.microphoneMode, status.microphoneGainDb, status.usbState, status.wifiState, status.wifiMode, status.relayState, Number(status.privacyMode), Number(status.earphoneRecording), now, now]);
      return;
    }
    if (event.kind === 'device_storage') {
      const now = timestamp(); const storage = event.storage;
      await this.db.run(`INSERT INTO device_status(device_id,source,storage_total_kb,storage_free_kb,recording_hours,storage_updated_at,updated_at) VALUES(?,'ws',?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET source='ws',storage_total_kb=excluded.storage_total_kb,storage_free_kb=excluded.storage_free_kb,recording_hours=excluded.recording_hours,storage_updated_at=excluded.storage_updated_at,updated_at=excluded.updated_at`, [this.deviceId, storage.totalKilobytes, storage.freeKilobytes, storage.recordingHours, now, now]);
      return;
    }
    if (event.kind === 'device_battery') {
      const now = timestamp(); const battery = event.battery;
      await this.db.run(`INSERT INTO device_status(device_id,source,battery_state,battery_state_code,battery_percent,battery_temperature_c,battery_voltage_mv,work_time_seconds,accumulated_work_time_seconds,battery_updated_at,updated_at) VALUES(?,'ws',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET source='ws',battery_state=excluded.battery_state,battery_state_code=excluded.battery_state_code,battery_percent=excluded.battery_percent,battery_temperature_c=excluded.battery_temperature_c,battery_voltage_mv=excluded.battery_voltage_mv,work_time_seconds=excluded.work_time_seconds,accumulated_work_time_seconds=excluded.accumulated_work_time_seconds,battery_updated_at=excluded.battery_updated_at,updated_at=excluded.updated_at`, [this.deviceId, battery.state, battery.stateCode, battery.percent, battery.temperatureC, battery.voltageMillivolts, battery.workTimeSeconds, battery.accumulatedWorkTimeSeconds, now, now]);
      return;
    }
    if (event.kind === 'device_command_result') {
      const active = this.#activeControl;
      if (!active || active.input.kind !== event.command) return;
      if (this.#controlTimer) { clearTimeout(this.#controlTimer); this.#controlTimer = null; }
      const completedAt = timestamp(); const succeeded = event.result === 0;
      const changed = await this.db.run(`UPDATE commands SET status=?,result_code=?,error_code=?,completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('dispatched','running') AND connection_epoch=?`, [succeeded ? 'succeeded' : 'failed', succeeded ? 'DEVICE_COMMAND_COMPLETED' : null, succeeded ? null : `DEVICE_RESULT_${event.result.toString(16).padStart(2, '0').toUpperCase()}`, completedAt, completedAt, active.commandId, this.connectionEpoch]);
      if (changed.changes === 1) { const [command, device] = await Promise.all([this.db.get<Row>('SELECT * FROM commands WHERE id=?', [active.commandId]), this.db.get<Row>('SELECT * FROM devices WHERE id=?', [this.deviceId])]); if (command && device) await this.emitEvent(device, succeeded ? 'command.succeeded' : 'command.failed', { command: mapPublicCommand(command) }); }
      this.#activeControl = null;
      await this.#startNextControl(); this.#startNextInventory(); await this.#startNextTransfer();
      return;
    }
    if (event.kind === 'ota_check') {
      if (!this.#activeOta) return;
      if (event.result === 0) { this.debug('device accepted OTA', { device_id: this.deviceId, command_id: this.#activeOta.commandId }); return; }
      if (event.result === 1) { await this.#finishOta(true, 'OTA_ALREADY_CURRENT'); return; }
      await this.#finishOta(false, `DEVICE_OTA_CHECK_${event.result.toString(16).padStart(2, '0').toUpperCase()}`); return;
    }
    if (event.kind === 'ota_transfer_request') {
      const active = this.#activeOta; if (!active) return;
      if (!Number.isSafeInteger(event.offset) || event.offset < 0 || event.offset >= active.firmware.size) { await this.#finishOta(false, 'DEVICE_OTA_OFFSET_INVALID'); return; }
      const end = Math.min(event.offset + 1_480, active.firmware.size);
      const content = active.firmware.content.slice(event.offset, end);
      this.socket.send(this.core.createOtaChunk({ offset: event.offset, content }));
      this.debug('device OTA chunk sent', { device_id: this.deviceId, command_id: active.commandId, offset: event.offset, bytes: content.byteLength, firmware_size: active.firmware.size });
      return;
    }
    if (event.kind === 'ota_status') {
      if (!this.#activeOta) return;
      if (event.result === 0) {
        this.socket.send(this.core.requestDeviceControl({ kind: 'power', action: 'reboot' }));
        this.debug('device OTA validated; reboot requested', { device_id: this.deviceId, command_id: this.#activeOta.commandId });
        await this.#finishOta(true, 'OTA_REBOOT_REQUESTED'); return;
      }
      if (event.result === 2) { await this.#finishOta(true, 'OTA_REBOOTING'); return; }
      await this.#finishOta(false, `DEVICE_OTA_STATUS_${event.result.toString(16).padStart(2, '0').toUpperCase()}`); return;
    }
    if (event.kind === 'new_file') {
      await this.#discoverAndPlan({ sessionId: event.sessionId, attribute: event.attribute, size: event.size });
      return;
    }
    if (event.kind === 'file_list') {
      await this.#acceptInventory(event);
      return;
    }
    this.debug('device file transfer result received', {
      device_id: this.deviceId,
      connection_epoch: this.connectionEpoch,
      session_id: event.sessionId,
      result_code: `0x${event.result.toString(16).padStart(2, '0').toUpperCase()}`,
      reported_size: event.size,
      offset: event.offset,
      content_bytes: event.content.byteLength,
      active_file_id: this.#activeTransfer?.fileId ?? null,
      active_session_id: this.#activeTransfer?.sessionId ?? null,
    });
    const active = this.#activeTransfer;
    if (!active || active.sessionId !== event.sessionId) {
      this.debug('device file transfer result ignored without matching active transfer', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, session_id: event.sessionId });
      return;
    }
    if (event.result === 0 && event.content.byteLength > 0) {
      if (event.size > 0 && event.size !== active.expectedSize) throw new Error('DEVICE_REPORTED_SIZE_MISMATCH');
      await this.appendRelay(active.fileId, event.offset, event.content, active.expectedSize);
      this.#armTransferTimeout(active);
    } else if (event.result === 0 && event.content.byteLength === 0) {
      await this.completeUpload(active.fileId, event.size);
      await this.#finishActiveTransfer('completed');
    } else if (event.result !== 0) {
      const errorCode = `DEVICE_TRANSFER_RESULT_${event.result.toString(16).padStart(2, '0').toUpperCase()}`;
      const failed = await this.db.all<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status='syncing'", [active.fileId]);
      const retryViaRelay = event.result === 0x0c && failed.some((file) => String(file.transport ?? '') !== 'server_relay');
      await this.db.run(retryViaRelay
        ? "UPDATE recording_files SET status='pending',force_relay=1,error_code=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing'"
        : "UPDATE recording_files SET status='failed',error_code=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing'", [errorCode, timestamp(), active.fileId]);
      if (retryViaRelay) await this.db.run("UPDATE recording_files SET force_relay=1,updated_at=? WHERE device_id=? AND status IN ('pending','failed') AND force_relay=0", [timestamp(), this.deviceId]);
      for (const file of failed) await this.emitEvent(file, 'recording.sync_failed', { file_id: file.id, device_id: this.deviceId, session_id: file.session_id, attribute: file.attribute, error_code: errorCode, ...recordingEventFacts({ ...file, resource_version: Number(file.resource_version ?? 1) + 1 }) });
      await this.#finishActiveTransfer(errorCode);
      if (retryViaRelay) {
        this.debug('device direct transfer scheduled for relay fallback', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, file_id: active.fileId, session_id: active.sessionId, attribute: active.attribute, error_code: errorCode }, 'warn');
        for (const file of failed) await this.#queueTransfer({ sessionId: Number(file.session_id), attribute: Number(file.attribute), size: Number(file.expected_size) });
      }
    }
  }

  async #acceptInventory(event: Extract<GatewayEvent, { kind: 'file_list' }>): Promise<void> {
    const inventory = this.#inventory;
    if (!inventory || event.requestStart !== inventory.requestStart || event.batchOffset !== inventory.nextOffset) throw new Error('FILE_LIST_SEQUENCE');
    if (this.#inventoryTimer) clearTimeout(this.#inventoryTimer); this.#inventoryTimer = null;
    this.debug('device file inventory page received', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, command_id: inventory.commandId, request_start: event.requestStart, batch_offset: event.batchOffset, total_count: event.totalCount, page_files: event.files.length }, 'info');
    if (inventory.commandId && inventory.nextOffset === 0 && inventory.requestStart === 0) {
      const startedAt = timestamp();
      await this.db.run("UPDATE commands SET status='running',started_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='dispatched' AND connection_epoch=?", [startedAt, startedAt, inventory.commandId, this.connectionEpoch]);
    }
    if (inventory.total === null) inventory.total = event.totalCount;
    const pageEntryTarget = fileListPageEntryTarget(event.totalCount);
    if (inventory.total !== event.totalCount || inventory.nextOffset + event.files.length > pageEntryTarget) throw new Error('FILE_LIST_INTEGRITY');
    let previous = inventory.files.at(-1)?.sessionId ?? inventory.requestStart - 1;
    for (const file of event.files) {
      if (file.sessionId < inventory.requestStart || file.sessionId <= previous) throw new Error('FILE_LIST_ORDER');
      previous = file.sessionId;
    }
    inventory.files.push(...event.files); inventory.nextOffset += event.files.length;
    if (inventory.nextOffset < pageEntryTarget) { this.#armInventoryTimeout(inventory); return; }
    const page = inventory.files;
    for (const file of page) await this.#discoverAndPlan(file);
    const last = page.at(-1);
    if (event.totalCount >= fileListPageSize && last && last.sessionId < 0xffff_ffff) {
      inventory.requestStart = last.sessionId + 1; inventory.total = null; inventory.nextOffset = 0; inventory.files = [];
      this.#sendInventoryPage();
      return;
    }
    const commandId = inventory.commandId; this.#inventory = null;
    if (commandId) {
      const completedAt = timestamp();
      const changed = await this.db.run("UPDATE commands SET status='succeeded',result_code='SYNC_COMPLETED',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('dispatched','running') AND connection_epoch=?", [completedAt, completedAt, commandId, this.connectionEpoch]);
      if (changed.changes === 1) {
        const [command, device] = await Promise.all([this.db.get<Row>('SELECT * FROM commands WHERE id=?', [commandId]), this.db.get<Row>('SELECT * FROM devices WHERE id=?', [this.deviceId])]);
        if (command && device) await this.emitEvent(device, 'command.succeeded', { command: mapPublicCommand(command) });
      }
    }
    this.#startNextInventory();
    await this.#startNextTransfer();
  }

  async #discoverAndPlan(file: FileDescriptor): Promise<void> {
    if (file.size <= 0 || file.size > this.maxFileBytes || file.attribute < 0 || file.attribute > 2) return;
    const device = await this.db.get<Row>("SELECT * FROM devices WHERE id=? AND connection_epoch=? AND claim_status='active' AND deleted_at IS NULL", [this.deviceId, this.connectionEpoch]);
    if (!device) return;
    const candidate = await this.db.get<Row>('SELECT * FROM recording_files WHERE device_id=? AND credential_epoch=? AND session_id=? AND attribute=? ORDER BY revision DESC LIMIT 1', [this.deviceId, device.credential_epoch, file.sessionId, file.attribute]);
    if (candidate && Number(candidate.expected_size) === file.size && candidate.status === 'synced') return;
    if (candidate && Number(candidate.expected_size) === file.size && ['pending', 'syncing', 'failed'].includes(String(candidate.status))) {
      await this.#queueTransfer(file);
      return;
    }
    const fileId = `file_${randomUUID()}`; const revision = candidate ? Number(candidate.revision) + 1 : 1; const conflict = Boolean(candidate); const now = timestamp(); const media = reviewedRecordingMedia(device);
    await this.db.run('INSERT INTO recording_files(id,device_id,credential_epoch,session_id,attribute,revision,expected_size,status,error_code,media_container,media_codec,media_content_type,media_filename_extension,encoding_profile,media_metadata_source,source_firmware_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [fileId, this.deviceId, device.credential_epoch, file.sessionId, file.attribute, revision, file.size, conflict ? 'identity_conflict' : 'pending', conflict ? 'FILE_IDENTITY_CONFLICT' : null, media.container, media.codec, media.content_type, media.filename_extension, media.encoding_profile, media.source, device.firmware_version ?? null, now, now]);
    if (conflict) return;
    const row = await this.db.get<Row>('SELECT * FROM recording_files WHERE id=?', [fileId]);
    await this.emitEvent(device, 'recording.discovered', { file_id: fileId, device_id: this.deviceId, session_id: file.sessionId, attribute: file.attribute, file_size: file.size, ...recordingEventFacts(row!) });
    if (row) await this.#queueTransfer(file);
  }

  async #queueTransfer(file: FileDescriptor): Promise<void> {
    const key = `${file.sessionId}:${file.attribute}`;
    if (this.#activeTransfer?.sessionId === file.sessionId && this.#activeTransfer.attribute === file.attribute) return;
    if (this.#queuedTransferKeys.has(key)) return;
    this.#queuedTransferKeys.add(key);
    this.#transferQueue.push(file);
    this.debug('device file transfer queued', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, session_id: file.sessionId, attribute: file.attribute, expected_size: file.size, queue_depth: this.#transferQueue.length });
    await this.#startNextTransfer();
  }

  async #startNextTransfer(): Promise<void> {
    if (this.#closed || !this.#confirmed || this.#activeTransfer || this.#activeStatusQuery || this.#activeControl || this.#activeOta || this.#controlQueue.length > 0 || this.#inventory || this.#pendingInventories.length > 0) return;
    const file = this.#transferQueue.shift();
    if (!file) return;
    this.#queuedTransferKeys.delete(`${file.sessionId}:${file.attribute}`);
    const device = await this.db.get<Row>("SELECT * FROM devices WHERE id=? AND connection_epoch=? AND claim_status='active' AND deleted_at IS NULL", [this.deviceId, this.connectionEpoch]);
    const candidate = device ? await this.db.get<Row>("SELECT * FROM recording_files WHERE device_id=? AND credential_epoch=? AND session_id=? AND attribute=? AND status IN ('pending','syncing','failed') ORDER BY revision DESC LIMIT 1", [this.deviceId, device.credential_epoch, file.sessionId, file.attribute]) : null;
    if (!device || !candidate || Number(candidate.expected_size) !== file.size) {
      await this.#startNextTransfer();
      return;
    }
    const plan = await this.planUpload(device, candidate, this.deviceHttpBaseUrl);
    if (!plan) {
      await this.#startNextTransfer();
      return;
    }
    this.#activeTransfer = { fileId: plan.fileId, sessionId: file.sessionId, attribute: file.attribute, expectedSize: file.size };
    this.#armTransferTimeout(this.#activeTransfer);
    const request = this.core.requestFileTransfer({ sessionId: file.sessionId, offset: plan.offset ?? 0, attribute: file.attribute, uploadUrl: plan.uploadUrl });
    this.socket.send(request);
    this.debug('device file transfer requested', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, file_id: plan.fileId, session_id: file.sessionId, attribute: file.attribute, expected_size: file.size, offset: plan.offset ?? 0, transport_url_origin: plan.uploadUrl ? new URL(plan.uploadUrl).origin : null, request_bytes: request.byteLength, queue_depth: this.#transferQueue.length }, 'info');
  }

  async #finishActiveTransfer(outcome: string): Promise<void> {
    const completed = this.#activeTransfer;
    if (this.#transferTimer) { clearTimeout(this.#transferTimer); this.#transferTimer = null; }
    this.#activeTransfer = null;
    this.debug('device file transfer lane released', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, file_id: completed?.fileId ?? null, session_id: completed?.sessionId ?? null, outcome, queue_depth: this.#transferQueue.length });
    this.#startNextInventory();
    await this.#startNextControl();
    await this.#startNextTransfer();
  }

  #armTransferTimeout(active: ActiveTransfer): void {
    if (this.#transferTimer) clearTimeout(this.#transferTimer);
    const estimatedMs = Math.ceil(active.expectedSize / transferMinimumBytesPerSecond * 1_000) + 60_000;
    const timeoutMs = this.transferTimeoutMs ?? Math.min(transferTimeoutCeilingMs, Math.max(transferTimeoutFloorMs, estimatedMs));
    this.#transferTimer = setTimeout(() => { void this.#expireActiveTransfer(active.fileId); }, timeoutMs);
    this.#transferTimer.unref();
    this.debug('device file transfer watchdog armed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, file_id: active.fileId, expected_size: active.expectedSize, timeout_ms: timeoutMs });
  }

  async #expireActiveTransfer(fileId: string): Promise<void> {
    const active = this.#activeTransfer;
    if (!active || active.fileId !== fileId) return;
    this.#transferTimer = null;
    const retry = await this.#recoverTransfer(active, 'DEVICE_TRANSFER_TIMEOUT', false);
    await this.#finishActiveTransfer('DEVICE_TRANSFER_TIMEOUT');
    if (retry) await this.#queueTransfer({ sessionId: active.sessionId, attribute: active.attribute, size: active.expectedSize });
  }

  async #recoverTransfer(active: ActiveTransfer, errorCode: string, retryRelay: boolean): Promise<boolean> {
    const files = await this.db.all<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status='syncing'", [active.fileId]);
    if (files.length === 0) return false;
    const retry = retryRelay || files.some((file) => String(file.transport ?? '') !== 'server_relay');
    const forceRelay = files.some((file) => String(file.transport ?? '') !== 'server_relay');
    const changedAt = timestamp();
    await this.db.run(retry
      ? "UPDATE recording_files SET status='pending',force_relay=CASE WHEN transport<>'server_relay' THEN 1 ELSE force_relay END,error_code=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing'"
      : "UPDATE recording_files SET status='failed',error_code=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing'", [errorCode, changedAt, active.fileId]);
    if (forceRelay) await this.db.run("UPDATE recording_files SET force_relay=1,updated_at=? WHERE device_id=? AND status IN ('pending','failed') AND force_relay=0", [changedAt, this.deviceId]);
    for (const file of files) await this.emitEvent(file, 'recording.sync_failed', { file_id: file.id, device_id: this.deviceId, session_id: file.session_id, attribute: file.attribute, error_code: errorCode, ...recordingEventFacts({ ...file, resource_version: Number(file.resource_version ?? 1) + 1 }) });
    this.debug(retry ? 'device file transfer will be recovered' : 'device file transfer failed after recovery was exhausted', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, file_id: active.fileId, session_id: active.sessionId, attribute: active.attribute, error_code: errorCode, retry, force_relay: forceRelay }, retry ? 'warn' : 'info');
    return retry;
  }

  async recoverInterruptedTransfer(): Promise<void> {
    const active = this.#activeTransfer;
    if (!active) return;
    if (this.#transferTimer) { clearTimeout(this.#transferTimer); this.#transferTimer = null; }
    await this.#recoverTransfer(active, 'DEVICE_TRANSFER_CONNECTION_CLOSED', true);
    this.#activeTransfer = null;
  }

  async #startNextControl(): Promise<void> {
    if (this.#closed || !this.#confirmed || this.#activeControl || this.#activeStatusQuery || this.#activeOta || this.#activeTransfer || this.#inventory) return;
    const next = this.#controlQueue.shift(); if (!next) return;
    const startedAt = timestamp();
    const changed = await this.db.run("UPDATE commands SET status='running',started_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='dispatched' AND connection_epoch=?", [startedAt, startedAt, next.commandId, this.connectionEpoch]);
    if (changed.changes !== 1) { await this.#startNextControl(); return; }
    this.#activeControl = next;
    this.socket.send(this.core.requestDeviceControl(next.input));
    this.#controlTimer = setTimeout(() => { void this.#expireActiveControl(next.commandId); }, 30_000); this.#controlTimer.unref();
    this.debug('device control requested', { device_id: this.deviceId, command_id: next.commandId, kind: next.input.kind, connection_epoch: this.connectionEpoch });
  }

  async #expireActiveControl(commandId: string): Promise<void> {
    if (this.#activeControl?.commandId !== commandId) return;
    this.#controlTimer = null; const completedAt = timestamp();
    const changed = await this.db.run("UPDATE commands SET status='failed',error_code='DEVICE_COMMAND_TIMEOUT',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('dispatched','running') AND connection_epoch=?", [completedAt, completedAt, commandId, this.connectionEpoch]);
    if (changed.changes === 1) { const [command, device] = await Promise.all([this.db.get<Row>('SELECT * FROM commands WHERE id=?', [commandId]), this.db.get<Row>('SELECT * FROM devices WHERE id=?', [this.deviceId])]); if (command && device) await this.emitEvent(device, 'command.failed', { command: mapPublicCommand(command) }); }
    this.#activeControl = null; this.debug('device control timed out', { device_id: this.deviceId, command_id: commandId, connection_epoch: this.connectionEpoch });
    await this.#startNextControl(); this.#startNextInventory(); await this.#startNextTransfer();
  }

  async #finishOta(succeeded: boolean, code: string): Promise<void> {
    const active = this.#activeOta; if (!active) return;
    if (this.#otaTimer) { clearTimeout(this.#otaTimer); this.#otaTimer = null; }
    const completedAt = timestamp();
    const changed = await this.db.run("UPDATE commands SET status=?,result_code=?,error_code=?,completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('dispatched','running') AND connection_epoch=?", [succeeded ? 'succeeded' : 'failed', succeeded ? code : null, succeeded ? null : code, completedAt, completedAt, active.commandId, this.connectionEpoch]);
    if (changed.changes === 1) { const [command, device] = await Promise.all([this.db.get<Row>('SELECT * FROM commands WHERE id=?', [active.commandId]), this.db.get<Row>('SELECT * FROM devices WHERE id=?', [this.deviceId])]); if (command && device) await this.emitEvent(device, succeeded ? 'command.succeeded' : 'command.failed', { command: mapPublicCommand(command) }); }
    this.debug('device OTA lane released', { device_id: this.deviceId, command_id: active.commandId, succeeded, code });
    this.#activeOta = null; this.#startNextInventory(); await this.#startNextControl(); await this.#startNextTransfer();
  }

  async #resumeQueuedCommands(): Promise<boolean> {
    const queued = await this.db.all<Row>("SELECT id,kind,payload_json FROM commands WHERE device_id=? AND status='queued' AND deadline_at>? ORDER BY created_at", [this.deviceId, timestamp()]);
    let resumedSync = false;
    for (const command of queued) {
      const commandId = String(command.id);
      if (command.kind === 'sync') { if (await this.#markDispatched(commandId)) { resumedSync = true; this.requestInventory(commandId); } continue; }
      if (command.kind === 'device.ota') { await this.db.run("UPDATE commands SET status='failed',error_code='OTA_RESTART_REQUIRED',completed_at=?,updated_at=? WHERE id=? AND status='queued'", [timestamp(), timestamp(), commandId]); continue; }
      let input: DeviceControl | null = null; try { input = parseDeviceControl(JSON.parse(String(command.payload_json ?? '{}'))); } catch { /* invalid command is failed below */ }
      if (!input) { await this.db.run("UPDATE commands SET status='failed',error_code='COMMAND_PAYLOAD_INVALID',completed_at=?,updated_at=? WHERE id=? AND status='queued'", [timestamp(), timestamp(), commandId]); continue; }
      if (await this.#markDispatched(commandId)) this.requestControl(commandId, input);
    }
    return resumedSync;
  }

  async #markDispatched(commandId: string): Promise<boolean> {
    const dispatchedAt = timestamp();
    const result = await this.db.run("UPDATE commands SET status='dispatched',dispatched_at=?,connection_epoch=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='queued' AND deadline_at>?", [dispatchedAt, this.connectionEpoch, dispatchedAt, commandId, dispatchedAt]);
    return result.changes === 1;
  }

  hasActiveTransfer(): boolean { return this.#activeTransfer !== null || this.#activeOta !== null; }
}

export class DeviceGateway {
  #actors = new Map<string, DeviceActor>();
  constructor(private readonly db: Database, private readonly core: GatewayProtocolCore, private readonly emitEvent: EmitEvent, private readonly planUpload: PlanUpload, private readonly completeUpload: CompleteUpload, private readonly appendRelay: AppendRelay, private readonly maxFileBytes: number, private readonly debug: DebugLog = () => undefined, private readonly timings: GatewayTimingOptions = {}) {}

  async attach(socket: GatewaySocket, deviceId: string, rawToken: Buffer, deviceHttpBaseUrl = ''): Promise<number> {
    const now = timestamp();
    const epoch = await this.db.get<{ connection_epoch: number }>("UPDATE devices SET online=0,connection_epoch=connection_epoch+1,updated_at=? WHERE id=? AND claim_status IN ('reserved','active') AND deleted_at IS NULL RETURNING connection_epoch", [now, deviceId]);
    if (!epoch) { rawToken.fill(0); throw new Error('DEVICE_NOT_FOUND'); }
    const previous = this.#actors.get(deviceId); previous?.supersede();
    if (!previous) await this.#recoverOrphanedTransfers(deviceId);
    const actor = new DeviceActor(deviceId, epoch.connection_epoch, socket, this.core, this.db, this.emitEvent, this.planUpload, this.completeUpload, this.appendRelay, this.maxFileBytes, this.debug, deviceHttpBaseUrl, this.timings.inventoryTimeoutMs ?? inventoryTimeoutDefaultMs, this.timings.statusQueryTimeoutMs ?? statusQueryTimeoutDefaultMs, this.timings.transferTimeoutMs, rawToken);
    this.#actors.set(deviceId, actor);
    socket.on('message', (data) => actor.enqueue(data));
    socket.on('close', () => {
      actor.close();
      if (this.#actors.get(deviceId) !== actor) return;
      this.#actors.delete(deviceId);
      void (async () => {
        const closedAt = timestamp();
        await actor.recoverInterruptedTransfer();
        await this.db.run(
          "UPDATE commands SET status='failed',error_code='DEVICE_DISCONNECTED_DURING_OTA',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE device_id=? AND kind='device.ota' AND status IN ('dispatched','running') AND connection_epoch=?",
          [closedAt, closedAt, deviceId, epoch.connection_epoch],
        );
        await this.db.run(
          "UPDATE commands SET status='queued',connection_epoch=NULL,dispatched_at=NULL,started_at=NULL,resource_version=resource_version+1,updated_at=? WHERE device_id=? AND kind<>'device.ota' AND status IN ('dispatched','running') AND connection_epoch=? AND deadline_at>?",
          [closedAt, deviceId, epoch.connection_epoch, closedAt],
        );
        const result = await this.db.run('UPDATE devices SET online=0,updated_at=? WHERE id=? AND connection_epoch=? AND online=1', [closedAt, deviceId, epoch.connection_epoch]);
        if (result.changes === 1) {
          const device = await this.db.get<Row>('SELECT * FROM devices WHERE id=?', [deviceId]);
          if (device) await this.emitEvent(device, 'device.offline', { device_id: deviceId, connection_epoch: epoch.connection_epoch });
        }
      })();
    });
    await this.db.run("UPDATE commands SET status='failed',error_code='DEVICE_DISCONNECTED_DURING_OTA',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE device_id=? AND kind='device.ota' AND status IN ('dispatched','running') AND (connection_epoch IS NULL OR connection_epoch<>?)", [now, now, deviceId, epoch.connection_epoch]);
    await this.db.run("UPDATE commands SET status='queued',connection_epoch=NULL,dispatched_at=NULL,started_at=NULL,resource_version=resource_version+1,updated_at=? WHERE device_id=? AND kind<>'device.ota' AND status IN ('dispatched','running') AND (connection_epoch IS NULL OR connection_epoch<>?) AND deadline_at>?", [now, deviceId, epoch.connection_epoch, now]);
    return epoch.connection_epoch;
  }

  async #recoverOrphanedTransfers(deviceId: string): Promise<void> {
    const files = await this.db.all<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.device_id=? AND f.status='syncing'", [deviceId]);
    if (files.length === 0) return;
    const recoveredAt = timestamp();
    let recovered = 0;
    let forcedRelay = 0;
    for (const file of files) {
      const direct = String(file.transport ?? '') !== 'server_relay';
      const changed = await this.db.run("UPDATE recording_files SET status='pending',force_relay=CASE WHEN transport<>'server_relay' THEN 1 ELSE force_relay END,error_code='DEVICE_TRANSFER_PROCESS_RESTARTED',resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing'", [recoveredAt, file.id]);
      if (changed.changes !== 1) continue;
      recovered += 1;
      if (direct) forcedRelay += 1;
      await this.emitEvent(file, 'recording.sync_failed', { file_id: file.id, device_id: deviceId, session_id: file.session_id, attribute: file.attribute, error_code: 'DEVICE_TRANSFER_PROCESS_RESTARTED', ...recordingEventFacts({ ...file, resource_version: Number(file.resource_version ?? 1) + 1 }) });
    }
    if (forcedRelay > 0) await this.db.run("UPDATE recording_files SET force_relay=1,updated_at=? WHERE device_id=? AND status IN ('pending','failed') AND force_relay=0", [recoveredAt, deviceId]);
    this.debug('orphaned device file transfers recovered after gateway restart', { device_id: deviceId, recovered_files: recovered, relay_fallback_files: forcedRelay }, 'warn');
  }

  async dispatchSync(deviceId: string, commandId: string): Promise<boolean> {
    const actor = this.#actors.get(deviceId);
    if (!actor) return false;
    const dispatchedAt = timestamp();
    const result = await this.db.run(
      "UPDATE commands SET status='dispatched',dispatched_at=?,connection_epoch=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND device_id=? AND status='queued' AND deadline_at>? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND connection_epoch=? AND online=1 AND deleted_at IS NULL)",
      [dispatchedAt, actor.connectionEpoch, dispatchedAt, commandId, deviceId, dispatchedAt, deviceId, actor.connectionEpoch],
    );
    if (result.changes !== 1) return false;
    if (!actor.requestInventory(commandId)) {
      await this.db.run(
        "UPDATE commands SET status='queued',connection_epoch=NULL,dispatched_at=NULL,started_at=NULL,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='dispatched' AND connection_epoch=?",
        [timestamp(), commandId, actor.connectionEpoch],
      );
      return false;
    }
    return true;
  }

  requestStatus(deviceId: string): boolean { return this.#actors.get(deviceId)?.requestStatus() ?? false; }

  async dispatchControl(deviceId: string, commandId: string, input: DeviceControl): Promise<boolean> {
    const actor = this.#actors.get(deviceId); if (!actor) return false;
    const dispatchedAt = timestamp();
    const result = await this.db.run(
      "UPDATE commands SET status='dispatched',dispatched_at=?,connection_epoch=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND device_id=? AND status='queued' AND deadline_at>? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND connection_epoch=? AND online=1 AND deleted_at IS NULL)",
      [dispatchedAt, actor.connectionEpoch, dispatchedAt, commandId, deviceId, dispatchedAt, deviceId, actor.connectionEpoch],
    );
    if (result.changes !== 1) return false;
    if (actor.requestControl(commandId, input)) return true;
    await this.db.run("UPDATE commands SET status='queued',connection_epoch=NULL,dispatched_at=NULL,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='dispatched' AND connection_epoch=?", [timestamp(), commandId, actor.connectionEpoch]);
    return false;
  }

  async dispatchOta(deviceId: string, commandId: string, firmware: GatewayOtaPackage): Promise<boolean> {
    const actor = this.#actors.get(deviceId); if (!actor) return false;
    const dispatchedAt = timestamp();
    const result = await this.db.run(
      "UPDATE commands SET status='dispatched',dispatched_at=?,connection_epoch=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND device_id=? AND status='queued' AND deadline_at>? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND connection_epoch=? AND online=1 AND deleted_at IS NULL)",
      [dispatchedAt, actor.connectionEpoch, dispatchedAt, commandId, deviceId, dispatchedAt, deviceId, actor.connectionEpoch],
    );
    if (result.changes !== 1) return false;
    if (await actor.requestOta(commandId, firmware)) return true;
    const failedAt = timestamp();
    await this.db.run("UPDATE commands SET status='failed',error_code='DEVICE_BUSY',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='dispatched' AND connection_epoch=?", [failedAt, failedAt, commandId, actor.connectionEpoch]);
    return false;
  }

  hasActiveTransfer(deviceId: string): boolean { return this.#actors.get(deviceId)?.hasActiveTransfer() ?? false; }

  replace(deviceId: string): void {
    const actor = this.#actors.get(deviceId); actor?.supersede(); this.#actors.delete(deviceId);
  }
}
