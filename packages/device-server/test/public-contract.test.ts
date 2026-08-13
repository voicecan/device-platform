import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capabilityVersion,
  deviceCapabilities,
  recordingMedia,
  recordingTiming,
  reviewedRecordingMedia,
} from '../src/public-contract.js';

test('recording media uses only reviewed facts and normalizes invalid values to unknown', () => {
  assert.deepEqual(reviewedRecordingMedia({ model: 'unreviewed', firmware_version: '99.0' }), {
    schema_version: 'recording.media.v1', container: null, codec: null,
    content_type: 'application/octet-stream', filename_extension: 'bin', sample_rate_hz: null,
    channels: null, bit_depth: null, duration_ms: null, encoding_profile: null, source: 'unknown',
  });
  const media = recordingMedia({
    media_content_type: '', media_filename_extension: '', media_sample_rate_hz: -1,
    media_channels: 0, media_bit_depth: 16.5, duration_ms: Number.NaN,
    media_metadata_source: 'caller_claimed',
  });
  assert.equal(media.content_type, 'application/octet-stream');
  assert.equal(media.filename_extension, 'bin');
  assert.equal(media.sample_rate_hz, null);
  assert.equal(media.channels, null);
  assert.equal(media.bit_depth, null);
  assert.equal(media.duration_ms, null);
  assert.equal(media.source, 'unknown');
});

test('recording timing keeps server discovery separate and validates timezone boundaries', () => {
  const base = { created_at: '2026-08-07T00:00:00.000Z', device_started_at: null, device_ended_at: null, duration_ms: 0 };
  assert.equal(recordingTiming({ ...base, device_timezone_offset_minutes: -840 }).device_timezone_offset_minutes, -840);
  assert.equal(recordingTiming({ ...base, device_timezone_offset_minutes: 840 }).device_timezone_offset_minutes, 840);
  assert.equal(recordingTiming({ ...base, device_timezone_offset_minutes: 841 }).device_timezone_offset_minutes, null);
  assert.equal(recordingTiming({ ...base, device_timezone_offset_minutes: 1.5 }).device_timezone_offset_minutes, null);
  assert.equal(recordingTiming(base).device_started_at, null);
  assert.equal(recordingTiming(base).duration_ms, null);
});

test('capability versions are stable by reviewed model and firmware, not device identity', () => {
  const first = { id: 'device-a', model: 'CAPSO', firmware_version: 'v0.5.3', claim_status: 'active' };
  const second = { ...first, id: 'device-b' };
  assert.equal(capabilityVersion(first), capabilityVersion(second));
  assert.match(capabilityVersion(first), /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(deviceCapabilities(first).commands, ['recording.sync']);
  const unknown = deviceCapabilities({ id: 'device-c', model: 'future-model', firmware_version: '1.0', claim_status: 'active' });
  assert.equal(unknown.recording.supported, false);
  assert.equal(unknown.source, 'unknown');
  assert.deepEqual(unknown.recording.media_profiles, []);
});
