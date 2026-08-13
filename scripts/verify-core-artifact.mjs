import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coreManifest } from '@voicecan/device-core/manifest';
import { loadNodePrivateCore } from '@voicecan/device-core/node';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'core-artifacts.lock.json'), 'utf8'));
const artifact = await readFile(resolve(root, lock.file));
const digest = createHash('sha256').update(artifact).digest('hex');
if (digest !== lock.sha256) throw new Error('CORE_ARTIFACT_DIGEST_MISMATCH');
if (coreManifest.protocolAbi !== lock.protocol_abi || coreManifest.supportedRange !== lock.supported_range
  || coreManifest.conformanceHash !== lock.conformance_hash) throw new Error('CORE_MANIFEST_MISMATCH');
const factory = await loadNodePrivateCore();
const session = await factory.createSession({
  exchange: async () => { throw new Error('not used by conformance verification'); },
  close: async () => undefined,
});
await session.close();
process.stdout.write(`verified ${lock.package}@${lock.version} (${lock.protocol_abi})\n`);
