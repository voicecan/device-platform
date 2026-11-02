import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingModeControl, recordingResultMessage, waitForRecordingCommand } from '../src/recording-control.js';

test('recording mode uses current microphone settings and refuses unknown settings', () => {
  assert.deepEqual(recordingModeControl('lookback', { microphone_mode: 2, microphone_gain_db: 17 }), { kind: 'recording_mode', mode: 'lookback', microphoneMode: 2, microphoneGainDb: 17 });
  for (const status of [{ microphone_mode: null, microphone_gain_db: 3 }, { microphone_mode: 0, microphone_gain_db: null }, { microphone_mode: 3, microphone_gain_db: 2 }, { microphone_mode: 0, microphone_gain_db: 32 }]) assert.throws(() => recordingModeControl('smart_capture', status), /RECORDING_SETTINGS_UNAVAILABLE/);
});

test('recording confirmation waits through dispatch and running before succeeding', async () => {
  const statuses = ['dispatched', 'running', 'succeeded']; const reads: string[] = [];
  const result = await waitForRecordingCommand({ id: 'cmd-1', status: 'queued', error_code: null }, async (id) => { reads.push(id); return { id, status: statuses.shift()!, error_code: null }; }, new AbortController().signal, { pause: async () => undefined });
  assert.equal(result.status, 'succeeded'); assert.deepEqual(reads, ['cmd-1', 'cmd-1', 'cmd-1']);
});

test('recording failures and pending deadlines never become success notices', async () => {
  for (const status of ['failed', 'expired']) await assert.rejects(waitForRecordingCommand({ id: 'cmd', status, error_code: 'DEVICE_RESULT_05' }, async () => { throw new Error('not reached'); }, new AbortController().signal), /DEVICE_RESULT_05/);
  await assert.rejects(waitForRecordingCommand({ id: 'cmd', status: 'running', error_code: null }, async () => { throw new Error('not reached'); }, new AbortController().signal, { timeoutMs: 0 }), /RECORDING_COMMAND_PENDING/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(waitForRecordingCommand({ id: 'cmd', status: 'queued', error_code: null }, async () => { throw new Error('not reached'); }, abort.signal), { name: 'AbortError' });
  assert.match(recordingResultMessage('DEVICE_RESULT_02'), /USB disk/);
  assert.match(recordingResultMessage('DEVICE_RESULT_02', true), /noise reduction/);
});
