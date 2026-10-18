import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { buildServer } from '../src/app.js';
import { restoreBackup } from '../src/maintenance.js';

test('automatic recovery copy restores administrator and device access and retains three snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'elio-recovery-test-'));
  const settings = { VOICECAN_PUBLIC_BASE_URL: 'http://127.0.0.1:8788', VOICECAN_SIMULATOR: 'true', VOICECAN_LOG_LEVEL: 'silent' };
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    const config = await loadConfig({ ...settings, VOICECAN_DATA_DIR: join(root, 'original') });
    migrate(config); app = await buildServer(config);
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { setup_token: (await readFile(join(config.dataDir, 'setup-token'), 'utf8')).trim(), username: 'recovery-admin', password: 'test recovery password phrase' } });
    assert.equal(setup.statusCode, 201);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'recovery-admin', password: 'test recovery password phrase' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token as string };
    const device = await app.inject({ method: 'POST', url: '/api/v1/simulator/devices', headers, payload: { manufacturer: 'Voicecan', sn: 'RECOVERY-TEST', group_id: setup.json().data.group_id } });
    assert.equal(device.statusCode, 201);
    const deviceId = device.json().data.device.id as string;
    let directory = '';
    for (let count = 0; count < 4; count += 1) {
      const backup = await app.inject({ method: 'POST', url: '/api/v1/admin/backups/create', headers, payload: {} });
      assert.equal(backup.statusCode, 200); assert.equal(backup.json().data.current, true);
      directory = backup.json().data.latest.directory as string;
    }
    assert.equal((await readdir(join(config.dataDir, 'recovery-backups'))).filter((name) => name.startsWith('snapshot-')).length, 3);
    await app.close(); app = undefined;
    const destination = join(root, 'restored');
    await restoreBackup(directory, destination);
    const restored = await loadConfig({ ...settings, VOICECAN_DATA_DIR: destination });
    app = await buildServer(restored);
    const restoredLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'recovery-admin', password: 'test recovery password phrase' } });
    assert.equal(restoredLogin.statusCode, 200);
    const grant = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/ble-maintenance-session`, headers: { cookie: String(restoredLogin.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': restoredLogin.json().data.csrf_token as string }, payload: {} });
    assert.equal(grant.statusCode, 200, 'restored device credential must remain usable');
    assert.equal(grant.json().data.serial_number, 'RECOVERY-TEST');
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});
