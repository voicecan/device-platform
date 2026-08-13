import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

type SqlRequest = {
  id: number;
  op: 'run' | 'get' | 'all' | 'batch' | 'close';
  sql?: string;
  params?: unknown[];
  statements?: Array<{ sql: string; params?: unknown[]; expectChanges?: number }>;
};

const database = new DatabaseSync(workerData.filename as string, { enableForeignKeyConstraints: true });
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');

parentPort?.on('message', (request: SqlRequest) => {
  try {
    let result: unknown;
    if (request.op === 'close') {
      database.close();
      result = null;
    } else if (request.op === 'run') {
      const change = database.prepare(request.sql!).run(...((request.params ?? []) as SQLInputValue[]));
      result = { changes: Number(change.changes), lastInsertRowid: String(change.lastInsertRowid) };
    } else if (request.op === 'get') {
      result = database.prepare(request.sql!).get(...((request.params ?? []) as SQLInputValue[])) ?? null;
    } else if (request.op === 'all') {
      result = database.prepare(request.sql!).all(...((request.params ?? []) as SQLInputValue[]));
    } else {
      database.exec('BEGIN IMMEDIATE');
      try {
        result = request.statements!.map((statement) => {
          const change = database.prepare(statement.sql).run(...((statement.params ?? []) as SQLInputValue[]));
          const result = { changes: Number(change.changes), lastInsertRowid: String(change.lastInsertRowid) };
          if (statement.expectChanges !== undefined && result.changes !== statement.expectChanges) throw new Error(`DATABASE_CAS_FAILED:${statement.expectChanges}:${result.changes}`);
          return result;
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    parentPort?.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
