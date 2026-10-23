import { randomUUID } from 'node:crypto';
import type { DeviceControl, FileDescriptor, GatewayEvent, GatewayProtocolCore } from '@voicecan/device-core';
import type { Database, SqlStatement } from './database.js';
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
type GatewayTimingOptions = { inventoryTimeoutMs?: number; statusQueryTimeoutMs?: number; transferTimeoutMs?: number; livenessTimeoutMs?: number; transferPriorityGraceMs?: number };
type InventoryRequest = { commandId: string | null; startSessionId: number };
type InventoryState = { commandId: string | null; requestStart: number; total: number | null; nextOffset: number; files: FileDescriptor[]; transferFiles: FileDescriptor[] };
type ActiveTransfer = { fileId: string; sessionId: number; attribute: number; expectedSize: number };

const fileListPageSize = 120;
const inventoryTimeoutDefaultMs = 30_000;
const statusQueryTimeoutDefaultMs = 35_000;
const statusRefreshIntervalDefaultMs = 5 * 60_000;
// The device sends an application heartbeat every 30s. Allow a small margin for
// scheduling and network jitter, then treat the connection as offline even if
// the half-open TCP socket has not produced a close event yet.
const deviceLivenessTimeoutDefaultMs = 32_000;
const transferGapMs = 500;
const transferPriorityGraceDefaultMs = 3_000;
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
  #inventoryWork: Promise<void> = Promise.resolve();
  #inventoryTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingInventories: InventoryRequest[] = [];
  #predecessorDeviceId: string | null | undefined = undefined;
  #scanFinalizing = false;
  #transferQueue: FileDescriptor[] = [];
  #queuedTransferKeys = new Set<string>();
  #activeTransfer: ActiveTransfer | null = null;
  #transferTimer: ReturnType<typeof setTimeout> | null = null;
  #transferGapTimer: ReturnType<typeof setTimeout> | null = null;
  #nextTransferNotBefore = 0;
  #heartbeatAckSequence = 0;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #statusQueryTimer: ReturnType<typeof setTimeout> | null = null;
  #statusQueue: Array<{ eventKind: StatusEventKind; request: Uint8Array }> = [];
  #deviceInfoCached = false;
  #activeStatusQuery: StatusEventKind | null = null;
  #controlTimer: ReturnType<typeof setTimeout> | null = null;
  #controlQueue: Array<{ commandId: string; input: DeviceControl }> = [];
  #activeControl: { commandId: string; input: DeviceControl } | null = null;
  #activeOta: { commandId: string; firmware: GatewayOtaPackage } | null = null;
  #otaTimer: ReturnType<typeof setTimeout> | null = null;
  #livenessTimer: ReturnType<typeof setInterval> | null = null;
  #lastInboundAt = Date.now();
  #livenessOffline = false;
  #livenessGeneration = 0;

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
    private readonly livenessTimeoutMs: number,
    private readonly transferPriorityGraceMs: number,
    rawToken: Buffer,
  ) {
    try { const request = this.core.createBindRequest(rawToken); this.socket.send(request); this.debug('device bind request sent', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, bytes: request.byteLength }); } finally { rawToken.fill(0); }
    this.#bindTimer = setTimeout(() => {
      if (!this.#confirmed) this.socket.close(1008, 'device bind confirmation timeout');
    }, 10_000);
    this.#livenessTimer = setInterval(() => { void this.#checkLiveness(); }, Math.max(100, Math.min(500, Math.floor(this.livenessTimeoutMs / 2))));
    this.#livenessTimer.unref();
  }

  async #checkLiveness(): Promise<void> {
    if (this.#closed || this.#livenessOffline) return;
    if (Date.now() - this.#lastInboundAt < this.livenessTimeoutMs) return;
    this.#livenessOffline = true;
    const generation = this.#livenessGeneration;
    const silentMs = Date.now() - this.#lastInboundAt;
    const now = timestamp();
    try {
      const result = await this.db.run('UPDATE devices SET online=0,updated_at=? WHERE id=? AND connection_epoch=? AND online=1', [now, this.deviceId, this.connectionEpoch]);
      if (generation !== this.#livenessGeneration) {
        // A frame arrived while the offline update was in flight. Restore the
        // online flag instead of leaving a healthy device marked offline.
        this.#livenessOffline = false;
        await this.db.run('UPDATE devices SET online=1,last_seen_at=?,updated_at=? WHERE id=? AND connection_epoch=?', [timestamp(), timestamp(), this.deviceId, this.connectionEpoch]);
        return;
      }
      if (result.changes === 1) {
        const device = await this.db.get<Row>('SELECT * FROM devices WHERE id=?', [this.deviceId]);
        if (device) await this.emitEvent(device, 'device.offline', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, reason: 'liveness_timeout' });
      }
      this.debug('device liveness timeout', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, silent_ms: silentMs }, 'warn');
    } catch (error) {
      this.#livenessOffline = false;
      this.debug('device liveness update failed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, error: error instanceof Error ? error.message : String(error) }, 'warn');
    }
  }

  enqueue(raw: unknown): void {
    if (this.#closed) return;
    this.#lastInboundAt = Date.now();
    this.#livenessGeneration += 1;
    if (this.#livenessOffline) this.#livenessOffline = false;
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
    this.#tail = this.#tail.then(() => this.#process(frame)).catch((error: unknown) => {
      this.debug('device gateway frame rejected', {
        device_id: this.deviceId, connection_epoch: this.connectionEpoch,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn');
      this.socket.close(1002, 'invalid device frame');
    }).finally(() => {
      this.#queued -= 1;
      this.#queuedBytes -= frame.byteLength;
      if (this.#inboundPaused && !this.#closed && this.#queuedBytes <= inboundQueueLowWatermarkBytes) {
        this.#inboundPaused = false;
        this.socket.resume();
        this.debug('device gateway inbound flow resumed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, queued: this.#queued, queued_bytes: this.#queuedBytes });
      }
    });
  }

  close(): void { this.#closed = true; clearTimeout(this.#bindTimer); if (this.#livenessTimer) clearInterval(this.#livenessTimer); if (this.#inventoryTimer) clearTimeout(this.#inventoryTimer); if (this.#transferTimer) clearTimeout(this.#transferTimer); if (this.#transferGapTimer) clearTimeout(this.#transferGapTimer); if (this.#statusTimer) clearInterval(this.#statusTimer); if (this.#statusQueryTimer) clearTimeout(this.#statusQueryTimer); if (this.#controlTimer) clearTimeout(this.#controlTimer); if (this.#otaTimer) clearTimeout(this.#otaTimer); this.debug('device gateway actor closed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, confirmed: this.#confirmed }); }
  supersede(): void { this.close(); this.socket.close(4001, 'connection superseded'); }

  async requestIncrementalInventory(commandId: string): Promise<boolean> {
    const lastSessionId = await this.#lastSessionId();
    return this.requestInventory(commandId, lastSessionId > 0 ? lastSessionId + 1 : 0);
  }

  requestInventory(commandId: string | null, startSessionId = 0): boolean {
    if (this.#closed) return false;
    if (this.#inventory) {
      if (!commandId || this.#inventory.commandId === commandId) return true;
      if (this.#inventory.commandId === null) {
        this.#inventory.commandId = commandId;
        this.debug('sync command attached to active device inventory', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, command_id: commandId, request_start: this.#inventory.requestStart });
        return true;
      }
    }
    if (commandId && this.#pendingInventories.some((request) => request.commandId === commandId)) return true;
    if (!commandId && this.#pendingInventories.some((request) => request.commandId === null)) return true;
    const automaticInventory = commandId ? this.#pendingInventories.findIndex((request) => request.commandId === null) : -1;
    if (automaticInventory >= 0) {
      this.#pendingInventories[automaticInventory] = { commandId, startSessionId };
      return true;
    }
    this.#pendingInventories.push({ commandId, startSessionId });
    // Status snapshots are best-effort. Once a synchronization request is
    // waiting, finish only the in-flight status query and yield the lane.
    this.#statusQueue = [];
    this.#startNextInventory();
    return true;
  }

  requestStatus(): boolean {
    if (this.#closed || !this.#confirmed || this.#activeStatusQuery || this.#statusQueue.length > 0 || this.#activeTransfer || this.#transferQueue.length > 0 || this.#inventory || this.#pendingInventories.length > 0 || this.#activeControl || this.#activeOta || this.#controlQueue.length > 0) return false;
    this.#statusQueue = [
      ...(this.#deviceInfoCached ? [] : [{ eventKind: 'device_info' as const, request: this.core.requestDeviceInfo() }]),
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
    this.#background(this.#startNextControl());
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
    this.#otaTimer = setTimeout(() => { this.#background(this.#finishOta(false, 'DEVICE_OTA_TIMEOUT')); }, 15 * 60_000); this.#otaTimer.unref();
    this.debug('device OTA requested', { device_id: this.deviceId, command_id: commandId, version: firmware.version, firmware_size: firmware.size, firmware_crc16: firmware.crc16, connection_epoch: this.connectionEpoch });
    return true;
  }

  #background(task: Promise<unknown>): void {
    // Timer-triggered work must never surface as an unhandled rejection: on
    // Node 24 that would terminate the process (for example when a watchdog
    // fires while the database worker is shutting down).
    void task.catch((error: unknown) => this.debug('device gateway background task failed', {
      device_id: this.deviceId, connection_epoch: this.connectionEpoch,
      error: error instanceof Error ? error.message : String(error),
    }, 'warn'));
  }

  #startNextInventory(): void {
    if (!this.#confirmed || this.#inventory || this.#activeStatusQuery || this.#activeTransfer || this.#activeControl || this.#activeOta || this.#controlQueue.length > 0 || this.#pendingInventories.length === 0) return;
    const next = this.#pendingInventories.shift()!;
    this.#inventory = { commandId: next.commandId, requestStart: next.startSessionId, total: null, nextOffset: 0, files: [], transferFiles: [] };
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
    this.#inventoryTimer = setTimeout(() => { this.#background(this.#expireInventory(inventory)); }, this.inventoryTimeoutMs);
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
    this.#statusQueryTimer = setTimeout(() => { this.#background(this.#expireStatusQuery(next.eventKind)); }, this.statusQueryTimeoutMs);
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
    let result: ReturnType<GatewayProtocolCore['process']>;
    try {
      result = this.core.process(frame);
    } catch (error) {
      const inventory = this.#inventory;
      // Some firmware builds answer a page request beyond their last file
      // with a zero-length response that the gateway Core rejects as an
      // integrity error. That means "nothing new", not a broken connection.
      if (error instanceof Error && error.message === 'FILE_LIST_INTEGRITY_FAILED' && inventory && inventory.requestStart > 0 && inventory.nextOffset === 0) {
        this.debug('device incremental file inventory returned no new page', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, request_start: inventory.requestStart });
        await this.#finalizeInventory(inventory, []);
        return;
      }
      throw error;
    }
    this.debug('device gateway event decoded', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, event_kind: result.event.kind, queued: this.#queued, queued_bytes: this.#queuedBytes, response_bytes: result.response?.byteLength ?? 0 });
    if (!this.#confirmed && result.event.kind !== 'bind_confirmed' && result.event.kind !== 'heartbeat') throw new Error('DEVICE_BIND_REQUIRED');
    if (result.event.kind === 'heartbeat') {
      // The device measures RTT and records a miss if the ACK does not arrive
      // before its next 30s heartbeat. Acknowledge before persistence so a slow
      // DB write or another queued frame cannot delay the response.
      if (result.response) {
        this.#heartbeatAckSequence += 1;
        this.socket.send(result.response);
        this.debug('device heartbeat acknowledged', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, heartbeat_ack_sequence: this.#heartbeatAckSequence, queued: this.#queued, queued_bytes: this.#queuedBytes, response_bytes: result.response.byteLength }, 'info');
      }
      try { await this.#persist(result.event); }
      catch (error) { this.debug('device heartbeat persistence failed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, error: error instanceof Error ? error.message : String(error) }, 'warn'); }
      return;
    }
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
      const cachedInfo = await this.db.get<Row>('SELECT info_updated_at FROM device_status WHERE device_id=?', [this.deviceId]);
      this.#deviceInfoCached = Boolean(cachedInfo?.info_updated_at && current.model && current.hardware_version && current.firmware_version);
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
      if (!resumedSync) {
        // First bind (including a rebind) and the first scan after upgrading an
        // existing deployment inspect the whole device. Later connections only
        // ask for files after the highest session ID already known, so old
        // recordings are never requested from the device again.
        const lastSessionId = await this.#lastSessionId();
        const fullScan = firstClaim || !current.initial_scan_completed_at || lastSessionId === 0;
        this.requestInventory(null, fullScan ? 0 : lastSessionId + 1);
      }
      // Status is deliberately low priority. The device can take tens of
      // seconds to answer a status query, and polling it aggressively competes
      // with heartbeat ACK processing. Keep the refresh infrequent and let the
      // timeout cover a slow device response; the admin can still request a
      // manual refresh.
      this.#statusTimer = setInterval(() => { this.requestStatus(); }, statusRefreshIntervalDefaultMs);
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
      this.#deviceInfoCached = true;
      return;
    }
    if (event.kind === 'device_status') {
      const now = timestamp(); const status = event.status;
      await this.db.run(`INSERT INTO device_status(device_id,source,record_state,record_mode,microphone_mode,microphone_gain_db,usb_state,wifi_state,wifi_mode,relay_state,privacy_mode,earphone_recording,status_updated_at,updated_at)
        VALUES(?,'ws',?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET source='ws',record_state=excluded.record_state,record_mode=excluded.record_mode,microphone_mode=excluded.microphone_mode,microphone_gain_db=excluded.microphone_gain_db,usb_state=excluded.usb_state,wifi_state=excluded.wifi_state,wifi_mode=excluded.wifi_mode,relay_state=excluded.relay_state,privacy_mode=excluded.privacy_mode,earphone_recording=excluded.earphone_recording,status_updated_at=excluded.status_updated_at,updated_at=excluded.updated_at`,
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
      await this.db.run(`INSERT INTO device_status(device_id,source,battery_state,battery_state_code,battery_percent,battery_temperature_c,battery_voltage_mv,work_time_seconds,accumulated_work_time_seconds,battery_updated_at,updated_at) VALUES(?,'ws',?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET source='ws',battery_state=excluded.battery_state,battery_state_code=excluded.battery_state_code,battery_percent=excluded.battery_percent,battery_temperature_c=excluded.battery_temperature_c,battery_voltage_mv=excluded.battery_voltage_mv,work_time_seconds=excluded.work_time_seconds,accumulated_work_time_seconds=excluded.accumulated_work_time_seconds,battery_updated_at=excluded.battery_updated_at,updated_at=excluded.updated_at`, [this.deviceId, battery.state, battery.stateCode, battery.percent, battery.temperatureC, battery.voltageMillivolts, battery.workTimeSeconds, battery.accumulatedWorkTimeSeconds, now, now]);
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
      this.debug('device new file notified', {
        device_id: this.deviceId, connection_epoch: this.connectionEpoch,
        session_id: event.sessionId, attribute: event.attribute, size: event.size,
        queue_depth: this.#transferQueue.length,
        active_transfer: this.#activeTransfer?.sessionId ?? null,
        active_status_query: this.#activeStatusQuery,
        active_inventory: Boolean(this.#inventory),
        pending_inventories: this.#pendingInventories.length,
        scan_finalizing: this.#scanFinalizing,
      }, 'info');
      await this.#discoverAndPlan({ sessionId: event.sessionId, attribute: event.attribute, size: event.size }, true, true);
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
    if (!inventory) {
      this.debug('device file inventory page ignored without an active request', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, request_start: event.requestStart, batch_offset: event.batchOffset, total_count: event.totalCount }, 'warn');
      return;
    }
    if (event.requestStart !== inventory.requestStart || event.batchOffset !== inventory.nextOffset) throw new Error('FILE_LIST_SEQUENCE');
    if (this.#inventoryTimer) clearTimeout(this.#inventoryTimer); this.#inventoryTimer = null;
    this.debug('device file inventory page received', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, command_id: inventory.commandId, request_start: event.requestStart, batch_offset: event.batchOffset, total_count: event.totalCount, page_files: event.files.length, first_entry: event.files[0] ? `${event.files[0].sessionId}:${event.files[0].attribute}` : null, last_entry: event.files.at(-1) ? `${event.files.at(-1)!.sessionId}:${event.files.at(-1)!.attribute}` : null }, 'info');
    if (inventory.commandId && inventory.nextOffset === 0) {
      const startedAt = timestamp();
      await this.db.run("UPDATE commands SET status='running',started_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='dispatched' AND connection_epoch=?", [startedAt, startedAt, inventory.commandId, this.connectionEpoch]);
    }
    if (inventory.total === null) inventory.total = event.totalCount;
    const pageEntryTarget = fileListPageEntryTarget(event.totalCount);
    if (inventory.total !== event.totalCount || inventory.nextOffset + event.files.length > pageEntryTarget) {
      this.debug('device file inventory integrity failure', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, request_start: event.requestStart, inventory_start: inventory.requestStart, total_count: event.totalCount, inventory_total: inventory.total, batch_offset: event.batchOffset, inventory_offset: inventory.nextOffset, page_files: event.files.length, page_entry_target: pageEntryTarget }, 'warn');
      throw new Error('FILE_LIST_INTEGRITY');
    }
    // Firmware does not guarantee a globally ordered list: one recording session
    // can expose several attributes (normal / BT call / BT media) with the same
    // session id, and some builds return newest-first. Normalize the page instead
    // of dropping an otherwise healthy connection with FILE_LIST_ORDER.
    const ordered = [...event.files].sort((left, right) => left.sessionId - right.sessionId || left.attribute - right.attribute);
    if (ordered.some((file) => file.sessionId < inventory.requestStart)) throw new Error('FILE_LIST_ORDER');
    const seen = new Set(inventory.files.map((file) => `${file.sessionId}:${file.attribute}:${file.size}`));
    let repeated = 0;
    for (const file of ordered) {
      const key = `${file.sessionId}:${file.attribute}:${file.size}`;
      if (seen.has(key)) { repeated += 1; continue; }
      seen.add(key); inventory.files.push(file);
    }
    inventory.nextOffset += event.files.length;
    if (repeated > 0) this.debug('device file inventory repeated entries', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, repeated, total_count: event.totalCount }, 'warn');
    if (inventory.nextOffset < pageEntryTarget) { this.#armInventoryTimeout(inventory); return; }
    const page = [...inventory.files].sort((left, right) => left.sessionId - right.sessionId || left.attribute - right.attribute);
    // File discovery and upload planning can take long enough to delay the next
    // heartbeat ACK. Keep the inbound frame lane free: parse/ACK on #tail, then
    // process this page on a separate serialized queue.
    this.#inventoryWork = this.#inventoryWork
      .then(() => this.#processInventoryPage(inventory, page, event.totalCount))
      .catch((error: unknown) => {
        this.debug('device inventory processing failed', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, error: error instanceof Error ? error.message : String(error) }, 'warn');
        if (this.#inventory === inventory) this.#inventory = null;
        this.#startNextInventory();
        void this.#startNextTransfer();
      });
  }

  async #processInventoryPage(inventory: InventoryState, page: FileDescriptor[], totalCount: number): Promise<void> {
    if (this.#closed) return;
    for (const file of page) { if (this.#closed) return; if (await this.#discoverAndPlan(file, false, false)) inventory.transferFiles.push(file); }
    const last = page.at(-1);
    if (totalCount >= fileListPageSize && last && last.sessionId < 0xffff_ffff) {
      if (this.#inventory !== inventory) return;
      inventory.requestStart = last.sessionId + 1; inventory.total = null; inventory.nextOffset = 0; inventory.files = [];
      this.#sendInventoryPage();
      return;
    }
    await this.#finalizeInventory(inventory, inventory.transferFiles);
  }

  async #finalizeInventory(inventory: InventoryState, transferFiles: FileDescriptor[]): Promise<void> {
    const commandId = inventory.commandId;
    if (this.#inventory === inventory) this.#inventory = null;
    if (commandId) {
      const completedAt = timestamp();
      const changed = await this.db.run("UPDATE commands SET status='succeeded',result_code='SYNC_COMPLETED',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('dispatched','running') AND connection_epoch=?", [completedAt, completedAt, commandId, this.connectionEpoch]);
      if (changed.changes === 1) {
        const [command, device] = await Promise.all([this.db.get<Row>('SELECT * FROM commands WHERE id=?', [commandId]), this.db.get<Row>('SELECT * FROM devices WHERE id=?', [this.deviceId])]);
        if (command && device) await this.emitEvent(device, 'command.succeeded', { command: mapPublicCommand(command) });
      }
    }
    this.#startNextInventory();
    if (!this.#inventory) {
      this.#scanFinalizing = true;
      try {
        await this.#updateSyncRound();
        await this.#queueIncompleteFiles(transferFiles);
        // A new_file frame can be processed while this finalizer awaits the
        // database. Re-count once more before transfers are allowed to start.
        await this.#updateSyncRound();
      } finally {
        this.#scanFinalizing = false;
      }
      await this.#startNextTransfer();
    }
  }

  async #discoverAndPlan(file: FileDescriptor, enqueue = true, front = false): Promise<boolean> {
    if (file.size <= 0 || file.size > this.maxFileBytes || file.attribute < 0 || file.attribute > 2) return false;
    const device = await this.db.get<Row>("SELECT * FROM devices WHERE id=? AND connection_epoch=? AND claim_status='active' AND deleted_at IS NULL", [this.deviceId, this.connectionEpoch]);
    if (!device) return false;
    const candidate = await this.db.get<Row>('SELECT * FROM recording_files WHERE device_id=? AND credential_epoch=? AND session_id=? AND attribute=? ORDER BY revision DESC LIMIT 1', [this.deviceId, device.credential_epoch, file.sessionId, file.attribute]);
    if (candidate && Number(candidate.expected_size) === file.size) {
      if (candidate.status === 'synced') return false;
      if (['pending', 'syncing', 'failed'].includes(String(candidate.status))) {
        if (await this.#inheritSyncedFile(file, device, candidate)) return false;
        if (enqueue) await this.#queueTransfer(file, front);
        return true;
      }
      if (candidate.status === 'identity_conflict') return false;
    }
    if (!candidate && await this.#inheritSyncedFile(file, device)) return false;
    const fileId = `file_${randomUUID()}`; const revision = candidate ? Number(candidate.revision) + 1 : 1; const conflict = Boolean(candidate); const now = timestamp(); const media = reviewedRecordingMedia(device);
    await this.db.run('INSERT INTO recording_files(id,device_id,credential_epoch,session_id,attribute,revision,expected_size,status,error_code,media_container,media_codec,media_content_type,media_filename_extension,encoding_profile,media_metadata_source,source_firmware_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [fileId, this.deviceId, device.credential_epoch, file.sessionId, file.attribute, revision, file.size, conflict ? 'identity_conflict' : 'pending', conflict ? 'FILE_IDENTITY_CONFLICT' : null, media.container, media.codec, media.content_type, media.filename_extension, media.encoding_profile, media.source, device.firmware_version ?? null, now, now]);
    if (conflict) return false;
    if (!this.#inventory && !this.#scanFinalizing) await this.#registerNewFileInRound();
    const row = await this.db.get<Row>('SELECT * FROM recording_files WHERE id=?', [fileId]);
    await this.emitEvent(device, 'recording.discovered', { file_id: fileId, device_id: this.deviceId, session_id: file.sessionId, attribute: file.attribute, file_size: file.size, ...recordingEventFacts(row!) });
    if (enqueue && row) await this.#queueTransfer(file, front);
    return true;
  }

  async #lastSessionId(): Promise<number> {
    const row = await this.db.get<{ last: number | null }>("SELECT MAX(session_id) AS last FROM recording_files WHERE device_id=? AND deletion_status='active'", [this.deviceId]);
    const last = Number(row?.last ?? 0);
    return Number.isSafeInteger(last) && last > 0 ? last : 0;
  }

  async #releasedPredecessorId(): Promise<string | null> {
    if (this.#predecessorDeviceId !== undefined) return this.#predecessorDeviceId;
    const device = await this.db.get<Row>('SELECT sn,group_id FROM devices WHERE id=?', [this.deviceId]);
    if (!device) { this.#predecessorDeviceId = null; return null; }
    const escapedSn = String(device.sn).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    const row = await this.db.get<{ id: string }>("SELECT id FROM devices WHERE deleted_at IS NOT NULL AND group_id=? AND sn LIKE ? ESCAPE '\\' ORDER BY deleted_at DESC LIMIT 1", [device.group_id, escapedSn + '#released#%']);
    this.#predecessorDeviceId = row?.id ?? null;
    return this.#predecessorDeviceId;
  }

  /**
   * A released device keeps its immutable recording rows on this server. When
   * the same physical device is bound again, a file that is still reported by
   * the device but was already synchronized under the previous binding must not
   * be requested again. Move that synced identity to the new binding instead.
   */
  async #inheritSyncedFile(file: FileDescriptor, device: Row, candidate?: Row): Promise<boolean> {
    const predecessorId = await this.#releasedPredecessorId();
    if (!predecessorId) return false;
    const inherited = await this.db.get<Row>("SELECT id FROM recording_files WHERE device_id=? AND session_id=? AND attribute=? AND expected_size=? AND status='synced' AND deletion_status='active' ORDER BY revision DESC LIMIT 1", [predecessorId, file.sessionId, file.attribute, file.size]);
    if (!inherited) return false;
    const now = timestamp();
    try {
      const statements: SqlStatement[] = [];
      if (candidate) {
        const existing = await this.db.all<{ id: string }>('SELECT id FROM recording_files WHERE device_id=? AND session_id=? AND attribute=?', [this.deviceId, file.sessionId, file.attribute]);
        for (const row of existing) {
          statements.push(
            { sql: 'DELETE FROM recording_download_grants WHERE file_id=?', params: [row.id] },
            { sql: 'DELETE FROM upload_tickets WHERE file_id=?', params: [row.id] },
            { sql: 'DELETE FROM s3_upload_attempts WHERE file_id=?', params: [row.id] },
            { sql: 'DELETE FROM recording_files WHERE id=? AND device_id=?', params: [row.id, this.deviceId], expectChanges: 1 },
          );
        }
      }
      statements.push({ sql: "UPDATE recording_files SET device_id=?,credential_epoch=?,transport=NULL,force_relay=0,error_code=NULL,updated_at=?,resource_version=resource_version+1 WHERE id=? AND device_id=? AND status='synced'", params: [this.deviceId, device.credential_epoch, now, inherited.id, predecessorId], expectChanges: 1 });
      await this.db.batch(statements);
      this.debug('rebound synced file inherited from released device', { device_id: this.deviceId, predecessor_device_id: predecessorId, file_id: inherited.id, session_id: file.sessionId, attribute: file.attribute, expected_size: file.size });
      return true;
    } catch (error) {
      this.debug('rebound synced file inheritance skipped', { device_id: this.deviceId, predecessor_device_id: predecessorId, file_id: inherited.id, session_id: file.sessionId, error: error instanceof Error ? error.message : String(error) }, 'warn');
      return false;
    }
  }

  async #updateSyncRound(): Promise<void> {
    const device = await this.db.get<Row>('SELECT credential_epoch,sync_round_total,sync_round_completed FROM devices WHERE id=?', [this.deviceId]);
    if (!device) return;
    const remaining = await this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM recording_files WHERE device_id=? AND credential_epoch=? AND deletion_status='active' AND status IN ('pending','syncing','failed')", [this.deviceId, device.credential_epoch]);
    const count = Number(remaining?.count ?? 0);
    const currentTotal = Number(device.sync_round_total ?? 0);
    const currentCompleted = Number(device.sync_round_completed ?? 0);
    const roundFinished = currentCompleted >= currentTotal;
    let total = currentTotal;
    let completed = currentCompleted;
    if (count === 0) {
      if (currentTotal > 0) completed = currentTotal;
    } else if (roundFinished) {
      total = count; completed = 0;
    } else {
      total = currentCompleted + count;
    }
    const now = timestamp();
    const startsNewRound = roundFinished && count > 0;
    await this.db.run("UPDATE devices SET sync_round_total=?,sync_round_completed=?,sync_round_started_at=CASE WHEN ?=1 THEN ? ELSE COALESCE(sync_round_started_at,?) END,initial_scan_completed_at=COALESCE(initial_scan_completed_at,?),updated_at=? WHERE id=?", [total, Math.min(completed, total), startsNewRound ? 1 : 0, now, now, now, now, this.deviceId]);
  }

  async #registerNewFileInRound(): Promise<void> {
    const now = timestamp();
    await this.db.run(`UPDATE devices SET
      sync_round_total=CASE WHEN sync_round_completed>=sync_round_total THEN 1 ELSE sync_round_total+1 END,
      sync_round_completed=CASE WHEN sync_round_completed>=sync_round_total THEN 0 ELSE sync_round_completed END,
      sync_round_started_at=CASE WHEN sync_round_completed>=sync_round_total THEN ? ELSE COALESCE(sync_round_started_at,?) END,
      updated_at=? WHERE id=?`, [now, now, now, this.deviceId]);
  }

  async #queueIncompleteFiles(discovered: FileDescriptor[] = []): Promise<void> {
    if (this.#closed) return;
    const device = await this.db.get<Row>("SELECT credential_epoch FROM devices WHERE id=? AND connection_epoch=? AND claim_status='active' AND deleted_at IS NULL", [this.deviceId, this.connectionEpoch]);
    if (!device) return;
    const stored = await this.db.all<Row>("SELECT session_id,attribute,expected_size FROM recording_files WHERE device_id=? AND credential_epoch=? AND deletion_status='active' AND status IN ('pending','syncing','failed')", [this.deviceId, device.credential_epoch]);
    const merged = new Map<string, FileDescriptor>();
    for (const file of discovered) merged.set(`${file.sessionId}:${file.attribute}`, file);
    for (const file of stored) merged.set(`${Number(file.session_id)}:${Number(file.attribute)}`, { sessionId: Number(file.session_id), attribute: Number(file.attribute), size: Number(file.expected_size) });
    const files = [...merged.values()].sort((left, right) => right.sessionId - left.sessionId || left.attribute - right.attribute);
    for (const file of files) {
      if (this.#closed) return;
      await this.#queueTransfer(file, false);
    }
  }

  #prioritizeTransferLane(): void {
    const deferred = this.#pendingInventories.filter((request) => request.commandId === null).length;
    if (deferred > 0) this.#pendingInventories = this.#pendingInventories.filter((request) => request.commandId !== null);
    if (this.#activeStatusQuery) {
      if (this.#statusQueryTimer) clearTimeout(this.#statusQueryTimer);
      this.#statusQueryTimer = setTimeout(() => {
        const kind = this.#activeStatusQuery;
        if (kind) this.#background(this.#expireStatusQuery(kind));
      }, this.transferPriorityGraceMs);
      this.#statusQueryTimer.unref();
    }
    if (this.#inventory && this.#inventory.commandId === null) {
      const inventory = this.#inventory;
      if (this.#inventoryTimer) clearTimeout(this.#inventoryTimer);
      this.#inventoryTimer = setTimeout(() => this.#background(this.#expireInventory(inventory)), this.transferPriorityGraceMs);
      this.#inventoryTimer.unref();
    }
    if (this.#activeStatusQuery || (this.#inventory && this.#inventory.commandId === null) || deferred > 0) {
      this.debug('device transfer lane prioritized for new file', {
        device_id: this.deviceId, connection_epoch: this.connectionEpoch,
        active_status_query: this.#activeStatusQuery,
        active_inventory: Boolean(this.#inventory),
        deferred_inventories: deferred,
        grace_ms: this.transferPriorityGraceMs,
      }, 'info');
    }
  }

  async #queueTransfer(file: FileDescriptor, front = false): Promise<void> {
    if (front) this.#prioritizeTransferLane();
    const key = `${file.sessionId}:${file.attribute}`;
    if (this.#activeTransfer?.sessionId === file.sessionId && this.#activeTransfer.attribute === file.attribute) return;
    if (this.#queuedTransferKeys.has(key)) return;
    this.#queuedTransferKeys.add(key);
    if (front) this.#transferQueue.unshift(file); else this.#transferQueue.push(file);
    this.debug('device file transfer queued', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, session_id: file.sessionId, attribute: file.attribute, expected_size: file.size, queue_depth: this.#transferQueue.length, front });
    await this.#startNextTransfer();
  }

  async #startNextTransfer(): Promise<void> {
    if (this.#closed || !this.#confirmed || this.#scanFinalizing || this.#activeTransfer || this.#activeStatusQuery || this.#activeControl || this.#activeOta || this.#controlQueue.length > 0 || this.#inventory || this.#pendingInventories.length > 0) return;
    const waitMs = this.#nextTransferNotBefore - Date.now();
    if (waitMs > 0) {
      if (!this.#transferGapTimer) {
        this.#transferGapTimer = setTimeout(() => {
          this.#transferGapTimer = null;
          this.#background(this.#startNextTransfer());
        }, waitMs);
        this.#transferGapTimer.unref();
      }
      return;
    }
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
    if (outcome === 'completed') this.#nextTransferNotBefore = Date.now() + transferGapMs;
    this.debug('device file transfer lane released', { device_id: this.deviceId, connection_epoch: this.connectionEpoch, file_id: completed?.fileId ?? null, session_id: completed?.sessionId ?? null, outcome, queue_depth: this.#transferQueue.length });
    this.#startNextInventory();
    await this.#startNextControl();
    await this.#startNextTransfer();
  }

  #armTransferTimeout(active: ActiveTransfer): void {
    if (this.#transferTimer) clearTimeout(this.#transferTimer);
    const estimatedMs = Math.ceil(active.expectedSize / transferMinimumBytesPerSecond * 1_000) + 60_000;
    const timeoutMs = this.transferTimeoutMs ?? Math.min(transferTimeoutCeilingMs, Math.max(transferTimeoutFloorMs, estimatedMs));
    this.#transferTimer = setTimeout(() => { this.#background(this.#expireActiveTransfer(active.fileId)); }, timeoutMs);
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
    this.#controlTimer = setTimeout(() => { this.#background(this.#expireActiveControl(next.commandId)); }, 30_000); this.#controlTimer.unref();
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
    if (succeeded) { this.#deviceInfoCached = false; await this.db.run('UPDATE device_status SET info_updated_at=NULL WHERE device_id=?', [this.deviceId]); }
    this.#activeOta = null; this.#startNextInventory(); await this.#startNextControl(); await this.#startNextTransfer();
  }

  async #resumeQueuedCommands(): Promise<boolean> {
    const queued = await this.db.all<Row>("SELECT id,kind,payload_json FROM commands WHERE device_id=? AND status='queued' AND deadline_at>? ORDER BY created_at", [this.deviceId, timestamp()]);
    let resumedSync = false;
    for (const command of queued) {
      const commandId = String(command.id);
      if (command.kind === 'sync') { if (await this.#markDispatched(commandId)) { resumedSync = true; const lastSessionId = await this.#lastSessionId(); this.requestInventory(commandId, lastSessionId > 0 ? lastSessionId + 1 : 0); } continue; }
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
    const actor = new DeviceActor(deviceId, epoch.connection_epoch, socket, this.core, this.db, this.emitEvent, this.planUpload, this.completeUpload, this.appendRelay, this.maxFileBytes, this.debug, deviceHttpBaseUrl, this.timings.inventoryTimeoutMs ?? inventoryTimeoutDefaultMs, this.timings.statusQueryTimeoutMs ?? statusQueryTimeoutDefaultMs, this.timings.transferTimeoutMs, this.timings.livenessTimeoutMs ?? deviceLivenessTimeoutDefaultMs, this.timings.transferPriorityGraceMs ?? transferPriorityGraceDefaultMs, rawToken);
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
      })().catch((error: unknown) => this.debug('device disconnect cleanup failed', {
        device_id: deviceId, connection_epoch: epoch.connection_epoch,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn'));
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
    if (!(await actor.requestIncrementalInventory(commandId))) {
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
