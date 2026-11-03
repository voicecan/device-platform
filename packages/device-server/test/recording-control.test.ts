import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayEvent, GatewayProtocolCore } from '@voicecan/device-core';
import type { Database } from '../src/database.js';
import { DeviceGateway, parseDeviceControl } from '../src/gateway.js';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

test('recording API accepts semantic operations and rejects invalid mode configuration', () => {
  for (const action of ['start', 'pause', 'resume', 'stop', 'highlight', 'preserve']) assert.deepEqual(parseDeviceControl({ kind: 'recording', action }), { kind: 'recording', action });
  const mode = { kind: 'recording_mode', mode: 'lookback', microphoneMode: 2, microphoneGainDb: 31 };
  assert.deepEqual(parseDeviceControl(mode), { ...mode, lookbackDurationIndex: 0 });
  assert.deepEqual(parseDeviceControl({ ...mode, microphoneMode: 3, lookbackDurationIndex: 3 }), { ...mode, microphoneMode: 3, lookbackDurationIndex: 3 });
  assert.equal(parseDeviceControl({ ...mode, lookbackSeconds: 3 }), null);
  for (const invalid of [{ action: 'erase' }, { action: null }, { action: ['start'] }]) assert.equal(parseDeviceControl({ kind: 'recording', ...invalid }), null);
  for (const invalid of [{ microphoneMode: '2' }, { microphoneMode: 4 }, { microphoneGainDb: -1 }, { microphoneGainDb: 32 }, { microphoneGainDb: 1.5 }, { lookbackDurationIndex: null }, { lookbackDurationIndex: 4 }, { mode: 'smart_capture', lookbackDurationIndex: 1 }]) assert.equal(parseDeviceControl({ ...mode, ...invalid }), null);
});

test('recording HTTP controls keep authorization, idempotency and command polling contracts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voicecan-recording-control-'));
  const config = await loadConfig({ VOICECAN_DATA_DIR: directory, VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8787', VOICECAN_SIMULATOR: 'true', VOICECAN_LOG_LEVEL: 'silent' });
  migrate(config);
  const app = await buildServer(config);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: (await readFile(join(directory, 'setup-token'), 'utf8')).trim(), username: 'admin', password: 'recording test correct horse password' } });
  assert.equal(setup.statusCode, 201, setup.body);
  const groupId = setup.json().data.group_id;
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'recording test correct horse password' } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token };
  const device = await app.inject({ method: 'POST', url: '/api/v1/simulator/devices', headers, payload: { sn: 'REC-CARD-01', manufacturer: 'Voicecan', group_id: groupId } });
  assert.equal(device.statusCode, 201, device.body);
  const url = `/api/v1/devices/${device.json().data.device.id}/control`;
  const requests: unknown[] = [];
  t.mock.method(DeviceGateway.prototype, 'dispatchControl', async (_deviceId: string, _commandId: string, control: unknown) => { requests.push(control); return true; });
  const control = { kind: 'recording', action: 'start' };
  const commandHeaders = { ...headers, 'idempotency-key': 'recording-start' };
  const first = await app.inject({ method: 'POST', url, headers: commandHeaders, payload: { control, reason: 'Recording card test' } });
  assert.equal(first.statusCode, 202, first.body);
  const duplicate = await app.inject({ method: 'POST', url, headers: commandHeaders, payload: { control, reason: 'Recording card retry' } });
  assert.equal(duplicate.json().data.id, first.json().data.id);
  assert.equal(requests.length, 1);
  const polled = await app.inject({ method: 'GET', url: `/api/v1/commands/${first.json().data.id}`, headers });
  assert.equal(polled.statusCode, 200, polled.body);
  assert.equal(polled.json().data.type, 'device.recording');
  assert.deepEqual(polled.json().data.control, control);
  const conflict = await app.inject({ method: 'POST', url, headers: commandHeaders, payload: { control: { kind: 'recording', action: 'stop' }, reason: 'Different operation' } });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const mode = { kind: 'recording_mode', mode: 'lookback', microphoneMode: 2, microphoneGainDb: 17 };
  const modeReply = await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'recording-mode' }, payload: { control: mode, reason: 'Recording card mode test' } });
  assert.equal(modeReply.statusCode, 202, modeReply.body);
  assert.deepEqual(modeReply.json().data.control, { ...mode, lookbackDurationIndex: 0 });
  const invalid = await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'invalid-recording-mode' }, payload: { control: { ...mode, microphoneGainDb: 32 }, reason: 'Invalid mode' } });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(invalid.json().code, 'INVALID_DEVICE_CONTROL');
  const unauthenticated = await app.inject({ method: 'POST', url, payload: { control, reason: 'No authorization' } });
  assert.notEqual(unauthenticated.statusCode, 202);
  assert.equal(requests.length, 2);
});

class Socket extends EventEmitter {
  sent: Uint8Array[] = [];
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void { this.emit('close'); }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('recording gateway confirms commands, retains session IDs in events, and reads back state after unsolicited replies', async () => {
  const device = { id: 'dev-1', group_id: 'group-1', connection_epoch: 7, credential_epoch: 1, claim_status: 'active', model: 'CAPSO', hardware_version: 'B100', firmware_version: 'v0.5.3' };
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const controls: unknown[] = [];
  const database = {
    get: async (sql: string) => {
      if (sql.startsWith('UPDATE devices SET online=0')) return { connection_epoch: 7 };
      if (sql.includes('SELECT info_updated_at')) return { info_updated_at: '2026-11-02T00:00:00Z' };
      if (sql.includes('SELECT * FROM devices')) return device;
      if (sql.includes('SELECT * FROM commands')) return { id: 'cmd-1', device_id: 'dev-1', kind: 'device.recording', status: 'succeeded' };
      return null;
    },
    all: async () => [],
    run: async (sql: string, params: unknown[] = []) => { runs.push({ sql, params }); return { changes: 1 }; },
    batch: async () => [{ changes: 1 }, { changes: 1 }, { changes: 1 }],
  } as unknown as Database;
  const status: Extract<GatewayEvent, { kind: 'device_status' }> = { kind: 'device_status', status: { recordState: 1, recordMode: 0, microphoneMode: 2, microphoneGainDb: 17, usbState: 0, wifiState: 1, wifiMode: 0, relayState: 0, privacyMode: false, earphoneRecording: false } };
  const events = new Map<number, GatewayEvent>([
    [10, { kind: 'bind_confirmed', firmwareVersion: 'v0.5.3' }],
    [11, { kind: 'file_list', requestStart: 0, totalCount: 0, batchOffset: 0, files: [] }],
    [12, { kind: 'device_command_result', command: 'recording', result: 0, sessionId: 0 }],
    [13, status],
    [14, { kind: 'device_command_result', command: 'recording', result: 5 }],
    [15, { kind: 'device_command_result', command: 'recording', result: 0, sessionId: 42, action: 'stop' }],
  ]);
  const core: GatewayProtocolCore = {
    createBindRequest: () => Uint8Array.of(1), requestFileList: () => Uint8Array.of(2), requestFileTransfer: () => Uint8Array.of(3), requestTimeSync: () => Uint8Array.of(4),
    requestDeviceInfo: () => Uint8Array.of(5), requestDeviceStatus: () => Uint8Array.of(6), requestDeviceStorage: () => Uint8Array.of(7), requestDeviceBattery: () => Uint8Array.of(8), requestDeviceControl: (control) => { controls.push(control); return Uint8Array.of(9); },
    requestOta: () => Uint8Array.of(20), createOtaChunk: () => Uint8Array.of(21), requestOtaStatus: () => Uint8Array.of(22), process: (frame) => ({ event: events.get(frame[0]!)! }),
  };
  const gateway = new DeviceGateway(database, core, async (_device, kind, data) => { emitted.push({ kind, data }); return 'event'; }, async () => null, async () => undefined, async () => undefined, 1024);
  const socket = new Socket();
  try {
    await gateway.attach(socket, 'dev-1', Buffer.alloc(32, 7));
    socket.emit('message', Uint8Array.of(10)); socket.emit('message', Uint8Array.of(11)); await flush();
    assert.equal(await gateway.dispatchControl('dev-1', 'cmd-1', { kind: 'recording', action: 'start' }), true); await flush();
    assert.deepEqual(controls, [{ kind: 'recording', action: 'start' }]);
    socket.emit('message', Uint8Array.of(15)); await flush();
    assert.ok(!runs.some(({ sql }) => sql.includes('UPDATE commands SET status=?')), 'a physical stop cannot acknowledge a pending start');
    socket.emit('message', Uint8Array.of(12)); await flush();
    assert.ok(emitted.some((event) => event.kind === 'command.succeeded' && event.data.session_id === 0 && event.data.device_result === 0));
    assert.equal(socket.sent.at(-1)?.[0], 6, 'acknowledgement triggers a fresh status query');
    assert.ok(!runs.some(({ sql }) => sql.startsWith('INSERT INTO device_status')), 'a control result cannot invent recording state');
    socket.emit('message', Uint8Array.of(13)); await flush();
    assert.ok(runs.some(({ sql }) => sql.startsWith('INSERT INTO device_status')));
    const completed = runs.filter(({ sql }) => sql.includes('UPDATE commands SET status=?')).length;
    socket.emit('message', Uint8Array.of(12)); await flush();
    assert.equal(socket.sent.at(-1)?.[0], 6, 'a physical-device operation also triggers status readback');
    assert.equal(runs.filter(({ sql }) => sql.includes('UPDATE commands SET status=?')).length, completed, 'unsolicited replies do not complete an absent command');
    socket.emit('message', Uint8Array.of(13)); await flush();
    assert.equal(await gateway.dispatchControl('dev-1', 'cmd-2', { kind: 'recording', action: 'highlight' }), true); await flush();
    socket.emit('message', Uint8Array.of(14)); await flush();
    assert.ok(runs.some(({ sql, params }) => sql.includes('UPDATE commands SET status=?') && params[0] === 'failed' && params[2] === 'DEVICE_RESULT_05'));
  } finally { socket.close(); }
});
