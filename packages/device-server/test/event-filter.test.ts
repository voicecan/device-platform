import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesEventSubscriptionFilter } from '../src/events.js';

const delivery = {
  replay_namespace: 'live',
  event_types_json: '["file.synced"]',
  device_ids_json: '["device-1"]',
  attributes_json: '[0]',
  event_type: 'file.synced',
  event_device_id: 'device-1',
  payload_json: '{"attribute":0}',
};

test('Application event filters narrow by type, device and numeric recording attribute', () => {
  assert.equal(matchesEventSubscriptionFilter(delivery), true);
  assert.equal(matchesEventSubscriptionFilter({ ...delivery, event_type: 'recording.deleted' }), false);
  assert.equal(matchesEventSubscriptionFilter({ ...delivery, event_device_id: 'device-2' }), false);
  assert.equal(matchesEventSubscriptionFilter({ ...delivery, payload_json: '{"attribute":1}' }), false);
});

test('signed test deliveries bypass filters but ordinary malformed payloads fail closed', () => {
  assert.equal(matchesEventSubscriptionFilter({ ...delivery, replay_namespace: 'test:event-1', event_type: 'webhook.test', payload_json: '{}' }), true);
  assert.equal(matchesEventSubscriptionFilter({ ...delivery, payload_json: 'not-json' }), false);
});
