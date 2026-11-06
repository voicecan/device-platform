import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Readable } from 'node:stream';
import { OPEN_PLATFORM_PERMISSIONS } from '@voicecan/contracts';
import type { ServerConfig } from '../../src/config.js';
import { encryptSecret, hashPassword, opaqueToken, tokenHash } from '../../src/security.js';
import { FilesystemStorage } from '../../src/storage.js';

// Synthetic, isolated authorization fixtures. Never included in the runtime package.
export const VIEWER_FIXTURE_IDS = {
  admin: 'user_fixture_admin', viewer: 'user_fixture_viewer', group: 'group_fixture',
  device: 'dev_fixture_recorder',
  recording: 'file_fixture-sample', application: 'app_fixture_showcase', webhook: 'endpoint_fixture_disabled',
} as const;

function* sampleWav(): Generator<Buffer> {
  const rate = 16_000; const samples = rate * 2; const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + samples * 2, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
  yield header;
  for (let start = 0; start < samples; start += 1600) {
    const chunk = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      const position = start + i;
      const fade = Math.min(1, position / 1600, (samples - position) / 1600);
      chunk.writeInt16LE(Math.round(2000 * fade * Math.sin(2 * Math.PI * 440 * position / rate)), i * 2);
    }
    yield chunk;
  }
}

export async function seedViewerFixture(config: ServerConfig, passwords: { admin: string; viewer: string }): Promise<void> {
  const [adminHash, viewerHash] = await Promise.all([hashPassword(passwords.admin), hashPassword(passwords.viewer)]);
  const storage = new FilesystemStorage(config.storageDir);
  const stored = await storage.receive(VIEWER_FIXTURE_IDS.recording, Readable.from(sampleWav()), 64_044);
  const database = new DatabaseSync(config.databaseFile, { enableForeignKeyConstraints: true });
  const timestamp = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const userInsert = database.prepare('INSERT INTO users(id,username,normalized_username,display_name,role,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
      userInsert.run(VIEWER_FIXTURE_IDS.admin, 'fixture-admin', 'fixture-admin', 'Fixture administrator', 'system_admin', adminHash, timestamp, timestamp);
      userInsert.run(VIEWER_FIXTURE_IDS.viewer, 'fixture-viewer', 'fixture-viewer', 'Test viewer', 'user', viewerHash, timestamp, timestamp);
      database.prepare('INSERT INTO user_groups(id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').run(VIEWER_FIXTURE_IDS.group, 'Authorization test fixture', timestamp, timestamp);
      const membership = database.prepare('INSERT INTO group_memberships(id,user_id,group_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
      membership.run('membership_fixture_admin', VIEWER_FIXTURE_IDS.admin, VIEWER_FIXTURE_IDS.group, 'group_admin', timestamp, timestamp);
      membership.run('membership_fixture_viewer', VIEWER_FIXTURE_IDS.viewer, VIEWER_FIXTURE_IDS.group, 'viewer', timestamp, timestamp);
      const viewer = database.prepare('SELECT u.role,m.role AS membership_role,m.active,u.disabled_at FROM users u JOIN group_memberships m ON m.user_id=u.id WHERE m.id=? AND u.id=? AND m.group_id=?').get('membership_fixture_viewer', VIEWER_FIXTURE_IDS.viewer, VIEWER_FIXTURE_IDS.group) as { role: string; membership_role: string; active: number; disabled_at: string | null } | undefined;
      if (!viewer || viewer.role !== 'user' || viewer.membership_role !== 'viewer' || !viewer.active || viewer.disabled_at) throw new Error('FIXTURE_VIEWER_POLICY_CHANGED');
      database.prepare('INSERT INTO devices(id,manufacturer,sn,display_name,model,group_id,online,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?) ON CONFLICT(id) DO NOTHING').run(VIEWER_FIXTURE_IDS.device, 'Fixture', 'FIXTURE-RECORDER-001', 'Fixture recorder (sample data)', 'Authorization test fixture', VIEWER_FIXTURE_IDS.group, timestamp, timestamp);
      database.prepare(`INSERT INTO recording_files(id,device_id,credential_epoch,session_id,attribute,revision,expected_size,actual_size,sha256,status,transport,storage_locator,media_container,media_codec,media_content_type,media_filename_extension,media_sample_rate_hz,media_channels,media_bit_depth,duration_ms,media_metadata_source,created_at,synced_at,updated_at)
          VALUES(?,?,1,1,1,1,?,?,?,'synced','server_relay',?,'wav','pcm_s16le','audio/wav','wav',16000,1,16,2000,'server_verified',?,?,?)`).run(VIEWER_FIXTURE_IDS.recording, VIEWER_FIXTURE_IDS.device, stored.size, stored.size, stored.sha256, stored.locator, timestamp, timestamp, timestamp);
      seedViewerMetadata(database, config, timestamp, VIEWER_FIXTURE_IDS);
      database.prepare('UPDATE server_settings SET setup_completed_at=COALESCE(setup_completed_at,?),setup_token_hash=NULL,setup_token_expires_at=NULL WHERE singleton=1').run(timestamp);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } finally { database.close(); }
}

function seedViewerMetadata(db: DatabaseSync, config: ServerConfig, timestamp: string, ids: { admin: string; viewer: string; group: string; device: string; recording: string; application: string; webhook: string }): void {
  const insert = (table: string, values: Record<string, SQLInputValue>): void => {
    const columns = Object.keys(values);
    db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`).run(...Object.values(values));
  };
  const sampleTime = '2026-01-01T12:00:00.000Z';
  const scopes = OPEN_PLATFORM_PERMISSIONS.map(item => item.code);
  insert('device_status', { device_id: ids.device, source: 'ws', record_state: 0, record_mode: 0, microphone_mode: 0, microphone_gain_db: 0, usb_state: 0, wifi_state: 0, wifi_mode: 1, relay_state: 1, privacy_mode: 0, earphone_recording: 0, storage_total_kb: 8_388_608, storage_free_kb: 6_291_456, recording_hours: 12, battery_state: 'discharging', battery_percent: 76, battery_temperature_c: 25, battery_voltage_mv: 3900, work_time_seconds: 7200, accumulated_work_time_seconds: 86400, info_updated_at: sampleTime, status_updated_at: sampleTime, storage_updated_at: sampleTime, battery_updated_at: sampleTime, updated_at: sampleTime });
  insert('open_platform_applications', { id: ids.application, group_id: ids.group, name: 'Fixture integrations (sample configuration)', description: 'Synthetic showcase of REST, MCP, Webhooks, permissions and quotas. Credentials are revoked, the OAuth client is suspended and the webhook is disabled. No live integrations.', environment: 'development', status: 'active', channels_json: JSON.stringify(['rest', 'mcp_stdio', 'mcp_remote', 'webhook']), owner_user_id: ids.admin, created_by: ids.admin, created_at: timestamp, updated_at: timestamp });
  insert('application_collaborators', { id: 'collaborator_fixture_owner', application_id: ids.application, user_id: ids.admin, role: 'owner', created_by: ids.admin, created_at: timestamp, updated_at: timestamp });
  for (const permission of scopes) insert('application_permission_grants', { application_id: ids.application, permission, created_by: ids.admin, created_at: timestamp });
  insert('application_policies', { application_id: ids.application, updated_by: ids.admin, updated_at: timestamp });
  insert('application_credentials', { id: 'credential_fixture_revoked', application_id: ids.application, group_id: ids.group, kind: 'api_token', name: 'Revoked example credential (sample)', token_prefix: 'vcd_app_fixture', token_fingerprint: 'fixture-revoked', token_hash: tokenHash(opaqueToken(), config.groupTokenPepper), scopes_json: JSON.stringify(scopes), status: 'revoked', expires_at: sampleTime, revoked_at: sampleTime, created_by: ids.admin, created_at: sampleTime });
  insert('oauth_clients', { id: 'oauth_client_fixture_suspended', application_id: ids.application, group_id: ids.group, name: 'Fixture MCP client (suspended sample)', redirect_uris_json: JSON.stringify(['https://example.invalid/oauth/callback']), scopes_json: JSON.stringify(['devices:read', 'recordings:read']), status: 'suspended', created_by: ids.admin, created_at: timestamp, updated_at: timestamp });
  insert('event_endpoints', { id: ids.webhook, group_id: ids.group, application_id: ids.application, url: 'https://example.invalid/fixture-webhook', secret_id: 'secret_fixture_disabled', secret_ciphertext: encryptSecret(opaqueToken(), config.masterKey, ids.webhook), enabled: 0, event_types_json: JSON.stringify(['file.synced', 'device.offline']), device_ids_json: JSON.stringify([ids.device]), updated_at: timestamp, created_at: timestamp });
  for (const status of ['delivered', 'dead'] as const) {
    const eventId = `evt_fixture_${status}`;
    insert('events', { id: eventId, type: status === 'delivered' ? 'file.synced' : 'device.offline', device_id: ids.device, owner_group_id: ids.group, ownership_epoch: 1, payload_json: JSON.stringify({ synthetic_fixture: true, note: 'Synthetic historical example; no real delivery was sent.', file_id: ids.recording }), created_at: sampleTime });
    insert('event_deliveries', { id: `delivery_fixture_${status}`, event_id: eventId, endpoint_id: ids.webhook, status, attempts: status === 'delivered' ? 1 : 3, next_attempt_at: sampleTime, delivered_at: status === 'delivered' ? sampleTime : null, last_status_code: status === 'delivered' ? 200 : 503, last_error: status === 'dead' ? 'FIXTURE_SAMPLE_DELIVERY_FAILURE' : null, created_at: sampleTime });
  }
  for (const status of [200, 403, 429]) insert('open_platform_api_logs', { id: `api_log_fixture_${status}`, application_id: ids.application, credential_id: 'credential_fixture_revoked', actor_id: ids.viewer, channel: status === 200 ? 'mcp_remote' : 'rest', method: 'GET', route: '/api/v1/recordings', status_code: status, duration_ms: 12, request_id: `fixture-sample-${status}`, created_at: sampleTime });
  insert('application_usage_buckets', { application_id: ids.application, channel: 'rest', bucket_start: sampleTime, request_count: 3, error_count: 2, rate_limited_count: 1 });
  insert('open_platform_security_alerts', { id: 'alert_fixture_example', application_id: ids.application, credential_id: 'credential_fixture_revoked', severity: 'info', code: 'FIXTURE_SAMPLE_CREDENTIAL_REVOKED', status: 'resolved', details_json: JSON.stringify({ synthetic_fixture: true, note: 'Synthetic example of credential incident review.' }), resolved_by: ids.admin, resolved_at: sampleTime, created_at: sampleTime });
  insert('recording_download_grants', { id: 'download_grant_fixture_revoked', token_hash: tokenHash(opaqueToken(), config.groupTokenPepper), file_id: ids.recording, device_id: ids.device, group_id: ids.group, ownership_epoch: 1, application_id: ids.application, credential_id: 'credential_fixture_revoked', key_version: config.masterKeyVersion, purpose: 'download', expires_at: sampleTime, max_requests: 1, request_count: 1, first_used_at: sampleTime, last_used_at: sampleTime, revoked_at: sampleTime, idempotency_key: 'fixture-sample-revoked', request_hash: 'fixture-sample', created_at: sampleTime });
  insert('audit_logs', { id: 'audit_fixture_showcase', actor_id: ids.admin, action: 'fixture.sample_configuration', resource_type: 'open_platform_application', resource_id: ids.application, group_id: ids.group, application_id: ids.application, request_id: 'fixture-sample-seed', result: 'success', reason: 'Synthetic showcase configuration; no live credentials or outbound deliveries.', created_at: sampleTime });
}
