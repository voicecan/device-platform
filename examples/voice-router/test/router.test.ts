import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createVoiceRouterTarget } from '../src/index.js';

test('voice router chooses the configured attribute destination', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'voicecan-router-'));
  const target = createVoiceRouterTarget({ directory, routes: { 2: 'memo' }, download: async (_id, destination) => writeFile(destination, 'audio') });
  await target.deliver({ id: 'event-router', type: 'file.synced', api_version: '2026-08-01', created_at: '2026-08-04T00:00:00.000Z', data: { file_id: 'file-3', attribute: 2 } });
  const receipt = JSON.parse(await readFile(resolve(directory, 'memo/event-router.json'), 'utf8')) as { route: string };
  assert.equal(receipt.route, 'memo');
});
