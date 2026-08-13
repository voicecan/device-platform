import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { GatewayProtocolCore } from '@voicecan/device-core';
import type { Database } from '../src/database.js';
import { DeviceGateway } from '../src/gateway.js';

class TestSocket extends EventEmitter {
  readonly sent: Uint8Array[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  pauseCount = 0;
  resumeCount = 0;
  send(data: Uint8Array): void { this.sent.push(data); }
  pause(): void { this.pauseCount += 1; }
  resume(): void { this.resumeCount += 1; }
  close(code?: number, reason?: string): void { this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }); this.emit('close'); }
}

test('gateway applies socket backpressure instead of closing on a relay-sized inbound burst', async () => {
  let releaseHeartbeat!: () => void;
  let heartbeatGate: Promise<void> | null = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')
      ? { connection_epoch: 7 }
      : sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=? AND deleted_at IS NULL')
        ? { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' }
        : null,
    all: async () => [],
    run: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=1,last_seen_at=')) await heartbeatGate;
      return { changes: 1 };
    },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: (frame) => frame[0] === 10
      ? { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }
      : { event: { kind: 'heartbeat', charging: false, batteryPercent: 50 } },
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setImmediate(resolve));

  const relaySizedFrame = new Uint8Array(2_048); relaySizedFrame[0] = 11;
  for (let index = 0; index < 65; index += 1) socket.emit('message', relaySizedFrame.slice());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.pauseCount, 1, 'the gateway must pause reads at the inbound high watermark');
  assert.equal(socket.closes.some((entry) => entry.reason === 'device queue overloaded'), false);

  heartbeatGate = null;
  releaseHeartbeat();
  for (let attempts = 0; attempts < 10 && socket.resumeCount === 0; attempts += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.resumeCount, 1, 'the gateway must resume reads after draining below the low watermark');
  socket.close();
});

test('gateway hard limit is based on queued bytes', async () => {
  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')
      ? { connection_epoch: 7 }
      : sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=? AND deleted_at IS NULL')
        ? { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' }
        : null,
    all: async () => [],
    run: async (sql: string) => { if (sql.startsWith('UPDATE devices SET online=1,last_seen_at=')) await bindGate; return { changes: 1 }; },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: (frame) => frame[0] === 10 ? { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } } : { event: { kind: 'heartbeat', charging: false, batteryPercent: 50 } },
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7)); socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setImmediate(resolve));
  const frame = new Uint8Array(2_048); frame[0] = 11;
  for (let index = 0; index < 257; index += 1) socket.emit('message', frame.slice());
  assert.equal(socket.closes.some((entry) => entry.reason === 'device queue overloaded'), true);
  releaseBind(); socket.close();
});

test('gateway fences command dispatch and requeues interrupted work', async () => {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1') ? { connection_epoch: 7 } : null,
    all: async () => [],
    run: async (sql: string, params: unknown[] = []) => {
      runs.push({ sql, params });
      return { changes: sql.startsWith("UPDATE commands SET status='dispatched'") || sql.startsWith("UPDATE commands SET status='queued'") ? 1 : 0 };
    },
    batch: async () => [],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1),
    requestFileList: () => Uint8Array.of(2),
    requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestFileTransfer: () => Uint8Array.of(3),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: () => ({ event: { kind: 'heartbeat', charging: false, batteryPercent: 50 } }),
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();

  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  assert.ok(runs.some((entry) => entry.sql.includes("status IN ('dispatched','running')") && entry.sql.includes('connection_epoch<>?')), 'a new fenced connection must recover stale in-flight commands');
  assert.equal(await gateway.dispatchSync('device-1', 'command-1'), true);
  const dispatched = runs.find((entry) => entry.sql.startsWith("UPDATE commands SET status='dispatched'"));
  assert.equal(dispatched?.params[1], 7);

  socket.close();
  await new Promise((resolve) => setImmediate(resolve));
  const requeued = runs.find((entry) => entry.sql.startsWith("UPDATE commands SET status='queued'") && entry.sql.includes("status IN ('dispatched','running')") && entry.sql.includes('connection_epoch=? AND deadline_at>?'));
  assert.ok(requeued);
  assert.equal(requeued.params[2], 7);
});

test('gateway advances after one requested page when legacy firmware reports all remaining files', async () => {
  const fileListRequests: Array<{ startSessionId: number; count: number }> = [];
  const files = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
    sessionId: start + index,
    attribute: 0,
    size: 1,
  }));
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.3' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 1_372, batchOffset: 0, files: files(1, 60) } }],
    [12, { event: { kind: 'file_list', requestStart: 0, totalCount: 1_372, batchOffset: 60, files: files(61, 60) } }],
  ]);
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=? AND deleted_at IS NULL')) {
        return { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: null };
      }
      return null;
    },
    all: async () => [],
    run: async () => ({ changes: 0 }),
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1),
    requestFileList: (startSessionId, count) => {
      fileListRequests.push({ startSessionId, count });
      return Uint8Array.of(2);
    },
    requestFileTransfer: () => Uint8Array.of(3),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    process: (frame) => {
      const result = events.get(frame[0] ?? -1);
      if (!result) throw new Error('unexpected test frame');
      return result;
    },
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();

  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Uint8Array.of(11));
  socket.emit('message', Uint8Array.of(12));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fileListRequests, [
    { startSessionId: 0, count: 120 },
    { startSessionId: 121, count: 120 },
  ]);
});

test('gateway gives file discovery priority and serializes status queries', async () => {
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 0, batchOffset: 0, files: [] } }],
    [12, { event: { kind: 'device_info', model: 'CAPSO', serialNumber: 'SN-1', hardwareVersion: 'B100', firmwareVersion: 'v0.5.2' } }],
  ]);
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1') ? { connection_epoch: 7 }
      : sql.includes('SELECT * FROM devices WHERE id=?') ? { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' } : null,
    all: async () => [], run: async () => ({ changes: 1 }), batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.map((frame) => frame[0]), [1, 4, 2], 'status polling must not get ahead of the initial file inventory');
  socket.emit('message', Uint8Array.of(11)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.requestStatus('device-1'), true);
  assert.deepEqual(socket.sent.map((frame) => frame[0]), [1, 4, 2, 5], 'only one status query may be in flight');
  socket.emit('message', Uint8Array.of(12)); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.map((frame) => frame[0]), [1, 4, 2, 5, 6], 'the next status query starts after the matching response');
  socket.close();
});

test('gateway fails a silent file inventory and releases the command lane', async () => {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      if (sql.startsWith('SELECT * FROM commands WHERE id=?')) return { id: 'command-timeout', device_id: 'device-1', kind: 'sync', status: 'failed', error_code: 'FILE_LIST_TIMEOUT' };
      return null;
    },
    all: async (sql: string) => sql.includes("FROM commands WHERE device_id=? AND status='queued'") ? [{ id: 'command-timeout', kind: 'sync', payload_json: '{}' }] : [],
    run: async (sql: string, params: unknown[] = []) => { runs.push({ sql, params }); return { changes: 1 }; }, batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: () => ({ event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }),
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024, () => undefined, { inventoryTimeoutMs: 5, statusQueryTimeoutMs: 5 });
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(runs.some((entry) => entry.sql.includes("error_code='FILE_LIST_TIMEOUT'")), 'a missing file-list response must fail explicitly');
  assert.equal(gateway.requestStatus('device-1'), true, 'the timed-out inventory must not keep the device command lane locked');
  socket.close();
});

test('gateway serializes recording transfers per device and advances after a terminal result', async () => {
  const requested: number[] = [];
  const candidates = new Map<number, Record<string, unknown>>([
    [100, { id: 'file-100', device_id: 'device-1', credential_epoch: 1, session_id: 100, attribute: 0, expected_size: 12, status: 'pending' }],
    [101, { id: 'file-101', device_id: 'device-1', credential_epoch: 1, session_id: 101, attribute: 0, expected_size: 13, status: 'pending' }],
  ]);
  const database = {
    get: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.includes('FROM devices WHERE id=?') || sql.includes('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      if (sql.includes('FROM recording_files WHERE device_id=?')) return candidates.get(Number(params.at(-2))) ?? candidates.get(Number(params.at(-1)));
      return null;
    },
    all: async () => [],
    run: async () => ({ changes: 1 }),
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 2, batchOffset: 0, files: [{ sessionId: 100, attribute: 0, size: 12 }, { sessionId: 101, attribute: 0, size: 13 }] } }],
    [12, { event: { kind: 'file_transfer', result: 0, sessionId: 100, size: 12, offset: 0, content: new Uint8Array() } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1),
    requestFileList: () => Uint8Array.of(2),
    requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestFileTransfer: (input) => { requested.push(input.sessionId); return Uint8Array.of(3); },
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async (_device, file) => ({ fileId: String(file.id), uploadUrl: 'http://192.168.50.20:8787/upload' }), async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();

  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7), 'http://192.168.50.20:8787');
  socket.emit('message', Uint8Array.of(10));
  socket.emit('message', Uint8Array.of(11));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, [100]);
  socket.emit('message', Uint8Array.of(12));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, [100, 101]);
});

test('gateway retries a 0x0C direct transfer through the relay lane', async () => {
  let forceRelay = false; let plans = 0;
  const file = () => ({ id: 'file-100', device_id: 'device-1', credential_epoch: 1, session_id: 100, attribute: 0, expected_size: 12, status: 'pending', transport: forceRelay ? null : 'filesystem_http', force_relay: Number(forceRelay), resource_version: 1, group_id: 'group-1', ownership_epoch: 1 });
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.includes('FROM devices WHERE id=?') || sql.includes('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      if (sql.includes('FROM recording_files WHERE device_id=?')) return file();
      return null;
    },
    all: async (sql: string) => sql.includes("WHERE f.id=? AND f.status='syncing'") ? [{ ...file(), status: 'syncing', transport: 'filesystem_http' }] : [],
    run: async (sql: string) => { if (sql.includes('force_relay=1')) forceRelay = true; return { changes: 1 }; },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 1, batchOffset: 0, files: [{ sessionId: 100, attribute: 0, size: 12 }] } }],
    [12, { event: { kind: 'file_transfer', result: 0x0c, sessionId: 100, size: 0, offset: 0, content: new Uint8Array() } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => { plans += 1; return { fileId: 'file-100', uploadUrl: forceRelay ? '' : 'http://192.168.50.20:8787/upload' }; }, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); socket.emit('message', Uint8Array.of(11)); await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Uint8Array.of(12)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forceRelay, true);
  assert.equal(plans, 2, 'the same file should be replanned immediately after selecting relay fallback');
  socket.close();
});

test('gateway falls back to relay when a direct transfer stays silent', async () => {
  let forceRelay = false; let plans = 0;
  const file = () => ({ id: 'file-100', device_id: 'device-1', credential_epoch: 1, session_id: 100, attribute: 0, expected_size: 12, status: 'pending', transport: forceRelay ? 'server_relay' : 'filesystem_http', force_relay: Number(forceRelay), resource_version: 1, group_id: 'group-1', ownership_epoch: 1 });
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.includes('FROM devices WHERE id=?') || sql.includes('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      if (sql.includes('FROM recording_files WHERE device_id=?')) return file();
      return null;
    },
    all: async (sql: string) => sql.includes("WHERE f.id=? AND f.status='syncing'") ? [{ ...file(), status: 'syncing' }] : [],
    run: async (sql: string) => { if (sql.includes('force_relay=CASE')) forceRelay = true; return { changes: 1 }; },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 1, batchOffset: 0, files: [{ sessionId: 100, attribute: 0, size: 12 }] } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => { plans += 1; return { fileId: 'file-100', uploadUrl: forceRelay ? '' : 'http://192.168.50.20:8787/upload' }; }, async () => undefined, async () => undefined, 1024, () => undefined, { transferTimeoutMs: 5 });
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); socket.emit('message', Uint8Array.of(11)); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(forceRelay, true);
  assert.equal(plans, 2, 'the watchdog should release the lane and immediately replan through relay');
  socket.close();
});

test('gateway preserves interrupted work and forces direct uploads through relay after reconnect', async () => {
  const runs: string[] = [];
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.includes('FROM devices WHERE id=?') || sql.includes('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      if (sql.includes('FROM recording_files WHERE device_id=?')) return { id: 'file-100', device_id: 'device-1', credential_epoch: 1, session_id: 100, attribute: 0, expected_size: 12, status: 'pending' };
      return null;
    },
    all: async (sql: string) => sql.includes("WHERE f.id=? AND f.status='syncing'") ? [{ id: 'file-100', device_id: 'device-1', session_id: 100, attribute: 0, expected_size: 12, status: 'syncing', transport: 'filesystem_http', resource_version: 1, group_id: 'group-1', ownership_epoch: 1 }] : [],
    run: async (sql: string) => { runs.push(sql); return { changes: 1 }; }, batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 1, batchOffset: 0, files: [{ sessionId: 100, attribute: 0, size: 12 }] } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => ({ fileId: 'file-100', uploadUrl: 'http://192.168.50.20:8787/upload' }), async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); socket.emit('message', Uint8Array.of(11)); await new Promise((resolve) => setImmediate(resolve));
  socket.close(); await new Promise((resolve) => setImmediate(resolve));
  assert.ok(runs.some((sql) => sql.includes("status='pending'") && sql.includes('force_relay=CASE')), 'an interrupted direct upload should become retryable through relay');
});

test('gateway recovers orphaned syncing rows when a fresh process accepts the device', async () => {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1') ? { connection_epoch: 8 } : null,
    all: async (sql: string) => sql.includes("f.device_id=? AND f.status='syncing'") ? [
      { id: 'file-direct', device_id: 'device-1', session_id: 100, attribute: 0, expected_size: 12, status: 'syncing', transport: 'filesystem_http', resource_version: 1 },
      { id: 'file-relay', device_id: 'device-1', session_id: 101, attribute: 0, expected_size: 13, status: 'syncing', transport: 'server_relay', force_relay: 1, resource_version: 1 },
    ] : [],
    run: async (sql: string, params: unknown[] = []) => { runs.push({ sql, params }); return { changes: 1 }; },
    batch: async () => [],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: () => ({ event: { kind: 'heartbeat', charging: false, batteryPercent: 50 } }),
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  assert.equal(runs.filter((entry) => entry.sql.includes("error_code='DEVICE_TRANSFER_PROCESS_RESTARTED'")).length, 2);
  assert.ok(runs.some((entry) => entry.sql.includes("status IN ('pending','failed')") && entry.sql.includes('force_relay=1')), 'remaining pending work should inherit the confirmed relay fallback');
  socket.close();
});

test('gateway transfers verified OTA content only after the device requests an offset', async () => {
  const otaRequests: Array<{ version: string; size: number; crc16: number; force?: boolean }> = [];
  const chunks: Array<{ offset: number; content: Uint8Array }> = [];
  const controls: unknown[] = [];
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 9 };
      if (sql.includes('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', group_id: 'group-1', connection_epoch: 9, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      return null;
    },
    all: async () => [],
    run: async (sql: string, params: unknown[] = []) => { runs.push({ sql, params }); return { changes: sql.includes("SET status='dispatched'") || sql.includes("SET status='running'") || sql.includes('SET status=?') ? 1 : 0 }; },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 0, batchOffset: 0, files: [] } }],
    [12, { event: { kind: 'ota_check', result: 0 } }],
    [13, { event: { kind: 'ota_transfer_request', offset: 0 } }],
    [14, { event: { kind: 'ota_status', result: 0 } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: (input) => { controls.push(input); return Uint8Array.of(9); },
    requestOta: (input) => { otaRequests.push(input); return Uint8Array.of(20); }, createOtaChunk: (input) => { chunks.push(input); return Uint8Array.of(21); }, requestOtaStatus: () => Uint8Array.of(22),
    process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); socket.emit('message', Uint8Array.of(11)); await new Promise((resolve) => setImmediate(resolve));
  const content = Uint8Array.from([1, 2, 3, 4, 5]);
  assert.equal(await gateway.dispatchOta('device-1', 'command-ota', { version: 'v0.5.4-dev', size: content.byteLength, crc16: 0x1234, content, force: true }), true);
  assert.deepEqual(otaRequests, [{ version: 'v0.5.4-dev', size: 5, crc16: 0x1234, force: true }]);
  assert.deepEqual(chunks, []);
  socket.emit('message', Uint8Array.of(12)); socket.emit('message', Uint8Array.of(13)); socket.emit('message', Uint8Array.of(14)); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [{ offset: 0, content }]);
  assert.deepEqual(controls, [{ kind: 'power', action: 'reboot' }]);
  assert.ok(runs.some((entry) => entry.sql.includes('SET status=?') && entry.params[0] === 'succeeded' && entry.params[1] === 'OTA_REBOOT_REQUESTED'));
});
