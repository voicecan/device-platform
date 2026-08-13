import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCli = process.env.npm_execpath;
const registry = 'https://registry.npmjs.org/';
const workspaces = ['packages/contracts', 'packages/server-client', 'packages/connector-runtime'];
const tagIndex = process.argv.indexOf('--tag');
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : 'preview';
if (!tag || !/^[a-z][a-z0-9._-]*$/i.test(tag)) throw new Error('A valid npm dist-tag is required');

function run(args, options = {}) {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', ...options })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed`);
}

const identity = npmCli
  ? spawnSync(process.execPath, [npmCli, 'whoami', '--registry', registry], { cwd: root, encoding: 'utf8' })
  : spawnSync('npm', ['whoami', '--registry', registry], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (identity.status !== 0) throw new Error('Authenticate to the official npm registry before publishing');

run(['run', 'ci']);
run(['run', 'npm:pack:check']);

const packages = [];
for (const workspace of workspaces) {
  const manifest = JSON.parse(await readFile(resolve(root, workspace, 'package.json'), 'utf8'));
  const existing = npmCli
    ? spawnSync(process.execPath, [npmCli, 'view', `${manifest.name}@${manifest.version}`, 'version', '--registry', registry], { cwd: root, encoding: 'utf8' })
    : spawnSync('npm', ['view', `${manifest.name}@${manifest.version}`, 'version', '--registry', registry], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (existing.status === 0) throw new Error(`${manifest.name}@${manifest.version} is already published; npm versions are immutable`);
  const lookupFailure = `${existing.stdout ?? ''}\n${existing.stderr ?? ''}`;
  if (!/E404|404 Not Found/i.test(lookupFailure)) throw new Error(`Unable to verify whether ${manifest.name}@${manifest.version} already exists; refusing to publish`);
  packages.push({ workspace, manifest });
}

for (const { workspace, manifest } of packages) {
  process.stdout.write(`publishing ${manifest.name}@${manifest.version} with tag ${tag}\n`);
  run(['publish', '--workspace', manifest.name, '--tag', tag, '--access', 'public', '--registry', registry]);
}
