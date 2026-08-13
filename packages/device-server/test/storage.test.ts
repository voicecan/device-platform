import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { FilesystemStorage } from '../src/storage.js';

test('filesystem storage verifies size and never overwrites a final object', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voicecan-storage-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const storage = new FilesystemStorage(directory);
  const content = Buffer.from('recording');
  const stored = await storage.receive('file_abcdef12-3456-7890-abcd-ef1234567890', Readable.from(content), content.length);
  assert.deepEqual(await readFile(storage.resolveLocator(stored.locator)), content);
  await assert.rejects(storage.receive('file_abcdef12-3456-7890-abcd-ef1234567890', Readable.from(Buffer.from('overwrite')), 9), /IMMUTABLE_OBJECT_EXISTS/);
  assert.deepEqual(await readFile(storage.resolveLocator(stored.locator)), content);
});

test('server relay enforces exact offsets and resumes a partial immutable upload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voicecan-relay-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const storage = new FilesystemStorage(directory); const fileId = 'file_12345678-3456-7890-abcd-ef1234567890';
  assert.equal(await storage.appendRelay(fileId, 0, Buffer.from('record'), 9), null);
  assert.equal(await storage.relayOffset(fileId), 6);
  await assert.rejects(storage.appendRelay(fileId, 5, Buffer.from('ing'), 9), /RELAY_OFFSET_MISMATCH/);
  const stored = await storage.appendRelay(fileId, 6, Buffer.from('ing'), 9);
  assert.equal(stored?.size, 9);
  assert.deepEqual(await readFile(storage.resolveLocator(stored!.locator)), Buffer.from('recording'));
});
