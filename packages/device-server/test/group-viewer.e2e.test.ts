import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { VIEWER_FIXTURE_IDS, seedViewerFixture } from './helpers/group-viewer-fixture.js';
import { migrate } from '../src/migrate.js';

const passwords = { admin: 'admin test correct horse battery staple', viewer: 'viewer test correct horse battery staple' };

test('Group viewer shares recordings without business writes or Application/OAuth escalation', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-group-viewer-'));
  const config = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DEPLOYMENT_PROFILE: 'edge', VOICECAN_VIEWER_ALLOW_PASSWORD_CHANGE: 'false', VOICECAN_LOG_LEVEL: 'silent' });
  migrate(config); await seedViewerFixture(config, passwords);
  const offline = new DatabaseSync(config.databaseFile);
  offline.prepare('INSERT INTO user_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('group_other', 'Other group', '2026-01-01', '2026-01-01');
  offline.prepare('INSERT INTO devices(id,manufacturer,sn,group_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('dev_other', 'Demo', 'OTHER', 'group_other', '2026-01-01', '2026-01-01');
  offline.prepare('INSERT INTO recording_files(id,device_id,credential_epoch,session_id,attribute,revision,expected_size,status,created_at,updated_at) VALUES(?,?,1,1,1,1,1,?,?,?)').run('file_other', 'dev_other', 'pending', '2026-01-01', '2026-01-01');
  offline.prepare("UPDATE recording_files SET actual_size=999999,status='synced' WHERE id='file_other'").run();
  offline.prepare('INSERT INTO users(id,username,normalized_username,display_name,role,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('user_other', 'other', 'other', 'Other private user', 'user', 'not-a-password-hash', '2026-01-01', '2026-01-01');
  offline.prepare('INSERT INTO group_memberships(id,user_id,group_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('membership_other', 'user_other', 'group_other', 'group_admin', '2026-01-01', '2026-01-01');
  offline.prepare('INSERT INTO open_platform_applications(id,group_id,name,owner_user_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('app_other', 'group_other', 'Other private application', 'user_other', 'user_other', '2026-01-01', '2026-01-01');
  offline.prepare('INSERT INTO open_platform_api_logs(id,application_id,actor_id,channel,method,route,status_code,duration_ms,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('log_other', 'app_other', 'user_other', 'rest', 'GET', '/private', 200, 1, 'private', '2026-01-01');
  offline.prepare('INSERT INTO open_platform_security_alerts(id,application_id,severity,code,details_json,created_at) VALUES(?,?,?,?,?,?)').run('alert_other', 'app_other', 'warning', 'PRIVATE_ALERT', '{}', '2026-01-01');
  offline.close();
  const app = await buildServer(config);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = async (username: string, password: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body);
    const cookies = response.headers['set-cookie'] as string[];
    return { cookie: cookies.map(value => value.split(';')[0]).join('; '), 'x-csrf-token': response.json().data.csrf_token as string };
  };
  const viewer = await login('fixture-viewer', passwords.viewer);
  const admin = await login('fixture-admin', passwords.admin);
  const me = await app.inject({ url: '/api/v1/auth/me', headers: viewer });
  assert.equal(me.json().data.membership_role, 'viewer'); assert.equal(me.json().data.can_change_password, false); assert.equal(me.json().data.can_mutate_group, false);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: admin })).json().data.can_change_password, true);
  const devices = await app.inject({ url: '/api/v1/devices', headers: viewer });
  assert.deepEqual(devices.json().data.map((device: { id: string }) => device.id), [VIEWER_FIXTURE_IDS.device]);
  for (const path of ['/api/v1/devices/dev_other', '/api/v1/devices/missing', '/api/v1/files/file_other', '/api/v1/files/missing', '/api/v1/recordings/file_other', '/api/v1/recordings/missing']) {
    const response = await app.inject({ url: path, headers: viewer }); assert.equal(response.statusCode, 404, path);
  }
  // Viewing administrative metadata is group-scoped, independent of application
  // collaboration. It does not delegate OAuth consent or disclose secrets.
  for (const path of ['/api/v1/users', '/api/v1/user-groups', `/api/v1/user-groups/${VIEWER_FIXTURE_IDS.group}/members`, '/api/v1/open-platform/applications', `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}`, `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}/credentials`, `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}/oauth-clients`, `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}/webhooks/${VIEWER_FIXTURE_IDS.webhook}/deliveries`, `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}/usage`, `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}/audit`, '/api/v1/open-platform/overview', '/api/v1/open-platform/oauth-clients', '/api/v1/open-platform/call-logs', '/api/v1/open-platform/download-grants', '/api/v1/open-platform/security-alerts', '/api/v1/event-endpoints', `/api/v1/event-endpoints/${VIEWER_FIXTURE_IDS.webhook}/deliveries?status=dead`, '/api/v1/audit-logs', '/api/v1/admin/storage']) {
    const response = await app.inject({ url: path, headers: viewer });
    assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
    assert.doesNotMatch(response.body, /user_other|app_other|group_other|log_other|alert_other|password_hash|token_hash|secret_ciphertext|token_ciphertext/);
  }
  const detail = (await app.inject({ url: `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}`, headers: viewer })).json().data;
  assert.equal(detail.collaborator_role, 'viewer'); assert.equal(detail.credentials[0].status, 'revoked'); assert.equal(detail.webhooks[0].enabled, false);
  assert.ok(detail.permissions.includes('devices:sync'), 'Inspecting configured write permissions does not grant them');
  const storage = (await app.inject({ url: '/api/v1/admin/storage', headers: viewer })).json().data;
  assert.equal(storage.scope, 'group'); assert.equal(storage.stored_bytes, 64_044); assert.equal(storage.capacity, null);
  for (const path of ['/api/v1/user-groups/group_other/members', '/api/v1/user-groups/missing/members', '/api/v1/open-platform/applications/app_other', '/api/v1/open-platform/applications/missing', '/api/v1/admin/backups/status', '/api/v1/admin/backups/export']) {
    assert.equal((await app.inject({ url: path, headers: viewer })).statusCode, 404, path);
  }
  const audio = await app.inject({ url: `/api/v1/files/${VIEWER_FIXTURE_IDS.recording}/content`, headers: viewer });
  assert.equal(audio.statusCode, 200, audio.body); assert.match(String(audio.headers['content-type']), /audio\/wav/);
  assert.equal(audio.rawPayload.length, 64_044);
  const recording = (await app.inject({ url: `/api/v1/recordings/${VIEWER_FIXTURE_IDS.recording}`, headers: viewer })).json().data;
  assert.equal(createHash('sha256').update(audio.rawPayload).digest('hex'), recording.sha256);
  for (const [method, url, payload] of [
    ['POST', `/api/v1/devices/${VIEWER_FIXTURE_IDS.device}/sync`, {}],
    ['POST', `/api/v1/devices/${VIEWER_FIXTURE_IDS.device}/commands`, { kind: 'sync' }],
    ['POST', `/api/v1/recordings/${VIEWER_FIXTURE_IDS.recording}/retry`, { reason: 'test' }],
    ['POST', `/api/v1/devices/${VIEWER_FIXTURE_IDS.device}/recording-sync/reset`, { reason: 'test' }],
    ['POST', '/api/v1/open-platform/applications', { group_id: VIEWER_FIXTURE_IDS.group, name: 'Denied' }],
    ['POST', '/api/v1/provisioning-sessions', {}],
    ['PUT', `/api/v1/user-groups/${VIEWER_FIXTURE_IDS.group}/members`, { user_id: VIEWER_FIXTURE_IDS.viewer, role: 'member' }],
    ['POST', '/api/v1/event-endpoints', { url: 'https://example.test/hook' }],
    ['POST', '/api/v1/admin/backups/create', {}],
    ['PATCH', '/api/v1/admin/storage', { max_storage_bytes: 1, reason: 'test' }],
    ['PATCH', `/api/v1/users/${VIEWER_FIXTURE_IDS.viewer}`, { role: 'system_admin', reason: 'test' }],
    ['POST', `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}/credentials`, { name: 'test', reason: 'test' }],
    ['PUT', `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}/permissions`, { permissions: ['devices:sync'], reason: 'test' }],
    ['DELETE', `/api/v1/open-platform/applications/${VIEWER_FIXTURE_IDS.application}`, { reason: 'test' }],
    ['POST', '/api/v1/open-platform/security-alerts/resolve-all', { reason: 'test' }],
    ['POST', '/api/v1/event-deliveries/delivery_fixture_dead/replay', { reason: 'test' }],
  ] as const) {
    const response = await app.inject({ method, url, headers: viewer, payload });
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`); assert.equal(response.json().code, 'VIEWER_READ_ONLY');
  }
  const passwordDenied = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: viewer, payload: {} });
  assert.equal(passwordDenied.statusCode, 403); assert.equal(passwordDenied.json().code, 'PASSWORD_CHANGE_DISABLED');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: viewer, payload: {} })).statusCode, 200);

  const permissions = ['devices:read', 'devices:sync', 'recordings:read', 'recordings:download_link:create'];
  const application = await app.inject({ method: 'POST', url: '/api/v1/open-platform/applications', headers: admin, payload: { group_id: VIEWER_FIXTURE_IDS.group, name: 'Viewer cap', channels: ['rest', 'mcp_remote'], permissions } });
  assert.equal(application.statusCode, 201, application.body); const applicationId = application.json().data.id as string;
  const collaborator = await app.inject({ method: 'POST', url: `/api/v1/open-platform/applications/${applicationId}/collaborators`, headers: admin, payload: { user_id: VIEWER_FIXTURE_IDS.viewer, role: 'developer', reason: 'Test Group viewer upper bound' } });
  assert.equal(collaborator.statusCode, 201, collaborator.body);
  assert.equal((await app.inject({ url: `/api/v1/open-platform/applications/${applicationId}`, headers: viewer })).statusCode, 200);
  const credential = await app.inject({ method: 'POST', url: `/api/v1/open-platform/applications/${applicationId}/credentials`, headers: viewer, payload: { name: 'Escalation', reason: 'test' } });
  assert.equal(credential.statusCode, 403);
  const client = await app.inject({ method: 'POST', url: `/api/v1/open-platform/applications/${applicationId}/oauth-clients`, headers: admin, payload: { name: 'Viewer test', redirect_uris: ['http://127.0.0.1/callback'], scopes: permissions, reason: 'test' } });
  assert.equal(client.statusCode, 201, client.body);
  const verifier = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
  const query = { client_id: client.json().data.id, redirect_uri: 'http://127.0.0.1/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: 'http://127.0.0.1:8787/mcp', scope: 'devices:sync' };
  const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: viewer, payload: { request: Buffer.from(JSON.stringify(query)).toString('base64url'), approved: true } });
  assert.equal(consent.statusCode, 400, consent.body); assert.equal(consent.json().code, 'INVALID_SCOPE');
  const readConsent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: viewer, payload: { request: Buffer.from(JSON.stringify({ ...query, scope: 'recordings:read recordings:download_link:create' })).toString('base64url'), approved: true } });
  assert.equal(readConsent.statusCode, 200, readConsent.body);

  // Membership changes are effective on the next request, including existing sessions.
  const updateRole = async (role: string) => app.inject({ method: 'PUT', url: `/api/v1/user-groups/${VIEWER_FIXTURE_IDS.group}/members`, headers: admin, payload: { user_id: VIEWER_FIXTURE_IDS.viewer, role } });
  assert.equal((await updateRole('system_admin')).statusCode, 400);
  assert.equal((await updateRole('member')).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: viewer })).json().data.can_change_password, true);
  assert.equal((await updateRole('viewer')).statusCode, 200);
  const reset = await app.inject({ method: 'PUT', url: `/api/v1/users/${VIEWER_FIXTURE_IDS.viewer}/password`, headers: admin, payload: { password: 'new shared viewer password' } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: viewer })).statusCode, 401);
  const fresh = await login('fixture-viewer', 'new shared viewer password');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: fresh, payload: {} })).statusCode, 200);
});

test('viewer password changes default to enabled; disabled policy is strict and scoped to Group viewers', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-viewer-password-'));
  const seedConfig = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_DEPLOYMENT_PROFILE: 'edge', VOICECAN_VIEWER_ALLOW_PASSWORD_CHANGE: 'false', VOICECAN_LOG_LEVEL: 'silent' });
  migrate(seedConfig); await seedViewerFixture(seedConfig, passwords);
  const config = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_LOG_LEVEL: 'silent' });
  assert.equal(config.viewerAllowPasswordChange, true);
  await assert.rejects(loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_VIEWER_ALLOW_PASSWORD_CHANGE: 'no' }), /must be true or false/);
  const app = await buildServer(config);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'fixture-viewer', password: passwords.viewer } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token as string };
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers })).json().data.can_change_password, true);
  const changed = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers, payload: { current_password: passwords.viewer, new_password: 'viewer changed own password' } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers })).statusCode, 401);
});
