import assert from 'node:assert/strict';
import test from 'node:test';
import { formatIsoTimestamp, formatSessionTimestamp, isoTimestampTitle, sessionTimestamp, sessionTimestampTitle } from '../src/recording-timestamp.js';

test('device session IDs decode as UTC Unix seconds', () => {
  assert.equal(sessionTimestamp(1_791_878_307)?.iso, '2026-10-13T07:58:27.000Z');
  assert.equal(sessionTimestamp(1_791_878_307_000)?.iso, '2026-10-13T07:58:27.000Z');
  assert.equal(sessionTimestamp(0), null);
  assert.equal(sessionTimestamp(Number.NaN), null);
});

test('session timestamps format in the requested user timezone', () => {
  assert.match(formatSessionTimestamp(1_791_878_307, 'en-US', 'Asia/Shanghai'), /10\/13\/2026/);
  assert.match(formatSessionTimestamp(1_791_878_307, 'en-US', 'Asia/Shanghai'), /15:58:27/);
  assert.match(sessionTimestampTitle(1_791_878_307, 'en-US', 'Asia/Shanghai') ?? '', /Asia\/Shanghai/);
  assert.match(formatIsoTimestamp('2026-10-23T13:33:30.918Z', 'en-US', 'Asia/Shanghai'), /10\/23\/2026/);
  assert.match(formatIsoTimestamp('2026-10-23T13:33:30.918Z', 'en-US', 'Asia/Shanghai'), /21:33:30/);
  assert.match(isoTimestampTitle('2026-10-23T13:33:30.918Z', 'en-US', 'Asia/Shanghai') ?? '', /Asia\/Shanghai/);
  assert.equal(formatIsoTimestamp(null), '—');
});
