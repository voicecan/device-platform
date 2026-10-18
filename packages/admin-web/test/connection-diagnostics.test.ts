import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionErrorCode, connectionAdvice, advanceConnection, connectionChecks } from '../src/connection-diagnostics.js';
test('diagnostics retain only an approved code, never arbitrary credential-bearing error text', () => {
  assert.equal(connectionErrorCode(new Error('WIFI_CONFIGURATION_REJECTED: secret-input')), 'WIFI_CONFIGURATION_REJECTED');
  assert.equal(connectionErrorCode(new Error('secret-input')), 'CONNECTION_FAILED');
  assert.doesNotMatch(connectionAdvice('WIFI_CONFIGURATION_REJECTED'), /incorrect password/);
  assert.match(connectionAdvice('WIFI_CONFIGURATION_REJECTED'), /A connection was not confirmed/);
  assert.match(connectionAdvice('WIFI_CONFIGURATION_REJECTED'), /does not identify a wrong password or an incompatible mixed-security network/);
  assert.doesNotMatch(connectionAdvice('WIFI_CONFIGURATION_REJECTED'), /not WPA|not legacy WPA/);
});
test('progress preserves completed steps as the next step begins', () => {
  const events = advanceConnection(advanceConnection([], 'backup', 1), 'select_device', 2);
  assert.equal(events[0]?.state, 'done'); assert.equal(events[1]?.state, 'running');
});

test('finishing a Wi-Fi command does not prove a connection; server failure preserves the positive Wi-Fi check', () => {
  const at = 0;
  assert.deepEqual(connectionChecks([]), { wifi: 'waiting', server: 'waiting' });
  assert.deepEqual(connectionChecks([{ stage: 'configure_wifi', state: 'done', at }, { stage: 'wait_wifi', state: 'done', at }, { stage: 'report_status', state: 'running', at }]), { wifi: 'checking', server: 'waiting' });
  assert.deepEqual(connectionChecks([{ stage: 'configure_wifi', state: 'failed', at }]), { wifi: 'failed', server: 'waiting' });
  const observed = [{ stage: 'configure_wifi', state: 'done', at }, { stage: 'wifi_connected', state: 'done', at }, { stage: 'wait_server', state: 'failed', at }] as const;
  assert.deepEqual(connectionChecks([...observed]), { wifi: 'connected', server: 'failed' });
  assert.deepEqual(connectionChecks([...observed, { stage: 'configure_wifi', state: 'running', at: 1 }]), { wifi: 'checking', server: 'waiting' });
  assert.deepEqual(connectionChecks([...observed.slice(0, 2), { stage: 'server_connected', state: 'done', at }]), { wifi: 'connected', server: 'connected' });
});
