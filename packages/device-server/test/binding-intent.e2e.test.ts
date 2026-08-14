import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

test('binding intent survives browser refresh and remains server-authoritative without a page callback', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-binding-intent-'));
  const config = await loadConfig({
    VOICECAN_DATA_DIR: dataDir,
    VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    VOICECAN_DEVICE_ADVERTISE_HOST: '192.168.50.20',
    VOICECAN_LOG_LEVEL: 'silent',
  });
  migrate(config);
  const app = await buildServer(config);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  const setupToken = (await readFile(join(dataDir, 'setup-token'), 'utf8')).trim();
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: setupToken, username: 'admin', password: 'correct horse battery staple' } });
  assert.equal(setup.statusCode, 201, setup.body);
  const groupId = setup.json().data.group_id as string;
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'correct horse battery staple' } });
  const adminHeaders = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token as string };

  const localGroups = await app.inject({ method: 'GET', url: '/api/v1/user-groups', headers: { authorization: `Bearer vcd_local_${config.localOperatorKey.toString('base64url')}` } });
  assert.equal(localGroups.statusCode, 200, localGroups.body);
  assert.equal(localGroups.json().data[0].id, groupId);
  const rejectedLocalKey = await app.inject({ method: 'GET', url: '/api/v1/user-groups', headers: { authorization: 'Bearer vcd_local_invalid' } });
  assert.equal(rejectedLocalKey.statusCode, 401, rejectedLocalKey.body);

  const created = await app.inject({ method: 'POST', url: '/api/v1/binding-intents', headers: adminHeaders, payload: { group_id: groupId, allowed_origin: 'http://127.0.0.1:8787', expected_sn: 'INTENT-0001', display_name: 'AI prepared recorder', network_mode: 'existing', locale: 'en', idempotency_key: 'binding-test-1' } });
  assert.equal(created.statusCode, 201, created.body);
  const intentId = created.json().data.id as string;
  const launchUrl = new URL(created.json().data.launch_url as string);
  assert.equal(launchUrl.searchParams.get('binding_intent'), intentId);
  const launchToken = new URLSearchParams(launchUrl.hash.slice(1)).get('launch');
  assert.ok(launchToken?.startsWith('vcd_bind_'));

  const exchanged = await app.inject({ method: 'POST', url: '/api/v1/binding-intents/exchange', headers: { origin: 'http://127.0.0.1:8787' }, payload: { launch_token: launchToken } });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.equal(exchanged.json().data.status, 'user_action');
  const browserCookie = String(exchanged.headers['set-cookie']).split(';')[0]!;
  assert.match(browserCookie, /^vc_binding=/);
  const launchReplay = await app.inject({ method: 'POST', url: '/api/v1/binding-intents/exchange', headers: { origin: 'http://127.0.0.1:8787' }, payload: { launch_token: launchToken } });
  assert.equal(launchReplay.statusCode, 403, launchReplay.body);

  const refreshedBeforeSelection = await app.inject({ method: 'GET', url: `/api/v1/binding-intents/${intentId}/browser`, headers: { cookie: browserCookie } });
  assert.equal(refreshedBeforeSelection.statusCode, 200, refreshedBeforeSelection.body);
  assert.equal(refreshedBeforeSelection.json().data.display_name, 'AI prepared recorder');
  assert.equal(refreshedBeforeSelection.json().data.device_ws_url, 'ws://192.168.50.20:8787/device/v1/ws');

  const grant = await app.inject({ method: 'POST', url: `/api/v1/binding-intents/${intentId}/grant`, headers: { cookie: browserCookie }, payload: {} });
  assert.equal(grant.statusCode, 200, grant.body);
  const claim = await app.inject({ method: 'POST', url: '/api/v1/provisioning-sessions/claim', headers: { origin: 'http://127.0.0.1:8787' }, payload: { provisioning_token: grant.json().data.provisioning_token, manufacturer: 'Voicecan', serial_number: 'INTENT-0001', bluetooth_name: 'CAPSO-INTENT' } });
  assert.equal(claim.statusCode, 201, claim.body);
  assert.equal(claim.json().data.display_name, 'AI prepared recorder');
  for (const stage of ['ble_authenticated', 'configured']) {
    const progress = await app.inject({ method: 'POST', url: `/api/v1/provisioning-sessions/${claim.json().data.provisioning_session_id}/progress`, headers: { origin: 'http://127.0.0.1:8787' }, payload: { continuation_token: claim.json().data.continuation_token, stage } });
    assert.equal(progress.statusCode, 200, progress.body);
  }

  const refreshedAfterConfiguration = await app.inject({ method: 'GET', url: `/api/v1/binding-intents/${intentId}/browser`, headers: { cookie: browserCookie } });
  assert.equal(refreshedAfterConfiguration.statusCode, 200, refreshedAfterConfiguration.body);
  assert.equal(refreshedAfterConfiguration.json().data.status, 'configured');
  assert.equal(refreshedAfterConfiguration.json().data.device_id, claim.json().data.device_id);
  const authoritativeStatus = await app.inject({ method: 'GET', url: `/api/v1/binding-intents/${intentId}`, headers: adminHeaders });
  assert.equal(authoritativeStatus.statusCode, 200, authoritativeStatus.body);
  assert.equal(authoritativeStatus.json().data.status, 'configured');
  assert.equal(authoritativeStatus.json().data.device_id, claim.json().data.device_id);
});
