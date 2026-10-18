import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardProvisioningEvents } from '../src/provisioning-callbacks.js';

test('connector errors and completion use current callbacks after a step change', () => {
  let step = 0; let hidden = false; let completed = '';
  const callbacksForRender = () => {
    const renderedStep = step;
    return { onStepChange: (next: number) => { step = next; }, onError: () => { if (renderedStep < 1) hidden = true; }, onProvisioned: () => { completed = String(renderedStep); }, onAlreadyClaimed: () => {} };
  };
  let current = callbacksForRender();
  const listeners = forwardProvisioningEvents(() => current);
  listeners.onStepChange(1); current = callbacksForRender();
  listeners.onError(new Error('WIFI_CONFIGURATION_REJECTED'));
  assert.equal(hidden, false);
  listeners.onStepChange(2); current = callbacksForRender();
  listeners.onError(new Error('SERVER_ONLINE_TIMEOUT'));
  assert.equal(hidden, false);
  listeners.onProvisioned();
  assert.equal(completed, '2');
});
