import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DeviceEvent, RecordingFile } from '@voicecan/contracts';
import { parseVerifiedDeviceEvent } from '@voicecan/server-client';

export type ConnectorTarget = {
  id: string;
  deliver: (event: DeviceEvent) => Promise<{ reference?: string } | void>;
};

export type DispatchResult = {
  eventId: string;
  delivered: string[];
  skipped: string[];
  failed: Array<{ targetId: string; error: string }>;
};

export type TargetRecord = {
  status: 'pending' | 'delivered';
  attempts: number;
  reference?: string;
  last_error?: string;
  delivered_at?: string;
};

export type DeliveryRecord = {
  event_id: string;
  event_hash: string;
  targets: Record<string, TargetRecord>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function startConnectorWebhookServer(input: {
  runtime: ConnectorRuntime;
  secret?: string;
  secrets?: readonly string[];
  port: number;
  host?: string;
  path?: string;
  maxBodyBytes?: number;
}): Server {
  const path = input.path ?? '/events';
  const maxBodyBytes = input.maxBodyBytes ?? 256 * 1024;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks);
      const event = parseVerifiedDeviceEvent({ rawBody, headers: request.headers, secrets: input.secrets ?? (input.secret ? [input.secret] : []) });
      const result = await input.runtime.dispatch(event);
      response.writeHead(result.failed.length === 0 ? 204 : 503).end();
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
        ? error.status
        : error instanceof Error && error.message === 'EVENT_ID_COLLISION' ? 409 : 500;
      response.writeHead(status).end();
    }
  });
  server.listen(input.port, input.host ?? '127.0.0.1');
  return server;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(bearer|token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 500);
}

export type DeliveryLedger = {
  load(eventId: string): Promise<DeliveryRecord | undefined>;
  save(record: DeliveryRecord): Promise<void>;
};

export class FileDeliveryLedger implements DeliveryLedger {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  async load(eventId: string): Promise<DeliveryRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.#path(eventId), 'utf8')) as DeliveryRecord;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(record: DeliveryRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const destination = this.#path(record.event_id);
    const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  }

  #path(eventId: string): string {
    const key = createHash('sha256').update(eventId).digest('hex');
    return resolve(this.#directory, `${key}.json`);
  }
}

export type EventClaim = 'claimed' | 'duplicate' | 'tombstoned';

export type ConnectorOutboxEntry = {
  id: string;
  topic: string;
  aggregate_id: string;
  idempotency_key: string;
  payload: unknown;
  attempt: number;
  available_at: string;
  created_at: string;
  last_error: string | null;
};

function now(): string { return new Date().toISOString(); }

/**
 * Single-process durable infrastructure for a Device Platform consumer. The
 * application remains responsible for its own domain job/result tables.
 */
export class SqliteConnectorStore implements DeliveryLedger {
  readonly #db: DatabaseSync;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    const databasePath = resolve(path);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS connector_delivery_ledger (
        event_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_event_inbox (
        event_id TEXT PRIMARY KEY,
        event_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        recording_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS connector_recording_tombstones (
        recording_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        event_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_outbox (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS connector_metrics (
        name TEXT PRIMARY KEY,
        value REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  load(eventId: string): Promise<DeliveryRecord | undefined> {
    return this.#serialize(() => {
      const row = this.#db.prepare('SELECT payload FROM connector_delivery_ledger WHERE event_id=?').get(eventId) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as DeliveryRecord : undefined;
    });
  }

  save(record: DeliveryRecord): Promise<void> {
    return this.#serialize(() => {
      this.#db.prepare(`INSERT INTO connector_delivery_ledger(event_id,payload,updated_at) VALUES(?,?,?)
        ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`).run(record.event_id, JSON.stringify(record), now());
    });
  }

  claimEvent(input: { id: string; type: string; recordingId?: string; payload: unknown }): Promise<EventClaim> {
    return this.#serialize(() => {
      const hash = createHash('sha256').update(stable(input.payload)).digest('hex');
      const existing = this.#db.prepare('SELECT event_hash,status FROM connector_event_inbox WHERE event_id=?').get(input.id) as { event_hash: string; status: string } | undefined;
      if (existing && existing.event_hash !== hash) throw new Error('EVENT_ID_COLLISION');
      if (input.recordingId && this.#hasTombstone(input.recordingId)) return 'tombstoned';
      if (existing?.status === 'processing' || existing?.status === 'completed') return 'duplicate';
      const timestamp = now();
      this.#db.prepare(`INSERT INTO connector_event_inbox(event_id,event_hash,event_type,recording_id,status,received_at,updated_at,last_error)
        VALUES(?,?,?,?, 'processing',?,?,NULL)
        ON CONFLICT(event_id) DO UPDATE SET status='processing',updated_at=excluded.updated_at,last_error=NULL`).run(
        input.id, hash, input.type, input.recordingId ?? null, timestamp, timestamp,
      );
      return 'claimed';
    });
  }

  completeEvent(eventId: string): Promise<void> {
    return this.#serialize(() => { this.#db.prepare("UPDATE connector_event_inbox SET status='completed',updated_at=?,last_error=NULL WHERE event_id=?").run(now(), eventId); });
  }

  failEvent(eventId: string, error: unknown): Promise<void> {
    return this.#serialize(() => { this.#db.prepare("UPDATE connector_event_inbox SET status='failed',updated_at=?,last_error=? WHERE event_id=?").run(now(), safeError(error), eventId); });
  }

  addTombstone(recordingId: string, reason: string, eventId?: string): Promise<void> {
    return this.#serialize(() => {
      this.#db.prepare(`INSERT INTO connector_recording_tombstones(recording_id,reason,event_id,created_at) VALUES(?,?,?,?)
        ON CONFLICT(recording_id) DO UPDATE SET reason=excluded.reason,event_id=excluded.event_id,created_at=excluded.created_at`).run(recordingId, reason, eventId ?? null, now());
    });
  }

  hasTombstone(recordingId: string): Promise<boolean> {
    return this.#serialize(() => this.#hasTombstone(recordingId));
  }

  enqueueOutbox(input: { topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }): Promise<void> {
    return this.#serialize(() => {
      const timestamp = now();
      this.#db.prepare(`INSERT INTO connector_outbox(id,topic,aggregate_id,idempotency_key,payload,attempt,available_at,created_at)
        VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(
        crypto.randomUUID(), input.topic, input.aggregateId, input.idempotencyKey, JSON.stringify(input.payload), timestamp, timestamp,
      );
    });
  }

  pendingOutbox(limit = 50): Promise<ConnectorOutboxEntry[]> {
    return this.#serialize(() => {
      const rows = this.#db.prepare(`SELECT id,topic,aggregate_id,idempotency_key,payload,attempt,available_at,created_at,last_error
        FROM connector_outbox WHERE delivered_at IS NULL AND available_at<=? ORDER BY created_at LIMIT ?`).all(now(), limit) as Array<Omit<ConnectorOutboxEntry, 'payload'> & { payload: string }>;
      return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
    });
  }

  completeOutbox(id: string): Promise<void> {
    return this.#serialize(() => { this.#db.prepare('UPDATE connector_outbox SET delivered_at=?,last_error=NULL WHERE id=?').run(now(), id); });
  }

  failOutbox(id: string, error: unknown): Promise<void> {
    return this.#serialize(() => {
      const row = this.#db.prepare('SELECT attempt FROM connector_outbox WHERE id=?').get(id) as { attempt: number } | undefined;
      const attempt = (row?.attempt ?? 0) + 1;
      const delay = Math.min(3_600_000, 1_000 * 2 ** Math.min(attempt, 12));
      this.#db.prepare('UPDATE connector_outbox SET attempt=?,available_at=?,last_error=? WHERE id=?').run(
        attempt, new Date(Date.now() + delay).toISOString(), safeError(error), id,
      );
    });
  }

  metric(name: string, delta = 1): Promise<void> {
    return this.#serialize(() => {
      this.#db.prepare(`INSERT INTO connector_metrics(name,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(name) DO UPDATE SET value=connector_metrics.value+excluded.value,updated_at=excluded.updated_at`).run(name, delta, now());
    });
  }

  metrics(): Promise<Record<string, number>> {
    return this.#serialize(() => Object.fromEntries((this.#db.prepare('SELECT name,value FROM connector_metrics ORDER BY name').all() as Array<{ name: string; value: number }>).map((row) => [row.name, row.value])));
  }

  async close(): Promise<void> {
    await this.#queue;
    this.#db.close();
  }

  #serialize<R>(operation: () => R | Promise<R>): Promise<R> {
    const task = this.#queue.then(operation);
    this.#queue = task.catch(() => undefined);
    return task;
  }

  #hasTombstone(recordingId: string): boolean {
    return Boolean(this.#db.prepare('SELECT 1 FROM connector_recording_tombstones WHERE recording_id=?').get(recordingId));
  }
}

export type RecordingSource = {
  list(query?: { status?: string; limit?: number }): AsyncGenerator<RecordingFile>;
};

export type RecordingReconcileResult = {
  scanned: number;
  accepted: number;
  removed: number;
  failed: number;
};

/** Runs cleanup only after the complete authorized Recording listing succeeds. */
export async function reconcileRecordings(input: {
  source: RecordingSource;
  knownRecordingIds: () => Promise<ReadonlySet<string>>;
  accept: (recording: RecordingFile) => Promise<boolean | void>;
  authorizationLost: (recordingId: string) => Promise<void>;
  status?: string;
  pageSize?: number;
}): Promise<RecordingReconcileResult> {
  const result: RecordingReconcileResult = { scanned: 0, accepted: 0, removed: 0, failed: 0 };
  const known = await input.knownRecordingIds();
  const authorized = new Set<string>();
  for await (const recording of input.source.list({ status: input.status ?? 'synced', limit: input.pageSize ?? 100 })) {
    result.scanned += 1;
    authorized.add(recording.id);
    try {
      if (await input.accept(recording)) result.accepted += 1;
    } catch {
      result.failed += 1;
    }
  }
  for (const recordingId of known) {
    if (authorized.has(recordingId)) continue;
    await input.authorizationLost(recordingId);
    result.removed += 1;
  }
  return result;
}

export class ConnectorRuntime {
  readonly #ledger: DeliveryLedger;
  readonly #targets: readonly ConnectorTarget[];
  readonly #inFlight = new Map<string, Promise<DispatchResult>>();

  constructor(input: { ledger: DeliveryLedger; targets: readonly ConnectorTarget[] }) {
    if (input.targets.length === 0) throw new Error('At least one connector target is required');
    const ids = input.targets.map((target) => target.id);
    if (ids.some((id) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) || new Set(ids).size !== ids.length) throw new Error('Connector target IDs must be unique and URL-safe');
    this.#ledger = input.ledger;
    this.#targets = [...input.targets];
  }

  dispatch(event: DeviceEvent): Promise<DispatchResult> {
    const active = this.#inFlight.get(event.id);
    if (active) return active;
    const operation = this.#dispatch(event).finally(() => this.#inFlight.delete(event.id));
    this.#inFlight.set(event.id, operation);
    return operation;
  }

  async #dispatch(event: DeviceEvent): Promise<DispatchResult> {
    const eventHash = createHash('sha256').update(stable(event)).digest('hex');
    const existing = await this.#ledger.load(event.id);
    if (existing && existing.event_hash !== eventHash) throw new Error('EVENT_ID_COLLISION');
    const record: DeliveryRecord = existing ?? { event_id: event.id, event_hash: eventHash, targets: {} };
    const result: DispatchResult = { eventId: event.id, delivered: [], skipped: [], failed: [] };

    for (const target of this.#targets) {
      const previous = record.targets[target.id];
      if (previous?.status === 'delivered') {
        result.skipped.push(target.id);
        continue;
      }
      const current: TargetRecord = { status: 'pending', attempts: (previous?.attempts ?? 0) + 1 };
      record.targets[target.id] = current;
      await this.#ledger.save(record);
      try {
        const receipt = await target.deliver(event);
        current.status = 'delivered';
        current.delivered_at = new Date().toISOString();
        if (receipt?.reference) current.reference = receipt.reference;
        delete current.last_error;
        result.delivered.push(target.id);
      } catch (error) {
        current.last_error = safeError(error);
        result.failed.push({ targetId: target.id, error: current.last_error });
      }
      await this.#ledger.save(record);
    }
    return result;
  }
}
