import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDeviceToken, deviceTokenVerifier, encodeDeviceToken } from '../src/security.js';

test('device tokens use canonical padded standard Base64 and byte verifiers', () => {
  const raw = Buffer.from(Array.from({ length: 32 }, (_, index) => 0xf0 ^ index));
  const encoded = encodeDeviceToken(raw);
  assert.match(encoded, /^[A-Za-z0-9+/]{43}=$/);
  assert.deepEqual(decodeDeviceToken(encoded), raw);
  assert.throws(() => decodeDeviceToken(raw.toString('base64url')), /DEVICE_TOKEN_ENCODING/);
  const pepper = Buffer.alloc(32, 7);
  assert.equal(deviceTokenVerifier(raw, pepper), deviceTokenVerifier(Buffer.from(raw), pepper));
});
