import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const forbiddenRoots = ['Cargo.toml', 'Cargo.lock', 'crates', 'private-fixtures', 'packages/device-core'];
for (const path of forbiddenRoots) {
  try {
    await readdir(resolve(root, path));
    throw new Error(`PRIVATE_CORE_PATH_PRESENT: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'vendor'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (['.rs', '.frames', '.map'].includes(extname(entry.name))) throw new Error(`PRIVATE_CORE_FILE_PRESENT: ${path}`);
  }
}
await scan(root);

const lock = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(root, 'core-artifacts.lock.json'), 'utf8'));
const entries = execFileSync('tar', ['-tf', resolve(root, lock.file)], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const forbiddenArtifact = entries.find((entry) => /(^|\/)(src|test|tests|crates|private-fixtures)(\/|$)|\.(rs|frames|map)$/.test(entry));
if (forbiddenArtifact) throw new Error(`PRIVATE_SOURCE_IN_RELEASE_ARTIFACT: ${forbiddenArtifact}`);
const rawGlue = entries.find((entry) => /private\/(browser|node)\/protocol_core\.(js|cjs)$/.test(entry));
if (rawGlue) throw new Error(`RAW_CORE_GLUE_IN_RELEASE_ARTIFACT: ${rawGlue}`);
for (const required of ['package/private/browser/semantic_core.js', 'package/private/node/semantic_core.cjs']) {
  if (!entries.includes(required)) throw new Error(`SEMANTIC_CORE_ENTRY_MISSING: ${required}`);
}
const inspection = await mkdtemp(join(tmpdir(), 'voicecan-core-boundary-'));
try {
  execFileSync('tar', ['-xzf', resolve(root, lock.file), '-C', inspection]);
  const browser = await import(pathToFileURL(resolve(inspection, 'package/private/browser/semantic_core.js')).href);
  const node = await import(pathToFileURL(resolve(inspection, 'package/private/node/semantic_core.cjs')).href);
  if (Object.keys(browser).sort().join(',') !== 'default,loadSemanticCore') throw new Error(`BROWSER_CORE_EXPORT_SURFACE_INVALID: ${Object.keys(browser).join(',')}`);
  const nodeExports = Object.keys(node).filter((name) => !['default', 'module.exports'].includes(name)).sort().join(',');
  if (nodeExports !== 'loadSemanticCore,loadSemanticGatewayCore') throw new Error(`NODE_CORE_EXPORT_SURFACE_INVALID: ${nodeExports}`);
} finally {
  await rm(inspection, { recursive: true, force: true });
}
process.stdout.write(`public boundary verified (${entries.length} protocol-runtime artifact files inspected)\n`);
