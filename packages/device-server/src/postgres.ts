import { Pool, types as pgTypes, type PoolClient, type PoolConfig } from 'pg';
import type { Database, SqlStatement } from './database.js';
import { SCHEMA_VERSION, schemaSql } from './schema.js';

// SQLite stores all INTEGER values as signed 64-bit values. Keep the same range in
// PostgreSQL and return safe JavaScript numbers for this schema's bounded counters.
pgTypes.setTypeParser(20, (value) => Number(value));

function placeholders(sql: string, parameterCount: number): string {
  let index = 0;
  const translated = sql.replaceAll('?', () => `$${++index}`);
  if (index !== parameterCount) throw new Error(`DATABASE_PARAMETER_MISMATCH:${parameterCount}:${index}`);
  return translated;
}

function postgresSchema(): string {
  return schemaSql
    .replace(/^PRAGMA .*;\n/gm, '')
    .replace(/CREATE TRIGGER IF NOT EXISTS audit_logs_immutable_update[\s\S]*?END;\nCREATE TRIGGER IF NOT EXISTS audit_logs_immutable_delete[\s\S]*?END;\n/, '')
    .replace(/^CREATE INDEX IF NOT EXISTS files_deletion_idx.*;\n/gm, '')
    .replaceAll('INTEGER', 'BIGINT');
}

const auditImmutabilitySql = `
CREATE OR REPLACE FUNCTION voicecan_reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_immutable_update ON audit_logs;
CREATE TRIGGER audit_logs_immutable_update BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION voicecan_reject_audit_mutation();
DROP TRIGGER IF EXISTS audit_logs_immutable_delete ON audit_logs;
CREATE TRIGGER audit_logs_immutable_delete BEFORE DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION voicecan_reject_audit_mutation();
`;

export class PostgresDatabase implements Database {
  readonly dialect = 'postgres' as const;
  readonly multiInstance = true;
  readonly #pool: Pool;

  constructor(connectionString: string, options: { max?: number; applicationName?: string } = {}) {
    const config: PoolConfig = {
      connectionString,
      max: options.max ?? 20,
      application_name: options.applicationName ?? 'voicecan-device-server',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    };
    this.#pool = new Pool(config);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await this.#pool.query(placeholders(sql, params.length), params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.#pool.query<T>(placeholders(sql, params.length), params);
    return result.rows[0] ?? null;
  }

  async all<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(placeholders(sql, params.length), params);
    return result.rows;
  }

  async batch(statements: SqlStatement[]): Promise<Array<{ changes: number }>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const results: Array<{ changes: number }> = [];
      for (const statement of statements) {
        const result = await client.query(placeholders(statement.sql, statement.params?.length ?? 0), statement.params ?? []);
        const changes = result.rowCount ?? 0;
        if (statement.expectChanges !== undefined && changes !== statement.expectChanges) throw new Error(`DATABASE_CAS_FAILED:${statement.expectChanges}:${changes}`);
        results.push({ changes });
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> { await this.#pool.end(); }
}

async function withMigrationLock<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query("SELECT pg_advisory_lock(hashtext('voicecan-device-platform-schema'))");
  try { return await operation(); }
  finally { await client.query("SELECT pg_advisory_unlock(hashtext('voicecan-device-platform-schema'))"); }
}

export async function migratePostgres(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1, application_name: 'voicecan-device-migrate', connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    await withMigrationLock(client, async () => {
      const versionResult = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      const serverVersion = Number(versionResult.rows[0]?.server_version_num ?? 0);
      if (serverVersion < 160_000) throw new Error(`PostgreSQL 16 or newer required; server_version_num=${serverVersion}`);
      await client.query('BEGIN');
      try {
        await client.query(postgresSchema());
        await client.query(`ALTER TABLE recording_files
          ADD COLUMN IF NOT EXISTS legal_hold BIGINT NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1)),
          ADD COLUMN IF NOT EXISTS legal_hold_reason TEXT,
          ADD COLUMN IF NOT EXISTS legal_hold_updated_at TEXT,
          ADD COLUMN IF NOT EXISTS deletion_status TEXT NOT NULL DEFAULT 'active' CHECK (deletion_status IN ('active','requested','failed','object_deleted')),
          ADD COLUMN IF NOT EXISTS deletion_requested_at TEXT,
          ADD COLUMN IF NOT EXISTS deletion_requested_by TEXT,
          ADD COLUMN IF NOT EXISTS deletion_reason TEXT,
          ADD COLUMN IF NOT EXISTS object_deleted_at TEXT,
          ADD COLUMN IF NOT EXISTS deletion_error TEXT,
          ADD COLUMN IF NOT EXISTS media_schema_version TEXT NOT NULL DEFAULT 'recording.media.v1',
          ADD COLUMN IF NOT EXISTS media_container TEXT,
          ADD COLUMN IF NOT EXISTS media_codec TEXT,
          ADD COLUMN IF NOT EXISTS media_content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          ADD COLUMN IF NOT EXISTS media_filename_extension TEXT NOT NULL DEFAULT 'bin',
          ADD COLUMN IF NOT EXISTS media_sample_rate_hz BIGINT,
          ADD COLUMN IF NOT EXISTS media_channels BIGINT,
          ADD COLUMN IF NOT EXISTS media_bit_depth BIGINT,
          ADD COLUMN IF NOT EXISTS duration_ms BIGINT,
          ADD COLUMN IF NOT EXISTS encoding_profile TEXT,
          ADD COLUMN IF NOT EXISTS media_metadata_source TEXT NOT NULL DEFAULT 'unknown',
          ADD COLUMN IF NOT EXISTS device_started_at TEXT,
          ADD COLUMN IF NOT EXISTS device_ended_at TEXT,
          ADD COLUMN IF NOT EXISTS device_timezone_offset_minutes BIGINT,
          ADD COLUMN IF NOT EXISTS source_firmware_version TEXT,
          ADD COLUMN IF NOT EXISTS resource_version BIGINT NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS force_relay BIGINT NOT NULL DEFAULT 0 CHECK (force_relay IN (0,1))`);
        await client.query("ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS ble_name_prefix TEXT NOT NULL DEFAULT 'CAPSO-'");
        await client.query('ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS storage_max_bytes BIGINT, ADD COLUMN IF NOT EXISTS storage_warning_ratio REAL, ADD COLUMN IF NOT EXISTS storage_stop_ratio REAL, ADD COLUMN IF NOT EXISTS storage_updated_at TEXT, ADD COLUMN IF NOT EXISTS storage_updated_by TEXT');
        await client.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS capability_version TEXT, ADD COLUMN IF NOT EXISTS capability_changed_at TEXT');
        await client.query('ALTER TABLE commands ADD COLUMN IF NOT EXISTS result_code TEXT, ADD COLUMN IF NOT EXISTS dispatched_at TEXT, ADD COLUMN IF NOT EXISTS resource_version BIGINT NOT NULL DEFAULT 1');
        await client.query('ALTER TABLE group_api_tokens ADD COLUMN IF NOT EXISTS application_id TEXT');
        await client.query('ALTER TABLE event_endpoints ADD COLUMN IF NOT EXISTS application_id TEXT');
        await client.query("ALTER TABLE event_endpoints ADD COLUMN IF NOT EXISTS event_types_json TEXT NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS device_ids_json TEXT NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS attributes_json TEXT NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS filter_version BIGINT NOT NULL DEFAULT 1, ADD COLUMN IF NOT EXISTS updated_at TEXT");
        await client.query('ALTER TABLE event_deliveries ADD COLUMN IF NOT EXISTS last_status_code BIGINT');
        await client.query('UPDATE event_endpoints SET updated_at=COALESCE(updated_at,created_at)');
        await client.query('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS application_id TEXT, ADD COLUMN IF NOT EXISTS credential_id TEXT, ADD COLUMN IF NOT EXISTS principal_id TEXT');
        await client.query('ALTER TABLE application_usage_buckets ADD COLUMN IF NOT EXISTS sync_command_count BIGINT NOT NULL DEFAULT 0');
        await client.query("ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS registration_type TEXT NOT NULL DEFAULT 'pre_registered', ADD COLUMN IF NOT EXISTS client_metadata_json TEXT NOT NULL DEFAULT '{}'");
        await client.query(`
          INSERT INTO open_platform_applications(id,group_id,name,description,environment,status,channels_json,owner_user_id,created_by,version,created_at,updated_at)
          SELECT 'app_legacy_' || t.group_id,t.group_id,'Legacy integrations','Migrated from group API tokens','development','active','["rest","webhook"]',
            COALESCE((SELECT gm.user_id FROM group_memberships gm WHERE gm.group_id=t.group_id AND gm.active=1 AND gm.role='group_admin' LIMIT 1),MIN(t.created_by)),
            MIN(t.created_by),1,MIN(t.created_at),MAX(t.created_at)
          FROM group_api_tokens t GROUP BY t.group_id
          ON CONFLICT(id) DO NOTHING;
          UPDATE group_api_tokens SET application_id='app_legacy_' || group_id WHERE application_id IS NULL;
          UPDATE event_endpoints e SET application_id='app_legacy_' || e.group_id
            WHERE e.application_id IS NULL AND EXISTS(SELECT 1 FROM open_platform_applications a WHERE a.id='app_legacy_' || e.group_id);
          INSERT INTO application_policies(application_id,updated_by,updated_at)
            SELECT a.id,a.created_by,a.updated_at FROM open_platform_applications a ON CONFLICT(application_id) DO NOTHING;
          INSERT INTO application_collaborators(id,application_id,user_id,role,created_by,created_at,updated_at)
            SELECT 'collab_legacy_' || a.group_id,a.id,a.owner_user_id,'owner',a.created_by,a.created_at,a.updated_at FROM open_platform_applications a ON CONFLICT(application_id,user_id) DO NOTHING;
          INSERT INTO application_permission_grants(application_id,permission,created_by,created_at)
            SELECT DISTINCT t.application_id,'devices:read',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%devices:read%' ON CONFLICT DO NOTHING;
          INSERT INTO application_permission_grants(application_id,permission,created_by,created_at)
            SELECT DISTINCT t.application_id,'devices:sync',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%sync:trigger%' ON CONFLICT DO NOTHING;
          INSERT INTO application_permission_grants(application_id,permission,created_by,created_at)
            SELECT DISTINCT t.application_id,'recordings:read',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%files:read%' ON CONFLICT DO NOTHING;
          INSERT INTO application_permission_grants(application_id,permission,created_by,created_at)
            SELECT DISTINCT t.application_id,'events:read',t.created_by,t.created_at FROM group_api_tokens t WHERE t.scopes_json LIKE '%events:read%' ON CONFLICT DO NOTHING;
          INSERT INTO application_permission_grants(application_id,permission,created_by,created_at)
            SELECT DISTINCT e.application_id,'events:read',a.created_by,a.created_at FROM event_endpoints e
            JOIN open_platform_applications a ON a.id=e.application_id WHERE e.application_id IS NOT NULL ON CONFLICT DO NOTHING;
        `);
        await client.query('CREATE INDEX IF NOT EXISTS files_deletion_idx ON recording_files(deletion_status,legal_hold,updated_at)');
        await client.query('CREATE INDEX IF NOT EXISTS oauth_dynamic_clients_source_idx ON oauth_dynamic_clients(source_hash,created_at)');
        await client.query('CREATE INDEX IF NOT EXISTS oauth_dynamic_clients_expiry_idx ON oauth_dynamic_clients(expires_at)');
        await client.query(auditImmutabilitySql);
        const applied = await client.query<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
        const current = Number(applied.rows[0]?.version ?? 0);
        if (current > SCHEMA_VERSION) throw new Error(`Database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
        await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,$2) ON CONFLICT(version) DO NOTHING', [SCHEMA_VERSION, new Date().toISOString()]);
        await client.query('INSERT INTO server_settings(singleton,created_at) VALUES(1,$1) ON CONFLICT(singleton) DO NOTHING', [new Date().toISOString()]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } finally {
    client.release();
    await pool.end();
  }
}
