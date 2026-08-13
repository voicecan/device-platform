import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { PostgresDatabase, migratePostgres } from '../src/postgres.js';
import { SCHEMA_VERSION } from '../src/schema.js';

const connectionString = process.env.VOICECAN_POSTGRES_TEST_URL;
const parsed = connectionString ? new URL(connectionString) : null;
const safeTestDatabase = Boolean(parsed && parsed.pathname.slice(1).endsWith('_test'));

test('PostgreSQL migration and two-instance CAS/lease fencing', { skip: !connectionString || !safeTestDatabase }, async () => {
  const pool = new Pool({ connectionString });
  const first = new PostgresDatabase(connectionString!, { max: 2, applicationName: 'voicecan-pg-test-first' });
  const second = new PostgresDatabase(connectionString!, { max: 2, applicationName: 'voicecan-pg-test-second' });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migratePostgres(connectionString!);
    await migratePostgres(connectionString!);

    assert.equal(first.dialect, 'postgres');
    assert.equal(first.multiInstance, true);
    assert.equal((await first.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations'))?.version, SCHEMA_VERSION);
    await pool.query('DROP INDEX files_deletion_idx');
    await pool.query(`ALTER TABLE recording_files
        DROP COLUMN legal_hold,
        DROP COLUMN legal_hold_reason,
        DROP COLUMN legal_hold_updated_at,
        DROP COLUMN deletion_status,
        DROP COLUMN deletion_requested_at,
        DROP COLUMN deletion_requested_by,
        DROP COLUMN deletion_reason,
        DROP COLUMN object_deleted_at,
        DROP COLUMN deletion_error`);
    await pool.query('DELETE FROM schema_migrations WHERE version=6');
    await pool.query('INSERT INTO schema_migrations(version,applied_at) VALUES(5,$1) ON CONFLICT(version) DO NOTHING', [new Date().toISOString()]);
    await migratePostgres(connectionString!);
    const lifecycleColumns = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='recording_files' AND column_name IN ('legal_hold','deletion_status') ORDER BY column_name");
    assert.deepEqual(lifecycleColumns.rows.map((row) => row.column_name), ['deletion_status', 'legal_hold']);

    const timestamp = new Date().toISOString();
    await first.batch([
      { sql: 'INSERT INTO users(id,username,normalized_username,role,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', params: ['user_test', 'test', 'test', 'system_admin', 'not-a-real-hash', timestamp, timestamp] },
      { sql: 'INSERT INTO user_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)', params: ['group_test', 'Test', timestamp, timestamp] },
      { sql: 'INSERT INTO devices(id,manufacturer,sn,group_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', params: ['device_test', 'voicecan', 'PG-TEST', 'group_test', timestamp, timestamp] },
      { sql: 'INSERT INTO event_endpoints(id,group_id,url,secret_id,secret_ciphertext,created_at) VALUES(?,?,?,?,?,?)', params: ['endpoint_test', 'group_test', 'https://example.test/hook', 'secret_test', 'ciphertext', timestamp] },
      { sql: 'INSERT INTO events(id,type,device_id,owner_group_id,ownership_epoch,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: ['event_test', 'file.synced', 'device_test', 'group_test', 1, '{}', timestamp] },
      { sql: 'INSERT INTO event_deliveries(id,event_id,endpoint_id,status,next_attempt_at,created_at) VALUES(?,?,?,?,?,?)', params: ['delivery_test', 'event_test', 'endpoint_test', 'pending', timestamp, timestamp] },
      { sql: 'INSERT INTO commands(id,device_id,kind,status,caller_scope,request_hash,deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', params: ['command_test', 'device_test', 'sync', 'queued', 'test', 'hash', new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp] },
    ]);

    const claimAt = new Date().toISOString();
    const claimUntil = new Date(Date.now() + 30_000).toISOString();
    const claims = await Promise.all([
      first.run("UPDATE event_deliveries SET claimed_by=?,claim_expires_at=? WHERE id=? AND status='pending' AND next_attempt_at<=? AND (claimed_by IS NULL OR claim_expires_at<=?)", ['first', claimUntil, 'delivery_test', claimAt, claimAt]),
      second.run("UPDATE event_deliveries SET claimed_by=?,claim_expires_at=? WHERE id=? AND status='pending' AND next_attempt_at<=? AND (claimed_by IS NULL OR claim_expires_at<=?)", ['second', claimUntil, 'delivery_test', claimAt, claimAt]),
    ]);
    assert.equal(claims[0]!.changes + claims[1]!.changes, 1);

    const commandClaims = await Promise.all([
      first.run("UPDATE commands SET status='dispatched',connection_epoch=1 WHERE id=? AND status='queued'", ['command_test']),
      second.run("UPDATE commands SET status='dispatched',connection_epoch=1 WHERE id=? AND status='queued'", ['command_test']),
    ]);
    assert.equal(commandClaims[0]!.changes + commandClaims[1]!.changes, 1);

    await first.run('INSERT INTO audit_logs(id,actor_id,action,resource_type,request_id,result,created_at) VALUES(?,?,?,?,?,?,?)', ['audit_test', 'test', 'test', 'test', 'request', 'success', timestamp]);
    await assert.rejects(first.run("UPDATE audit_logs SET result='failure' WHERE id=?", ['audit_test']), /AUDIT_LOG_IMMUTABLE/);
    await assert.rejects(first.batch([
      { sql: 'UPDATE devices SET ownership_epoch=ownership_epoch+1 WHERE id=? AND ownership_epoch=?', params: ['device_test', 1], expectChanges: 1 },
      { sql: 'UPDATE commands SET status=? WHERE id=? AND status=?', params: ['queued', 'missing', 'dispatched'], expectChanges: 1 },
    ]), /DATABASE_CAS_FAILED/);
    assert.equal((await first.get<{ ownership_epoch: number }>('SELECT ownership_epoch FROM devices WHERE id=?', ['device_test']))?.ownership_epoch, 1);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    if (safeTestDatabase) {
      await pool.query('DROP SCHEMA public CASCADE');
      await pool.query('CREATE SCHEMA public');
    }
    await pool.end();
  }
});
