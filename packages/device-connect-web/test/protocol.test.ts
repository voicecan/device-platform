import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeConnectCallback, encodeConnectCallback } from '../src/protocol.js';
import type { DeviceConnectCallback } from '../src/protocol.js';

test('connector callback round-trips only the non-secret completion envelope', () => {
  const callback: DeviceConnectCallback = {
    version: 1,
    sessionId: 'browser-session',
    state: 'one-time-state',
    result: 'completed',
    provisioningSessionId: 'provision-123',
    deviceId: 'device-456',
    completedAt: Date.now(),
  };
  const encoded = encodeConnectCallback(callback);
  assert.doesNotMatch(encoded, /provision|device|state/);
  assert.deepEqual(decodeConnectCallback(encoded), callback);
  assert.equal(decodeConnectCallback('not-valid-base64'), undefined);
});

test('connector callback rejects malformed optional identifiers', () => {
  const malformed = Buffer.from(JSON.stringify({ version: 1, sessionId: 's', state: 'x', result: 'completed', provisioningSessionId: 42, completedAt: Date.now() })).toString('base64url');
  assert.equal(decodeConnectCallback(malformed), undefined);
});

test('connector passes browser-valid lowercase Bluetooth UUIDs', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /serviceUuid: '00001a10-0000-1000-8000-00805f9b34fb'/);
  assert.match(source, /writeCharacteristicUuid: '00002dd1-0000-1000-8000-00805f9b34fb'/);
  assert.match(source, /notifyCharacteristicUuid: '00002dd0-0000-1000-8000-00805f9b34fb'/);
  assert.match(source, /namePrefix: input\.bleNamePrefix \?\? 'CAPSO-'/);
  assert.doesNotMatch(source, /0000[12][A-F0-9]+-0000-1000-8000-00805f9b34fb/);
});

test('bound maintenance exposes reviewed network operations without persisting credentials', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /configureWifi: async \(configuration\)/);
  assert.match(source, /configureServer: async \(wssUrl\)/);
  assert.match(source, /token: serverToken/);
  assert.match(source, /serverToken\.fill\(0\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.(?:log|debug).*serverToken/);
});

test('public connector requires a visible user gesture before opening Web Bluetooth', async () => {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(source, /startButton\.textContent = pageText\[locale\]\.startButton/);
  assert.match(source, /startButton\.addEventListener\('click'/);
  assert.match(source, /await connector\.element\.startProvisioning\(\)/);
  assert.match(source, /connector\.element\.addEventListener\('provisionerror'/);
  assert.match(source, /connector\.element\.hidden = true/);
  assert.match(source, /const provisioningStatusPollMs = 10_000/);
  assert.match(style, /\.connect-start-button/);
});
