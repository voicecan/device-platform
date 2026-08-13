import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCli = process.env.npm_execpath;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'voicecan-platform-package-'));

function runNpm(args, cwd = root) {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(String(result.error ?? result.stderr ?? result.stdout ?? `npm ${args.join(' ')} failed`));
  return result.stdout;
}

async function freePort() {
  return await new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate a test port')); return; }
      server.close((error) => error ? reject(error) : accept(address.port));
    });
  });
}

try {
  const prepared = spawnSync(process.execPath, [resolve(root, 'scripts/prepare-device-platform-package.mjs')], { cwd: root, encoding: 'utf8' });
  if (prepared.status !== 0) throw new Error(String(prepared.error ?? prepared.stderr ?? prepared.stdout ?? 'Unable to prepare package'));
  const packed = JSON.parse(runNpm(['pack', './distribution/device-platform', '--pack-destination', temporaryRoot, '--json', '--ignore-scripts']));
  const tarball = join(temporaryRoot, packed[0].filename);
  const installation = join(temporaryRoot, 'installation');
  await mkdir(installation);
  await writeFile(join(installation, 'package.json'), '{"private":true}\n');
  await writeFile(join(installation, '.npmrc'), 'registry=https://registry.npmjs.org/\n@voicecan:registry=https://registry.npmjs.org/\n');
  runNpm(['install', tarball, '--ignore-scripts', '--registry', 'https://registry.npmjs.org/'], installation);

  const packageRoot = join(installation, 'node_modules/@voicecan/device-platform');
  const cli = join(packageRoot, 'runtime/device-server/dist/cli.js');
  const requiredFiles = [
    cli,
    join(packageRoot, 'runtime/admin-web/dist/index.html'),
    join(packageRoot, 'node_modules/@voicecan/device-core/private/browser/semantic_core.js'),
    join(packageRoot, 'node_modules/@voicecan/device-core/private/browser/protocol_core_bg.wasm'),
  ];
  for (const path of requiredFiles) await readFile(path);

  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: installation, encoding: 'utf8' });
  if (help.status !== 0 || !help.stdout.includes('voicecan-device init')) throw new Error('Installed CLI help failed');

  const port = await freePort();
  const dataDir = join(installation, 'data');
  const environment = {
    ...process.env,
    VOICECAN_DATA_DIR: dataDir,
    VOICECAN_PORT: String(port),
    VOICECAN_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    VOICECAN_LOG_FILE: 'false',
  };
  const server = spawn(process.execPath, [cli, 'init', '--no-open'], { cwd: installation, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });

  await new Promise((accept, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Timed out waiting for packaged server:\n${output}`)), 30_000);
    const poll = setInterval(() => {
      if (output.includes('Voicecan Device Server is ready')) { clearTimeout(deadline); clearInterval(poll); accept(); }
    }, 50);
    server.once('exit', (code) => { clearTimeout(deadline); clearInterval(poll); reject(new Error(`Packaged server exited ${code}:\n${output}`)); });
  });

  const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
  if (!ready.ok) throw new Error(`Packaged readiness returned HTTP ${ready.status}`);
  const admin = await fetch(`http://127.0.0.1:${port}/admin`);
  if (!admin.ok || !(await admin.text()).includes('Voicecan Device Server Admin')) throw new Error('Packaged Admin page failed');
  const doctor = spawnSync(process.execPath, [cli, 'doctor'], { cwd: installation, env: environment, encoding: 'utf8' });
  if (doctor.status !== 0 || !doctor.stdout.includes('OK Core')) throw new Error(`Packaged doctor failed: ${doctor.stderr}`);
  const token = spawnSync(process.execPath, [cli, 'show-setup-token'], { cwd: installation, env: environment, encoding: 'utf8' });
  if (token.status !== 0 || token.stdout.trim().length < 32) throw new Error('Packaged setup token command failed');

  server.kill('SIGTERM');
  await new Promise((accept) => server.once('exit', accept));
  process.stdout.write(`Verified clean npm install, explicit init, readiness, Core assets, and Admin UI on port ${port}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
