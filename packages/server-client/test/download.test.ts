import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VoicecanDeviceServer } from '../src/index.js';

function downloadFetch(content: Buffer, sha256: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/v1/recordings/')) return new Response(JSON.stringify({
      success: true, code: '', message: 'success', request_id: 'request-1', data: {
        grant_id: 'grant-1', download_url: 'https://object.example.test/temporary', expires_at: '2026-08-07T01:00:00.000Z',
        purpose: 'download', content_length: content.length, content_type: 'audio/lc3', filename: 'recording.lc3', sha256,
        range_supported: true, delivery: 'external_temporary_url',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } });
    return new Response(content, { status: 200, headers: { 'content-type': 'audio/lc3' } });
  }) as typeof fetch;
}

test('SDK verifies recording length and SHA-256 before an atomic no-overwrite commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voicecan-sdk-download-'));
  try {
    const content = Buffer.from('verified recording bytes');
    const client = new VoicecanDeviceServer({ baseUrl: 'https://device.example.test', applicationToken: 'vcd_app_test', fetch: downloadFetch(content, createHash('sha256').update(content).digest('hex')) });
    const destination = join(directory, 'recording.lc3');
    const progress: Array<{ received: number; total: number }> = [];
    await client.recordings.downloadToFile('recording-1', destination, { idempotencyKey: 'download-test-1', onProgress: (value) => progress.push(value) });
    assert.deepEqual(await readFile(destination), content);
    assert.deepEqual(progress.at(-1), { received: content.length, total: content.length });
    await assert.rejects(client.recordings.downloadToFile('recording-1', destination), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SDK event iterator follows every cursor page', async () => {
  const seenUrls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input); seenUrls.push(url); const cursor = new URL(url).searchParams.get('cursor');
    return new Response(JSON.stringify({ success: true, code: '', message: 'success', request_id: 'request-events', data: {
      items: [{ id: cursor ? 'event-2' : 'event-1', type: 'file.synced', api_version: '2026-08-07', created_at: '2026-08-07T00:00:00Z', data: {} }],
      next_cursor: cursor ? null : 'cursor-2',
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new VoicecanDeviceServer({ baseUrl: 'https://device.example.test', applicationToken: 'vcd_app_test', fetch: fakeFetch });
  const ids: string[] = [];
  for await (const event of client.events.iterate({ eventType: 'file.synced', limit: 1 })) ids.push(event.id);
  assert.deepEqual(ids, ['event-1', 'event-2']);
  assert.equal(seenUrls.length, 2);
});

test('SDK removes temporary data when recording verification fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voicecan-sdk-download-fail-'));
  try {
    const content = Buffer.from('corrupt recording bytes');
    const client = new VoicecanDeviceServer({ baseUrl: 'https://device.example.test', applicationToken: 'vcd_app_test', fetch: downloadFetch(content, '0'.repeat(64)) });
    await assert.rejects(client.recordings.downloadToFile('recording-1', join(directory, 'recording.lc3')), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'DOWNLOAD_SHA256_MISMATCH');
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SDK maps expired Grants and removes partial data after download cancellation', async () => {
  const expiredFetch = (async (input: string | URL | Request) => {
    if (String(input).includes('/api/v1/recordings/')) return new Response(JSON.stringify({ success: true, code: '', message: 'success', data: { grant_id: 'expired', download_url: 'https://object.example.test/expired', expires_at: '2026-08-07T00:00:00Z', purpose: 'download', content_length: 1, content_type: 'audio/lc3', filename: 'expired.lc3', sha256: null, range_supported: true, delivery: 'external_temporary_url' } }), { status: 201 });
    return new Response('expired', { status: 410 });
  }) as typeof fetch;
  const expired = new VoicecanDeviceServer({ baseUrl: 'https://device.example.test', applicationToken: 'vcd_app_test', fetch: expiredFetch });
  await assert.rejects(expired.recordings.downloadToFile('recording-expired', '/tmp/not-created-by-expired-grant'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TEMPORARY_DOWNLOAD_EXPIRED');

  const directory = await mkdtemp(join(tmpdir(), 'voicecan-sdk-download-abort-'));
  try {
    const content = Buffer.from('partial recording bytes');
    const interruptingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/v1/recordings/')) return downloadFetch(content, createHash('sha256').update(content).digest('hex'))(input);
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(content.subarray(0, 4)); init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); } });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const client = new VoicecanDeviceServer({ baseUrl: 'https://device.example.test', applicationToken: 'vcd_app_test', fetch: interruptingFetch });
    const controller = new AbortController();
    await assert.rejects(client.recordings.downloadToFile('recording-abort', join(directory, 'recording.lc3'), { signal: controller.signal, onProgress: () => controller.abort(new Error('operator canceled')) }), /operator canceled/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
