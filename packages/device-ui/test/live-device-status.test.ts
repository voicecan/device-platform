import assert from 'node:assert/strict';
import test from 'node:test';
import { readLiveDeviceStatus } from '../src/live-device-status.js';

test('stopping live polling drains the current response without aborting its BLE command', async () => {
  const controller = new AbortController();
  let finish!: (status: { wifiConfigured: boolean }) => void;
  let finished = false;
  const read = readLiveDeviceStatus({ getStatus: (...args: unknown[]) => {
    assert.equal(args.length, 0, 'poll cancellation must not free the transport while a device response is pending');
    return new Promise<{ wifiConfigured: boolean }>((resolve) => { finish = resolve; });
  } }, controller.signal).then(() => { finished = true; }, (error: unknown) => { finished = true; throw error; });
  const rejection = assert.rejects(read, { name: 'AbortError' });
  controller.abort();
  await Promise.resolve();
  assert.equal(finished, false, 'the pending response must drain before the canceled poll settles');
  finish({ wifiConfigured: true });
  await rejection;
});

test('an already stopped live poll does not start a device read', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readLiveDeviceStatus({ getStatus: async () => { assert.fail('stopped poll must not read'); } }, controller.signal), { name: 'AbortError' });
});
