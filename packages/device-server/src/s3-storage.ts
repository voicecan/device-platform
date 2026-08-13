import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ServerConfig } from './config.js';

export type S3UploadPlan = { attemptId: string; stagingKey: string; uploadUrl: string; expiresAt: string };
export type S3CommittedFile = { locator: string; size: number; sha256: string | null };

type Presigner = (client: S3Client, command: PutObjectCommand | GetObjectCommand, options: { expiresIn: number }) => Promise<string>;

export class S3ImmutableStorage {
  constructor(private readonly client: S3Client, private readonly bucket: string, private readonly presign: Presigner = getSignedUrl) {}

  async prepare(fileId: string, expectedSize: number, ttlSeconds = 600): Promise<S3UploadPlan> {
    const attemptId = `attempt_${randomUUID()}`;
    const stagingKey = `staging/${fileId}/${attemptId}`;
    const uploadUrl = await this.presign(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: stagingKey, ContentLength: expectedSize }), { expiresIn: ttlSeconds });
    return { attemptId, stagingKey, uploadUrl, expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString() };
  }

  async verifyAndCommit(fileId: string, attemptId: string, stagingKey: string, expectedSize: number): Promise<S3CommittedFile> {
    const staged = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: stagingKey, ChecksumMode: 'ENABLED' }));
    if (staged.ContentLength !== expectedSize) throw new Error('S3_SIZE_MISMATCH');
    const finalKey = `final/${fileId}/${attemptId}`;
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: finalKey, CopySource: encodeURIComponent(`${this.bucket}/${stagingKey}`), MetadataDirective: 'COPY' }));
    const committed = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: finalKey, ChecksumMode: 'ENABLED' }));
    if (committed.ContentLength !== expectedSize) throw new Error('S3_FINAL_SIZE_MISMATCH');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey }));
    const locator = Buffer.from(JSON.stringify({ driver: 's3_direct', bucket: this.bucket, key: finalKey, versionId: committed.VersionId ?? null, etag: committed.ETag ?? null })).toString('base64url');
    const sha256 = committed.ChecksumSHA256 ? Buffer.from(committed.ChecksumSHA256, 'base64').toString('hex') : null;
    return { locator: `s3:${locator}`, size: expectedSize, sha256 };
  }

  async open(locator: string, range?: { start: number; end: number }): Promise<Readable> {
    if (!locator.startsWith('s3:')) throw new Error('INVALID_S3_LOCATOR');
    const value = JSON.parse(Buffer.from(locator.slice(3), 'base64url').toString()) as { bucket: string; key: string; versionId: string | null };
    if (value.bucket !== this.bucket || !value.key.startsWith('final/')) throw new Error('INVALID_S3_LOCATOR');
    const result = await this.client.send(new GetObjectCommand({ Bucket: value.bucket, Key: value.key, ...(value.versionId ? { VersionId: value.versionId } : {}), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }));
    if (!(result.Body instanceof Readable)) throw new Error('S3_BODY_UNAVAILABLE');
    return result.Body;
  }

  async presignDownload(locator: string, ttlSeconds: number): Promise<string> {
    if (!locator.startsWith('s3:')) throw new Error('INVALID_S3_LOCATOR');
    const value = JSON.parse(Buffer.from(locator.slice(3), 'base64url').toString()) as { bucket: string; key: string; versionId: string | null };
    if (value.bucket !== this.bucket || !value.key.startsWith('final/')) throw new Error('INVALID_S3_LOCATOR');
    return this.presign(this.client, new GetObjectCommand({
      Bucket: value.bucket,
      Key: value.key,
      ...(value.versionId ? { VersionId: value.versionId } : {}),
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: 'attachment',
    }), { expiresIn: ttlSeconds });
  }

  async delete(locator: string): Promise<void> {
    if (!locator.startsWith('s3:')) throw new Error('INVALID_S3_LOCATOR');
    const value = JSON.parse(Buffer.from(locator.slice(3), 'base64url').toString()) as { bucket: string; key: string; versionId: string | null };
    if (value.bucket !== this.bucket || !value.key.startsWith('final/')) throw new Error('INVALID_S3_LOCATOR');
    await this.client.send(new DeleteObjectCommand({ Bucket: value.bucket, Key: value.key, ...(value.versionId ? { VersionId: value.versionId } : {}) }));
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: value.bucket, Key: value.key, ...(value.versionId ? { VersionId: value.versionId } : {}) }));
      throw new Error('OBJECT_DELETE_VERIFICATION_FAILED');
    } catch (error) {
      if (error instanceof Error && error.message === 'OBJECT_DELETE_VERIFICATION_FAILED') throw error;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return;
      throw error;
    }
  }

  async deleteStaging(stagingKey: string): Promise<void> {
    if (!stagingKey.startsWith('staging/')) throw new Error('INVALID_STAGING_KEY');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey }));
  }
}

export function createS3Storage(config: ServerConfig): S3ImmutableStorage | null {
  if (!config.s3) return null;
  return new S3ImmutableStorage(new S3Client({
    ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  }), config.s3.bucket);
}
