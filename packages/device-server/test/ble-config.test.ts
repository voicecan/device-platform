import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

test('BLE discovery startup UUID defaults, normalizes, and rejects invalid configuration', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-ble-config-'));
  try {
    const environment = { VOICECAN_DATA_DIR: dataDir, VOICECAN_LOG_LEVEL: 'silent' };
    assert.equal((await loadConfig(environment)).bleServiceUuid, '00001a10-0000-1000-8000-00805f9b34fb');
    for (const value of [' 1A11 ', '00001A11', '00001A11-0000-1000-8000-00805F9B34FB']) {
      assert.equal((await loadConfig({ ...environment, VOICECAN_BLE_SERVICE_UUID: value })).bleServiceUuid, '00001a11-0000-1000-8000-00805f9b34fb');
    }
    await assert.rejects(loadConfig({ ...environment, VOICECAN_BLE_SERVICE_UUID: 'CAPSO-' }), /VOICECAN_BLE_SERVICE_UUID/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('migration removes legacy discovery columns and preserves existing settings', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-ble-migrate-'));
  try {
    const config = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_LOG_LEVEL: 'silent' });
    migrate(config);
    const old = new DatabaseSync(config.databaseFile);
    old.exec("ALTER TABLE server_settings ADD COLUMN ble_name_prefix TEXT NOT NULL DEFAULT 'CUSTOM-'; ALTER TABLE binding_intents ADD COLUMN ble_name_prefix TEXT NOT NULL DEFAULT 'CUSTOM-'");
    const settings = old.prepare('SELECT singleton,master_key_version FROM server_settings').all();
    old.close();
    migrate(config); migrate(config);
    const current = new DatabaseSync(config.databaseFile);
    try {
      for (const table of ['server_settings', 'binding_intents']) {
        assert.ok(!(current.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((column) => column.name === 'ble_name_prefix'));
      }
      assert.deepEqual(current.prepare('SELECT singleton,master_key_version FROM server_settings').all(), settings);
    } finally { current.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
