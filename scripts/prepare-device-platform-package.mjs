import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageRoot = resolve(root, 'distribution/device-platform');
const runtimeRoot = resolve(packageRoot, 'runtime');
const bundledRoot = resolve(packageRoot, 'node_modules/@voicecan');

async function requirePath(path) {
  try { await readdir(path); } catch { throw new Error(`Required build output is missing: ${path}`); }
}

async function copyDirectory(source, destination) {
  await requirePath(source);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

await rm(runtimeRoot, { recursive: true, force: true });
await rm(resolve(packageRoot, 'node_modules'), { recursive: true, force: true });
await cp(resolve(root, 'LICENSE'), resolve(packageRoot, 'LICENSE'));

for (const name of ['device-server', 'admin-web', 'device-ui', 'device-web', 'contracts']) {
  await copyDirectory(resolve(root, `packages/${name}/dist`), resolve(runtimeRoot, name, 'dist'));
  await rm(resolve(runtimeRoot, name, 'dist/.tsbuildinfo'), { force: true });
}
await rm(resolve(runtimeRoot, 'device-server/dist/src'), { recursive: true, force: true });

await copyDirectory(resolve(root, 'packages/access-control/dist'), resolve(bundledRoot, 'access-control/dist'));
await rm(resolve(bundledRoot, 'access-control/dist/.tsbuildinfo'), { force: true });
const accessManifest = JSON.parse(await readFile(resolve(root, 'packages/access-control/package.json'), 'utf8'));
await cp(resolve(root, 'packages/access-control/package.json'), resolve(bundledRoot, 'access-control/package.json'));
if (accessManifest.name !== '@voicecan/access-control') throw new Error('Unexpected access-control package identity');

const installedCore = resolve(root, 'node_modules/@voicecan/device-core');
const coreManifest = JSON.parse(await readFile(resolve(installedCore, 'package.json'), 'utf8'));
if (coreManifest.name !== '@voicecan/device-core' || coreManifest.version !== '0.1.0-preview.18') {
  throw new Error('The installed reviewed protocol-runtime artifact does not match the pinned release');
}
await mkdir(resolve(bundledRoot, 'device-core'), { recursive: true });
await cp(resolve(installedCore, 'package.json'), resolve(bundledRoot, 'device-core/package.json'));
for (const path of [...coreManifest.files, 'README.md']) {
  const source = resolve(installedCore, path);
  const destination = resolve(bundledRoot, 'device-core', path);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

process.stdout.write('Prepared self-contained @voicecan/device-platform runtime\n');
