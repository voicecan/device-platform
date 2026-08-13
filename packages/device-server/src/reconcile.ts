import type { ServerConfig } from './config.js';
import type { Database } from './database.js';
import type { S3ImmutableStorage } from './s3-storage.js';
import type { FilesystemStorage } from './storage.js';
import { mapPublicCommand, recordingEventFacts } from './public-contract.js';

type Row = Record<string, unknown>;
type EmitEvent = (deviceRow: Row, type: string, payload: Record<string, unknown>) => Promise<string>;

export type ReconcileResult = {
  expiredTickets: number;
  expiredS3Attempts: number;
  recoveredFiles: number;
  partialFilesRemoved: number;
  expiredCommands: number;
  expiredProvisioning: number;
  expiredTransferOutSessions: number;
};

export class Reconciler {
  #timer?: NodeJS.Timeout;
  #running = false;

  constructor(
    private readonly db: Database,
    private readonly filesystem: FilesystemStorage,
    private readonly s3: S3ImmutableStorage | null,
    private readonly config: ServerConfig,
    private readonly emitEvent: EmitEvent,
  ) {}

  start(): void {
    this.#timer = setInterval(() => void this.run(), this.config.reconcileIntervalMs);
    this.#timer.unref();
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); }

  async run(): Promise<ReconcileResult> {
    if (this.#running) return { expiredTickets: 0, expiredS3Attempts: 0, recoveredFiles: 0, partialFilesRemoved: 0, expiredCommands: 0, expiredProvisioning: 0, expiredTransferOutSessions: 0 };
    this.#running = true;
    const timestamp = new Date().toISOString();
    const result: ReconcileResult = { expiredTickets: 0, expiredS3Attempts: 0, recoveredFiles: 0, partialFilesRemoved: 0, expiredCommands: 0, expiredProvisioning: 0, expiredTransferOutSessions: 0 };
    try {
      const expiredTickets = await this.db.all<Row>(
        'SELECT u.id AS ticket_id,u.file_id,f.*,d.group_id,d.ownership_epoch FROM upload_tickets u JOIN recording_files f ON f.id=u.file_id JOIN devices d ON d.id=f.device_id WHERE u.consumed_at IS NULL AND u.failed_at IS NULL AND u.expires_at<=?', [timestamp]);
      for (const ticket of expiredTickets) {
        await this.db.batch([
          { sql: "UPDATE upload_tickets SET failed_at=?,failure_code='UPLOAD_TICKET_EXPIRED' WHERE id=? AND consumed_at IS NULL AND failed_at IS NULL", params: [timestamp, ticket.ticket_id] },
          { sql: "UPDATE recording_files SET status='failed',error_code='UPLOAD_TICKET_EXPIRED',resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('pending','syncing')", params: [timestamp, ticket.file_id] },
        ]);
        await this.emitEvent(ticket, 'recording.sync_failed', { file_id: ticket.file_id, device_id: ticket.device_id, session_id: ticket.session_id, attribute: ticket.attribute, error_code: 'UPLOAD_TICKET_EXPIRED', ...recordingEventFacts({ ...ticket, resource_version: Number(ticket.resource_version ?? 1) + 1 }) });
        result.expiredTickets += 1;
      }

      const expiredAttempts = await this.db.all<Row>(
        'SELECT s.id AS attempt_id,s.file_id,s.staging_key,f.*,d.group_id,d.ownership_epoch FROM s3_upload_attempts s JOIN recording_files f ON f.id=s.file_id JOIN devices d ON d.id=f.device_id WHERE s.completed_at IS NULL AND s.failed_at IS NULL AND s.expires_at<=?', [timestamp]);
      for (const attempt of expiredAttempts) {
        await this.s3?.deleteStaging(String(attempt.staging_key)).catch(() => undefined);
        await this.db.batch([
          { sql: "UPDATE s3_upload_attempts SET failed_at=?,failure_code='S3_ATTEMPT_EXPIRED' WHERE id=?", params: [timestamp, attempt.attempt_id] },
          { sql: "UPDATE recording_files SET status='failed',error_code='S3_ATTEMPT_EXPIRED',resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing'", params: [timestamp, attempt.file_id] },
        ]);
        await this.emitEvent(attempt, 'recording.sync_failed', { file_id: attempt.file_id, device_id: attempt.device_id, session_id: attempt.session_id, attribute: attempt.attribute, error_code: 'S3_ATTEMPT_EXPIRED', ...recordingEventFacts({ ...attempt, resource_version: Number(attempt.resource_version ?? 1) + 1 }) });
        result.expiredS3Attempts += 1;
      }

      const recoverable = await this.db.all<Row>(`
        SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f
        JOIN devices d ON d.id=f.device_id
        WHERE f.transport='filesystem_http' AND f.status IN ('syncing','failed') AND f.storage_locator IS NULL LIMIT 100`);
      for (const file of recoverable) {
        const stored = await this.filesystem.inspect(String(file.id));
        if (!stored || stored.size !== Number(file.expected_size)) continue;
        const changed = await this.db.run("UPDATE recording_files SET status='synced',actual_size=?,sha256=?,storage_locator=?,error_code=NULL,synced_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status<>'synced'", [stored.size, stored.sha256, stored.locator, timestamp, timestamp, file.id]);
        if (changed.changes) {
          await this.emitEvent(file, 'file.synced', { file_id: file.id, device_id: file.device_id, session_id: file.session_id, attribute: file.attribute, file_size: stored.size, sha256: stored.sha256, reconciled: true, ...recordingEventFacts({ ...file, actual_size: stored.size, sha256: stored.sha256, synced_at: timestamp, resource_version: Number(file.resource_version ?? 1) + 1 }) });
          result.recoveredFiles += 1;
        }
      }
      result.partialFilesRemoved = await this.filesystem.cleanupPartialFiles(new Date(Date.now() - 24 * 60 * 60_000));
      const expiredCommands = await this.db.all<Row>("SELECT c.*,d.group_id,d.ownership_epoch FROM commands c JOIN devices d ON d.id=c.device_id WHERE c.status IN ('queued','dispatched','running') AND c.deadline_at<=?", [timestamp]);
      for (const command of expiredCommands) {
        const changed = await this.db.run("UPDATE commands SET status='expired',error_code='COMMAND_DEADLINE_EXCEEDED',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('queued','dispatched','running')", [timestamp, timestamp, command.id]);
        if (changed.changes === 1) {
          await this.emitEvent(command, 'command.expired', { command: mapPublicCommand({ ...command, status: 'expired', error_code: 'COMMAND_DEADLINE_EXCEEDED', completed_at: timestamp, resource_version: Number(command.resource_version ?? 1) + 1 }) });
          result.expiredCommands += 1;
        }
      }
      const expiredProvisioning = await this.db.all<{ id: string; device_id: string | null }>("SELECT id,device_id FROM provisioning_sessions WHERE status IN ('pending','reserved','ble_authenticated','configured','online') AND expires_at<=?", [timestamp]);
      for (const session of expiredProvisioning) {
        await this.db.run("UPDATE provisioning_sessions SET status='failed',failed_at=?,failure_code='PROVISIONING_EXPIRED',updated_at=? WHERE id=? AND status IN ('pending','reserved','ble_authenticated','configured','online')", [timestamp, timestamp, session.id]);
        result.expiredProvisioning += 1;
      }
      const expiredTransferOut = await this.db.run("UPDATE transfer_out_sessions SET status='expired',failed_at=?,failure_code='TRANSFER_OUT_EXPIRED',updated_at=? WHERE status IN ('pending','claimed') AND expires_at<=?", [timestamp, timestamp, timestamp]);
      result.expiredTransferOutSessions = expiredTransferOut.changes;
      await this.db.run('DELETE FROM login_attempts WHERE updated_at<?', [new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()]);
      return result;
    } finally { this.#running = false; }
  }
}
