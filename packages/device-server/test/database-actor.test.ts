import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseActor } from '../src/database.js';

test('a closed database actor fails fast instead of leaving calls pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voicecan-db-actor-'));
  const db = new DatabaseActor(join(directory, 'test.sqlite'));
  try {
    const row = await db.get<{ value: number }>('SELECT 1 AS value');
    assert.equal(row?.value, 1);
    await db.close();
    await assert.rejects(db.run('SELECT 1'), /DATABASE_WORKER_EXITED|DATABASE_CLOSED/);
    await assert.rejects(db.all('SELECT 1'), /DATABASE_WORKER_EXITED|DATABASE_CLOSED/);
  } finally {
    await db.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
