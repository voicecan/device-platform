import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCli = process.env.npm_execpath;
const workspaces = ['packages/contracts', 'packages/server-client', 'packages/connector-runtime'];
const registry = 'https://registry.npmjs.org/';

function run(args, options = {}) {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, encoding: 'utf8', ...options })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(String(result.error ?? result.stderr ?? result.stdout ?? `npm ${args.join(' ')} failed`));
  return result.stdout;
}

run(['run', 'build']);

for (const workspace of workspaces) {
  const manifest = JSON.parse(await readFile(resolve(root, workspace, 'package.json'), 'utf8'));
  if (manifest.private) throw new Error(`${manifest.name} must be publishable`);
  if (manifest.publishConfig?.registry !== registry) throw new Error(`${manifest.name} has an unexpected publish registry`);
  if (manifest.publishConfig?.access !== 'public') throw new Error(`${manifest.name} must publish with public access`);
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (String(version).startsWith('file:') || String(version).startsWith('workspace:')) throw new Error(`${manifest.name} has non-publishable dependency ${name}@${version}`);
  }
  const packed = JSON.parse(run(['pack', '--dry-run', '--json', '--workspace', manifest.name, '--ignore-scripts']));
  const entry = packed[0];
  const paths = new Set(entry.files.map((file) => file.path));
  for (const required of ['package.json', 'dist/index.js', 'dist/index.d.ts']) {
    if (!paths.has(required)) throw new Error(`${manifest.name} package is missing ${required}`);
  }
  for (const path of paths) {
    if (path.includes('/src/') || path.includes('/test/') || path.endsWith('.tsbuildinfo')) throw new Error(`${manifest.name} leaks development file ${path}`);
  }
  process.stdout.write(`pack verified ${manifest.name}@${manifest.version} (${entry.files.length} files)\n`);
}

run(['exec', '--', 'node', 'scripts/prepare-device-platform-package.mjs']);
const platformManifest = JSON.parse(await readFile(resolve(root, 'distribution/device-platform/package.json'), 'utf8'));
const platformPacked = JSON.parse(run(['pack', '--dry-run', '--json', './distribution/device-platform', '--ignore-scripts']));
const platformEntry = platformPacked[0];
const platformPaths = new Set(platformEntry.files.map((file) => file.path));
for (const required of [
  'package.json',
  'README.md',
  'runtime/device-server/dist/cli.js',
  'runtime/admin-web/dist/index.html',
  'runtime/device-web/dist/index.js',
  'runtime/device-ui/dist/index.js',
  'node_modules/@voicecan/access-control/dist/index.js',
  'node_modules/@voicecan/device-core/private/browser/semantic_core.js',
  'node_modules/@voicecan/device-core/private/browser/protocol_core_bg.wasm',
]) {
  if (!platformPaths.has(required)) throw new Error(`${platformManifest.name} package is missing ${required}`);
}
for (const path of platformPaths) {
  if (path.includes('/src/') || path.includes('/test/') || path.endsWith('.tsbuildinfo')) throw new Error(`${platformManifest.name} leaks development file ${path}`);
}
process.stdout.write(`pack verified ${platformManifest.name}@${platformManifest.version} (${platformEntry.files.length} files)\n`);
