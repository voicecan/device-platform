import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('public Fastify API routes are represented in OpenAPI', async () => {
  const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
  const openapi = await readFile(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8');
  const routes = [...source.matchAll(/app\.(?:get|post|put|patch|delete)\('(?<path>\/api\/v1\/[^']+)'/g)]
    .map((match) => match.groups!.path!)
    .filter((path) => !path.startsWith('/api/v1/simulator/'))
    .map((path) => path.slice('/api/v1'.length).replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}'));
  const undocumented = [...new Set(routes)].filter((path) => !openapi.includes(`  ${path}:`));
  assert.deepEqual(undocumented, []);
  for (const schema of ['Device', 'RecordingFile', 'DeviceEvent', 'Command', 'ProvisioningClaim', 'TransferOutClaim', 'CursorPageFiles']) {
    assert.match(openapi, new RegExp(`^    ${schema}:`, 'm'), `${schema} must have a field-level schema`);
  }
  for (const reference of ['DeviceListEnvelope', 'FilePageEnvelope', 'EventPageEnvelope', 'ProvisioningClaimRequest', 'TransferOutCompleteRequest']) {
    assert.match(openapi, new RegExp(`#/components/schemas/${reference}`), `${reference} must be bound to an operation`);
  }
});
