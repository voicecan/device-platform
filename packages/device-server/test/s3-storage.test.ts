import assert from 'node:assert/strict';
import test from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3ImmutableStorage } from '../src/s3-storage.js';

test('S3 direct signs an attempt staging key and promotes to an attempt-specific final version', async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'HeadObjectCommand') {
        const isFinal = String(command.input.Key).startsWith('final/');
        return { ContentLength: 5, ...(isFinal ? { VersionId: 'version-1', ETag: 'etag', ChecksumSHA256: Buffer.from('hash').toString('base64') } : {}) };
      }
      return {};
    },
  } as unknown as S3Client;
  const storage = new S3ImmutableStorage(client, 'recordings', async (_client, command) => `https://minio.test/${String(command.input.Key)}`);
  const plan = await storage.prepare('file_12345678-1234-1234-1234-123456789012', 5);
  assert.match(plan.stagingKey, /^staging\/file_.*\/attempt_/);
  const committed = await storage.verifyAndCommit('file_12345678-1234-1234-1234-123456789012', plan.attemptId, plan.stagingKey, 5);
  const copy = commands.find((command) => command.name === 'CopyObjectCommand');
  assert.equal(copy?.input.Key, `final/file_12345678-1234-1234-1234-123456789012/${plan.attemptId}`);
  assert.ok(commands.some((command) => command.name === 'DeleteObjectCommand' && command.input.Key === plan.stagingKey));
  assert.match(committed.locator, /^s3:/);
  assert.equal(committed.sha256, Buffer.from('hash').toString('hex'));
});

test('S3 deletion targets and verifies the immutable object version', async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'HeadObjectCommand') throw Object.assign(new Error('Not Found'), { $metadata: { httpStatusCode: 404 } });
      return {};
    },
  } as unknown as S3Client;
  const storage = new S3ImmutableStorage(client, 'recordings');
  const locator = `s3:${Buffer.from(JSON.stringify({ driver: 's3_direct', bucket: 'recordings', key: 'final/file_123/attempt_456', versionId: 'version-7' })).toString('base64url')}`;
  await storage.delete(locator);
  assert.deepEqual(commands.map((command) => command.name), ['DeleteObjectCommand', 'HeadObjectCommand']);
  assert.equal(commands[0]?.input.VersionId, 'version-7');
  assert.equal(commands[1]?.input.VersionId, 'version-7');
});

test('S3 temporary delivery signs only the immutable locator target', async () => {
  let signed: { name: string; input: Record<string, unknown>; expiresIn: number } | undefined;
  const client = { async send() { return {}; } } as unknown as S3Client;
  const storage = new S3ImmutableStorage(client, 'recordings', async (_client, command, options) => {
    signed = { name: command.constructor.name, input: command.input as Record<string, unknown>, expiresIn: options.expiresIn };
    return 'https://object.example.test/temporary';
  });
  const locator = `s3:${Buffer.from(JSON.stringify({ driver: 's3_direct', bucket: 'recordings', key: 'final/file_123/attempt_456', versionId: 'version-7' })).toString('base64url')}`;
  assert.equal(await storage.presignDownload(locator, 45), 'https://object.example.test/temporary');
  assert.equal(signed?.name, 'GetObjectCommand');
  assert.equal(signed?.input.Bucket, 'recordings');
  assert.equal(signed?.input.Key, 'final/file_123/attempt_456');
  assert.equal(signed?.input.VersionId, 'version-7');
  assert.equal(signed?.expiresIn, 45);
  await assert.rejects(storage.presignDownload(`s3:${Buffer.from(JSON.stringify({ bucket: 'other', key: 'final/escape', versionId: null })).toString('base64url')}`, 45), /INVALID_S3_LOCATOR/);
});
