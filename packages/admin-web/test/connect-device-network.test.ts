import assert from 'node:assert/strict';
import test from 'node:test';
import { connectDeviceNetwork } from '../src/connect-device-network.js';

function fixture(states: boolean[], reject = false) {
  const calls: string[] = [];
  const state = () => ({ wifiConfigured: states.length > 1 ? states.shift()! : states[0]! });
  return { calls, input: {
    session: {
      async configureWifi() { calls.push('wifi'); if (reject) throw new Error('WIFI_CONFIGURATION_REJECTED'); return state(); },
      async refresh() { calls.push('read'); return state(); },
      async configureServer() { calls.push('server'); },
    },
    wifi: { ssid: 'fixture', password: '', encryption: 'open' as const },
    serverUrl: 'ws://192.168.1.2:8788/device/v1/ws',
    async onStatus() { calls.push('report'); },
    onWifiConnected() { calls.push('clear-password'); },
    async pause() {},
  } };
}
test('network setup waits for a positive device reading before writing the server', async () => {
  const { calls, input } = fixture([false, false, true]);
  await connectDeviceNetwork(input);
  assert.deepEqual(calls, ['wifi', 'read', 'read', 'report', 'clear-password', 'server']);
});
test('Wi-Fi rejection never changes the server or clears credentials needed for retry', async () => {
  const { calls, input } = fixture([false], true);
  await assert.rejects(connectDeviceNetwork(input), /WIFI_CONFIGURATION_REJECTED/);
  assert.deepEqual(calls, ['wifi', 'read', 'report']);
});
test('accepted Wi-Fi settings without a connection stop before server configuration', async () => {
  const { calls, input } = fixture([false]);
  await assert.rejects(connectDeviceNetwork(input), /DEVICE_WIFI_NOT_CONNECTED/);
  assert.equal(calls.filter((value) => value === 'read').length, 15);
  assert.equal(calls.includes('server'), false);
  assert.equal(calls.includes('clear-password'), false);
});
test('invalid server URLs are rejected before changing Wi-Fi', async () => {
  const { calls, input } = fixture([true]); input.serverUrl = 'https://example.test';
  await assert.rejects(connectDeviceNetwork(input), /INVALID_DEVICE_SERVER_URL/);
  assert.deepEqual(calls, []);
});

test('server acceptance is not completion until the device is observed online', async () => {
  const { input } = fixture([true]); const stages: string[] = [];
  await assert.rejects(connectDeviceNetwork({ ...input, onStage: (stage) => stages.push(stage), confirmOnline: async () => false }), /SERVER_ONLINE_TIMEOUT/);
  assert.equal(stages.at(-1), 'wait_server');
});
test('Wi-Fi rejection preserves its actual failing stage', async () => {
  const { input } = fixture([false], true); const stages: string[] = [];
  await assert.rejects(connectDeviceNetwork({ ...input, onStage: (stage) => stages.push(stage) }), /WIFI_CONFIGURATION_REJECTED/);
  assert.deepEqual(stages, ['configure_wifi']);
});

test('a device is never configured to call its own loopback when the computer has no LAN', async () => {
  const { input, calls } = fixture([true]); input.serverUrl = 'ws://127.0.0.1:8788/device/v1/ws';
  await assert.rejects(connectDeviceNetwork(input), /INVALID_DEVICE_SERVER_URL/); assert.deepEqual(calls, []);
});

test('server failure preserves retry credentials until the full connection completes', async () => {
  let cleared = false;
  const input = {
    session: { configureWifi: async () => ({ wifiConfigured: true }), refresh: async () => ({ wifiConfigured: true }), configureServer: async () => {} },
    wifi: { ssid: 'fixture', password: 'fixture-only', encryption: 'wpa2' as const },
    serverUrl: 'ws://192.168.1.10:8788/device/v1/ws', onStatus: async () => {},
    onComplete: () => { cleared = true; }, pause: async () => {},
  };
  await assert.rejects(connectDeviceNetwork({ ...input, confirmOnline: async () => false }), /SERVER_ONLINE_TIMEOUT/);
  assert.equal(cleared, false);
  await assert.rejects(connectDeviceNetwork({ ...input, session: { ...input.session, configureServer: async () => { throw new Error('DEVICE_DISCONNECTED'); } } }), /DEVICE_DISCONNECTED/);
  assert.equal(cleared, false);
  await connectDeviceNetwork({ ...input, confirmOnline: async () => true });
  assert.equal(cleared, true);
});

test('verification events come only after positive device and server observations', async () => {
  const { input } = fixture([false, true]);
  const stages: string[] = [];
  await connectDeviceNetwork({ ...input, onStage: (stage) => stages.push(stage), confirmOnline: async () => true });
  assert.equal(stages.indexOf('wifi_connected') > stages.indexOf('report_status'), true);
  assert.equal(stages.indexOf('server_connected') > stages.indexOf('wait_server'), true);
  const timeoutStages: string[] = [];
  await assert.rejects(connectDeviceNetwork({ ...input, onStage: (stage) => timeoutStages.push(stage), confirmOnline: async () => false }), /SERVER_ONLINE_TIMEOUT/);
  assert.equal(timeoutStages.includes('server_connected'), false);
});

test('an existing device network can finish setup without rewriting Wi-Fi credentials', async () => {
  const { input, calls } = fixture([true]);
  let completed = false;
  await connectDeviceNetwork({ ...input, wifi: undefined, confirmOnline: async () => true, onComplete: () => { completed = true; } });
  assert.equal(calls.includes('wifi'), false);
  assert.equal(calls.includes('read'), true);
  assert.equal(calls.includes('server'), true);
  assert.equal(completed, true);
});
test('rejected settings followed by a fresh connected reading offer the existing network, without silently accepting the requested settings', async () => {
  const { input, calls } = fixture([true], true);
  let reported = false;
  await assert.rejects(connectDeviceNetwork({ ...input, onStatus: async (status) => { reported = status.wifiConfigured; } }), /WIFI_SETTINGS_REJECTED_NETWORK_CONNECTED/);
  assert.equal(reported, true);
  assert.equal(calls.includes('server'), false);
  assert.equal(calls.includes('clear-password'), false);
});
test('checking the existing network cannot bypass a disconnected device or unconfirmed server', async () => {
  const disconnected = fixture([false]);
  await assert.rejects(connectDeviceNetwork({ ...disconnected.input, wifi: undefined }), /DEVICE_WIFI_NOT_CONNECTED/);
  assert.equal(disconnected.calls.includes('server'), false);
  assert.equal(disconnected.calls.includes('wifi'), false);
  const connected = fixture([true]);
  let completed = false;
  await assert.rejects(connectDeviceNetwork({ ...connected.input, wifi: undefined, confirmOnline: async () => false, onComplete: () => { completed = true; } }), /SERVER_ONLINE_TIMEOUT/);
  assert.equal(completed, false);
});
test('authentication or transport failure is never treated as an existing Wi-Fi connection', async () => {
  const { input, calls } = fixture([true]);
  await assert.rejects(connectDeviceNetwork({ ...input, session: { ...input.session, configureWifi: async () => { throw new Error('AUTHENTICATION_FAILED'); } } }), /AUTHENTICATION_FAILED/);
  assert.equal(calls.includes('read'), false);
  assert.equal(calls.includes('server'), false);
});
