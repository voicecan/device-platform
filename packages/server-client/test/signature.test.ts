import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { API_VERSION, type RecordingMediaDescriptor } from '@voicecan/contracts';
import {
  assessRecordingMedia, isKnownRecordingMedia, parseVerifiedDeviceEvent,
  verifyEventSignature, verifyEventSignatureWithSecrets, VoicecanWebhookError,
} from '../src/index.js';

test('webhook verifier checks body, delivery id and timestamp', () => {
  const rawBody = Buffer.from('{"ok":true}');
  const timestamp = '1785744000';
  const deliveryId = 'delivery_1';
  const signature = `v1=${createHmac('sha256', 'secret').update(`${timestamp}.${deliveryId}.`).update(rawBody).digest('hex')}`;
  assert.equal(verifyEventSignature({ rawBody, timestamp, deliveryId, signature, secret: 'secret', now: 1_785_744_000_000 }), true);
  assert.equal(verifyEventSignature({ rawBody: Buffer.from('{}'), timestamp, deliveryId, signature, secret: 'secret', now: 1_785_744_000_000 }), false);
  assert.equal(verifyEventSignatureWithSecrets({ rawBody, timestamp, deliveryId, signature, secrets: ['next-secret', 'secret'], now: 1_785_744_000_000 }), true);
});

test('verified Webhook parser accepts rotating secrets and validates the public event envelope', () => {
  const event = { id: 'event-1', type: 'file.synced', api_version: API_VERSION, created_at: '2026-08-01T00:00:00.000Z', data: { file_id: 'recording-1' } };
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = '1785542400';
  const deliveryId = 'delivery-1';
  const signature = `v1=${createHmac('sha256', 'next-secret').update(`${timestamp}.${deliveryId}.`).update(rawBody).digest('hex')}`;
  const parsed = parseVerifiedDeviceEvent({
    rawBody,
    headers: { 'Voicecan-Timestamp': timestamp, 'voicecan-delivery-id': deliveryId, 'VOICECAN-SIGNATURE': signature },
    secrets: ['current-secret', 'next-secret'],
    now: 1_785_542_400_000,
  });
  assert.deepEqual(parsed, event);
  assert.throws(() => parseVerifiedDeviceEvent({ rawBody, headers: {}, secrets: ['next-secret'], now: 1_785_542_400_000 }), (error: unknown) => error instanceof VoicecanWebhookError && error.status === 401);
});

test('recording media assessment trusts reviewed declarations but never binary fallbacks', () => {
  const media: RecordingMediaDescriptor = {
    schema_version: 'recording.media.v1', container: 'lc3', codec: 'lc3', content_type: 'audio/lc3', filename_extension: 'lc3',
    sample_rate_hz: 16_000, channels: 1, bit_depth: null, duration_ms: null, encoding_profile: 'voicecan-lc3-v1', source: 'server_verified',
  };
  assert.equal(isKnownRecordingMedia(media), true);
  assert.deepEqual(assessRecordingMedia({ ...media, source: 'unknown' }), { usable: false, reason: 'MEDIA_SOURCE_UNKNOWN' });
  assert.deepEqual(assessRecordingMedia({ ...media, content_type: 'application/octet-stream', filename_extension: 'bin' }), { usable: false, reason: 'MEDIA_BINARY_FALLBACK' });
});
