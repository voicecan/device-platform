import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { parseApiEnvelope } from '../src/api-response.js';

test('a valid success envelope is returned unchanged', () => {
  const envelope = parseApiEnvelope<{ id: string }>(200, JSON.stringify({ success: true, code: '', message: 'success', data: { id: 'dev_1' } }));
  assert.deepEqual(envelope.data, { id: 'dev_1' });
});

test('an empty success body resolves without data', () => {
  const envelope = parseApiEnvelope<void>(204, '');
  assert.equal(envelope.success, true);
  assert.equal(envelope.data, undefined);
});

test('an empty failure body becomes a typed error', () => {
  assert.throws(() => parseApiEnvelope(502, ''), (error: unknown) => error instanceof ApiError && error.code === 'EMPTY_RESPONSE' && error.status === 502);
});

test('a proxy HTML page becomes a typed error instead of a SyntaxError', () => {
  assert.throws(() => parseApiEnvelope(502, '<html><body>Bad Gateway</body></html>'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE' && error.status === 502);
});

test('a successful status with a non-envelope body is rejected', () => {
  assert.throws(() => parseApiEnvelope(200, '{"ok":true}'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});

test('a JSON failure envelope keeps its server code and message for the caller', () => {
  const envelope = parseApiEnvelope(409, JSON.stringify({ success: false, code: 'BINDING_STATE_CONFLICT', message: 'State changed', data: null }));
  assert.equal(envelope.success, false);
  assert.equal(envelope.code, 'BINDING_STATE_CONFLICT');
  assert.equal(envelope.message, 'State changed');
});
