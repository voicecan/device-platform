import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const url = value('--url');
if (!url) throw new Error('Usage: doctor.mjs --url <server-url> [--wss-url <device-wss-url>] [--core-lock <core-artifacts.lock.json>]');
const base = new URL(url);
let failed = false;
const report = (ok, label, detail) => {
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) failed = true;
};

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
report(nodeMajor === 24 && nodeMinor >= 15, 'Node.js >=24.15 <25', process.version);

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(base.hostname);
report(base.protocol === 'https:' || loopback, 'HTTP TLS policy', `${base.protocol}//${base.host}`);

for (const [path, label] of [
  ['/health/live', 'liveness'],
  ['/health/ready', 'readiness'],
  ['/api/v1/setup/status', 'setup state'],
]) {
  try {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5_000) });
    const body = await response.text();
    report(response.ok, label, `HTTP ${response.status} ${body.slice(0, 200)}`);
  } catch (error) {
    report(false, label, error instanceof Error ? error.message : String(error));
  }
}

const wssValue = value('--wss-url');
if (wssValue) {
  const wss = new URL(wssValue);
  report(wss.protocol === 'wss:', 'device WSS policy', `${wss.protocol}//${wss.host}${wss.pathname}`);
  if (wss.protocol === 'wss:') {
    await new Promise((done) => {
      const socket = tlsConnect({
        host: wss.hostname,
        port: Number(wss.port || 443),
        servername: isIP(wss.hostname) ? undefined : wss.hostname,
        rejectUnauthorized: true,
        timeout: 5_000,
      });
      let settled = false;
      const finish = (ok, detail) => {
        if (settled) return;
        settled = true;
        report(ok, 'device WSS certificate', detail);
        socket.destroy();
        done();
      };
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerCertificate();
        finish(socket.authorized, socket.authorized ? `authorized; expires ${certificate.valid_to}` : socket.authorizationError || 'unauthorized');
      });
      socket.once('timeout', () => finish(false, 'TLS connection timed out'));
      socket.once('error', (error) => finish(false, error.message));
    });
  }
}

const lockValue = value('--core-lock');
if (lockValue) {
  try {
    const lockPath = resolve(lockValue);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const artifactPath = resolve(lockPath, '..', lock.file);
    await access(artifactPath, constants.R_OK);
    const digest = createHash('sha256').update(await readFile(artifactPath)).digest('hex');
    report(digest === lock.sha256, 'Protocol-runtime artifact digest', `${lock.package}@${lock.version} ${lock.protocol_abi}`);
    report(lock.protocol_abi === 'voicecan-v1.2' && lock.supported_range === '1.2.x', 'Core ABI contract', `${lock.protocol_abi} / ${lock.supported_range}`);
  } catch (error) {
    report(false, 'Protocol-runtime artifact lock', error instanceof Error ? error.message : String(error));
  }
}

if (failed) process.exitCode = 1;
