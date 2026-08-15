import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { randomUuidV4 } from '../src/random.js';

test('browser idempotency keys use getRandomValues without randomUUID', async () => {
  const source = await readFile(new URL('../src/random.ts', import.meta.url), 'utf8');
  assert.match(source, /crypto\.getRandomValues/);
  assert.doesNotMatch(source, /crypto\.randomUUID/);

  const value = randomUuidV4();
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
