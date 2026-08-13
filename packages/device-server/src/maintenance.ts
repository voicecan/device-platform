import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { ServerConfig } from './config.js';
import { decryptSecretWithKeyring, encryptSecret, hashPassword, tokenHash } from './security.js';

function openExclusive(config: ServerConfig): DatabaseSync {
  const database = new DatabaseSync(config.databaseFile, { enableForeignKeyConstraints: true });
  database.exec('PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE;');
  return database;
}

type BackupManifest = {
  schema: 2 | 3;
  database: 'device-platform.sqlite';
  objects: 'objects';
  firmware?: 'firmware';
  keyring: 'master-keyring.json';
  pepper: 'token-pepper.key';
};

function pathContains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

async function readBackupManifest(root: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')) as Partial<BackupManifest>;
  if ((manifest.schema !== 2 && manifest.schema !== 3) || manifest.database !== 'device-platform.sqlite' || manifest.objects !== 'objects'
    || (manifest.schema === 3 && manifest.firmware !== 'firmware')
    || manifest.keyring !== 'master-keyring.json' || manifest.pepper !== 'token-pepper.key') {
    throw new Error('BACKUP_MANIFEST_INVALID');
  }
  return manifest as BackupManifest;
}

export async function createBackup(config: ServerConfig, outputDirectory: string): Promise<void> {
  const target = resolve(outputDirectory);
  try { await stat(target); throw new Error('BACKUP_TARGET_EXISTS'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  await mkdir(target, { recursive: false, mode: 0o700 });
  const database = new DatabaseSync(config.databaseFile, { readOnly: true });
  try { await backup(database, resolve(target, 'device-platform.sqlite')); } finally { database.close(); }
  await cp(config.storageDir, resolve(target, 'objects'), { recursive: true, errorOnExist: true, force: false });
  await cp(config.firmwareDir, resolve(target, 'firmware'), { recursive: true, errorOnExist: true, force: false });
  for (const name of ['master-keyring.json', 'master.key', 'token-pepper.key']) {
    const source = resolve(config.dataDir, name);
    try { await cp(source, resolve(target, name), { errorOnExist: true, force: false }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify({ schema: 3, created_at: new Date().toISOString(), node: process.version, storage_driver: config.storageDriver, database: 'device-platform.sqlite', objects: 'objects', firmware: 'firmware', keyring: 'master-keyring.json', pepper: 'token-pepper.key' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

export async function verifyBackup(directory: string): Promise<void> {
  const root = resolve(directory);
  const manifest = await readBackupManifest(root);
  await readFile(resolve(root, manifest.keyring)); await readFile(resolve(root, manifest.pepper));
  if (manifest.firmware) await readdir(resolve(root, manifest.firmware));
  const database = new DatabaseSync(resolve(root, manifest.database), { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw new Error(`BACKUP_INTEGRITY_FAILED: ${integrity.integrity_check}`);
    const setup = database.prepare('SELECT setup_completed_at FROM server_settings WHERE singleton=1').get() as { setup_completed_at: string | null } | undefined;
    if (!setup?.setup_completed_at) throw new Error('BACKUP_SETUP_NOT_COMPLETE');
  } finally { database.close(); }
}

export async function restoreBackup(backupDirectory: string, destinationDataDirectory: string): Promise<void> {
  await verifyBackup(backupDirectory);
  const source = resolve(backupDirectory);
  const destination = resolve(destinationDataDirectory);
  if (pathContains(source, destination) || pathContains(destination, source)) throw new Error('BACKUP_RESTORE_PATH_OVERLAP');
  try {
    const entries = await readdir(destination);
    if (entries.length !== 0) throw new Error('RESTORE_TARGET_NOT_EMPTY');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') await mkdir(destination, { recursive: true, mode: 0o700 });
    else throw error;
  }
  const manifest = await readBackupManifest(source);
  await cp(resolve(source, manifest.database), resolve(destination, 'device-platform.sqlite'), { errorOnExist: true, force: false });
  await cp(resolve(source, manifest.objects), resolve(destination, 'objects'), { recursive: true, errorOnExist: true, force: false });
  if (manifest.firmware) await cp(resolve(source, manifest.firmware), resolve(destination, 'firmware'), { recursive: true, errorOnExist: true, force: false });
  else await mkdir(resolve(destination, 'firmware'), { recursive: false, mode: 0o700 });
  await cp(resolve(source, manifest.keyring), resolve(destination, 'master-keyring.json'), { errorOnExist: true, force: false });
  await cp(resolve(source, manifest.pepper), resolve(destination, 'token-pepper.key'), { errorOnExist: true, force: false });
  try { await cp(resolve(source, 'master.key'), resolve(destination, 'master.key'), { errorOnExist: true, force: false }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  await cp(resolve(source, 'manifest.json'), resolve(destination, 'restored-from-manifest.json'), { errorOnExist: true, force: false });
}

export async function setOfflinePassword(config: ServerConfig, username: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const database = openExclusive(config);
  try {
    const user = database.prepare('SELECT id FROM users WHERE normalized_username=?').get(username.normalize('NFKC').toLocaleLowerCase('en-US')) as { id: string } | undefined;
    if (!user) throw new Error('USER_NOT_FOUND');
    const timestamp = new Date().toISOString();
    database.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, timestamp, user.id);
    database.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(timestamp, user.id);
    database.prepare('DELETE FROM login_attempts WHERE identity_hash=?').run(tokenHash(username.normalize('NFKC').toLocaleLowerCase('en-US'), config.groupTokenPepper));
    database.prepare('INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`audit_${randomUUID()}`, 'offline-host-operator', 'user.password_set_offline', 'user', user.id, `offline_${randomUUID()}`, 'success', 'offline recovery', timestamp);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; } finally { database.close(); }
}

export async function rotateMasterKey(config: ServerConfig): Promise<number> {
  const nextVersion = Math.max(...config.masterKeys.keys()) + 1;
  const nextKey = randomBytes(32);
  const keys = new Map(config.masterKeys); keys.set(nextVersion, nextKey);
  const keyringPath = resolve(config.dataDir, 'master-keyring.json');
  const temporary = `${keyringPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ current_version: nextVersion, keys: Object.fromEntries([...keys].map(([version, key]) => [String(version), key.toString('base64url')])) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, keyringPath);

  const database = openExclusive(config);
  try {
    const credentials = database.prepare('SELECT id,device_id,token_ciphertext,key_version FROM device_credentials').all() as Array<{ id: string; device_id: string; token_ciphertext: string; key_version: number }>;
    for (const credential of credentials) {
      const plaintext = decryptSecretWithKeyring(credential.token_ciphertext, keys, `${credential.device_id}:${credential.id}`, credential.key_version);
      database.prepare('UPDATE device_credentials SET token_ciphertext=?,key_version=? WHERE id=?').run(encryptSecret(plaintext, nextKey, `${credential.device_id}:${credential.id}`), nextVersion, credential.id);
      plaintext.fill(0);
    }
    const endpoints = database.prepare('SELECT id,secret_ciphertext,next_secret_ciphertext FROM event_endpoints').all() as Array<{ id: string; secret_ciphertext: string; next_secret_ciphertext: string | null }>;
    for (const endpoint of endpoints) {
      const current = decryptSecretWithKeyring(endpoint.secret_ciphertext, keys, endpoint.id);
      const next = endpoint.next_secret_ciphertext ? decryptSecretWithKeyring(endpoint.next_secret_ciphertext, keys, endpoint.id) : null;
      database.prepare('UPDATE event_endpoints SET secret_ciphertext=?,next_secret_ciphertext=? WHERE id=?').run(encryptSecret(current, nextKey, endpoint.id), next ? encryptSecret(next, nextKey, endpoint.id) : null, endpoint.id);
      current.fill(0); next?.fill(0);
    }
    database.prepare('UPDATE server_settings SET master_key_version=? WHERE singleton=1').run(nextVersion);
    database.prepare('INSERT INTO audit_logs(id,actor_id,action,resource_type,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(`audit_${randomUUID()}`, 'offline-host-operator', 'deployment_key.rotated', 'server', `offline_${randomUUID()}`, 'success', `key_version=${nextVersion}`, new Date().toISOString());
    database.exec('COMMIT');
    return nextVersion;
  } catch (error) { database.exec('ROLLBACK'); throw error; } finally { database.close(); }
}
