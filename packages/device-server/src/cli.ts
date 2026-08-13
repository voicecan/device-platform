#!/usr/bin/env node
import { buildServer, readSetupToken } from './app.js';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { migrate } from './migrate.js';
import { createBackup, restoreBackup, rotateMasterKey, setOfflinePassword, verifyBackup } from './maintenance.js';
import { CONFORMANCE_HASH, PROTOCOL_ABI } from '@voicecan/contracts';
import { coreManifest } from '@voicecan/device-core/manifest';
import { loadNodePrivateCore } from '@voicecan/device-core/node';
import { migratePostgres } from './postgres.js';
import { resolveDeviceWsUrl } from './device-url.js';
import { formatStartupSummary } from './startup-summary.js';

const usage = `Voicecan Device Platform

Usage:
  voicecan-device init [--no-open]   Initialize, migrate, start, and open Admin
  voicecan-device serve              Start without running migrations
  voicecan-device migrate            Run database migrations explicitly
  voicecan-device doctor             Check a running installation
  voicecan-device show-setup-token    Print the temporary first-run token
  voicecan-device --help              Show this help
`;

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => undefined);
    child.unref();
  } catch { /* Opening a browser is best effort; the URL is always printed. */ }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command === '--help' || command === '-h' || command === 'help') { process.stdout.write(usage); return; }
  if (command === 'backup' && process.argv[3] === 'restore' && process.argv[4] && process.argv[5]) { await restoreBackup(process.argv[4], process.argv[5]); process.stdout.write(`Backup restored into new data directory: ${resolve(process.argv[5])}\n`); return; }
  const config = await loadConfig();
  if (command === 'migrate' || command === 'init') {
    if (config.databaseDriver === 'postgres') await migratePostgres(config.databaseUrl!);
    else migrate(config);
    process.stdout.write(`Database migrated: ${config.databaseDriver === 'postgres' ? 'PostgreSQL' : config.databaseFile}\n`);
    if (command === 'migrate') return;
  }
  if (command === 'show-setup-token-path') {
    if (config.databaseDriver !== 'sqlite') throw new Error('PostgreSQL setup token is supplied by VOICECAN_SETUP_TOKEN and has no local file path');
    process.stdout.write(`${config.dataDir}/setup-token\n`);
    return;
  }
  if (command === 'show-setup-token') {
    const token = config.databaseDriver === 'postgres' ? config.bootstrapSetupToken : await readSetupToken(config);
    if (!token) throw new Error('Setup token is unavailable or setup is complete');
    process.stdout.write(`${token}\n`);
    return;
  }
  if (command === 'doctor') {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || (minor ?? 0) < 15) throw new Error(`Node.js >=24.15 <25 required; found ${process.version}`);
    if (coreManifest.protocolAbi !== PROTOCOL_ABI || coreManifest.conformanceHash !== CONFORMANCE_HASH) throw new Error('Core manifest does not match the server contract');
    const core = await loadNodePrivateCore();
    const session = await core.createSession({ exchange: async () => { throw new Error('doctor does not exchange device frames'); }, close: async () => undefined });
    await session.close();
    const response = await fetch(`${config.publicBaseUrl}/health/ready`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Readiness failed: HTTP ${response.status}`);
    const publicUrl = new URL(config.publicBaseUrl);
    if (publicUrl.protocol !== 'https:' && config.deploymentProfile !== 'intranet' && !['127.0.0.1', 'localhost', '::1'].includes(publicUrl.hostname)) throw new Error('Non-loopback public URL requires HTTPS or the intranet deployment profile');
    const gatewayUrl = new URL(resolveDeviceWsUrl({ ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), advertiseHost: config.deviceAdvertiseHost, port: config.port }));
    if (gatewayUrl.protocol !== 'ws:' && gatewayUrl.protocol !== 'wss:') throw new Error('Device gateway URL must use WS or WSS');
    process.stdout.write(`OK Node ${process.version}\nOK Core ${coreManifest.protocolAbi} ${coreManifest.conformanceHash}\nOK ${config.publicBaseUrl}/health/ready\nOK device WS ${gatewayUrl.href}\n`);
    return;
  }
  if (command === 'backup' && process.argv[3] === 'create' && process.argv[4]) { if (config.databaseDriver !== 'sqlite') throw new Error('Use PostgreSQL PITR plus an immutable S3 inventory for Production backups'); await createBackup(config, process.argv[4]); process.stdout.write(`Backup created: ${resolve(process.argv[4])}\n`); return; }
  if (command === 'backup' && process.argv[3] === 'verify' && process.argv[4]) { await verifyBackup(process.argv[4]); process.stdout.write(`Backup verified: ${resolve(process.argv[4])}\n`); return; }
  if (command === 'users' && process.argv[3] === 'set-password') { if (config.databaseDriver !== 'sqlite') throw new Error('Offline password recovery currently supports SQLite Edge only'); const usernameIndex = process.argv.indexOf('--username'); const passwordIndex = process.argv.indexOf('--password-stdin'); if (usernameIndex < 0 || !process.argv[usernameIndex + 1] || passwordIndex < 0) throw new Error('Usage: users set-password --username <name> --password-stdin'); let password = ''; for await (const chunk of process.stdin) password += chunk; await setOfflinePassword(config, process.argv[usernameIndex + 1]!, password.replace(/[\r\n]+$/, '')); process.stdout.write('Password updated and sessions revoked.\n'); return; }
  if (command === 'keys' && process.argv[3] === 'rotate') { if (config.databaseDriver !== 'sqlite' || config.externallyManagedKeys) throw new Error('Use the reviewed external-secret rewrap runbook for PostgreSQL or externally managed keys'); const version = await rotateMasterKey(config); process.stdout.write(`Master key rotated to version ${version}; retained old keys until a restore drill passes.\n`); return; }
  if (command !== 'serve' && command !== 'init') throw new Error(`Unknown command: ${command}`);
  const server = await buildServer(config);
  const setupResponse = await server.inject({ method: 'GET', url: '/api/v1/setup/status' });
  const setupPending = (setupResponse.json() as { data?: { status?: string } }).data?.status === 'setup_pending';
  const setupTokenAvailable = setupPending ? Boolean(config.databaseDriver === 'postgres' ? config.bootstrapSetupToken : await readSetupToken(config)) : false;
  if (setupPending && !setupTokenAvailable) throw new Error('Setup is pending but no setup token is available');
  await server.listen({ host: config.host, port: config.port });
  const adminUrl = new URL('/admin', config.publicBaseUrl).href;
  const deviceWsUrl = resolveDeviceWsUrl({ ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), advertiseHost: config.deviceAdvertiseHost, port: config.port });
  process.stdout.write(formatStartupSummary({ adminUrl, deviceWsUrl, detailedLogPath: config.logFileEnabled ? resolve(config.logDirectory, 'device-server.log') : null, dataDirectory: config.dataDir, ...(setupPending ? { showSetupTokenCommand: 'voicecan-device show-setup-token' } : {}), ...(setupPending && config.databaseDriver === 'sqlite' ? { setupTokenPath: resolve(config.dataDir, 'setup-token') } : {}), ...(setupPending && config.databaseDriver === 'postgres' ? { setupTokenSource: 'VOICECAN_SETUP_TOKEN (external secret)' } : {}) }));
  if (command === 'init' && !process.argv.includes('--no-open')) openBrowser(adminUrl);
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.beginDrain();
    process.stdout.write(`Received ${signal}; readiness is draining for ${config.drainMs}ms before shutdown.\n`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, config.drainMs));
    await server.close();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM').catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }));
  process.once('SIGINT', () => void shutdown('SIGINT').catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }));
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
