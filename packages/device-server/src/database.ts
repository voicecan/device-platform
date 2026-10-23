import type { BackupConfig } from './maintenance.js';
import { Worker } from 'node:worker_threads';

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
export type SqlStatement = { sql: string; params?: unknown[]; expectChanges?: number };

/**
 * Callers must await every returned promise. `DatabaseActor` marks its promises
 * as handled so an intentionally fire-and-forget call cannot terminate the
 * process on Node 24, but that safety net also hides programming errors: an
 * unawaited failure is neither retried nor reported.
 */
export interface Database {
  readonly dialect: 'sqlite' | 'postgres';
  readonly multiInstance: boolean;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  get<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  batch(statements: SqlStatement[]): Promise<Array<{ changes: number }>>;
  close(): Promise<void>;
}

/**
 * Serializes SQLite access onto a worker thread. Once the worker has failed or
 * exited, every call rejects immediately instead of queueing forever; callers
 * still need to await (or explicitly handle) the rejection to observe it.
 */
export class DatabaseActor implements Database {
  readonly dialect = 'sqlite' as const;
  readonly multiInstance = false;
  #worker: Worker;
  #sequence = 0;
  #pending = new Map<number, Pending>();
  #failure?: Error;
  #closed = false;

  constructor(filename: string) {
    const workerFile = new URL(import.meta.url.endsWith('.ts') ? './database-worker.ts' : './database-worker.js', import.meta.url);
    this.#worker = new Worker(workerFile, { workerData: { filename } });
    this.#worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? 'Database worker failed'));
    });
    this.#worker.on('error', (error) => this.#fail(error));
    // A worker that exits leaves its in-flight promises forever unsettled.
    // Fail them (and every later call) so requests return an error instead of
    // hanging until the client times out.
    this.#worker.on('exit', (code) => this.#fail(new Error(`DATABASE_WORKER_EXITED:${code}`)));
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #send<T>(message: Record<string, unknown>): Promise<T> {
    if (this.#failure) {
      const rejected = Promise.reject<T>(this.#failure);
      void rejected.catch(() => undefined);
      return rejected;
    }
    const id = ++this.#sequence;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { this.#worker.postMessage({ id, ...message }); }
      catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    // Some callers (gateway timers, shutdown-adjacent work) intentionally fire and
    // forget. On Node 24 an unobserved rejection terminates the process, so mark
    // this promise handled here; callers that await it still receive the error.
    void promise.catch(() => undefined);
    return promise;
  }

  run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.#send({ op: 'run', sql, params });
  }

  get<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.#send({ op: 'get', sql, params });
  }

  all<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#send({ op: 'all', sql, params });
  }

  batch(statements: SqlStatement[]): Promise<Array<{ changes: number }>> {
    return this.#send({ op: 'batch', statements });
  }

  createVerifiedBackup(config: BackupConfig, directory: string): Promise<void> {
    return this.#send({ op: 'backup', config, directory });
  }

  verifyBackup(directory: string): Promise<void> {
    return this.#send({ op: 'verify-backup', directory });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#send({ op: 'close' }); }
    catch { /* the worker is already gone; terminate below is still required */ }
    await this.#worker.terminate();
    // Deterministic fail-fast for any call that races the shutdown.
    this.#failure ??= new Error('DATABASE_CLOSED');
  }
}
