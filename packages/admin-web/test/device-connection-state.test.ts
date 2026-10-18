import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceConnectionState, recordingSyncCounts, currentDeviceOptions } from '../src/device-connection-state.js';

test('Bluetooth connection does not claim the server is online or allow recording sync', () => {
  const state = deviceConnectionState(false, true, 1);
  assert.equal(state.server, 'offline');
  assert.equal(state.bluetooth, 'connected');
  assert.equal(state.wifi, 'connected');
  assert.equal(state.canControl, true);
  assert.equal(state.canSync, false);
});

test('unobserved Wi-Fi and unloaded server state stay unknown', () => {
  const state = deviceConnectionState(undefined, false, null);
  assert.equal(state.server, 'unknown');
  assert.equal(state.wifi, 'unknown');
  assert.equal(state.canControl, false);
  assert.equal(deviceConnectionState(false, false, undefined).wifi, 'unknown');
  assert.equal(deviceConnectionState(false, false, 0).wifi, 'disconnected');
});

test('server connection alone permits remote controls and synchronization', () => {
  const state = deviceConnectionState(true, false, null);
  assert.equal(state.server, 'online');
  assert.equal(state.canControl, true);
  assert.equal(state.canSync, true);
});

test('pending recordings never inflate the actively syncing count', () => {
  assert.deepEqual(recordingSyncCounts({ pending: 51, syncing: 0, synced: 0, failed: 0 }), { pending: 51, syncing: 0, synced: 0, failed: 0 });
  assert.deepEqual(recordingSyncCounts({ pending: 2, syncing: 1, synced: 3, failed: 1 }), { pending: 2, syncing: 1, synced: 3, failed: 1 });
});


test('selected device picker uses the latest detail snapshot instead of a stale list badge', () => {
  const stale = [{ id: 'selected', online: false }, { id: 'other', online: false }];
  assert.deepEqual(currentDeviceOptions(stale, { id: 'selected', online: true }), [{ id: 'selected', online: true }, { id: 'other', online: false }]);
  assert.equal(stale[0]?.online, false);
  assert.deepEqual(currentDeviceOptions(stale, undefined), stale);
  assert.deepEqual(currentDeviceOptions([], { id: 'selected', online: true }), [{ id: 'selected', online: true }]);
});
