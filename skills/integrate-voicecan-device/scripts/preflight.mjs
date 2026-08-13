import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const methodIndex = args.indexOf('--method');
const method = methodIndex >= 0 ? args[methodIndex + 1] : undefined;
if (!['docker', 'node'].includes(method)) throw new Error('Choose an installation method first, then run with --method docker or --method node');

const checks = [];
if (method === 'docker') {
  try {
    const version = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    checks.push({ name: 'Docker daemon', ok: true, detail: version });
    execFileSync('docker', ['compose', 'version'], { stdio: ['ignore', 'ignore', 'pipe'] });
    checks.push({ name: 'Docker Compose v2', ok: true, detail: 'available' });
  } catch {
    checks.push({ name: 'Docker + Compose v2', ok: false, detail: 'unavailable for the selected method' });
  }
} else {
  for (const command of ['git', 'curl', 'tar']) {
    try {
      const path = execFileSync('sh', ['-c', 'command -v "$1"', 'preflight', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      checks.push({ name: command, ok: true, detail: path });
    } catch {
      checks.push({ name: command, ok: false, detail: 'required for private Node.js installation' });
    }
  }
  const hasChecksum = ['sha256sum', 'shasum', 'openssl'].some((command) => {
    try { execFileSync('sh', ['-c', 'command -v "$1"', 'preflight', command], { stdio: 'ignore' }); return true; } catch { return false; }
  });
  checks.push({ name: 'SHA-256 utility', ok: hasChecksum, detail: hasChecksum ? 'available' : 'sha256sum, shasum, or openssl required' });
}
checks.push({ name: '.gitignore', ok: existsSync('.gitignore'), detail: existsSync('.gitignore') ? 'present' : 'create one before secrets' });
for (const check of checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
