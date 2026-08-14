import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

test('independent server setup, immutable upload, group isolation and device transfer', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-device-'));
  const config = await loadConfig({
    VOICECAN_DATA_DIR: dataDir,
    VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    VOICECAN_CONNECT_WEB_URL: 'https://connector.example.test/connect/',
    VOICECAN_SIMULATOR: 'true',
    VOICECAN_ALLOW_PRIVATE_WEBHOOKS: 'true',
    VOICECAN_ALLOW_HTTP_WEBHOOKS: 'true',
    VOICECAN_DISK_WARNING_RATIO: '0.98',
    VOICECAN_DISK_STOP_RATIO: '0.999',
    VOICECAN_LOG_LEVEL: 'silent',
  });
  migrate(config);
  const app = await buildServer(config);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  for (const url of ['/sdk/device-core-browser.js', '/sdk/device-ui.js', '/sdk/types.js']) {
    const asset = await app.inject({ method: 'GET', url });
    assert.equal(asset.statusCode, 200, `${url}: ${asset.body}`);
    assert.equal(asset.headers['cache-control'], 'no-store', `${url} must not serve stale unversioned runtime code`);
  }
  for (const url of ['/admin', '/admin/app.js', '/admin/style.css']) {
    const asset = await app.inject({ method: 'GET', url });
    assert.equal(asset.statusCode, 200, `${url}: ${asset.body}`);
  }
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, '/admin');
  assert.equal(root.headers['cache-control'], 'no-store');
  for (const url of ['/device', '/device/app.js', '/sdk/private/semantic_core.js', '/sdk/private/protocol_core_bg.wasm']) {
    const protectedAsset = await app.inject({ method: 'GET', url });
    assert.equal(protectedAsset.statusCode, 401, `${url} must require a human session`);
  }
  const adminPage = await app.inject({ method: 'GET', url: '/admin' });
  assert.match(adminPage.body, /id="root"/);
  assert.match(adminPage.body, /content="https:\/\/connector\.example\.test\/connect\/"/);
  assert.doesNotMatch(adminPage.body, /__VOICECAN_CONNECT_URL__/);
  const deviceUiBundle = await app.inject({ method: 'GET', url: '/sdk/device-ui.js' });
  assert.match(deviceUiBundle.body, /voicecan-provisioner/);
  assert.doesNotMatch(deviceUiBundle.body, /from\s*["']lit["']/);
  const setupToken = (await readFile(join(dataDir, 'setup-token'), 'utf8')).trim();

  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: setupToken, username: 'admin', password: 'correct horse battery staple' } });
  assert.equal(setup.statusCode, 201, setup.body);
  await assert.rejects(readFile(join(dataDir, 'setup-token'), 'utf8'), { code: 'ENOENT' });
  const setupData = setup.json().data as { group_id: string };
  const repeat = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: setupToken, username: 'other', password: 'correct horse battery staple' } });
  assert.equal(repeat.statusCode, 403);

  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ADMIN', password: 'correct horse battery staple' } });
  assert.equal(login.statusCode, 200, login.body);
  assert.match(String(login.headers['set-cookie']), /vc_csrf=/);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const csrf = login.json().data.csrf_token as string;
  const adminHeaders = { cookie, 'x-csrf-token': csrf };
  for (const url of ['/device', '/device/app.js', '/sdk/private/semantic_core.js', '/sdk/private/protocol_core_bg.wasm']) {
    const asset = await app.inject({ method: 'GET', url, headers: adminHeaders });
    assert.equal(asset.statusCode, 200, `${url}: ${asset.body}`);
    assert.equal(asset.headers['cache-control'], 'no-store');
  }
  const devicePage = await app.inject({ method: 'GET', url: '/device', headers: adminHeaders });
  assert.doesNotMatch(devicePage.body, /<script type="importmap">/);
  assert.match(devicePage.body, /id="device-language"/);
  assert.match(String(devicePage.headers['content-security-policy']), /trusted-types voicecan lit-html sanitizer/);
  assert.match(devicePage.body, /class="device-intro"/);
  assert.match(devicePage.body, /id="device-mode-release"/);
  const deviceApp = await app.inject({ method: 'GET', url: '/device/app.js', headers: adminHeaders });
  assert.match(deviceApp.body, /voicecan\.locale/);
  assert.match(deviceApp.body, /绑定 Voicecan 设备/);
  assert.match(deviceApp.body, /网络配置仅是需要时执行的其中一步/);
  const deviceAccess = await app.inject({ method: 'GET', url: '/api/v1/settings/device-access', headers: adminHeaders });
  assert.equal(deviceAccess.statusCode, 200, deviceAccess.body);
  assert.ok(String(deviceAccess.json().data.preferred_device_ws_url).endsWith('/device/v1/ws'));
  assert.ok(deviceAccess.json().data.device_ws_urls.some((candidate: { preferred: boolean }) => candidate.preferred));
  const publicDeviceAccess = await app.inject({ method: 'GET', url: '/api/v1/settings/device-access', headers: { ...adminHeaders, host: '8.8.8.8:9443' } });
  assert.equal(publicDeviceAccess.statusCode, 200, publicDeviceAccess.body);
  assert.equal(publicDeviceAccess.json().data.preferred_device_ws_url, 'ws://8.8.8.8:9443/device/v1/ws');
  assert.deepEqual(publicDeviceAccess.json().data.device_ws_urls[0], { url: 'ws://8.8.8.8:9443/device/v1/ws', host: '8.8.8.8', preferred: true });

  const firmwareContent = Buffer.from('custom firmware fixture');
  const firmwareUploadUrl = '/api/v1/admin/firmware-packages/upload?hardware_version=HW-TEST&channel=developer&version=v0.5.4-dev&crc16=4660&max_ble_chunk=180&release_notes=Local%20fixture';
  const firmwareUpload = await app.inject({ method: 'POST', url: firmwareUploadUrl, headers: { ...adminHeaders, 'content-type': 'application/octet-stream', 'content-length': String(firmwareContent.length) }, payload: firmwareContent });
  assert.equal(firmwareUpload.statusCode, 201, firmwareUpload.body);
  assert.equal(firmwareUpload.json().data.package_size, firmwareContent.length);
  assert.equal(firmwareUpload.json().data.source, 'uploaded');
  assert.deepEqual(await readFile(join(config.firmwareDir, firmwareUpload.json().data.object_path)), firmwareContent);
  const duplicateFirmware = await app.inject({ method: 'POST', url: firmwareUploadUrl, headers: { ...adminHeaders, 'content-type': 'application/octet-stream' }, payload: firmwareContent });
  assert.equal(duplicateFirmware.statusCode, 409, duplicateFirmware.body);
  const firmwareList = await app.inject({ method: 'GET', url: '/api/v1/admin/firmware-packages', headers: adminHeaders });
  assert.equal(firmwareList.statusCode, 200, firmwareList.body);
  assert.equal(firmwareList.json().data[0].version, 'v0.5.4-dev');
  const officialContent = Buffer.from('official firmware fixture'); const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/latest?')) return new Response(JSON.stringify({ success: true, data: { id: 'official-1', version: 'v0.5.5', hw_version: 'HW-OFFICIAL', release_channel: 'production', release_notes: 'Official fixture', package_size: officialContent.length, checksum: createHash('sha256').update(officialContent).digest('hex'), crc16: 22136, max_ble_chunk: 180, is_required: false, published_at: '2026-08-10T00:00:00.000Z', up_to_date: false, file_url: '/api/v1/public/device-firmware/official-1/file' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/official-1/file')) return new Response(officialContent, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(officialContent.length) } });
    throw new Error(`unexpected official firmware request: ${url}`);
  };
  try {
    const imported = await app.inject({ method: 'POST', url: '/api/v1/admin/firmware-packages/import-official', headers: adminHeaders, payload: { hardware_version: 'HW-OFFICIAL', channel: 'production' } });
    assert.equal(imported.statusCode, 201, imported.body); assert.equal(imported.json().data.imported, true); assert.equal(imported.json().data.source_url, 'https://api.voice-can.com/');
    assert.deepEqual(await readFile(join(config.firmwareDir, imported.json().data.firmware.object_path)), officialContent);
    const alreadyImported = await app.inject({ method: 'POST', url: '/api/v1/admin/firmware-packages/import-official', headers: adminHeaders, payload: { hardware_version: 'HW-OFFICIAL', channel: 'production' } });
    assert.equal(alreadyImported.statusCode, 200, alreadyImported.body); assert.equal(alreadyImported.json().data.imported, false);
  } finally { globalThis.fetch = originalFetch; }

  const shortPassword = await app.inject({ method: 'POST', url: '/api/v1/users', headers: adminHeaders, payload: { username: 'short-password-user', password: 'too-short' } });
  assert.equal(shortPassword.statusCode, 400, shortPassword.body);
  assert.equal(shortPassword.json().code, 'PASSWORD_POLICY_FAILED');
  assert.match(shortPassword.json().message, /12/);

  const user = await app.inject({ method: 'POST', url: '/api/v1/users', headers: adminHeaders, payload: { username: 'group-b-admin', password: 'another correct horse password' } });
  assert.equal(user.statusCode, 201, user.body);
  const group = await app.inject({ method: 'POST', url: '/api/v1/user-groups', headers: adminHeaders, payload: { name: 'Group B', group_admin_user_id: user.json().data.id } });
  assert.equal(group.statusCode, 201, group.body);
  const groupB = group.json().data.id as string;
  const member = await app.inject({ method: 'POST', url: '/api/v1/users', headers: adminHeaders, payload: { username: 'group-b-member', password: 'member correct horse password' } });
  assert.equal(member.statusCode, 201, member.body);
  const membership = await app.inject({ method: 'PUT', url: `/api/v1/user-groups/${groupB}/members`, headers: adminHeaders, payload: { user_id: member.json().data.id } });
  assert.equal(membership.statusCode, 201, membership.body);

  async function createToken(groupId: string): Promise<{ id: string; token: string }> {
    const response = await app.inject({ method: 'POST', url: `/api/v1/user-groups/${groupId}/api-tokens`, headers: adminHeaders, payload: { name: 'test', scopes: ['devices:read', 'files:read', 'events:read', 'sync:trigger'] } });
    assert.equal(response.statusCode, 201, response.body);
    return { id: response.json().data.id as string, token: response.json().data.token as string };
  }
  const tokenAResult = await createToken(setupData.group_id); const tokenA = tokenAResult.token;
  const tokenBResult = await createToken(groupB); const tokenB = tokenBResult.token;

  const simulated = await app.inject({ method: 'POST', url: '/api/v1/simulator/devices', headers: adminHeaders, payload: { manufacturer: 'Voicecan', sn: 'PREVIEW-0001', group_id: setupData.group_id } });
  assert.equal(simulated.statusCode, 201, simulated.body);
  const deviceId = simulated.json().data.device.id as string;
  const bleStatus = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/ble-status`, headers: adminHeaders, payload: {
    serial_number: 'PREVIEW-0001',
    info: { manufacturer: 'Voicecan', serialNumber: 'PREVIEW-0001', model: 'CAPSO', hardwareVersion: 'HW-TEST', firmwareVersion: 'v0.5.2' },
    status: {
      batteryPercent: 82, recording: false, wifiConfigured: true,
      operational: { recordState: 0, recordMode: 0, microphoneMode: 1, microphoneGainDb: 22, usbState: 0, wifiState: 1, wifiMode: 2, relayState: 0, privacyMode: false, earphoneRecording: true },
      storage: { totalKilobytes: 1024, freeKilobytes: 768, recordingHours: 12 },
      battery: { state: 'charging', stateCode: 2, percent: 82, temperatureC: 31, voltageMillivolts: 4012, workTimeSeconds: 600, accumulatedWorkTimeSeconds: 7200 },
    },
  } });
  assert.equal(bleStatus.statusCode, 200, bleStatus.body);
  const refreshedDevice = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}`, headers: adminHeaders });
  assert.equal(refreshedDevice.statusCode, 200, refreshedDevice.body);
  assert.equal(refreshedDevice.json().data.hardware_version, 'HW-TEST');
  assert.equal(refreshedDevice.json().data.firmware_version, 'v0.5.2');
  const refreshedStatus = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/status`, headers: adminHeaders });
  assert.equal(refreshedStatus.statusCode, 200, refreshedStatus.body);
  assert.equal(refreshedStatus.json().data.status.wifi_mode, 2);
  assert.equal(refreshedStatus.json().data.status.battery_temperature_c, 31);
  assert.ok(refreshedStatus.json().data.status.status_updated_at);
  const disconnectedControl = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/control`, headers: { ...adminHeaders, 'idempotency-key': 'disconnected-control' }, payload: { control: { kind: 'privacy', enabled: true }, reason: 'Exercise connection race guard' } });
  assert.equal(disconnectedControl.statusCode, 409, disconnectedControl.body);
  assert.equal(disconnectedControl.json().code, 'DEVICE_CONTROL_UNAVAILABLE');
  const renamedDevice = await app.inject({ method: 'PATCH', url: `/api/v1/devices/${deviceId}`, headers: adminHeaders, payload: { display_name: 'Meeting room recorder', reason: 'E2E friendly name' } });
  assert.equal(renamedDevice.statusCode, 200, renamedDevice.body);
  assert.equal(renamedDevice.json().data.display_name, 'Meeting room recorder');
  assert.equal(renamedDevice.json().data.sn, 'PREVIEW-0001');
  const crossGroupGrant = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers: adminHeaders, payload: { group_id: groupB, allowed_origin: 'https://trusted.test', expected_sn: 'PREVIEW-0001' } });
  assert.equal(crossGroupGrant.statusCode, 201, crossGroupGrant.body);
  const crossGroupClaim = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'https://trusted.test' }, payload: { provisioning_token: crossGroupGrant.json().data.provisioning_token, manufacturer: 'Voicecan', serial_number: 'PREVIEW-0001' } });
  assert.equal(crossGroupClaim.statusCode, 409, crossGroupClaim.body);
  assert.equal(crossGroupClaim.json().code, 'DEVICE_ALREADY_CLAIMED');
  assert.equal(crossGroupClaim.json().data, undefined, 'cross-group claims must not disclose the existing device ID');
  const content = Buffer.from('immutable recording fixture');
  const discovered = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers: adminHeaders, payload: { device_id: deviceId, session_id: 1_785_744_000, attribute: 0, content_length: content.length } });
  assert.equal(discovered.statusCode, 201, discovered.body);
  const fileId = discovered.json().data.file_id as string;
  const uploadPath = new URL(discovered.json().data.upload_url as string).pathname;
  const uploaded = await app.inject({ method: 'PUT', url: uploadPath, headers: { 'content-type': 'application/octet-stream', 'content-length': String(content.length) }, payload: content });
  assert.equal(uploaded.statusCode, 200, uploaded.body);

  const filesA = await app.inject({ method: 'GET', url: '/api/v1/files', headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(filesA.statusCode, 200, filesA.body);
  assert.deepEqual(filesA.json().data.items.map((item: { id: string }) => item.id), [fileId]);
  assert.equal(filesA.json().data.total_count, 1);
  assert.equal(filesA.json().data.count, 1);
  const filtered = await app.inject({ method: 'GET', url: `/api/v1/files?device_id=${deviceId}&attribute=0&status=synced&search=PREVIEW`, headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(filtered.json().data.total_count, 1);
  const forbiddenB = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}`, headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(forbiddenB.statusCode, 404);
  const downloadedA = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/content`, headers: { authorization: `Bearer ${tokenA}` } });
  assert.deepEqual(downloadedA.rawPayload, content);
  assert.equal(downloadedA.headers['accept-ranges'], 'bytes');
  const rangedA = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/content`, headers: { authorization: `Bearer ${tokenA}`, range: 'bytes=0-8' } });
  assert.equal(rangedA.statusCode, 206, rangedA.body);
  assert.deepEqual(rangedA.rawPayload, content.subarray(0, 9));
  const invalidRange = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/content`, headers: { authorization: `Bearer ${tokenA}`, range: 'bytes=999-1000' } });
  assert.equal(invalidRange.statusCode, 416, invalidRange.body);
  const failedAudits = await app.inject({ method: 'GET', url: '/api/v1/audit-logs?result=failure', headers: adminHeaders });
  assert.ok(failedAudits.json().data.some((entry: { reason: string }) => entry.reason === 'RANGE_NOT_SATISFIABLE'));

  const endpoint = await app.inject({ method: 'POST', url: '/api/v1/event-endpoints', headers: adminHeaders, payload: { group_id: setupData.group_id, url: 'http://127.0.0.1:1/hook' } });
  assert.equal(endpoint.statusCode, 201, endpoint.body);
  const endpointId = endpoint.json().data.id as string;
  const rotation = await app.inject({ method: 'POST', url: `/api/v1/event-endpoints/${endpointId}/rotate-secret`, headers: adminHeaders, payload: { activates_at: new Date(Date.now() + 120_000).toISOString() } });
  assert.equal(rotation.statusCode, 200, rotation.body);
  assert.notEqual(rotation.json().data.secret_id, endpoint.json().data.secret_id);
  const backfillPreview = await app.inject({ method: 'POST', url: `/api/v1/event-endpoints/${endpointId}/backfill-preview`, headers: adminHeaders, payload: { event_type: 'file.synced' } });
  assert.equal(backfillPreview.statusCode, 200, backfillPreview.body);
  assert.equal(backfillPreview.json().data.event_count, 1);
  const backfill = await app.inject({ method: 'POST', url: `/api/v1/event-endpoints/${endpointId}/backfill`, headers: adminHeaders, payload: { event_type: 'file.synced', resource_version: backfillPreview.json().data.resource_version, confirmation_token: backfillPreview.json().data.confirmation_token, reason: 'E2E replay verification' } });
  assert.equal(backfill.statusCode, 202, backfill.body);
  assert.equal(backfill.json().data.event_count, 1);
  const disabledEndpoint = await app.inject({ method: 'DELETE', url: `/api/v1/event-endpoints/${endpointId}`, headers: adminHeaders, payload: { reason: 'E2E lifecycle-safe disable' } });
  assert.equal(disabledEndpoint.statusCode, 200, disabledEndpoint.body);
  assert.equal(disabledEndpoint.json().data.enabled, false);
  const canceledDeliveries = await app.inject({ method: 'GET', url: `/api/v1/event-endpoints/${endpointId}/deliveries?status=canceled`, headers: adminHeaders });
  assert.equal(canceledDeliveries.statusCode, 200, canceledDeliveries.body);
  assert.ok(canceledDeliveries.json().data.length >= 1);

  const inFlightContent = Buffer.from('transfer fencing fixture');
  const inFlight = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers: adminHeaders, payload: { device_id: deviceId, session_id: 1_785_744_001, attribute: 0, content_length: inFlightContent.length } });
  assert.equal(inFlight.statusCode, 201, inFlight.body);
  const blockedPreview = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/transfer-preview`, headers: adminHeaders, payload: { target_group_id: groupB } });
  const blockedTransfer = await app.inject({ method: 'PUT', url: `/api/v1/devices/${deviceId}/group`, headers: adminHeaders, payload: { target_group_id: groupB, resource_version: blockedPreview.json().data.resource_version, confirmation_token: blockedPreview.json().data.confirmation_token, reason: 'must be blocked while uploading' } });
  assert.equal(blockedTransfer.statusCode, 409, blockedTransfer.body);
  const inFlightUpload = await app.inject({ method: 'PUT', url: new URL(inFlight.json().data.upload_url as string).pathname, headers: { 'content-type': 'application/octet-stream', 'content-length': String(inFlightContent.length) }, payload: inFlightContent });
  assert.equal(inFlightUpload.statusCode, 200, inFlightUpload.body);

  const retryFixture = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers: adminHeaders, payload: { device_id: deviceId, session_id: 1_785_744_002, attribute: 0, content_length: 10 } });
  const rejectedRetryUpload = await app.inject({ method: 'PUT', url: new URL(retryFixture.json().data.upload_url as string).pathname, headers: { 'content-type': 'application/octet-stream', 'content-length': '9' }, payload: Buffer.alloc(9) });
  assert.equal(rejectedRetryUpload.statusCode, 400, rejectedRetryUpload.body);
  const retryResponse = await app.inject({ method: 'POST', url: `/api/v1/recordings/${retryFixture.json().data.file_id}/retry`, headers: adminHeaders, payload: { reason: 'E2E retry recovery' } });
  assert.equal(retryResponse.statusCode, 202, retryResponse.body);
  assert.equal(retryResponse.json().data.status, 'pending');

  const resetFixture = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers: adminHeaders, payload: { device_id: deviceId, session_id: 1_785_744_003, attribute: 0, content_length: 10 } });
  const rejectedResetUpload = await app.inject({ method: 'PUT', url: new URL(resetFixture.json().data.upload_url as string).pathname, headers: { 'content-type': 'application/octet-stream', 'content-length': '9' }, payload: Buffer.alloc(9) });
  assert.equal(rejectedResetUpload.statusCode, 400, rejectedResetUpload.body);
  const resetResponse = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/recording-sync/reset`, headers: adminHeaders, payload: { mode: 'failed', reason: 'E2E batch recovery' } });
  assert.equal(resetResponse.statusCode, 202, resetResponse.body);
  assert.equal(resetResponse.json().data.recordings_deleted, false);
  assert.ok(resetResponse.json().data.reset_count >= 1);
  const syncWorkspace = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/recording-sync`, headers: adminHeaders });
  assert.equal(syncWorkspace.statusCode, 200, syncWorkspace.body);
  assert.equal(syncWorkspace.json().data.device.connection_status, 'online');
  assert.equal(syncWorkspace.json().data.reset_policy.deletes_recordings, false);

  const preview = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/transfer-preview`, headers: adminHeaders, payload: { target_group_id: groupB } });
  assert.equal(preview.statusCode, 200, preview.body);
  const transferPayload = { target_group_id: groupB, resource_version: preview.json().data.resource_version, confirmation_token: preview.json().data.confirmation_token, reason: 'E2E ownership transfer' };
  const concurrentTransfers = await Promise.all([
    app.inject({ method: 'PUT', url: `/api/v1/devices/${deviceId}/group`, headers: adminHeaders, payload: transferPayload }),
    app.inject({ method: 'PUT', url: `/api/v1/devices/${deviceId}/group`, headers: adminHeaders, payload: transferPayload }),
  ]);
  assert.deepEqual(concurrentTransfers.map((response) => response.statusCode).sort(), [200, 409]);
  const revokedA = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}`, headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(revokedA.statusCode, 404);
  const availableB = await app.inject({ method: 'GET', url: `/api/v1/files/${fileId}`, headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(availableB.statusCode, 200, availableB.body);
  const eventsA = await app.inject({ method: 'GET', url: '/api/v1/events', headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(eventsA.json().data.items.length, 0);
  assert.equal(eventsA.json().data.total_count, 0);
  const eventsB = await app.inject({ method: 'GET', url: '/api/v1/events', headers: { authorization: `Bearer ${tokenB}` } });
  assert.ok(eventsB.json().data.items.length >= 1);
  assert.equal(eventsB.json().data.count, eventsB.json().data.items.length);
  assert.ok(eventsB.json().data.total_count >= eventsB.json().data.items.length);
  const oneEventB = await app.inject({ method: 'GET', url: '/api/v1/events?limit=1', headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(oneEventB.json().data.items.length, 1);
  assert.equal(oneEventB.json().data.count, 1);
  assert.equal(oneEventB.json().data.total_count, eventsB.json().data.total_count);

  const groupBLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'group-b-admin', password: 'another correct horse password' } });
  assert.equal(groupBLogin.statusCode, 200, groupBLogin.body);
  const groupBCookie = String(groupBLogin.headers['set-cookie']).split(';')[0]!;
  const groupBFiles = await app.inject({ method: 'GET', url: '/api/v1/files', headers: { cookie: groupBCookie } });
  assert.equal(groupBFiles.statusCode, 200, groupBFiles.body);
  const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/users/${user.json().data.id}`, headers: adminHeaders, payload: { disabled: true, reason: 'E2E immediate revocation' } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  const disabledSession = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: groupBCookie } });
  assert.equal(disabledSession.statusCode, 401);

  const memberLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'group-b-member', password: 'member correct horse password' } });
  assert.equal(memberLogin.statusCode, 200, memberLogin.body);
  const memberCookie = String(memberLogin.headers['set-cookie']).split(';')[0]!;
  const removedMember = await app.inject({ method: 'DELETE', url: `/api/v1/user-groups/${groupB}/members/${member.json().data.id}`, headers: adminHeaders });
  assert.equal(removedMember.statusCode, 200, removedMember.body);
  const removedMemberSession = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: memberCookie } });
  assert.equal(removedMemberSession.statusCode, 401);

  const revokedToken = await app.inject({ method: 'DELETE', url: `/api/v1/user-groups/${setupData.group_id}/api-tokens/${tokenAResult.id}`, headers: adminHeaders });
  assert.equal(revokedToken.statusCode, 200, revokedToken.body);
  const revokedTokenAccess = await app.inject({ method: 'GET', url: '/api/v1/files', headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(revokedTokenAccess.statusCode, 401);

  const csrfRefresh = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { cookie } });
  assert.equal(csrfRefresh.statusCode, 200, csrfRefresh.body);
  assert.equal(csrfRefresh.headers['cache-control'], 'no-store');
  const refreshedCsrf = csrfRefresh.json().data.csrf_token as string;
  assert.notEqual(refreshedCsrf, csrf);
  const staleCsrfWrite = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers: adminHeaders, payload: { group_id: setupData.group_id, allowed_origin: 'http://localhost' } });
  assert.equal(staleCsrfWrite.statusCode, 403, staleCsrfWrite.body);
  const refreshedCsrfWrite = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions', headers: { cookie, 'x-csrf-token': refreshedCsrf }, payload: { group_id: setupData.group_id, allowed_origin: 'http://localhost' } });
  assert.equal(refreshedCsrfWrite.statusCode, 201, refreshedCsrfWrite.body);

  app.beginDrain();
  const draining = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(draining.statusCode, 503);
  assert.equal(draining.json().data.status, 'draining');
});
