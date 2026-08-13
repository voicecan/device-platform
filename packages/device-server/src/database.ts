import { Worker } from 'node:worker_threads';

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
export type SqlStatement = { sql: string; params?: unknown[]; expectChanges?: number };

export interface Database {
  readonly dialect: 'sqlite' | 'postgres';
  readonly multiInstance: boolean;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  get<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  batch(statements: SqlStatement[]): Promise<Array<{ changes: number }>>;
  close(): Promise<void>;
}

export class DatabaseActor implements Database {
  readonly dialect = 'sqlite' as const;
  readonly multiInstance = false;
  #worker: Worker;
  #sequence = 0;
  #pending = new Map<number, Pending>();

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
    this.#worker.on('error', (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  #send<T>(message: Record<string, unknown>): Promise<T> {
    const id = ++this.#sequence;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#worker.postMessage({ id, ...message });
    });
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

  async close(): Promise<void> {
    await this.#send({ op: 'close' });
    await this.#worker.terminate();
  }
}
