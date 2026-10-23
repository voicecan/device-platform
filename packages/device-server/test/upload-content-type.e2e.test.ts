import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

test('device upload accepts audio/lc3 and bodies larger than the JSON body limit', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-upload-'));
  const config = await loadConfig({
    VOICECAN_DATA_DIR: dataDir,
    VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    VOICECAN_CONNECT_WEB_URL: 'https://connector.example.test/connect/',
    VOICECAN_SIMULATOR: 'true',
    VOICECAN_DISK_WARNING_RATIO: '0.98',
    VOICECAN_DISK_STOP_RATIO: '0.999',
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
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const csrf = login.json().data.csrf_token as string;
  const adminHeaders = { cookie, 'x-csrf-token': csrf };

  const device = await app.inject({ method: 'POST', url: '/api/v1/simulator/devices', headers: adminHeaders, payload: { manufacturer: 'Voicecan', sn: 'UPLOAD-0001', group_id: groupId } });
  assert.equal(device.statusCode, 201, device.body);
  const deviceId = device.json().data.device.id as string;

  const content = Buffer.alloc(2 * 1024 * 1024, 0x42);
  const discovered = await app.inject({ method: 'POST', url: '/api/v1/simulator/files', headers: adminHeaders, payload: { device_id: deviceId, session_id: 1_786_000_123, attribute: 0, content_length: content.length } });
  assert.equal(discovered.statusCode, 201, discovered.body);
  const uploadPath = new URL(discovered.json().data.upload_url as string).pathname;

  const uploaded = await app.inject({ method: 'PUT', url: uploadPath, headers: { 'content-type': 'audio/lc3', 'content-length': String(content.length) }, payload: content });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  assert.equal(uploaded.json().data.size, content.length);
});
