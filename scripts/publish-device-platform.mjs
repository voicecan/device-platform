import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageRoot = resolve(root, 'distribution/device-platform');
const registry = 'https://registry.npmjs.org/';
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;

function invoke(args, options = {}) {
  return npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, ...options })
    : spawnSync('npm', args, { cwd: root, shell: process.platform === 'win32', ...options });
}

function run(args, options = {}) {
  const result = invoke(args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed`);
}

if (manifest.name !== '@voicecan/device-platform' || manifest.version !== '1.0.0') throw new Error('Unexpected Device Platform package identity');
if (manifest.license !== 'Apache-2.0' || !existsSync(resolve(root, 'LICENSE')) || !existsSync(resolve(packageRoot, 'NOTICE'))) {
  throw new Error('The repository licensing gate is unresolved; Apache-2.0 LICENSE and NOTICE are required before publishing');
}
if (manifest.publishConfig?.registry !== registry || manifest.publishConfig?.access !== 'public') throw new Error('Unexpected npm publication settings');

const identity = invoke(['whoami', '--registry', registry], { encoding: 'utf8' });
if (identity.status !== 0) throw new Error('Authenticate to the official npm registry before publishing');

const existing = invoke(['view', `${manifest.name}@${manifest.version}`, 'version', '--registry', registry], { encoding: 'utf8' });
if (existing.status === 0) throw new Error(`${manifest.name}@${manifest.version} is already published; npm versions are immutable`);
if (!/E404|404 Not Found/i.test(`${existing.stdout ?? ''}\n${existing.stderr ?? ''}`)) throw new Error('Unable to verify that the target version is unpublished');

run(['run', 'ci']);
run(['run', 'npm:pack:check']);
run(['run', 'npm:platform:test']);
run(['publish', './distribution/device-platform', '--tag', 'latest', '--access', 'public', '--registry', registry]);
