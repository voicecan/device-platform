import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionErrorCode } from '../src/connection-diagnostics.js';
import { connectionReading, connectionReport } from '../src/connection-reading.js';

test('readings keep observed facts and unknown values without inferring a cause', () => {
  const reading = connectionReading({ wifiConfigured: false, battery: { percent: 10, state: 'low' } }, 0);
  assert.deepEqual(reading, { at: '1970-01-01T00:00:00.000Z', wifiConnected: false, batteryPercent: 10, batteryState: 'low' });
  assert.equal(connectionReading({ battery: { percent: NaN, state: 'unrecognized' } }, 0).batteryPercent, null);
  assert.equal(connectionReading({}, 0).wifiConnected, null);
});

test('diagnostic export explicitly selects observations and never copies credentials or arbitrary errors', () => {
  const status = { wifiConfigured: true, battery: { percent: 100, state: 'normal' }, password: 'fixture-secret', token: 'fixture-token' };
  const event = { stage: 'configure_wifi' as const, state: 'failed' as const, at: 0, code: 'WIFI_CONFIGURATION_REJECTED', password: 'fixture-secret' };
  const report = JSON.stringify(connectionReport('fixture-device', 'v0.6.5', [event, { ...event, code: 'fixture-secret' }], [connectionReading(status, 0)]));
  assert.match(report, /WIFI_CONFIGURATION_REJECTED/);
  assert.match(report, /batteryPercent/);
  assert.doesNotMatch(report, /fixture-secret|fixture-token|password|token/);
  assert.match(report, /CONNECTION_FAILED/);
});

test('export preserves safe normalized browser Bluetooth error codes', () => {
  for (const name of ['NotFoundError', 'NotSupportedError']) {
    const error = new Error('untrusted details'); error.name = name;
    const code = connectionErrorCode(error);
    const report = connectionReport('fixture-device', null, [{ stage: 'select_device', state: 'failed', at: 0, code }], []);
    assert.equal(report.events[0]?.code, code);
  }
});
