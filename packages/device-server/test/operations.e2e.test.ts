import assert from 'node:assert/strict';
import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { createBackup, restoreBackup, rotateMasterKey, setOfflinePassword, verifyBackup } from '../src/maintenance.js';
import { migrate } from '../src/migrate.js';

async function configured(dataDir: string): Promise<ServerConfig> {
  return loadConfig({
    VOICECAN_DATA_DIR: dataDir,
    VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    VOICECAN_DEVICE_ADVERTISE_HOST: '192.168.50.20',
    VOICECAN_SIMULATOR: 'true',
    VOICECAN_ALLOW_PRIVATE_WEBHOOKS: 'true',
    VOICECAN_ALLOW_HTTP_WEBHOOKS: 'true',
    VOICECAN_DISK_WARNING_RATIO: '0.98',
    VOICECAN_DISK_STOP_RATIO: '0.999',
    VOICECAN_LOG_LEVEL: 'silent',
  });
}

test('P0 lifecycle, rate limit, sync recovery, backup restore and key rotation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voicecan-operations-'));
  const dataDir = join(root, 'data');
  const backupDir = join(root, 'backup');
  const restoredDir = join(root, 'restored');
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    let config = await configured(dataDir);
    migrate(config);
    app = await buildServer(config);
    const setupToken = (await readFile(join(dataDir, 'setup-token'), 'utf8')).trim();
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: setupToken, username: 'admin', password: 'correct horse battery staple' } });
    assert.equal(setup.statusCode, 201, setup.body);
    const groupId = setup.json().data.group_id as string;
    const userId = setup.json().data.user_id as string;
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'correct horse battery staple' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token as string };

    const defaultDeviceAccess = await app.inject({ method: 'GET', url: '/api/v1/settings/device-access', headers });
    assert.equal(defaultDeviceAccess.statusCode, 200, defaultDeviceAccess.body);
    assert.equal(defaultDeviceAccess.json().data.ble_name_prefix, 'CAPSO-');
    const updatedDeviceAccess = await app.inject({ method: 'PATCH', url: '/api/v1/settings/device-access', headers, payload: { ble_name_prefix: 'VC-EDGE-' } });
    assert.equal(updatedDeviceAccess.statusCode, 200, updatedDeviceAccess.body);
    assert.equal(updatedDeviceAccess.json().data.ble_name_prefix, 'VC-EDGE-');

    const defaultStorage = await app.inject({ method: 'GET', url: '/api/v1/admin/storage', headers });
    assert.equal(defaultStorage.statusCode, 200, defaultStorage.body);
    assert.equal(defaultStorage.json().data.driver, 'filesystem_http');
    assert.equal(defaultStorage.json().data.max_storage_bytes, 100 * 1024 * 1024 * 1024);
    assert.equal(defaultStorage.json().data.driver_change_requires_restart, true);
    const invalidStorage = await app.inject({ method: 'PATCH', url: '/api/v1/admin/storage', headers, payload: { max_storage_bytes: 3 * 1024 * 1024 * 1024, warning_ratio: 0.9, stop_ratio: 0.8, reason: 'invalid ordering' } });
    assert.equal(invalidStorage.statusCode, 400, invalidStorage.body);
    assert.equal(invalidStorage.json().code, 'INVALID_STORAGE_POLICY');
    const updatedStorage = await app.inject({ method: 'PATCH', url: '/api/v1/admin/storage', headers, payload: { max_storage_bytes: 3 * 1024 * 1024 * 1024, warning_ratio: 0.8, stop_ratio: 0.9, reason: 'capacity review' } });
    assert.equal(updatedStorage.statusCode, 200, updatedStorage.body);
    assert.equal(updatedStorage.json().data.max_storage_bytes, 3 * 1024 * 1024 * 1024);
    assert.equal(updatedStorage.json().data.warning_ratio, 0.8);
    const persistedStorage = await app.inject({ method: 'GET', url: '/api/v1/admin/storage', headers });
    assert.equal(persistedStorage.json().data.stop_ratio, 0.9);
    assert.ok(persistedStorage.json().data.settings_updated_at);

    const demote = await app.inject({ method: 'PATCH', url: `/api/v1/users/${userId}`, headers, payload: { role: 'user' } });
    assert.equal(demote.statusCode, 409);
    const removeSelf = await app.inject({ method: 'DELETE', url: `/api/v1/users/${userId}`, headers });
    assert.equal(removeSelf.statusCode, 409);

    const grant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers, payload: { group_id: groupId, allowed_origin: 'https://trusted.test', expected_sn: 'ORIGIN-0001' } });
    assert.equal(grant.statusCode, 201, grant.body);
    const provisioningTtlMs = Date.parse(grant.json().data.expires_at) - Date.now();
    assert.ok(provisioningTtlMs > 29 * 60_000 && provisioningTtlMs <= 30 * 60_000, `unexpected provisioning TTL: ${provisioningTtlMs}ms`);
    const grantToken = grant.json().data.provisioning_token as string;
    const relayedGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers, payload: { group_id: groupId, allowed_origin: 'http://192.168.50.10:8787', connector_origin: 'https://connect.voice-can.com', expected_sn: 'REMOTE-0001' } });
    assert.equal(relayedGrant.statusCode, 201, relayedGrant.body);
    const relayedClaim = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'http://192.168.50.10:8787' }, payload: { provisioning_token: relayedGrant.json().data.provisioning_token, manufacturer: 'Voicecan', serial_number: 'REMOTE-0001' } });
    assert.equal(relayedClaim.statusCode, 201, relayedClaim.body);
    const untrustedHttpGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers, payload: { group_id: groupId, allowed_origin: 'http://192.168.50.10:8787', expected_sn: 'REMOTE-0002' } });
    assert.equal(untrustedHttpGrant.statusCode, 400, untrustedHttpGrant.body);
    const wrongConnectorGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers, payload: { group_id: groupId, allowed_origin: 'http://192.168.50.10:8787', connector_origin: 'https://untrusted.example.test', expected_sn: 'REMOTE-0003' } });
    assert.equal(wrongConnectorGrant.statusCode, 400, wrongConnectorGrant.body);
    const wrongOrigin = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', payload: { provisioning_token: grantToken, manufacturer: 'Voicecan', serial_number: 'ORIGIN-0001' } });
    assert.equal(wrongOrigin.statusCode, 403);
    const claimed = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'https://trusted.test' }, payload: { provisioning_token: grantToken, manufacturer: 'Voicecan', serial_number: 'ORIGIN-0001', bluetooth_name: 'CAPSO-SCANNED' } });
    assert.equal(claimed.statusCode, 201, claimed.body);
    assert.match(claimed.json().data.device_token, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(claimed.json().data.wss_url, 'ws://192.168.50.20:8787/device/v1/ws');
    assert.equal(claimed.json().data.display_name, 'CAPSO-SCANNED');
    const deviceSocket = await app.injectWS('/device/v1/ws', { headers: { deviceid: 'ORIGIN-0001', authorization: `Bearer ${claimed.json().data.device_token}` } });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('device reverse-bind request timed out')), 1_000);
      deviceSocket.once('message', () => { clearTimeout(timeout); resolve(); });
      deviceSocket.once('close', (_code, reason) => { clearTimeout(timeout); reject(new Error(`device websocket closed before reverse bind: ${reason.toString()}`)); });
    });
    deviceSocket.close();
    const provisioningSessionId = claimed.json().data.provisioning_session_id as string;
    const continuationToken = claimed.json().data.continuation_token as string;
    const reserved = await app.inject({ method: 'GET', url: `/api/v1/provisioning-sessions/${provisioningSessionId}`, headers });
    assert.equal(reserved.json().data.status, 'reserved');
    for (const stage of ['ble_authenticated', 'configured']) {
      const progress = await app.inject({ method: 'POST', url: `/api/v1/provisioning-sessions/${provisioningSessionId}/progress`, headers: { origin: 'https://trusted.test' }, payload: { continuation_token: continuationToken, stage } });
      assert.equal(progress.statusCode, 200, progress.body);
    }
    const observed = await app.inject({ method: 'POST', url: `/api/v1/provisioning-sessions/${provisioningSessionId}/observe`, headers: { origin: 'https://trusted.test' }, payload: { continuation_token: continuationToken } });
    assert.equal(observed.json().data.status, 'configured');
    assert.equal(observed.json().data.online, false);
    const replayedGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'https://trusted.test' }, payload: { provisioning_token: grantToken, manufacturer: 'Voicecan', serial_number: 'ORIGIN-0001' } });
    assert.equal(replayedGrant.statusCode, 403);
    const failed = await app.inject({ method: 'POST', url: `/api/v1/provisioning-sessions/${provisioningSessionId}/progress`, headers: { origin: 'https://trusted.test' }, payload: { continuation_token: continuationToken, stage: 'failed', failure_code: 'BLE_DISCONNECTED' } });
    assert.equal(failed.statusCode, 200, failed.body);
    const recoveredSameGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'https://trusted.test' }, payload: { provisioning_token: grantToken, manufacturer: 'Voicecan', serial_number: 'ORIGIN-0001', bluetooth_name: 'CAPSO-CHANGED' } });
    assert.equal(recoveredSameGrant.statusCode, 201, recoveredSameGrant.body);
    assert.equal(recoveredSameGrant.json().data.recovered, true);
    assert.equal(recoveredSameGrant.json().data.device_token, claimed.json().data.device_token);
    assert.equal(recoveredSameGrant.json().data.display_name, 'CAPSO-SCANNED', 'recovery must not overwrite the initial device name');
    const failedRetry = await app.inject({ method: 'POST', url: `/api/v1/provisioning-sessions/${provisioningSessionId}/progress`, headers: { origin: 'https://trusted.test' }, payload: { continuation_token: recoveredSameGrant.json().data.continuation_token, stage: 'failed', failure_code: 'SERVER_ONLINE_TIMEOUT' } });
    assert.equal(failedRetry.statusCode, 200, failedRetry.body);
    const recoveryGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers, payload: { group_id: groupId, allowed_origin: 'https://trusted.test', expected_sn: 'ORIGIN-0001' } });
    assert.equal(recoveryGrant.statusCode, 201, recoveryGrant.body);
    const recovered = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'https://trusted.test' }, payload: { provisioning_token: recoveryGrant.json().data.provisioning_token, manufacturer: 'Voicecan', serial_number: 'ORIGIN-0001' } });
    assert.equal(recovered.statusCode, 201, recovered.body);
    assert.equal(recovered.json().data.recovered, true);
    assert.equal(recovered.json().data.device_id, claimed.json().data.device_id);
    assert.equal(recovered.json().data.device_token, claimed.json().data.device_token);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'deliberately incorrect password' } });
      assert.equal(rejected.statusCode, 401);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'correct horse battery staple' } });
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);

    const device = await app.inject({ method: 'POST', url: '/api/v1/simulator/devices', headers, payload: { manufacturer: 'Voicecan', sn: 'RECOVERY-0001', group_id: groupId } });
    const deviceId = device.json().data.device.id as string;
    const deviceToken = device.json().data.device_token as string;
    const alreadyClaimedGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers, payload: { group_id: groupId, allowed_origin: 'https://trusted.test', expected_sn: 'RECOVERY-0001' } });
    assert.equal(alreadyClaimedGrant.statusCode, 201, alreadyClaimedGrant.body);
    const alreadyClaimed = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'https://trusted.test' }, payload: { provisioning_token: alreadyClaimedGrant.json().data.provisioning_token, manufacturer: 'Voicecan', serial_number: 'RECOVERY-0001', bluetooth_name: 'CAPSO-RECOVERY' } });
    assert.equal(alreadyClaimed.statusCode, 409, alreadyClaimed.body);
    assert.equal(alreadyClaimed.json().code, 'DEVICE_ALREADY_CLAIMED');
    assert.equal(alreadyClaimed.json().data.device_id, deviceId);
    const namedExistingDevice = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}`, headers });
    assert.equal(namedExistingDevice.json().data.display_name, 'CAPSO-RECOVERY', 'a same-group legacy device with no name should adopt its scanned Bluetooth name');
    const content = Buffer.from('recover an immutable object after a simulated database crash');
    const discovered = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers, payload: { device_id: deviceId, session_id: 100, attribute: 0, content_length: content.length } });
    assert.equal(discovered.statusCode, 201, discovered.body);
    const fileId = discovered.json().data.file_id as string;
    const rediscovered = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers, payload: { device_id: deviceId, session_id: 100, attribute: 0, content_length: content.length } });
    assert.equal(rediscovered.statusCode, 202, rediscovered.body);
    assert.equal(rediscovered.json().data.file_id, fileId);
    assert.equal(rediscovered.json().data.upload_url, undefined);

    const locator = join(fileId.slice(5, 7), fileId);
    const finalPath = join(config.storageDir, locator);
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, content, { flag: 'wx' });
    const uploadPath = new URL(discovered.json().data.upload_url as string).pathname;
    const raced = await app.inject({ method: 'PUT', url: uploadPath, headers: { 'content-type': 'application/octet-stream', 'content-length': String(content.length) }, payload: content });
    assert.equal(raced.statusCode, 500);
    const reconciled = await app.inject({ method: 'POST', url: '/api/v1/admin/reconcile', headers, payload: {} });
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    assert.equal(reconciled.json().data.recoveredFiles, 1);
    const completeAgain = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers, payload: { device_id: deviceId, session_id: 100, attribute: 0, content_length: content.length } });
    assert.equal(completeAgain.statusCode, 200, completeAgain.body);
    assert.equal(completeAgain.json().data.already_synced, true);

    const transfer = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/transfer-out-sessions`, headers, payload: { allowed_origin: 'https://trusted.test', reason: 'move to an independent deployment' } });
    assert.equal(transfer.statusCode, 201, transfer.body);
    const transferToken = transfer.json().data.transfer_token as string;
    assert.ok(transferToken.startsWith(`${transfer.json().data.id}.`));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const claimedTransfer = await app.inject({ method: 'POST', url: `/api/v1/transfer-out-sessions/${transfer.json().data.id}/claim`, headers: { origin: 'https://trusted.test' }, payload: { transfer_token: transferToken, public_key_jwk: publicKey.export({ format: 'jwk' }) } });
    assert.equal(claimedTransfer.statusCode, 200, claimedTransfer.body);
    const unsealed = privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(claimedTransfer.json().data.sealed_device_token, 'base64'));
    assert.deepEqual(unsealed, Buffer.from(deviceToken, 'base64'));
    const released = await app.inject({ method: 'POST', url: `/api/v1/transfer-out-sessions/${transfer.json().data.id}/complete`, headers: { origin: 'https://trusted.test' }, payload: { continuation_token: claimedTransfer.json().data.continuation_token, serial_number: 'RECOVERY-0001', result: 'ack' } });
    assert.equal(released.statusCode, 200, released.body);
    assert.equal(released.json().data.recordings_erased, false);
    const releasedDevice = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}`, headers });
    assert.equal(releasedDevice.statusCode, 404);
    const retainedFile = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}`, headers });
    assert.equal(retainedFile.statusCode, 200, retainedFile.body);

    const held = await app.inject({ method: 'PUT', url: `/api/v1/files/${fileId}/legal-hold`, headers, payload: { enabled: true, reason: 'preserve for an active review' } });
    assert.equal(held.statusCode, 200, held.body);
    assert.equal(held.json().data.legal_hold, true);
    const blockedDeletion = await app.inject({ method: 'POST', url: `/api/v1/files/${fileId}/deletion-preview`, headers, payload: {} });
    assert.equal(blockedDeletion.statusCode, 409, blockedDeletion.body);
    assert.equal(blockedDeletion.json().code, 'FILE_LEGAL_HOLD');
    const cleared = await app.inject({ method: 'PUT', url: `/api/v1/files/${fileId}/legal-hold`, headers, payload: { enabled: false, reason: 'review completed' } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const deletionPreview = await app.inject({ method: 'POST', url: `/api/v1/files/${fileId}/deletion-preview`, headers, payload: {} });
    assert.equal(deletionPreview.statusCode, 200, deletionPreview.body);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/files/${fileId}`, headers, payload: { reason: 'approved retention expiry', resource_version: deletionPreview.json().data.resource_version, confirmation_token: deletionPreview.json().data.confirmation_token } });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().data.object_deleted, true);
    assert.equal(deleted.json().data.device_source_deleted, false);
    const deletedContent = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/content`, headers });
    assert.equal(deletedContent.statusCode, 404);
    const tombstone = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}`, headers });
    assert.equal(tombstone.statusCode, 200, tombstone.body);
    assert.equal(tombstone.json().data.deletion_status, 'object_deleted');

    await app.close(); app = undefined;
    await setOfflinePassword(config, 'admin', 'new correct horse battery staple');
    const nextVersion = await rotateMasterKey(config);
    assert.equal(nextVersion, 2);
    config = await configured(dataDir);
    assert.equal(config.masterKeyVersion, 2);
    await writeFile(join(config.firmwareDir, 'backup-fixture.bin'), 'firmware backup fixture');
    await createBackup(config, backupDir);
    await verifyBackup(backupDir);
    await restoreBackup(backupDir, restoredDir);
    const restoredConfig = await configured(restoredDir);
    assert.equal(restoredConfig.masterKeyVersion, 2);
    assert.equal(await readFile(join(restoredConfig.firmwareDir, 'backup-fixture.bin'), 'utf8'), 'firmware backup fixture');
    app = await buildServer(restoredConfig);
    const restoredStatus = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    assert.equal(restoredStatus.json().data.status, 'ready');
    const restoredLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'new correct horse battery staple' } });
    assert.equal(restoredLogin.statusCode, 200, restoredLogin.body);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
