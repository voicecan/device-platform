import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('compact initial status is a lightweight hint instead of a full operation card', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /compact-status-card/);
  assert.match(source, /\.card\.compact-status-card \{[^}]*border: 0;[^}]*padding: 0;[^}]*background: transparent;[^}]*box-shadow: none;/);
  assert.match(source, /class="compact-status" role="status"/);
  assert.doesNotMatch(source, /this\.compact \? html`<div class="stage"><div role="status">/);
});

test('compact binding renders a full connection stage after device selection starts', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /this\.compact && this\.step === 0 && !this\.busy/);
  assert.match(source, /class="stage progress-visual selection-progress"/);
  assert.match(source, /Connecting to the selected device/);
});

test('waiting for server confirmation never restarts BLE status reads', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /state === 'waiting_server'\) \{ this\.#stopLiveStatus\(\); this\.liveStatusError = ''; \}/);
  assert.doesNotMatch(source, /state === 'waiting_server'[^\n]*#startLiveStatus/);
  assert.match(source, /const refreshDeviceStatus = this\.step === 1/);
});
