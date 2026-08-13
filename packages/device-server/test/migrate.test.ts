import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { SCHEMA_VERSION } from '../src/schema.js';

test('migration upgrades the v1 delivery ledger and remains idempotent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'voicecan-migrate-'));
  try {
    const config = await loadConfig({ VOICECAN_DATA_DIR: dataDir, VOICECAN_LOG_LEVEL: 'silent' });
    const old = new DatabaseSync(config.databaseFile);
    old.exec(`CREATE TABLE event_deliveries (
      id TEXT PRIMARY KEY,event_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,delivered_at TEXT,last_error TEXT,created_at TEXT NOT NULL,
      UNIQUE(event_id,endpoint_id)
    );
    CREATE TABLE recording_files (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    old.close();
    migrate(config); migrate(config);
    const current = new DatabaseSync(config.databaseFile, { readOnly: true });
    const columns = current.prepare('PRAGMA table_info(event_deliveries)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'replay_namespace'));
    assert.ok(columns.some((column) => column.name === 'claimed_by'));
    assert.ok(columns.some((column) => column.name === 'claim_expires_at'));
    assert.ok(columns.some((column) => column.name === 'last_status_code'));
    const version = current.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
    assert.equal(version.version, SCHEMA_VERSION);
    const settingColumns = current.prepare('PRAGMA table_info(server_settings)').all() as Array<{ name: string }>;
    assert.ok(settingColumns.some((column) => column.name === 'ble_name_prefix'));
    for (const name of ['storage_max_bytes', 'storage_warning_ratio', 'storage_stop_ratio', 'storage_updated_at', 'storage_updated_by']) {
      assert.ok(settingColumns.some((column) => column.name === name), `server_settings.${name} must be migrated`);
    }
    const fileColumns = current.prepare('PRAGMA table_info(recording_files)').all() as Array<{ name: string }>;
    assert.ok(fileColumns.some((column) => column.name === 'legal_hold'));
    assert.ok(fileColumns.some((column) => column.name === 'deletion_status'));
    for (const name of ['media_schema_version', 'media_container', 'media_codec', 'media_content_type', 'media_filename_extension', 'encoding_profile', 'media_metadata_source', 'device_started_at', 'device_ended_at', 'duration_ms', 'device_timezone_offset_minutes', 'source_firmware_version', 'resource_version', 'force_relay']) {
      assert.ok(fileColumns.some((column) => column.name === name), `recording_files.${name} must be migrated`);
    }
    const deviceColumns = current.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
    assert.ok(deviceColumns.some((column) => column.name === 'display_name'));
    assert.ok(deviceColumns.some((column) => column.name === 'capability_version'));
    assert.ok(deviceColumns.some((column) => column.name === 'capability_changed_at'));
    const commandColumns = current.prepare('PRAGMA table_info(commands)').all() as Array<{ name: string }>;
    assert.ok(commandColumns.some((column) => column.name === 'result_code'));
    assert.ok(commandColumns.some((column) => column.name === 'dispatched_at'));
    assert.ok(commandColumns.some((column) => column.name === 'resource_version'));
    const endpointColumns = current.prepare('PRAGMA table_info(event_endpoints)').all() as Array<{ name: string }>;
    assert.ok(endpointColumns.some((column) => column.name === 'event_types_json'));
    assert.ok(endpointColumns.some((column) => column.name === 'device_ids_json'));
    assert.ok(endpointColumns.some((column) => column.name === 'attributes_json'));
    assert.ok(endpointColumns.some((column) => column.name === 'filter_version'));
    const oauthClientColumns = current.prepare('PRAGMA table_info(oauth_clients)').all() as Array<{ name: string }>;
    assert.ok(oauthClientColumns.some((column) => column.name === 'registration_type'));
    assert.ok(oauthClientColumns.some((column) => column.name === 'client_metadata_json'));
    const dynamicClientTable = current.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_dynamic_clients'").get() as { name: string } | undefined;
    assert.equal(dynamicClientTable?.name, 'oauth_dynamic_clients');
    current.close();
    const writable = new DatabaseSync(config.databaseFile);
    writable.prepare('INSERT INTO audit_logs(id,actor_id,action,resource_type,request_id,result,created_at) VALUES(?,?,?,?,?,?,?)').run('audit_immutable', 'test', 'test', 'test', 'request', 'success', new Date().toISOString());
    assert.throws(() => writable.prepare("UPDATE audit_logs SET result='failure' WHERE id='audit_immutable'").run(), /AUDIT_LOG_IMMUTABLE/);
    assert.throws(() => writable.prepare("DELETE FROM audit_logs WHERE id='audit_immutable'").run(), /AUDIT_LOG_IMMUTABLE/);
    writable.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
