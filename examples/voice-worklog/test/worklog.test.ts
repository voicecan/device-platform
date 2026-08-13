import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createVoiceWorklogTarget } from '../src/index.js';

test('voice worklog writes a local entry with its streamed attachment', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'voicecan-worklog-'));
  const target = createVoiceWorklogTarget({ directory, download: async (_id, destination) => writeFile(destination, 'audio') });
  await target.deliver({ id: 'event-worklog', type: 'file.synced', api_version: '2026-08-01', created_at: '2026-08-04T00:00:00.000Z', data: { file_id: 'file-2' } });
  assert.match(await readFile(resolve(directory, 'entries/event-worklog.md'), 'utf8'), /File: file-2/);
});
