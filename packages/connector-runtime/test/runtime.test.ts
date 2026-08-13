import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { DeviceEvent, RecordingFile } from '@voicecan/contracts';
import { ConnectorRuntime, FileDeliveryLedger, SqliteConnectorStore, reconcileRecordings } from '../src/index.js';

const event: DeviceEvent = { id: 'event-1', type: 'file.synced', api_version: '2026-08-01', created_at: '2026-08-04T00:00:00.000Z', data: { file_id: 'file-1' } };

test('successful targets are skipped while only failed targets retry', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'voicecan-connectors-'));
  let stableCalls = 0;
  let flakyCalls = 0;
  const runtime = new ConnectorRuntime({
    ledger: new FileDeliveryLedger(directory),
    targets: [
      { id: 'stable', deliver: async () => { stableCalls += 1; } },
      { id: 'flaky', deliver: async () => { flakyCalls += 1; if (flakyCalls === 1) throw new Error('temporary failure'); } },
    ],
  });
  const first = await runtime.dispatch(event);
  assert.deepEqual(first.delivered, ['stable']);
  assert.deepEqual(first.failed.map((item) => item.targetId), ['flaky']);
  const second = await runtime.dispatch(event);
  assert.deepEqual(second.skipped, ['stable']);
  assert.deepEqual(second.delivered, ['flaky']);
  assert.equal(stableCalls, 1);
  assert.equal(flakyCalls, 2);
});

test('concurrent duplicate delivery is coalesced and event ID collisions fail closed', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'voicecan-connectors-'));
  let calls = 0;
  const runtime = new ConnectorRuntime({ ledger: new FileDeliveryLedger(directory), targets: [{ id: 'target', deliver: async () => { calls += 1; } }] });
  await Promise.all([runtime.dispatch(event), runtime.dispatch(event)]);
  assert.equal(calls, 1);
  await assert.rejects(runtime.dispatch({ ...event, type: 'device.online' }), /EVENT_ID_COLLISION/);
});

test('SQLite connector store persists inbox collisions, tombstones, delivery state, outbox and metrics', async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'voicecan-connector-sqlite-'));
  const store = new SqliteConnectorStore(join(directory, 'runtime.sqlite'));
  context.after(() => store.close());

  assert.equal(await store.claimEvent({ id: 'event-1', type: 'file.synced', recordingId: 'recording-1', payload: event }), 'claimed');
  await store.completeEvent('event-1');
  assert.equal(await store.claimEvent({ id: 'event-1', type: 'file.synced', recordingId: 'recording-1', payload: event }), 'duplicate');
  await assert.rejects(store.claimEvent({ id: 'event-1', type: 'device.online', payload: { ...event, type: 'device.online' } }), /EVENT_ID_COLLISION/);

  await store.addTombstone('recording-deleted', 'recording_deleted', 'delete-event');
  assert.equal(await store.claimEvent({ id: 'late-event', type: 'file.synced', recordingId: 'recording-deleted', payload: { late: true } }), 'tombstoned');

  const runtime = new ConnectorRuntime({ ledger: store, targets: [{ id: 'sqlite-target', deliver: async () => ({ reference: 'saved' }) }] });
  assert.deepEqual((await runtime.dispatch({ ...event, id: 'delivery-event' })).delivered, ['sqlite-target']);
  assert.deepEqual((await runtime.dispatch({ ...event, id: 'delivery-event' })).skipped, ['sqlite-target']);

  await store.enqueueOutbox({ topic: 'result.ready', aggregateId: 'recording-1', idempotencyKey: 'result:recording-1:1', payload: { ok: true } });
  await store.enqueueOutbox({ topic: 'result.ready', aggregateId: 'recording-1', idempotencyKey: 'result:recording-1:1', payload: { ok: true } });
  const pending = await store.pendingOutbox();
  assert.equal(pending.length, 1);
  await store.completeOutbox(pending[0]!.id);
  await store.metric('events.completed');
  assert.equal((await store.metrics())['events.completed'], 1);
});

test('recording reconciliation removes unauthorized data only after a complete listing', async () => {
  const recordings = [{ id: 'recording-1' }, { id: 'recording-2' }] as RecordingFile[];
  const accepted: string[] = [];
  const removed: string[] = [];
  const result = await reconcileRecordings({
    source: { list: async function* () { yield* recordings; } },
    knownRecordingIds: async () => new Set(['recording-1', 'recording-old']),
    accept: async (recording) => { accepted.push(recording.id); return recording.id === 'recording-2'; },
    authorizationLost: async (recordingId) => { removed.push(recordingId); },
  });
  assert.deepEqual(result, { scanned: 2, accepted: 1, removed: 1, failed: 0 });
  assert.deepEqual(accepted, ['recording-1', 'recording-2']);
  assert.deepEqual(removed, ['recording-old']);
});
