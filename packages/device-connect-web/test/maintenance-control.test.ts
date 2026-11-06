import assert from 'node:assert/strict';
import test from 'node:test';
import type { SemanticProtocolSession } from '@voicecan/device-core';
import { applyMaintenanceControl } from '../src/maintenance-control.js';

test('nearby maintenance routes recording controls and mode settings through semantic Core', async () => {
  const calls: unknown[] = [];
  const session = {
    controlRecording: async (action: string, options?: unknown) => { calls.push(options === undefined ? action : { action, options }); return { result: 0, sessionId: 42 }; },
    setRecordingMode: async (configuration: unknown) => { calls.push(configuration); },
    factoryReset: async () => { throw new Error('recording must never fall through to reset'); },
  } as unknown as SemanticProtocolSession;
  for (const action of ['start', 'pause', 'resume', 'stop', 'highlight', 'preserve'] as const) await applyMaintenanceControl(session, { kind: 'recording', action });
  const configuration = { kind: 'recording_mode', mode: 'lookback', microphoneMode: 2, microphoneGainDb: 21 } as const;
  await applyMaintenanceControl(session, configuration);
  assert.deepEqual(calls, ['start', 'pause', 'resume', 'stop', 'highlight', 'preserve', configuration]);
  for (const minutes of [0, 30, 255]) await applyMaintenanceControl(session, { kind: 'recording', action: 'start', maxDurationMinutes: minutes });
  assert.deepEqual(calls.slice(-3), [0, 30, 255].map((minutes) => ({ action: 'start', options: { maxDurationMinutes: minutes } })));
  session.controlRecording = async () => { throw new Error('device rejected recording'); };
  await assert.rejects(applyMaintenanceControl(session, { kind: 'recording', action: 'start' }), /device rejected/);
});
