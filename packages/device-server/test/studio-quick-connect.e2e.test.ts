import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

test('Studio quick setup is local, scoped, secret-free, reusable and refuses revoked credentials', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-quick-studio-'));
  const config = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8787', VOICECAN_LOG_LEVEL: 'silent' });
  migrate(config); const app = await buildServer(config); config.publicBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const originalFetch = globalThis.fetch; let accepting = false, configured = false, applicationId = '', posts = 0;
  globalThis.fetch = (async (url, options) => {
    if (String(url) === 'http://127.0.0.1:8815/api/v1/runtime') { if (!accepting) throw new Error('offline'); return new Response(JSON.stringify({ profile: 'local-full', configured, application_id: applicationId, platform_url: config.publicBaseUrl }), { headers: { 'content-type': 'application/json' } }); }
    if (String(url) === 'http://127.0.0.1:8815/api/local-connection') { posts++; const body = JSON.parse(String(options?.body)); applicationId = body.application_id; configured = true; return new Response('{}', { status: 202 }); }
    return originalFetch(url, options);
  }) as typeof fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: (await readFile(join(dataDir, 'setup-token'), 'utf8')).trim(), username: 'admin', password: 'correct horse battery staple' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'correct horse battery staple' } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token, origin: config.publicBaseUrl };
  const url = '/api/v1/open-platform/studio-quick-connect', payload = { group_id: setup.json().data.group_id };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).json().code, 'STUDIO_NOT_RUNNING');
  assert.equal((await app.inject({ url: '/api/v1/open-platform/applications', headers })).json().data.length, 0);
  accepting = true;
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'http://evil.invalid' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload, remoteAddress: '192.168.1.10' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie, origin: config.publicBaseUrl }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, scopes: ['devices:sync'] } })).statusCode, 400);
  const created = await app.inject({ method: 'POST', url, headers, payload }); assert.equal(created.statusCode, 200, created.body);
  const plan = created.json().data; assert.deepEqual(plan.scopes, ['devices:read', 'recordings:read', 'recordings:download_link:create']); assert.equal(created.body.includes('vcd_app_'), false); assert.equal('secret_ref' in plan, false);
  const folder = join(dataDir, 'studio-connections'), names = await readdir(folder), tokenFile = names.find((name) => name.endsWith('.token'))!;
  const secret = await readFile(join(folder, tokenFile), 'utf8'); assert.equal((await stat(join(folder, tokenFile))).mode & 0o077, 0);
  const caps = await app.inject({ url: '/api/v1/capabilities', headers: { authorization: `Bearer ${secret}` } }); assert.equal(caps.statusCode, 200); assert.deepEqual(caps.json().data.scopes.sort(), [...plan.scopes].sort());
  const reused = await app.inject({ method: 'POST', url, headers, payload }); assert.equal(reused.statusCode, 200, reused.body); assert.equal(reused.json().data.credential_id, plan.credential_id); assert.equal(posts, 1);
  await app.inject({ method: 'DELETE', url: `/api/v1/open-platform/applications/${plan.application_id}/credentials/${plan.credential_id}`, headers, payload: { reason: 'Test revocation' } });
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 409); assert.equal(posts, 1);
});
