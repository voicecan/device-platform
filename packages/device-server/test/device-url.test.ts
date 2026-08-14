import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceHttpBaseUrl, publicRequestDeviceWsUrl, resolveDeviceWsUrl, validateDeviceWsUrl } from '../src/device-url.js';

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

test('current public IP becomes a protocol-matched device WebSocket candidate', () => {
  assert.equal(publicRequestDeviceWsUrl({ requestHost: '8.8.8.8', secure: false }), 'ws://8.8.8.8/device/v1/ws');
  assert.equal(publicRequestDeviceWsUrl({ requestHost: '8.8.4.4:9443', secure: true }), 'wss://8.8.4.4:9443/device/v1/ws');
  assert.equal(publicRequestDeviceWsUrl({ requestHost: '[2606:4700:4700::1111]', secure: true }), 'wss://[2606:4700:4700::1111]/device/v1/ws');
});

test('private, shared, loopback, documentation, and hostname request addresses are not preferred', () => {
  for (const requestHost of ['192.168.1.20:8787', '10.0.0.8', '172.20.1.5', '100.64.0.8', '127.0.0.1', '[fd00::8]', '203.0.113.8', 'device.example.test']) {
    assert.equal(publicRequestDeviceWsUrl({ requestHost, secure: false }), undefined, requestHost);
  }
});

test('device WebSocket URL rejects non-WebSocket and credential-bearing values', () => {
  assert.throws(() => validateDeviceWsUrl('http://192.168.1.10/device/v1/ws'), /ws:\/\/ or wss:\/\//);
  assert.throws(() => validateDeviceWsUrl('ws://user:secret@192.168.1.10/device/v1/ws'), /must not contain credentials/);
});

test('device upload base follows the device-reachable WebSocket origin', () => {
  assert.equal(deviceHttpBaseUrl('ws://192.168.1.10:8787/device/v1/ws'), 'http://192.168.1.10:8787');
  assert.equal(deviceHttpBaseUrl('wss://device.example.test/device/v1/ws'), 'https://device.example.test');
});
