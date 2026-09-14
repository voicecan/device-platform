import assert from 'node:assert/strict';
import test from 'node:test';
import { hasActiveNativeExecutor, visibleNativeHandoffs } from '../src/native-handoff-state.js';

const future = '2099-01-01T00:00:00.000Z';

test('cancelled executor pointers are not treated as active or visible', () => {
  const snapshot = {
    execution_epoch: 3,
    active_handoff_id: 'cancelled',
    handoffs: [{ id: 'cancelled', status: 'cancelled', client_fingerprint: 'abc123', lease_expires_at: null, expires_at: future }],
  };

  assert.equal(hasActiveNativeExecutor(snapshot), false);
  assert.deepEqual(visibleNativeHandoffs(snapshot, Date.now()), []);
});

test('approved executor remains active while exchanged requests stay visible', () => {
  const snapshot = {
    execution_epoch: 4,
    active_handoff_id: 'approved',
    handoffs: [
      { id: 'approved', status: 'approved', client_fingerprint: 'approved-code', lease_expires_at: future, expires_at: future },
      { id: 'waiting', status: 'exchanged', client_fingerprint: 'waiting-code', lease_expires_at: null, expires_at: future },
    ],
  };

  assert.equal(hasActiveNativeExecutor(snapshot), true);
  assert.deepEqual(visibleNativeHandoffs(snapshot, Date.now()).map(item => item.id), ['approved', 'waiting']);
});

test('an expired approval requires reauthorization and is no longer active', () => {
  const snapshot = {
    execution_epoch: 5,
    active_handoff_id: 'expired-lease',
    handoffs: [{ id: 'expired-lease', status: 'approved', client_fingerprint: 'renew-code', lease_expires_at: '2020-01-01T00:00:00.000Z', expires_at: future }],
  };

  assert.equal(hasActiveNativeExecutor(snapshot, Date.now()), false);
  assert.deepEqual(visibleNativeHandoffs(snapshot, Date.now()).map(item => item.id), ['expired-lease']);
});


test('expired original task stays visible for same-credential recovery', () => {
  const snapshot = { execution_epoch: 2, active_handoff_id: 'original', handoffs: [
    { id: 'original', status: 'approved', client_fingerprint: 'code', lease_expires_at: future, expires_at: '2020-01-01T00:00:00.000Z', provisioning_stage: 'failed', failure_code: 'PROVISIONING_EXPIRED' },
    { id: 'unused', status: 'exchanged', client_fingerprint: 'other', lease_expires_at: null, expires_at: '2020-01-01T00:00:00.000Z' },
  ] };
  assert.equal(hasActiveNativeExecutor(snapshot), false);
  assert.deepEqual(visibleNativeHandoffs(snapshot, Date.now()).map(item => item.id), ['original']);
});
