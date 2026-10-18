import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';
import { DatabaseActor, type Database } from './database.js';

type Receipt = { directory: string; created_at: string; fingerprint: string };
export type RecoveryBackupStatus = { supported: boolean; current: boolean; latest: { created_at: string; directory: string } | null };

/** A server-owned, verified recovery copy. No credential bytes leave this service. */
export class RecoveryBackups {
  readonly supported: boolean;
  readonly root: string;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private config: ServerConfig, private db: Database) {
    this.supported = db instanceof DatabaseActor && config.storageDriver !== 's3_direct' && !config.externallyManagedKeys;
    this.root = join(config.dataDir, 'recovery-backups');
  }
  async #receipt(): Promise<Receipt | null> {
    try {
      const value = JSON.parse(await readFile(join(this.root, 'latest.json'), 'utf8')) as Receipt;
      if (!/^snapshot-[0-9a-f-]{36}$/.test(value.directory) || !/^[0-9a-f]{64}$/.test(value.fingerprint) || !Number.isFinite(Date.parse(value.created_at))) return null;
      return value;
    } catch { return null; }
  }
  async #fingerprint(): Promise<string> {
    const ring = JSON.parse(await readFile(join(this.config.dataDir, 'master-keyring.json'), 'utf8')) as { keys: Record<string, string>; current_version: number };
    const pepper = Buffer.from((await readFile(join(this.config.dataDir, 'token-pepper.key'), 'utf8')).trim(), 'base64url');
    if (!pepper.equals(this.config.groupTokenPepper) || ring.current_version !== this.config.masterKeyVersion || [...this.config.masterKeys].some(([version, key]) => !key.equals(Buffer.from(ring.keys[String(version)] ?? '', 'base64url')))) throw new Error('BACKUP_KEYS_UNAVAILABLE');
    const credentials = await this.db.all('SELECT id,device_id,token_ciphertext,key_version,token_verifier,credential_epoch,status,expires_at,revoked_at FROM device_credentials ORDER BY id');
    const devices = await this.db.all('SELECT id,claim_status,group_id,credential_epoch FROM devices ORDER BY id');
    const users = await this.db.all('SELECT id,username,password_hash,role,disabled_at FROM users ORDER BY id');
    return createHash('sha256').update(JSON.stringify([ring, pepper.toString('base64url'), credentials, devices, users])).digest('hex');
  }
  async status(): Promise<RecoveryBackupStatus> {
    if (!this.supported) return { supported: false, current: false, latest: null };
    const receipt = await this.#receipt();
    let current = false;
    if (receipt) {
      try {
        const directory = join(this.root, receipt.directory);
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('BACKUP_SYMLINK_REJECTED');
        await (this.db as DatabaseActor).verifyBackup(directory);
        current = receipt.fingerprint === await this.#fingerprint();
      } catch { /* Missing or damaged backups are never reported as protected. */ }
    }
    return { supported: true, current, latest: receipt ? { created_at: receipt.created_at, directory: join(this.root, receipt.directory) } : null };
  }
  ensure(force = false): Promise<RecoveryBackupStatus> {
    const operation = this.#queue.then(() => this.#ensure(force));
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
  async #ensure(force: boolean): Promise<RecoveryBackupStatus> {
    if (!this.supported) return this.status();
    const status = await this.status();
    if (status.current && !force) return status;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('BACKUP_SYMLINK_REJECTED');
    await chmod(this.root, 0o700);
    const directory = `snapshot-${randomUUID()}`;
    const target = join(this.root, directory);
    const temporaryReceipt = join(this.root, `receipt-${randomUUID()}.tmp`);
    // Hash before the snapshot: concurrent credential changes cause a later refresh,
    // never a false claim that a newer credential was already backed up.
    const fingerprint = await this.#fingerprint();
    try {
      const config = this.config;
      await (this.db as DatabaseActor).createVerifiedBackup({ dataDir: config.dataDir, databaseFile: config.databaseFile, storageDir: config.storageDir, firmwareDir: config.firmwareDir, storageDriver: config.storageDriver }, target);
      const receipt: Receipt = { directory, created_at: new Date().toISOString(), fingerprint };
      await writeFile(temporaryReceipt, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      await rename(temporaryReceipt, join(this.root, 'latest.json'));
      // Retain three server-generated copies, including the published one. Never
      // touch manual exports or files outside this dedicated directory.
      const snapshots = await readdir(this.root, { withFileTypes: true }).catch(() => []);
      const previous = await Promise.all(snapshots.filter((entry) => entry.isDirectory() && entry.name !== directory && /^snapshot-[0-9a-f-]{36}$/.test(entry.name)).map(async (entry) => ({ name: entry.name, time: await lstat(join(this.root, entry.name)).then((value) => value.mtimeMs, () => 0) })));
      for (const old of previous.sort((a, b) => b.time - a.time).slice(2)) await rm(join(this.root, old.name), { recursive: true, force: true }).catch(() => undefined);
      return { supported: true, current: true, latest: { created_at: receipt.created_at, directory: target } };
    } catch {
      await rm(target, { recursive: true, force: true });
      await rm(temporaryReceipt, { force: true });
      throw new Error('RECOVERY_BACKUP_FAILED');
    }
  }
  async settled(): Promise<void> { await this.#queue; }
}
