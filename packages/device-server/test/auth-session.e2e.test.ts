import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

test('human sessions renew while the admin page is active', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-auth-session-'));
  const config = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8787', VOICECAN_LOG_LEVEL: 'silent' });
  migrate(config);
  const app = await buildServer(config);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  const setupToken = (await readFile(join(dataDir, 'setup-token'), 'utf8')).trim();
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: setupToken, username: 'admin', password: 'fixture correct horse battery staple' } });
  assert.equal(setup.statusCode, 201, setup.body);

  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'fixture correct horse battery staple' } });
  assert.equal(login.statusCode, 200, login.body);
  const loginCookies = login.headers['set-cookie'];
  assert.ok(Array.isArray(loginCookies));
  const cookie = loginCookies.map((value) => String(value).split(';')[0]).join('; ');
  const csrf = login.json().data.csrf_token as string;

  const refreshed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie, 'x-csrf-token': csrf }, payload: {} });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.ok(Date.parse(refreshed.json().data.expires_at) > Date.now() + 11 * 60 * 60_000);
  const refreshedCookies = refreshed.headers['set-cookie'];
  assert.ok(Array.isArray(refreshedCookies));
  assert.ok(refreshedCookies.some((value) => String(value).startsWith('vc_session=') && String(value).includes('Max-Age=43200')));
  assert.ok(refreshedCookies.some((value) => String(value).startsWith('vc_csrf=') && String(value).includes('Max-Age=43200')));

  const withoutCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie }, payload: {} });
  assert.equal(withoutCsrf.statusCode, 403, withoutCsrf.body);
  assert.equal(withoutCsrf.json().code, 'CSRF_FAILED');

  const anonymous = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: {} });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  assert.equal(anonymous.json().code, 'UNAUTHENTICATED');
});
