import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createMeetingAssistantTarget } from '../src/index.js';

test('meeting assistant streams a recording into a durable queue job', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'voicecan-meeting-'));
  const target = createMeetingAssistantTarget({ directory, download: async (_id, destination) => { const { writeFile } = await import('node:fs/promises'); await writeFile(destination, 'audio'); } });
  await target.deliver({ id: 'event-meeting', type: 'file.synced', api_version: '2026-08-01', created_at: '2026-08-04T00:00:00.000Z', data: { file_id: 'file-1' } });
  const job = JSON.parse(await readFile(resolve(directory, 'queue/event-meeting.json'), 'utf8')) as { state: string; file_id: string };
  assert.deepEqual(job, { ...job, state: 'queued', file_id: 'file-1' });
});
