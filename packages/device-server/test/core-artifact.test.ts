import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFORMANCE_HASH, PROTOCOL_ABI } from '@voicecan/contracts';
import { coreManifest } from '@voicecan/device-core/manifest';
import { loadNodePrivateCore } from '@voicecan/device-core/node';

test('reviewed Core artifact matches the public ABI contract and loads in Node', async () => {
  assert.equal(coreManifest.protocolAbi, PROTOCOL_ABI);
  assert.equal(coreManifest.conformanceHash, CONFORMANCE_HASH);
  const factory = await loadNodePrivateCore();
  const session = await factory.createSession({
    exchange: async () => { throw new Error('not used'); },
    close: async () => undefined,
  });
  await session.close();
});
