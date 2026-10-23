import assert from 'node:assert/strict';
import test from 'node:test';
import { startGuardedInterval } from '../src/scheduled-task.js';

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('a rejecting interval task is reported and keeps running', async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const task = startGuardedInterval(5, async () => { runs += 1; throw new Error('database unavailable'); }, (error) => errors.push(error));
  try {
    await wait(60);
    assert.ok(runs >= 2, `expected repeated runs, got ${runs}`);
    assert.equal(errors.length, runs);
    assert.match((errors[0] as Error).message, /database unavailable/);
  } finally { task.stop(); }
});

test('a synchronous throw is reported instead of escaping the timer', async () => {
  const errors: unknown[] = [];
  const task = startGuardedInterval(5, () => { throw new Error('synchronous failure'); }, (error) => errors.push(error));
  try {
    await wait(40);
    assert.ok(errors.length >= 1);
    assert.match((errors[0] as Error).message, /synchronous failure/);
  } finally { task.stop(); }
});

test('stop prevents further runs and is idempotent', async () => {
  let runs = 0;
  const task = startGuardedInterval(5, () => { runs += 1; }, () => undefined);
  await wait(30);
  task.stop();
  task.stop();
  const stoppedAt = runs;
  await wait(40);
  assert.equal(runs, stoppedAt);
  assert.ok(stoppedAt >= 1);
});

test('a task that outlives its interval never overlaps itself', async () => {
  let runs = 0;
  let active = 0;
  let maxActive = 0;
  const task = startGuardedInterval(10, async () => {
    runs += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(40);
    active -= 1;
  }, () => undefined);
  try {
    await wait(160);
    assert.ok(runs >= 2, `expected repeated runs, got ${runs}`);
    assert.equal(maxActive, 1);
  } finally { task.stop(); }
});
