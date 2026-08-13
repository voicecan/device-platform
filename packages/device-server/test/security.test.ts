import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateWebhookUrl } from '../src/events.js';

test('webhook URL validation rejects SSRF address classes and unsafe schemes', async () => {
  for (const url of [
    'ftp://8.8.8.8/hook',
    'https://10.1.2.3/hook',
    'http://10.1.2.3/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.2/hook',
    'https://[fe80::1]/hook',
    'https://[fc00::1]/hook',
  ]) await assert.rejects(validateWebhookUrl(url, false));

  await assert.rejects(validateWebhookUrl('http://8.8.8.8/hook', false), /WEBHOOK_HTTPS_REQUIRED/);
  await assert.rejects(validateWebhookUrl('https://127.0.0.1:9999/hook', false), /WEBHOOK_PRIVATE_ADDRESS_DENIED/);
  await assert.rejects(validateWebhookUrl('https://[::1]:9999/hook', false), /WEBHOOK_PRIVATE_ADDRESS_DENIED/);
  assert.equal((await validateWebhookUrl('http://127.0.0.1:9999/hook', true, true)).protocol, 'http:');
});

test('Webhook payloads use the shared API version contract', async () => {
  const source = await readFile(new URL('../src/events.ts', import.meta.url), 'utf8');
  assert.match(source, /api_version: API_VERSION/);
  assert.doesNotMatch(source, /api_version: '2026-/);
});
