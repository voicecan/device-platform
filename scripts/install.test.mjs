import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const installer = join(root, 'install.sh');
const nodeInstaller = join(root, 'install-node.sh');
const unixInstallerTest = { skip: process.platform === 'win32' ? 'Bash installers support macOS and Linux; exercised by Linux CI' : false };

test('runtime lock pins every supported platform and matches build/CI baselines', async () => {
  const lock = await readFile(join(root, 'node-runtime.lock'), 'utf8');
  const version = lock.match(/^node_version=([^\n]+)$/m)?.[1]?.trimEnd();
  assert.equal(version, '24.19.0');
  for (const target of ['darwin|arm64', 'darwin|x64', 'linux|arm64', 'linux|x64']) {
    assert.match(lock, new RegExp(`^${target.replace('|', '\\|')}\\|node-v${version}-.+\\|[0-9a-f]{64}$`, 'm'));
  }
  for (const path of ['Dockerfile', 'packages/device-connect-web/Dockerfile', '.gitea/workflows/ci.yaml', '.gitea/workflows/release-candidate.yaml']) {
    assert.match(await readFile(join(root, path), 'utf8'), new RegExp(`24\\.19\\.0`), `${path} must use the locked Node runtime`);
  }
});

test('one-command installer clones main, writes safe config, migrates, and starts', unixInstallerTest, async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'voicecan-installer-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const bin = join(workspace, 'bin');
  const installDirectory = join(workspace, 'installation');
  const publicRepository = join(workspace, 'public-repository');
  await mkdir(bin);
  const fakeDocker = join(bin, 'docker');
  await writeFile(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "info" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "inspect" ]]; then
  printf 'healthy\\n'
  exit 0
fi
if [[ "\${1:-}" == "volume" ]]; then
  exit 1
fi
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  printf 'Docker Compose version v2.test\\n'
  exit 0
fi
if [[ " $* " == *" ps --all --quiet "* ]]; then
  exit 0
fi
if [[ " $* " == *" ps --quiet device-server "* ]]; then
  printf 'test-container\\n'
  exit 0
fi
exit 0
`);
  await chmod(fakeDocker, 0o755);

  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, publicRepository]);
  execFileSync('git', ['checkout', '--quiet', '-B', 'installer-test'], { cwd: publicRepository });
  const result = spawnSync('bash', [
    installer,
    '--repository', `file://${publicRepository}`,
    '--ref', 'installer-test',
    '--install-dir', installDirectory,
    '--port', '18787',
    '--project', 'voicecan-installer-test',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Voicecan Device Platform is installed and healthy/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:18787\/admin/);

  const environment = await readFile(join(installDirectory, '.env'), 'utf8');
  assert.match(environment, /^VOICECAN_PORT=18787$/m);
  assert.match(environment, /^VOICECAN_DATA_DIR=\/data$/m);
  assert.match(environment, /^VOICECAN_PUBLIC_BASE_URL=http:\/\/127\.0\.0\.1:18787$/m);
  assert.match(environment, /^VOICECAN_DEVICE_IMAGE=voicecan-device-platform:[0-9a-f]{12}$/m);
  assert.match(await readFile(join(installDirectory, '.git', 'voicecan-install-complete'), 'utf8'), /^[0-9a-f]{40}\n$/);

  const repeated = spawnSync('bash', [installer, '--install-dir', installDirectory], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already installed/);
});

test('installer rejects unsafe parameters before making changes', unixInstallerTest, () => {
  const invalidPort = spawnSync('bash', [installer, '--port', '0'], { encoding: 'utf8' });
  assert.notEqual(invalidPort.status, 0);
  assert.match(invalidPort.stderr, /port must be between 1 and 65535/);

  const invalidUrl = spawnSync('bash', [installer, '--public-url', 'https://device.example/#fragment'], { encoding: 'utf8' });
  assert.notEqual(invalidUrl.status, 0);
  assert.match(invalidUrl.stderr, /without spaces or fragments/);
});

test('Node.js installer verifies, builds, migrates, and writes a native runtime config', unixInstallerTest, async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'voicecan-node-installer-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const installDirectory = join(workspace, 'installation');
  const publicRepository = join(workspace, 'public-repository');
  const operationLog = join(workspace, 'operations.log');
  const runtimeFixture = join(workspace, 'runtime-fixture', 'node-v24.19.0-test');
  const runtimeBin = join(runtimeFixture, 'bin');
  const runtimeNpm = join(runtimeFixture, 'lib', 'node_modules', 'npm', 'bin');
  await mkdir(runtimeBin, { recursive: true });
  await mkdir(runtimeNpm, { recursive: true });

  const fakeNode = join(runtimeBin, 'node');
  await writeFile(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf 'v24.19.0\\n'
elif [[ "\${1:-}" == "-e" ]]; then
  exit 0
elif [[ "\${1:-}" == *"/npm-cli.js" ]]; then
  shift
  if [[ "\${1:-}" == "--version" ]]; then
    printf '11.17.0\\n'
  else
    printf 'npm:%s\\n' "$*" >> "$FAKE_INSTALL_LOG"
  fi
else
  printf 'node:%s\\n' "$*" >> "$FAKE_INSTALL_LOG"
fi
`);
  await chmod(fakeNode, 0o755);
  await writeFile(join(runtimeNpm, 'npm-cli.js'), '// fixture entrypoint\n');

  const runtimeArchive = join(workspace, 'node-runtime.tar.gz');
  execFileSync('tar', ['-czf', runtimeArchive, '-C', join(workspace, 'runtime-fixture'), 'node-v24.19.0-test']);
  const runtimeSha256 = createHash('sha256').update(await readFile(runtimeArchive)).digest('hex');
  const runtimeOs = process.platform === 'darwin' ? 'darwin' : 'linux';
  const runtimeArch = process.arch === 'arm64' ? 'arm64' : 'x64';

  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, publicRepository]);
  execFileSync('git', ['checkout', '--quiet', '-B', 'installer-test'], { cwd: publicRepository });
  const commitRuntimeLock = async (sha256) => {
    await writeFile(join(publicRepository, 'node-runtime.lock'), [
      'format=1',
      'node_version=24.19.0',
      'base_url=https://fixture.invalid/v24.19.0',
      `${runtimeOs}|${runtimeArch}|node-v24.19.0-${runtimeOs}-${runtimeArch}.tar.gz|${sha256}`,
      '',
    ].join('\n'));
    execFileSync('git', ['add', 'node-runtime.lock'], { cwd: publicRepository });
    execFileSync('git', ['-c', 'user.name=Voicecan Test', '-c', 'user.email=test@voicecan.invalid', 'commit', '--quiet', '-m', 'test: runtime lock'], { cwd: publicRepository });
  };
  await commitRuntimeLock(runtimeSha256);
  const result = spawnSync('bash', [
    nodeInstaller,
    '--repository', `file://${publicRepository}`,
    '--ref', 'installer-test',
    '--install-dir', installDirectory,
    '--port', '18788',
    '--no-service',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_INSTALL_LOG: operationLog,
      VOICECAN_NODE_ARCHIVE: runtimeArchive,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed with a private Node\.js runtime/);
  assert.match(result.stdout, new RegExp(`Node SHA:\\s+${runtimeSha256}`));
  assert.match(result.stdout, /No user-level service was started/);

  const environment = await readFile(join(installDirectory, '.env'), 'utf8');
  assert.match(environment, /^VOICECAN_HOST=127\.0\.0\.1$/m);
  assert.match(environment, /^VOICECAN_PORT=18788$/m);
  assert.match(environment, new RegExp(`^VOICECAN_DATA_DIR=${installDirectory}/data$`, 'm'));
  assert.match(environment, /^NODE_ENV=production$/m);

  assert.equal(await readFile(operationLog, 'utf8'), [
    'npm:ci --ignore-scripts',
    'npm:run check:public',
    'npm:run verify:core',
    'npm:run build',
    'node:--env-file=.env packages/device-server/dist/cli.js migrate',
    'npm:prune --omit=dev --ignore-scripts',
    '',
  ].join('\n'));
  assert.match(await readFile(join(installDirectory, '.git', 'voicecan-node-install-complete'), 'utf8'), /^[0-9a-f]{40}\n$/);
  assert.equal(await readFile(join(installDirectory, '.git', 'voicecan-node-runtime-version'), 'utf8'), '24.19.0\n');
  assert.equal(await readFile(join(installDirectory, '.git', 'voicecan-node-runtime-sha256'), 'utf8'), `${runtimeSha256}\n`);

  await commitRuntimeLock('0'.repeat(64));
  const rejected = spawnSync('bash', [
    nodeInstaller,
    '--repository', `file://${publicRepository}`,
    '--ref', 'installer-test',
    '--install-dir', join(workspace, 'rejected-installation'),
    '--port', '18789',
    '--no-service',
  ], {
    encoding: 'utf8',
    env: { ...process.env, VOICECAN_NODE_ARCHIVE: runtimeArchive },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /runtime SHA-256 mismatch/);
});
