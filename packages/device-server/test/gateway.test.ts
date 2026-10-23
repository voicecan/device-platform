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

test('gateway accepts duplicate and descending session entries from firmware file lists', async () => {
  const inserted: Array<{ sessionId: number; attribute: number }> = [];
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=?')) return { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      if (sql.startsWith('SELECT * FROM recording_files WHERE device_id=?')) return null;
      if (sql.startsWith('SELECT * FROM recording_files WHERE id=?')) return { id: 'file-x', device_id: 'device-1', session_id: 100, attribute: 0, expected_size: 12, group_id: 'group-1', ownership_epoch: 1, status: 'pending', resource_version: 1 };
      return null;
    },
    all: async () => [],
    run: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO recording_files')) inserted.push({ sessionId: Number(params[3]), attribute: Number(params[4]) });
      return { changes: 1 };
    },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 4, batchOffset: 0, files: [
      { sessionId: 100, attribute: 1, size: 12 },
      { sessionId: 100, attribute: 0, size: 12 },
      { sessionId: 99, attribute: 0, size: 11 },
      { sessionId: 100, attribute: 0, size: 12 },
    ] } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  socket.emit('message', Uint8Array.of(11));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(socket.closes.some((entry) => entry.reason === 'invalid device frame'), false, 'a recoverable list ordering must not close the connection');
  assert.deepEqual(inserted, [
    { sessionId: 99, attribute: 0 },
    { sessionId: 100, attribute: 0 },
    { sessionId: 100, attribute: 1 },
  ]);
  socket.close();
});

test('gateway requests only files after the last known session on reconnect', async () => {
  const fileListStarts: number[] = [];
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=?')) return { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2', initial_scan_completed_at: '2026-01-01T00:00:00.000Z' };
      if (sql.startsWith('SELECT MAX(session_id) AS last')) return { last: 5 };
      return null;
    },
    all: async () => [],
    run: async () => ({ changes: 1 }),
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: (startSessionId) => { fileListStarts.push(startSessionId); return Uint8Array.of(2); }, requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: () => ({ event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }),
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(fileListStarts, [6], 'a known device only scans after its highest session ID');
  assert.equal(socket.closes.length, 0);
  socket.close();
});

test('gateway treats an empty incremental file page as no new files and keeps the connection', async () => {
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=?')) return { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.6.8', initial_scan_completed_at: '2026-01-01T00:00:00.000Z' };
      if (sql.startsWith('SELECT MAX(session_id) AS last')) return { last: 5 };
      if (sql.startsWith('SELECT credential_epoch FROM devices')) return { credential_epoch: 1 };
      if (sql.startsWith('SELECT credential_epoch,sync_round_total,sync_round_completed FROM devices')) return { credential_epoch: 1, sync_round_total: 1, sync_round_completed: 1 };
      if (sql.startsWith('SELECT COUNT(*) AS count FROM recording_files')) return { count: 0 };
      return null;
    },
    all: async () => [],
    run: async () => ({ changes: 1 }),
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: (frame) => { if (frame[0] === 10) return { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.6.8' } }; throw new Error('FILE_LIST_INTEGRITY_FAILED'); },
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.emit('message', Uint8Array.of(11));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(socket.closes.length, 0, 'an empty incremental page must not close the device connection');
  socket.close();
});

test('gateway acknowledges every heartbeat request', async () => {
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')
      ? { connection_epoch: 7 }
      : sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=?')
        ? { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' }
        : null,
    all: async () => [],
    run: async () => ({ changes: 1 }),
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: (frame) => frame[0] === 10
      ? { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }
      : { event: { kind: 'heartbeat', charging: false, batteryPercent: 50 }, response: Uint8Array.of(0) },
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Uint8Array.of(11));
  socket.emit('message', Uint8Array.of(12));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const heartbeatAcks = socket.sent.filter((frame) => frame.byteLength === 1 && frame[0] === 0);
  assert.equal(heartbeatAcks.length, 2, 'every heartbeat request must be acknowledged');
  socket.close();
});

test('gateway keeps heartbeat ACKs ahead of slow inventory processing', async () => {
  let releaseInsert!: () => void;
  const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=?')) return { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' };
      if (sql.startsWith('SELECT * FROM recording_files WHERE device_id=?')) return null;
      if (sql.startsWith('SELECT * FROM recording_files WHERE id=?')) return { id: 'file-x', device_id: 'device-1', session_id: 100, attribute: 0, expected_size: 12, group_id: 'group-1', ownership_epoch: 1, status: 'pending', resource_version: 1 };
      return null;
    },
    all: async () => [],
    run: async (sql: string) => {
      if (sql.startsWith('INSERT INTO recording_files')) await insertGate;
      return { changes: 1 };
    },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 1, batchOffset: 0, files: [{ sessionId: 100, attribute: 0, size: 12 }] } }],
    [12, { event: { kind: 'heartbeat', charging: false, batteryPercent: 50 }, response: Uint8Array.of(0) }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Uint8Array.of(11));
  socket.emit('message', Uint8Array.of(12));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const heartbeatAcks = socket.sent.filter((frame) => frame.byteLength === 1 && frame[0] === 0);
  assert.equal(heartbeatAcks.length, 1, 'a slow inventory page must not delay the heartbeat ACK');
  releaseInsert();
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.close();
});

test('gateway persists device status with matching SQL parameters', async () => {
  let checked = false;
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')
      ? { connection_epoch: 7 }
      : sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=?')
        ? { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' }
        : null,
    all: async () => [],
    run: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO device_status(device_id,source,record_state')) {
        const values = sql.slice(sql.indexOf('VALUES('), sql.indexOf('ON CONFLICT'));
        assert.equal((values.match(/\?/g) ?? []).length, params.length, 'device status SQL placeholders must match its parameters');
        checked = true;
      }
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
      : { event: { kind: 'device_status', status: { recordState: 1, recordMode: 0, microphoneMode: 0, microphoneGainDb: 0, usbState: 0, wifiState: 1, wifiMode: 0, relayState: 0, privacyMode: false, earphoneRecording: false } } },
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Uint8Array.of(11));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(checked, true, 'the device status frame must be persisted');
  assert.equal(socket.closes.some((entry) => entry.reason === 'invalid device frame'), false);
  socket.close();
});

test('gateway persists every device status variant with matching SQL parameters', async () => {
  let checked = 0;
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')
      ? { connection_epoch: 7 }
      : sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=?')
        ? { id: 'device-1', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' }
        : sql.startsWith('SELECT COUNT(*) AS total')
          ? { total: 12, incomplete: 0 }
          : null,
    all: async () => [],
    run: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO device_status')) {
        const values = sql.slice(sql.indexOf('VALUES('), sql.indexOf('ON CONFLICT'));
        assert.equal((values.match(/\?/g) ?? []).length, params.length, sql.slice(0, 80));
        checked += 1;
      }
      return { changes: 1 };
    },
    batch: async (statements: Array<{ sql: string; params?: unknown[] }> = []) => {
      for (const statement of statements) {
        if (statement.sql.includes('INSERT INTO device_status')) {
          const values = statement.sql.slice(statement.sql.indexOf('VALUES('), statement.sql.indexOf('ON CONFLICT'));
          assert.equal((values.match(/\?/g) ?? []).length, (statement.params ?? []).length, statement.sql.slice(0, 80));
          checked += 1;
        }
      }
      return [{ changes: 1 }, { changes: 1 }, { changes: 1 }];
    },
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'device_info', model: 'CAPSO', serialNumber: 'SN-1', hardwareVersion: 'B100', firmwareVersion: 'v0.6.8' } }],
    [12, { event: { kind: 'device_status', status: { recordState: 1, recordMode: 0, microphoneMode: 0, microphoneGainDb: 0, usbState: 0, wifiState: 1, wifiMode: 0, relayState: 0, privacyMode: false, earphoneRecording: false } } }],
    [13, { event: { kind: 'device_storage', storage: { totalKilobytes: 1_000, freeKilobytes: 500, recordingHours: 1 } } }],
    [14, { event: { kind: 'device_battery', battery: { state: 'normal', stateCode: 0, percent: 100, temperatureC: 30, voltageMillivolts: 4_300, workTimeSeconds: 10, accumulatedWorkTimeSeconds: 20 } } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  await new Promise((resolve) => setImmediate(resolve));
  for (const frame of [11, 12, 13, 14]) socket.emit('message', Uint8Array.of(frame));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(checked, 4, 'info, status, storage and battery inserts must all match their parameters');
  assert.equal(socket.closes.some((entry) => entry.reason === 'invalid device frame'), false);
  socket.close();
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

test('gateway prioritizes a newly notified file over an in-flight status query', async () => {
  let inserted = false;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.6.8' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 0, batchOffset: 0, files: [] } }],
    [13, { event: { kind: 'new_file', sessionId: 200, attribute: 0, size: 12 } }],
  ]);
  const file = { id: 'file-new', device_id: 'device-1', credential_epoch: 1, session_id: 200, attribute: 0, expected_size: 12, status: 'pending', revision: 1 };
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=? AND deleted_at IS NULL')) return { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', model: 'CAPSO', hardware_version: 'B100', firmware_version: 'v0.6.8', initial_scan_completed_at: '2026-01-01T00:00:00.000Z' };
      if (sql.startsWith('SELECT info_updated_at FROM device_status')) return { info_updated_at: '2026-01-01T00:00:00.000Z' };
      if (sql.startsWith('SELECT MAX(session_id)')) return { last: null };
      if (sql.startsWith('SELECT credential_epoch,sync_round_total,sync_round_completed FROM devices')) return { credential_epoch: 1, sync_round_total: 0, sync_round_completed: 0 };
      if (sql.startsWith('SELECT COUNT(*) AS count FROM recording_files')) return { count: 0 };
      if (sql.startsWith('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', credential_epoch: 1, claim_status: 'active', model: 'CAPSO', hardware_version: 'B100', firmware_version: 'v0.6.8' };
      if (sql.startsWith('SELECT sn,group_id FROM devices WHERE id=?')) return { sn: 'SN-1', group_id: 'group-1' };
      if (sql.startsWith('SELECT id FROM devices WHERE deleted_at IS NOT NULL')) return null;
      if (sql.startsWith('SELECT * FROM recording_files WHERE device_id=? AND credential_epoch=? AND session_id=? AND attribute=? ORDER BY revision DESC')) return inserted ? file : null;
      if (sql.startsWith('SELECT * FROM recording_files WHERE id=?')) return inserted ? file : null;
      if (sql.startsWith('SELECT * FROM recording_files WHERE device_id=? AND credential_epoch=? AND session_id=? AND attribute=? AND status IN')) return file;
      return null;
    },
    all: async (sql: string) => sql.includes("FROM recording_files WHERE device_id=? AND credential_epoch=?") ? [] : [],
    run: async (sql: string) => { if (sql.startsWith('INSERT INTO recording_files')) inserted = true; return { changes: 1 }; },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async () => ({ fileId: 'file-new', uploadUrl: '' }), async () => undefined, async () => undefined, 1024, () => undefined, { inventoryTimeoutMs: 5, statusQueryTimeoutMs: 35_000, transferPriorityGraceMs: 5 });
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Uint8Array.of(11)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.requestStatus('device-1'), true);
  assert.equal(socket.sent.at(-1)?.[0], 6, 'the status query must be in flight before the new file arrives');
  socket.emit('message', Uint8Array.of(13));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(socket.sent.at(-1)?.[0], 3, 'the new file transfer must start after the short priority grace, not the 35s status timeout');
  socket.close();
});

test('gateway marks a silent device offline before the TCP close event', async () => {
  let online = 1;
  const events: string[] = [];
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1') ? { connection_epoch: 7 }
      : sql.startsWith('SELECT * FROM devices WHERE id=? AND connection_epoch=? AND deleted_at IS NULL') ? { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2' }
        : sql.startsWith('SELECT info_updated_at FROM device_status') ? null
          : sql.startsWith('SELECT * FROM devices WHERE id=?') ? { id: 'device-1', online } : null,
    all: async () => [],
    run: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0,updated_at=? WHERE id=? AND connection_epoch=? AND online=1')) { online = 0; return { changes: 1 }; }
      if (sql.startsWith("UPDATE devices SET claim_status='active',online=1")) { online = 1; return { changes: 1 }; }
      return { changes: 1 };
    },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: () => ({ event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }),
  };
  const gateway = new DeviceGateway(database, core, async (_device, type) => { events.push(type); return 'event'; }, async () => null, async () => undefined, async () => undefined, 1024, () => undefined, { inventoryTimeoutMs: 5, statusQueryTimeoutMs: 5, livenessTimeoutMs: 5 });
  const socket = new TestSocket(); await gateway.attach(socket, 'device-1', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(online, 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(online, 0, 'a silent connection must be marked offline without waiting for TCP close');
  assert.ok(events.includes('device.offline'));
  socket.close();
});

test('gateway skips device info once it is cached for the device', async () => {
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.6.8' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 0, batchOffset: 0, files: [] } }],
  ]);
  const database = {
    get: async (sql: string) => sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1') ? { connection_epoch: 7 }
      : sql.includes('SELECT * FROM devices WHERE id=?') ? { id: 'device-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', model: 'CAPSO', hardware_version: 'B100', firmware_version: 'v0.6.8' }
        : sql.includes('SELECT info_updated_at FROM device_status') ? { info_updated_at: '2026-10-23T16:23:33.593Z' } : null,
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
  socket.emit('message', Uint8Array.of(11)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.requestStatus('device-1'), true);
  assert.deepEqual(socket.sent.map((frame) => frame[0]), [1, 4, 2, 6], 'cached device info must not be requested again before status');
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
    [102, { id: 'file-102', device_id: 'device-1', credential_epoch: 1, session_id: 102, attribute: 0, expected_size: 11, status: 'pending' }],
  ]);
  const database = {
    get: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.startsWith('SELECT sn,group_id FROM devices')) return { sn: 'SN-1', group_id: 'group-1' };
      if (sql.includes('FROM devices WHERE id=?') || sql.includes('SELECT * FROM devices WHERE id=?')) return { id: 'device-1', group_id: 'group-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', firmware_version: 'v0.5.2', initial_scan_completed_at: '2026-01-01T00:00:00.000Z' };
      if (sql.includes('FROM recording_files WHERE device_id=?')) return candidates.get(Number(params.at(-2))) ?? candidates.get(Number(params.at(-1)));
      if (sql.startsWith('SELECT * FROM recording_files WHERE id=?')) return { id: 'file-102', device_id: 'device-1', session_id: 102, attribute: 0, expected_size: 11, resource_version: 1 };
      return null;
    },
    all: async () => [],
    run: async () => ({ changes: 1 }),
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.5.2' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 2, batchOffset: 0, files: [{ sessionId: 100, attribute: 0, size: 12 }, { sessionId: 101, attribute: 0, size: 13 }] } }],
    [12, { event: { kind: 'file_transfer', result: 0, sessionId: 101, size: 13, offset: 0, content: new Uint8Array() } }],
    [13, { event: { kind: 'new_file', sessionId: 102, attribute: 0, size: 11 } }],
    [14, { event: { kind: 'file_transfer', result: 0, sessionId: 102, size: 11, offset: 0, content: new Uint8Array() } }],
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
  assert.deepEqual(requested, [101], 'the newest file is synchronized first');
  socket.emit('message', Uint8Array.of(13));
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Uint8Array.of(12));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(requested, [101, 102], 'a new file notification is inserted at the front of the queue');
  socket.emit('message', Uint8Array.of(14));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(requested, [101, 102, 100], 'older queued files follow the new file');
});

test('gateway reconciles a rebound device with files already synced under its released predecessor', async () => {
  const requested: number[] = [];
  const batches: string[][] = [];
  const fileStarts: number[] = [];
  const database = {
    get: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('UPDATE devices SET online=0,connection_epoch=connection_epoch+1')) return { connection_epoch: 7 };
      if (sql.includes('FROM devices WHERE id=? AND connection_epoch=?')) return { id: 'device-2', group_id: 'group-1', ownership_epoch: 1, connection_epoch: 7, credential_epoch: 1, claim_status: 'reserved', firmware_version: 'v0.6.8', initial_scan_completed_at: null };
      if (sql.startsWith('SELECT sn,group_id FROM devices')) return { sn: 'SN-2', group_id: 'group-1' };
      if (sql.startsWith('SELECT id FROM devices WHERE deleted_at IS NOT NULL')) return { id: 'device-1' };
      if (sql.startsWith("SELECT id FROM recording_files WHERE device_id=? AND session_id=? AND attribute=? AND expected_size=? AND status='synced'")) return { id: 'file-old' };
      if (sql.startsWith('SELECT * FROM recording_files WHERE device_id=? AND credential_epoch=?')) return null;
      if (sql.startsWith('SELECT MAX(session_id) AS last')) return { last: null };
      if (sql.startsWith('SELECT credential_epoch FROM devices')) return { credential_epoch: 1 };
      if (sql.startsWith('SELECT credential_epoch,sync_round_total,sync_round_completed FROM devices')) return { credential_epoch: 1, sync_round_total: 0, sync_round_completed: 0 };
      if (sql.startsWith('SELECT COUNT(*) AS count FROM recording_files')) return { count: 0 };
      return null;
    },
    all: async (sql: string) => sql.startsWith('SELECT id FROM recording_files WHERE device_id=? AND session_id=? AND attribute=?') ? [] : [],
    run: async () => ({ changes: 1 }),
    batch: async (statements: Array<{ sql: string }>) => { batches.push(statements.map((statement) => statement.sql)); return statements.map(() => ({ changes: 1 })); },
  } as unknown as Database;
  const events = new Map<number, ReturnType<GatewayProtocolCore['process']>>([
    [10, { event: { kind: 'bind_confirmed', firmwareVersion: 'v0.6.8' } }],
    [11, { event: { kind: 'file_list', requestStart: 0, totalCount: 1, batchOffset: 0, files: [{ sessionId: 100, attribute: 0, size: 12 }] } }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1),
    requestFileList: (startSessionId) => { fileStarts.push(startSessionId); return Uint8Array.of(2); },
    requestTimeSync: () => Uint8Array.of(4), requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: () => Uint8Array.of(9),
    requestFileTransfer: (input) => { requested.push(input.sessionId); return Uint8Array.of(3); },
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22),
    process: (frame) => events.get(frame[0]!)!,
  };
  const gateway = new DeviceGateway(database, core, async () => 'event', async (_device, file) => ({ fileId: String(file.id), uploadUrl: 'http://192.168.50.20:8787/upload' }), async () => undefined, async () => undefined, 1024);
  const socket = new TestSocket();
  await gateway.attach(socket, 'device-2', Buffer.alloc(32, 7));
  socket.emit('message', Uint8Array.of(10));
  socket.emit('message', Uint8Array.of(11));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(fileStarts, [0], 'a rebind performs a full inventory');
  assert.deepEqual(requested, [], 'an already-synced predecessor file is not requested again');
  assert.ok(batches.some((statements) => statements.some((sql) => sql.startsWith('UPDATE recording_files SET device_id=?'))), 'the synced file identity is moved to the new binding');
  socket.close();
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
