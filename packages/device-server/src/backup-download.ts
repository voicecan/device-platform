import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { ServerConfig } from './config.js';
import { createBackup, verifyBackup } from './maintenance.js';

const tarBlockSize = 512;

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength > length) throw new Error(`BACKUP_ARCHIVE_PATH_TOO_LONG: ${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) throw new Error('BACKUP_ARCHIVE_VALUE_TOO_LARGE');
  writeTarString(header, offset, length, `${encoded}\0`);
}

function tarPathFields(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const separators = [...path.matchAll(/\//g)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const position = separators[index]!;
    const prefix = path.slice(0, position);
    const name = path.slice(position + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`BACKUP_ARCHIVE_PATH_TOO_LONG: ${path}`);
}

function tarHeader(path: string, size: number, modifiedAt: number, directory: boolean): Buffer {
  const header = Buffer.alloc(tarBlockSize);
  const fields = tarPathFields(directory && !path.endsWith('/') ? `${path}/` : path);
  writeTarString(header, 0, 100, fields.name);
  writeTarOctal(header, 100, 8, directory ? 0o700 : 0o600);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, directory ? 0 : size);
  writeTarOctal(header, 136, 12, modifiedAt);
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, directory ? '5' : '0');
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');
  writeTarString(header, 265, 32, 'voicecan');
  writeTarString(header, 297, 32, 'voicecan');
  writeTarString(header, 345, 155, fields.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

async function* tarEntries(root: string, archiveRoot: string, current = root): AsyncGenerator<Buffer> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error('BACKUP_ARCHIVE_SYMLINK_REJECTED');
    const absolute = resolve(current, entry.name);
    const local = relative(root, absolute).split(sep).join('/');
    const archivePath = `${archiveRoot}/${local}`;
    const metadata = await stat(absolute);
    const modifiedAt = Math.floor(metadata.mtimeMs / 1_000);
    if (entry.isDirectory()) {
      yield tarHeader(archivePath, 0, modifiedAt, true);
      yield* tarEntries(root, archiveRoot, absolute);
      continue;
    }
    if (!entry.isFile()) throw new Error('BACKUP_ARCHIVE_ENTRY_UNSUPPORTED');
    yield tarHeader(archivePath, metadata.size, modifiedAt, false);
    for await (const chunk of createReadStream(absolute)) yield Buffer.from(chunk);
    const padding = (tarBlockSize - metadata.size % tarBlockSize) % tarBlockSize;
    if (padding) yield Buffer.alloc(padding);
  }
}

async function* tarArchive(root: string, archiveRoot: string): AsyncGenerator<Buffer> {
  const metadata = await stat(root);
  yield tarHeader(archiveRoot, 0, Math.floor(metadata.mtimeMs / 1_000), true);
  yield* tarEntries(root, archiveRoot);
  yield Buffer.alloc(tarBlockSize * 2);
}

export type DownloadableBackup = {
  filename: string;
  stream: Readable;
};

export async function createDownloadableBackup(config: ServerConfig): Promise<DownloadableBackup> {
  if (config.databaseDriver !== 'sqlite' || config.storageDriver === 's3_direct') throw new Error('BACKUP_EXTERNAL_REQUIRED');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'voicecan-backup-export-'));
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const archiveRoot = `voicecan-device-backup-${timestamp}`;
  const backupDirectory = join(temporaryRoot, archiveRoot);
  try {
    await createBackup(config, backupDirectory);
    await verifyBackup(backupDirectory);
    const gzip = createGzip({ level: 9 });
    const stream = Readable.from(tarArchive(backupDirectory, basename(backupDirectory))).pipe(gzip);
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      void rm(temporaryRoot, { recursive: true, force: true });
    };
    stream.once('end', cleanup);
    stream.once('close', cleanup);
    stream.once('error', cleanup);
    return { filename: `${archiveRoot}.tar.gz`, stream };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
