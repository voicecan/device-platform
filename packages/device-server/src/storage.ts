import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type StoredFile = { locator: string; size: number; sha256: string };
type RelayWriter = { handle: FileHandle; offset: number; expectedSize: number; partialPath: string; idleTimer: ReturnType<typeof setTimeout> | null };
const relayWriterIdleMs = 60_000;

export class FilesystemStorage {
  readonly #relayWriters = new Map<string, RelayWriter>();
  constructor(private readonly root: string) {}

  locator(fileId: string): string {
    if (!/^file_[a-zA-Z0-9-]+$/.test(fileId)) throw new Error('INVALID_FILE_ID');
    return join(fileId.slice(5, 7), fileId);
  }

  resolveLocator(locator: string): string {
    const path = resolve(this.root, locator);
    const root = resolve(this.root);
    if (!path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error('INVALID_STORAGE_LOCATOR');
    return path;
  }

  async receive(fileId: string, body: Readable, expectedSize: number): Promise<StoredFile> {
    const locator = this.locator(fileId);
    const finalPath = this.resolveLocator(locator);
    const temporaryPath = `${finalPath}.part-${crypto.randomUUID()}`;
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    let size = 0;
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > expectedSize) callback(new Error('UPLOAD_TOO_LARGE'));
        else { hash.update(chunk); callback(null, chunk); }
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
      if (size !== expectedSize) throw new Error('UPLOAD_SIZE_MISMATCH');
      const handle = await open(temporaryPath, 'r+');
      await handle.sync();
      await handle.close();
      try {
        await stat(finalPath);
        throw new Error('IMMUTABLE_OBJECT_EXISTS');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          await rename(temporaryPath, finalPath);
        } else throw error;
      }
      return { locator, size, sha256: hash.digest('hex') };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async relayOffset(fileId: string): Promise<number> {
    const active = this.#relayWriters.get(fileId);
    if (active) { this.#armRelayWriterIdle(fileId, active); return active.offset; }
    const partialPath = `${this.resolveLocator(this.locator(fileId))}.relay.part`;
    try { return (await stat(partialPath)).size; } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async resetRelay(fileId: string): Promise<void> {
    const active = this.#relayWriters.get(fileId);
    if (active) {
      this.#relayWriters.delete(fileId);
      if (active.idleTimer) clearTimeout(active.idleTimer);
      await active.handle.close().catch(() => undefined);
    }
    const partialPath = `${this.resolveLocator(this.locator(fileId))}.relay.part`;
    await rm(partialPath, { force: true });
  }

  async appendRelay(fileId: string, offset: number, content: Uint8Array, expectedSize: number): Promise<StoredFile | null> {
    const locator = this.locator(fileId); const finalPath = this.resolveLocator(locator); const partialPath = `${finalPath}.relay.part`;
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    let writer = this.#relayWriters.get(fileId);
    if (!writer) {
      let current = 0;
      try { current = (await stat(partialPath)).size; } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (current !== offset) throw new Error('RELAY_OFFSET_MISMATCH');
      if (current + content.byteLength > expectedSize) throw new Error('RELAY_TOO_LARGE');
      let handle: FileHandle;
      try { handle = await open(partialPath, 'r+'); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        handle = await open(partialPath, 'wx+', 0o600);
      }
      writer = { handle, offset: current, expectedSize, partialPath, idleTimer: null };
      this.#relayWriters.set(fileId, writer);
    }
    if (writer.expectedSize !== expectedSize) throw new Error('RELAY_SIZE_CHANGED');
    if (writer.offset !== offset) throw new Error('RELAY_OFFSET_MISMATCH');
    if (writer.offset + content.byteLength > expectedSize) throw new Error('RELAY_TOO_LARGE');
    try {
      let written = 0;
      while (written < content.byteLength) {
        const result = await writer.handle.write(content, written, content.byteLength - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error('RELAY_WRITE_STALLED');
        written += result.bytesWritten;
      }
      writer.offset += written;
    } catch (error) {
      this.#relayWriters.delete(fileId);
      if (writer.idleTimer) clearTimeout(writer.idleTimer);
      await writer.handle.close().catch(() => undefined);
      throw error;
    }
    if (writer.offset < expectedSize) { this.#armRelayWriterIdle(fileId, writer); return null; }
    this.#relayWriters.delete(fileId);
    if (writer.idleTimer) clearTimeout(writer.idleTimer);
    await writer.handle.sync(); await writer.handle.close();
    const hash = createHash('sha256'); for await (const chunk of createReadStream(partialPath)) hash.update(chunk);
    try { await stat(finalPath); throw new Error('IMMUTABLE_OBJECT_EXISTS'); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') await rename(partialPath, finalPath);
      else throw error;
    }
    return { locator, size: expectedSize, sha256: hash.digest('hex') };
  }

  #armRelayWriterIdle(fileId: string, writer: RelayWriter): void {
    if (writer.idleTimer) clearTimeout(writer.idleTimer);
    writer.idleTimer = setTimeout(() => {
      if (this.#relayWriters.get(fileId) !== writer) return;
      this.#relayWriters.delete(fileId);
      void writer.handle.close().catch(() => undefined);
    }, relayWriterIdleMs);
    writer.idleTimer.unref();
  }

  async inspect(fileId: string): Promise<StoredFile | null> {
    const locator = this.locator(fileId);
    const path = this.resolveLocator(locator);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return { locator, size: info.size, sha256: hash.digest('hex') };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(locator: string): Promise<void> {
    const path = this.resolveLocator(locator);
    await rm(path, { force: true });
    try { await stat(path); throw new Error('OBJECT_DELETE_VERIFICATION_FAILED'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }

  async capacity(): Promise<{ total: number; available: number; usedRatio: number }> {
    const info = await statfs(this.root);
    const total = info.blocks * info.bsize;
    const available = info.bavail * info.bsize;
    return { total, available, usedRatio: total > 0 ? (total - available) / total : 1 };
  }

  async cleanupPartialFiles(olderThan: Date): Promise<number> {
    let removed = 0;
    const activePartialPaths = new Set([...this.#relayWriters.values()].map((writer) => writer.partialPath));
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && !activePartialPaths.has(path) && (entry.name.includes('.part-') || entry.name.endsWith('.relay.part'))) {
          const info = await stat(path);
          if (info.mtime < olderThan) { await rm(path, { force: true }); removed += 1; }
        }
      }
    };
    await walk(this.root);
    return removed;
  }
}
