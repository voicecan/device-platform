import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStartupSummary } from '../src/startup-summary.js';

test('startup summary prints only the setup-token path and an explicit reveal command', () => {
  const pending = formatStartupSummary({ adminUrl: 'http://127.0.0.1:8787/admin', deviceWsUrl: 'ws://192.168.1.8:8787/device/v1/ws', detailedLogPath: 'data/logs/device-server.log', dataDirectory: 'data', setupTokenPath: 'data/setup-token', showSetupTokenCommand: 'node packages/device-server/dist/cli.js show-setup-token' });
  assert.match(pending, /Admin:\s+http:\/\/127\.0\.0\.1:8787\/admin/);
  assert.match(pending, /Token file:\s+data\/setup-token/);
  assert.match(pending, /Show token:\s+node packages\/device-server\/dist\/cli\.js show-setup-token/);
  assert.doesNotMatch(pending, /setup-secret/);
  assert.match(pending, /create the first administrator/);
  const ready = formatStartupSummary({ adminUrl: 'http://127.0.0.1:8787/admin', deviceWsUrl: 'ws://127.0.0.1:8787/device/v1/ws', detailedLogPath: null, dataDirectory: 'data' });
  assert.match(ready, /Setup:\s+complete/);
  assert.doesNotMatch(ready, /setup_token/);
});
