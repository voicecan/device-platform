import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceHttpBaseUrl, resolveDeviceWsUrl, validateDeviceWsUrl } from '../src/device-url.js';

test('device WebSocket URL resolution honors override and configured precedence', () => {
  assert.equal(resolveDeviceWsUrl({ requested: 'ws://192.168.1.25:9000/custom', configured: 'wss://device.example.test/device/v1/ws', requestHost: 'nas.local:8787', advertiseHost: '192.168.1.10', port: 8787 }), 'ws://192.168.1.25:9000/custom');
  assert.equal(resolveDeviceWsUrl({ configured: 'wss://device.example.test/device/v1/ws', requestHost: 'nas.local:8787', advertiseHost: '192.168.1.10', port: 8787 }), 'wss://device.example.test/device/v1/ws');
});

test('device WebSocket URL defaults to request host or detected LAN address', () => {
  assert.equal(resolveDeviceWsUrl({ requestHost: 'nas.local:8787', advertiseHost: '192.168.1.10', port: 8787 }), 'ws://nas.local:8787/device/v1/ws');
  assert.equal(resolveDeviceWsUrl({ requestHost: '192.168.1.10', advertiseHost: '192.168.1.10', port: 8787 }), 'ws://192.168.1.10:8787/device/v1/ws');
  assert.equal(resolveDeviceWsUrl({ requestHost: '127.0.0.1:8787', advertiseHost: '192.168.1.10', port: 8787 }), 'ws://192.168.1.10:8787/device/v1/ws');
  assert.equal(resolveDeviceWsUrl({ advertiseHost: 'fd00::10', port: 8787 }), 'ws://[fd00::10]:8787/device/v1/ws');
});

test('device WebSocket URL rejects non-WebSocket and credential-bearing values', () => {
  assert.throws(() => validateDeviceWsUrl('http://192.168.1.10/device/v1/ws'), /ws:\/\/ or wss:\/\//);
  assert.throws(() => validateDeviceWsUrl('ws://user:secret@192.168.1.10/device/v1/ws'), /must not contain credentials/);
});

test('device upload base follows the device-reachable WebSocket origin', () => {
  assert.equal(deviceHttpBaseUrl('ws://192.168.1.10:8787/device/v1/ws'), 'http://192.168.1.10:8787');
  assert.equal(deviceHttpBaseUrl('wss://device.example.test/device/v1/ws'), 'https://device.example.test');
});
