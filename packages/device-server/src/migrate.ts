import { DatabaseSync } from 'node:sqlite';
import type { ServerConfig } from './config.js';
import { SCHEMA_VERSION, schemaSql } from './schema.js';

export function migrate(config: ServerConfig): void {
  const database = new DatabaseSync(config.databaseFile, { enableForeignKeyConstraints: true });
  try {
    database.exec(schemaSql);
    const addColumn = (table: string, column: string, definition: string): void => {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((candidate) => candidate.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    addColumn('server_settings', 'master_key_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('server_settings', 'ble_name_prefix', "TEXT NOT NULL DEFAULT 'CAPSO-'");
    addColumn('server_settings', 'storage_max_bytes', 'INTEGER');
    addColumn('server_settings', 'storage_warning_ratio', 'REAL');
    addColumn('server_settings', 'storage_stop_ratio', 'REAL');
    addColumn('server_settings', 'storage_updated_at', 'TEXT');
    addColumn('server_settings', 'storage_updated_by', 'TEXT');
    addColumn('devices', 'display_name', 'TEXT');
    addColumn('devices', 'hardware_version', 'TEXT');
    addColumn('devices', 'claim_status', "TEXT NOT NULL DEFAULT 'active' CHECK (claim_status IN ('reserved','active'))");
    addColumn('devices', 'capability_version', 'TEXT');
    addColumn('devices', 'capability_changed_at', 'TEXT');
    addColumn('device_credentials', 'status', "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('temporary','active'))");
    addColumn('device_credentials', 'expires_at', 'TEXT');
    addColumn('commands', 'connection_epoch', 'INTEGER');
    addColumn('commands', 'error_code', 'TEXT');
    addColumn('commands', 'result_code', 'TEXT');
    addColumn('commands', 'dispatched_at', 'TEXT');
    addColumn('commands', 'started_at', 'TEXT');
    addColumn('commands', 'completed_at', 'TEXT');
    addColumn('commands', 'resource_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('commands', 'payload_json', "TEXT NOT NULL DEFAULT '{}'");
    addColumn('group_api_tokens', 'rotated_from_id', 'TEXT');
    addColumn('group_api_tokens', 'replaced_by_id', 'TEXT');
    addColumn('group_api_tokens', 'application_id', 'TEXT');
    addColumn('upload_tickets', 'failed_at', 'TEXT');
    addColumn('upload_tickets', 'failure_code', 'TEXT');
    addColumn('s3_upload_attempts', 'failed_at', 'TEXT');
    addColumn('s3_upload_attempts', 'failure_code', 'TEXT');
    addColumn('event_endpoints', 'next_secret_id', 'TEXT');
    addColumn('event_endpoints', 'next_secret_ciphertext', 'TEXT');
    addColumn('event_endpoints', 'next_activates_at', 'TEXT');
    addColumn('event_endpoints', 'application_id', 'TEXT');
    addColumn('event_endpoints', 'event_types_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumn('event_endpoints', 'device_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumn('event_endpoints', 'attributes_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumn('event_endpoints', 'filter_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('event_endpoints', 'updated_at', 'TEXT');
    addColumn('audit_logs', 'application_id', 'TEXT');
    addColumn('audit_logs', 'credential_id', 'TEXT');
    addColumn('audit_logs', 'principal_id', 'TEXT');
    addColumn('application_usage_buckets', 'sync_command_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('oauth_clients', 'registration_type', "TEXT NOT NULL DEFAULT 'pre_registered'");
    addColumn('oauth_clients', 'client_metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    const provisioningDefinition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provisioning_sessions'").get() as { sql: string } | undefined;
    if (provisioningDefinition && !provisioningDefinition.sql.includes("'reserved'")) {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE provisioning_sessions_v3 (
          id TEXT PRIMARY KEY,
          public_token_hash TEXT NOT NULL UNIQUE,
          allowed_origin TEXT NOT NULL,
          expected_sn TEXT,
          group_id TEXT NOT NULL REFERENCES user_groups(id),
          created_by TEXT NOT NULL REFERENCES users(id),
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          failed_at TEXT,
          failure_code TEXT,
          continuation_token_hash TEXT UNIQUE,
          device_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending','reserved','ble_authenticated','configured','online','completed','failed')),
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO provisioning_sessions_v3(
          id,public_token_hash,allowed_origin,expected_sn,group_id,created_by,expires_at,
          consumed_at,failed_at,failure_code,device_id,status,completed_at,updated_at,created_at
        ) SELECT
          id,public_token_hash,allowed_origin,expected_sn,group_id,created_by,expires_at,
          consumed_at,failed_at,failure_code,device_id,
          CASE status WHEN 'claimed' THEN 'completed' WHEN 'online' THEN 'completed' ELSE status END,
          CASE WHEN status IN ('claimed','online') THEN COALESCE(consumed_at,created_at) ELSE NULL END,
          COALESCE(consumed_at,failed_at,created_at),created_at
        FROM provisioning_sessions;
        DROP TABLE provisioning_sessions;
        ALTER TABLE provisioning_sessions_v3 RENAME TO provisioning_sessions;
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
    }
    const deliveryColumns = database.prepare('PRAGMA table_info(event_deliveries)').all() as Array<{ name: string }>;
    if (!deliveryColumns.some((candidate) => candidate.name === 'replay_namespace')) {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE event_deliveries_v2 (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES events(id),
          endpoint_id TEXT NOT NULL REFERENCES event_endpoints(id),
          replay_namespace TEXT NOT NULL DEFAULT 'live',
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          delivered_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(event_id, endpoint_id, replay_namespace)
        );
        INSERT INTO event_deliveries_v2(id,event_id,endpoint_id,replay_namespace,status,attempts,next_attempt_at,delivered_at,last_error,created_at)
          SELECT id,event_id,endpoint_id,'live',status,attempts,next_attempt_at,delivered_at,last_error,created_at FROM event_deliveries;
        DROP TABLE event_deliveries;
        ALTER TABLE event_deliveries_v2 RENAME TO event_deliveries;
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
    }
    addColumn('event_deliveries', 'claimed_by', 'TEXT');
    addColumn('event_deliveries', 'claim_expires_at', 'TEXT');
    addColumn('event_deliveries', 'last_status_code', 'INTEGER');
    addColumn('recording_files', 'legal_hold', 'INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1))');
    addColumn('recording_files', 'legal_hold_reason', 'TEXT');
    addColumn('recording_files', 'legal_hold_updated_at', 'TEXT');
    addColumn('recording_files', 'deletion_status', "TEXT NOT NULL DEFAULT 'active' CHECK (deletion_status IN ('active','requested','failed','object_deleted'))");
    addColumn('recording_files', 'deletion_requested_at', 'TEXT');
    addColumn('recording_files', 'deletion_requested_by', 'TEXT');
    addColumn('recording_files', 'deletion_reason', 'TEXT');
    addColumn('recording_files', 'object_deleted_at', 'TEXT');
    addColumn('recording_files', 'deletion_error', 'TEXT');
    addColumn('recording_files', 'media_schema_version', "TEXT NOT NULL DEFAULT 'recording.media.v1'");
    addColumn('recording_files', 'media_container', 'TEXT');
    addColumn('recording_files', 'media_codec', 'TEXT');
    addColumn('recording_files', 'media_content_type', "TEXT NOT NULL DEFAULT 'application/octet-stream'");
    addColumn('recording_files', 'media_filename_extension', "TEXT NOT NULL DEFAULT 'bin'");
    addColumn('recording_files', 'media_sample_rate_hz', 'INTEGER');
    addColumn('recording_files', 'media_channels', 'INTEGER');
    addColumn('recording_files', 'media_bit_depth', 'INTEGER');
    addColumn('recording_files', 'duration_ms', 'INTEGER');
    addColumn('recording_files', 'encoding_profile', 'TEXT');
    addColumn('recording_files', 'media_metadata_source', "TEXT NOT NULL DEFAULT 'unknown'");
    addColumn('recording_files', 'device_started_at', 'TEXT');
    addColumn('recording_files', 'device_ended_at', 'TEXT');
    addColumn('recording_files', 'device_timezone_offset_minutes', 'INTEGER');
    addColumn('recording_files', 'source_firmware_version', 'TEXT');
    addColumn('recording_files', 'resource_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('recording_files', 'force_relay', 'INTEGER NOT NULL DEFAULT 0 CHECK (force_relay IN (0,1))');
    database.exec('UPDATE event_endpoints SET updated_at=COALESCE(updated_at,created_at)');
    database.exec('CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON event_deliveries(status, next_attempt_at)');
    database.exec('CREATE INDEX IF NOT EXISTS deliveries_claim_idx ON event_deliveries(status, claim_expires_at, next_attempt_at)');
    database.exec('CREATE INDEX IF NOT EXISTS files_deletion_idx ON recording_files(deletion_status, legal_hold, updated_at)');
    database.exec("CREATE INDEX IF NOT EXISTS tickets_active_idx ON upload_tickets(file_id, expires_at) WHERE consumed_at IS NULL AND failed_at IS NULL");
    database.exec("CREATE INDEX IF NOT EXISTS s3_attempts_active_idx ON s3_upload_attempts(file_id, expires_at) WHERE completed_at IS NULL AND failed_at IS NULL");
    database.exec('CREATE INDEX IF NOT EXISTS oauth_dynamic_clients_source_idx ON oauth_dynamic_clients(source_hash,created_at)');
    database.exec('CREATE INDEX IF NOT EXISTS oauth_dynamic_clients_expiry_idx ON oauth_dynamic_clients(expires_at)');
    database.exec(`
      INSERT OR IGNORE INTO open_platform_applications(id,group_id,name,description,environment,status,channels_json,owner_user_id,created_by,version,created_at,updated_at)
      SELECT 'app_legacy_' || t.group_id,t.group_id,'Legacy integrations','Migrated from group API tokens','development','active','["rest","webhook"]',
        COALESCE((SELECT gm.user_id FROM group_memberships gm WHERE gm.group_id=t.group_id AND gm.active=1 AND gm.role='group_admin' LIMIT 1),MIN(t.created_by)),
        MIN(t.created_by),1,MIN(t.created_at),MAX(t.created_at)
      FROM group_api_tokens t GROUP BY t.group_id;
      UPDATE group_api_tokens SET application_id='app_legacy_' || group_id WHERE application_id IS NULL;
      UPDATE event_endpoints SET application_id='app_legacy_' || group_id
        WHERE application_id IS NULL AND EXISTS(SELECT 1 FROM open_platform_applications a WHERE a.id='app_legacy_' || event_endpoints.group_id);
      INSERT OR IGNORE INTO application_policies(application_id,updated_by,updated_at)
        SELECT a.id,a.created_by,a.updated_at FROM open_platform_applications a;
      INSERT OR IGNORE INTO application_collaborators(id,application_id,user_id,role,created_by,created_at,updated_at)
        SELECT 'collab_legacy_' || a.group_id,a.id,a.owner_user_id,'owner',a.created_by,a.created_at,a.updated_at FROM open_platform_applications a;
      INSERT OR IGNORE INTO application_permission_grants(application_id,permission,created_by,created_at)
        SELECT DISTINCT t.application_id,'devices:read',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%devices:read%';
      INSERT OR IGNORE INTO application_permission_grants(application_id,permission,created_by,created_at)
        SELECT DISTINCT t.application_id,'devices:sync',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%sync:trigger%';
      INSERT OR IGNORE INTO application_permission_grants(application_id,permission,created_by,created_at)
        SELECT DISTINCT t.application_id,'recordings:read',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%files:read%';
      INSERT OR IGNORE INTO application_permission_grants(application_id,permission,created_by,created_at)
        SELECT DISTINCT t.application_id,'events:read',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%events:read%';
      INSERT OR IGNORE INTO application_permission_grants(application_id,permission,created_by,created_at)
        SELECT DISTINCT e.application_id,'events:read',a.created_by,a.created_at FROM event_endpoints e
        JOIN open_platform_applications a ON a.id=e.application_id WHERE e.application_id IS NOT NULL;
    `);
    database.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, new Date().toISOString());
    database.prepare('INSERT OR IGNORE INTO server_settings(singleton, created_at) VALUES (1, ?)')
      .run(new Date().toISOString());
  } finally {
    database.close();
  }
}
