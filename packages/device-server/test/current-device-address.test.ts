import assert from 'node:assert/strict';
import test from 'node:test';
import { currentDeviceAdvertiseHosts } from '../src/config.js';
test('automatic device address follows a network change and drops the old LAN', () => {
  assert.deepEqual(currentDeviceAdvertiseHosts({ deviceAdvertiseHost: '192.168.31.204', deviceAdvertiseHostConfigured: false }, ['172.20.10.2']), ['172.20.10.2']);
});
test('an explicitly configured device address remains authoritative', () => {
  assert.deepEqual(currentDeviceAdvertiseHosts({ deviceAdvertiseHost: 'device.example.test', deviceAdvertiseHostConfigured: true }, ['172.20.10.2']), ['device.example.test', '172.20.10.2']);
});
test('no network does not reuse a disconnected interface', () => {
  assert.deepEqual(currentDeviceAdvertiseHosts({ deviceAdvertiseHost: '192.168.31.204', deviceAdvertiseHostConfigured: false }, []), []);
});
