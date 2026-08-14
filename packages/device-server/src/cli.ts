#!/usr/bin/env node
import { buildServer, readSetupToken } from './app.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { CLI_CAPABILITIES, CliError, flagValue, hasFlag, outputMode, writeFailure, writeSuccess, type OutputMode } from './cli-contract.js';
import { applyProfileEnvironment, defaultProfileConfig, ensureProfileConfig, getConfigValue, initialProfileConfig, profilePaths, readProfileConfig, sanitizedProfileConfig, selectedProfile, setConfigValue, unsetConfigValue, validateProfileConfig, writeProfileConfig, type ProfileConfig } from './profile.js';
import { installService, serviceLogCommand, serviceStatus, startService, stopService, uninstallService } from './service-manager.js';
import { localAdminRequest } from './local-admin-client.js';
import { runAdminMcp } from './admin-mcp.js';

const usage = `Voicecan Device Platform

Usage:
  voicecan-device onboard [--no-open]                    Configure, migrate, install and start
  voicecan-device init [--foreground] [--no-open]           Compatibility alias for onboard
  voicecan-device serve                                    Run in the foreground without migrations
  voicecan-device service install|start|stop|restart|status|logs|uninstall
  voicecan-device config path|list|get|set|unset|validate
  voicecan-device migrate                                   Run database migrations explicitly
  voicecan-device doctor                                    Check a running installation
  voicecan-device setup status|open
  voicecan-device device bind prepare|status|wait
  voicecan-device app list|create|credential create
  voicecan-device mcp connect|print-config|run
  voicecan-device admin-mcp stdio
  voicecan-device capabilities
  voicecan-device show-setup-token                          Print the temporary first-run token

Common options:
  --profile <name>          Select an isolated installation profile (default: default)
  --output text|json        Select human or machine-readable output
  --dry-run                 Preview a supported state change
  --non-interactive         Never wait for terminal input
`;

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => undefined);
    child.unref();
  } catch { /* Opening a browser is best effort; the URL is always returned. */ }
}

async function loadSelectedProfile(profile: string): Promise<ProfileConfig> {
  const profileConfig = (await readProfileConfig(profile)) ?? (await ensureProfileConfig(profile)).config;
  applyProfileEnvironment(profileConfig);
  return profileConfig;
}

async function databaseMigrate(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const config = await loadConfig();
  if (config.databaseDriver === 'postgres') await migratePostgres(config.databaseUrl!);
  else migrate(config);
  return config;
}

async function waitForReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new CliError('SERVICE_READINESS_TIMEOUT', `Service did not become ready at ${baseUrl}: ${lastError}`, 6);
}

async function serve(command: 'serve' | 'init', mode: OutputMode, profile: string): Promise<void> {
  const config = await loadConfig();
  const server = await buildServer(config);
  const setupResponse = await server.inject({ method: 'GET', url: '/api/v1/setup/status' });
  const setupPending = (setupResponse.json() as { data?: { status?: string } }).data?.status === 'setup_pending';
  const setupTokenAvailable = setupPending ? Boolean(config.databaseDriver === 'postgres' ? config.bootstrapSetupToken : await readSetupToken(config)) : false;
  if (setupPending && !setupTokenAvailable) throw new CliError('SETUP_TOKEN_UNAVAILABLE', 'Setup is pending but no setup token is available', 5);
  await server.listen({ host: config.host, port: config.port });
  const adminUrl = new URL('/admin', config.publicBaseUrl).href;
  const deviceWsUrl = resolveDeviceWsUrl({ ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), advertiseHost: config.deviceAdvertiseHost, port: config.port });
  if (mode === 'json') {
    process.stderr.write(`Voicecan Device Server is ready at ${config.publicBaseUrl}\n`);
  } else {
    process.stdout.write(formatStartupSummary({ adminUrl, deviceWsUrl, detailedLogPath: config.logFileEnabled ? resolve(config.logDirectory, 'device-server.log') : null, dataDirectory: config.dataDir, ...(setupPending ? { showSetupTokenCommand: `voicecan-device show-setup-token --profile ${profile}` } : {}), ...(setupPending && config.databaseDriver === 'sqlite' ? { setupTokenPath: resolve(config.dataDir, 'setup-token') } : {}), ...(setupPending && config.databaseDriver === 'postgres' ? { setupTokenSource: 'VOICECAN_SETUP_TOKEN (external secret)' } : {}) }));
  }
  if (command === 'init' && !process.argv.includes('--no-open')) openBrowser(adminUrl);
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.beginDrain();
    process.stderr.write(`Received ${signal}; readiness is draining for ${config.drainMs}ms before shutdown.\n`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, config.drainMs));
    await server.close();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM').catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }));
  process.once('SIGINT', () => void shutdown('SIGINT').catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }));
}

async function configCommand(args: string[], profile: string, mode: OutputMode): Promise<void> {
  const operation = args[1] ?? 'list';
  const paths = profilePaths(profile);
  if (operation === 'path') {
    writeSuccess({ command: 'config.path', profile, data: paths, warnings: [], next_actions: [] }, mode, paths.configFile);
    return;
  }
  const existing = await readProfileConfig(profile);
  if (!existing && operation !== 'set') throw new CliError('PROFILE_NOT_CONFIGURED', `Profile ${profile} has not been configured`, 5, undefined, [{ type: 'command', label: 'Run onboarding', command: `voicecan-device onboard --profile ${profile}`, requires_user: false }]);
  if (operation === 'list') {
    writeSuccess({ command: 'config.list', profile, data: sanitizedProfileConfig(existing!), warnings: [], next_actions: [] }, mode, `${JSON.stringify(sanitizedProfileConfig(existing!), null, 2)}\n`);
    return;
  }
  if (operation === 'validate') {
    const value = validateProfileConfig(existing!, profile);
    writeSuccess({ command: 'config.validate', profile, data: { valid: true, config: sanitizedProfileConfig(value) }, warnings: [], next_actions: [] }, mode, `Profile ${profile} is valid.`);
    return;
  }
  if (operation === 'get') {
    const key = args[2]; if (!key) throw new CliError('MISSING_CONFIG_KEY', 'config get requires a key', 3);
    const value = getConfigValue(existing!, key);
    writeSuccess({ command: 'config.get', profile, data: { key, value }, warnings: [], next_actions: [] }, mode, value === undefined ? '' : String(value));
    return;
  }
  if (operation === 'set') {
    const key = args[2]; const value = args[3];
    if (!key || value === undefined || value.startsWith('--')) throw new CliError('MISSING_CONFIG_VALUE', 'config set requires <key> <value>', 3);
    const base = existing ?? defaultProfileConfig(profile);
    const next = setConfigValue(base, key, value);
    const dryRun = hasFlag(args, '--dry-run');
    if (!dryRun) await writeProfileConfig(next);
    writeSuccess({ command: 'config.set', profile, data: { key, value: getConfigValue(next, key), applied: !dryRun, config_path: paths.configFile }, warnings: [], next_actions: dryRun ? [{ type: 'command', label: 'Apply this configuration change', command: `voicecan-device config set ${key} ${JSON.stringify(value)} --profile ${profile}`, requires_user: false }] : [] }, mode, dryRun ? `Would set ${key}=${String(getConfigValue(next, key))}` : `Set ${key}`);
    return;
  }
  if (operation === 'unset') {
    const key = args[2]; if (!key) throw new CliError('MISSING_CONFIG_KEY', 'config unset requires a key', 3);
    const next = unsetConfigValue(existing!, key); const dryRun = hasFlag(args, '--dry-run');
    if (!dryRun) await writeProfileConfig(next);
    writeSuccess({ command: 'config.unset', profile, data: { key, applied: !dryRun, config_path: paths.configFile }, warnings: [], next_actions: [] }, mode, dryRun ? `Would unset ${key}` : `Unset ${key}`);
    return;
  }
  throw new CliError('UNKNOWN_CONFIG_COMMAND', `Unknown config command: ${operation}`, 3);
}

async function serviceCommand(args: string[], profile: string, mode: OutputMode): Promise<void> {
  const operation = args[1] ?? 'status';
  const paths = profilePaths(profile);
  let status;
  if (operation === 'install') {
    const dryRun = hasFlag(args, '--dry-run');
    const existing = await readProfileConfig(profile);
    const profileConfig = existing ?? (dryRun ? initialProfileConfig(profile, flagValue(args, '--port') ? Number(flagValue(args, '--port')) : 8787) : (await ensureProfileConfig(profile, flagValue(args, '--port') ? Number(flagValue(args, '--port')) : undefined)).config);
    status = await installService(paths, profileConfig, dryRun);
  }
  else if (operation === 'start') status = await startService(paths);
  else if (operation === 'stop') status = await stopService(paths);
  else if (operation === 'restart') { await stopService(paths); status = await startService(paths); }
  else if (operation === 'status') status = await serviceStatus(paths);
  else if (operation === 'uninstall') status = await uninstallService(paths, hasFlag(args, '--dry-run'));
  else if (operation === 'logs') {
    const value = serviceLogCommand(paths);
    writeSuccess({ command: 'service.logs', profile, data: value, warnings: [], next_actions: [] }, mode, value.command);
    return;
  } else throw new CliError('UNKNOWN_SERVICE_COMMAND', `Unknown service command: ${operation}`, 3);
  writeSuccess({ command: `service.${operation}`, profile, data: status, warnings: status.degraded && status.detail ? [status.detail] : [], next_actions: [] }, mode, `${status.manager}: ${status.running ? 'running' : status.installed ? 'installed' : 'not installed'}${status.degraded ? ' (degraded)' : ''}`);
}

async function onboard(args: string[], profile: string, mode: OutputMode, alias: 'onboard' | 'init'): Promise<void> {
  const dryRun = hasFlag(args, '--dry-run');
  const requestedPort = flagValue(args, '--port');
  const existing = await readProfileConfig(profile);
  let profileConfig = existing ?? initialProfileConfig(profile, requestedPort ? Number(requestedPort) : 8787);
  if (requestedPort) profileConfig = setConfigValue(profileConfig, 'server.port', requestedPort);
  const publicUrl = flagValue(args, '--public-url'); if (publicUrl) profileConfig = setConfigValue(profileConfig, 'server.public_base_url', publicUrl);
  validateProfileConfig(profileConfig, profile);
  const foreground = hasFlag(args, '--foreground');
  if (dryRun) {
    const paths = profilePaths(profile);
    const servicePlan = foreground ? null : await installService(paths, profileConfig, true);
    writeSuccess({ command: alias, profile, data: { config: sanitizedProfileConfig(profileConfig), migration: 'would_run', foreground, service: servicePlan }, warnings: [], next_actions: [] }, mode, `Would configure ${paths.configFile}, run migrations, and ${foreground ? 'start in the foreground' : 'install the background service'}.`);
    return;
  }
  await writeProfileConfig(profileConfig);
  applyProfileEnvironment(profileConfig);
  const config = await databaseMigrate();
  if (foreground) { await serve('init', mode, profile); return; }
  const paths = profilePaths(profile);
  const installed = await installService(paths, profileConfig);
  if (installed.degraded) throw new CliError('SERVICE_MANAGER_UNAVAILABLE', installed.detail ?? 'The service definition was written but the service manager is unavailable', 6, installed);
  await startService(paths);
  await waitForReady(config.publicBaseUrl);
  const adminUrl = new URL('/admin', config.publicBaseUrl).href;
  if (!hasFlag(args, '--no-open')) openBrowser(adminUrl);
  writeSuccess({ command: alias, profile, data: { config_path: paths.configFile, data_directory: config.dataDir, admin_url: adminUrl, service: await serviceStatus(paths), setup_status: 'open_admin_to_complete' }, warnings: [], next_actions: [{ type: 'open_url', label: 'Complete trusted local setup', url: adminUrl, requires_user: true }] }, mode, `Voicecan Device Platform is running in the background.\nAdmin: ${adminUrl}\nProfile: ${profile}\nConfig: ${paths.configFile}\n`);
}

function commaList(value: string | undefined, fallback: readonly string[] = []): string[] {
  return value === undefined ? [...fallback] : [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

async function selectedGroup(config: Awaited<ReturnType<typeof loadConfig>>, args: readonly string[]): Promise<string> {
  const requested = flagValue(args, '--group');
  if (requested) return requested;
  const groups = await localAdminRequest<Array<{ id: string; name: string; status?: string }>>(config, '/user-groups');
  const active = groups.filter((group) => group.status !== 'archived');
  if (active.length === 1) return active[0]!.id;
  throw new CliError('GROUP_REQUIRED', 'Use --group because the installation has zero or multiple active groups', 3, { groups: active.map(({ id, name }) => ({ id, name })) });
}

async function deviceCommand(args: string[], config: Awaited<ReturnType<typeof loadConfig>>, profile: string, mode: OutputMode): Promise<void> {
  if (args[1] === 'list') { const devices = await localAdminRequest<unknown[]>(config, '/devices'); writeSuccess({ command: 'device.list', profile, data: devices, warnings: [], next_actions: [] }, mode, `${JSON.stringify(devices, null, 2)}\n`); return; }
  if (args[1] === 'get' || args[1] === 'status') {
    const deviceId = args[2]; if (!deviceId || deviceId.startsWith('--')) throw new CliError('DEVICE_ID_REQUIRED', `device ${args[1]} requires <device-id>`, 3);
    const value = await localAdminRequest<Record<string, unknown>>(config, `/devices/${encodeURIComponent(deviceId)}${args[1] === 'status' ? '/status' : ''}`);
    writeSuccess({ command: `device.${args[1]}`, profile, data: value, warnings: [], next_actions: [] }, mode, `${JSON.stringify(value, null, 2)}\n`); return;
  }
  if (args[1] === 'sync') {
    const deviceId = args[2]; if (!deviceId || deviceId.startsWith('--')) throw new CliError('DEVICE_ID_REQUIRED', 'device sync requires <device-id>', 3);
    const idempotencyKey = flagValue(args, '--idempotency-key') ?? `cli-${randomUUID()}`;
    const value = await localAdminRequest<Record<string, unknown>>(config, `/devices/${encodeURIComponent(deviceId)}/sync`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: '{}' });
    writeSuccess({ command: 'device.sync', profile, data: value, warnings: [], next_actions: [] }, mode, `Synchronization requested for ${deviceId}.`); return;
  }
  if (args[1] !== 'bind') throw new CliError('UNKNOWN_DEVICE_COMMAND', 'Usage: device list|get|status|sync|bind', 3);
  const operation = args[2] ?? 'prepare';
  if (operation === 'prepare') {
    const groupId = flagValue(args, '--group') ?? (hasFlag(args, '--dry-run') ? '<group-id>' : await selectedGroup(config, args));
    const requestedServerUrl = flagValue(args, '--server-url');
    const deviceWsUrl = requestedServerUrl && requestedServerUrl !== 'auto'
      ? requestedServerUrl
      : resolveDeviceWsUrl({ ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), requestHost: new URL(config.publicBaseUrl).host, advertiseHost: config.deviceAdvertiseHost, port: config.port });
    const body = {
      group_id: groupId,
      allowed_origin: new URL(config.publicBaseUrl).origin,
      idempotency_key: flagValue(args, '--idempotency-key') ?? `cli-${randomUUID()}`,
      network_mode: flagValue(args, '--network') ?? 'existing',
      locale: flagValue(args, '--locale') ?? 'en',
      device_ws_url: deviceWsUrl,
      ...(flagValue(args, '--expected-sn') ? { expected_sn: flagValue(args, '--expected-sn') } : {}),
      ...(flagValue(args, '--display-name') ? { display_name: flagValue(args, '--display-name') } : {}),
    };
    if (hasFlag(args, '--dry-run')) {
      writeSuccess({ command: 'device.bind.prepare', profile, data: { request: body, would_open_browser: !hasFlag(args, '--no-open') }, warnings: [], next_actions: [] }, mode, `Would prepare binding for ${groupId} and ${hasFlag(args, '--no-open') ? 'return the user-action step' : 'open the Bluetooth selection page'}.`);
      return;
    }
    const intent = await localAdminRequest<Record<string, unknown>>(config, '/binding-intents', { method: 'POST', body: JSON.stringify(body) });
    const launchUrl = typeof intent.launch_url === 'string' ? intent.launch_url : undefined;
    const shouldOpen = !hasFlag(args, '--no-open');
    if (launchUrl && shouldOpen) openBrowser(launchUrl);
    const safe = { ...intent, launch_url: undefined, user_action_opened: Boolean(launchUrl && shouldOpen) };
    writeSuccess({ command: 'device.bind.prepare', profile, data: safe, warnings: [], next_actions: [{ type: 'user_input', label: shouldOpen ? 'Select the Bluetooth device in the opened browser' : 'Run again without --no-open to select the Bluetooth device', requires_user: true }] }, mode, `Binding ${String(intent.id)} is ready.${shouldOpen ? ' Select the Bluetooth device in the opened browser.' : ' Browser opening was skipped.'}`);
    return;
  }
  const intentId = args[3];
  if (!intentId || intentId.startsWith('--')) throw new CliError('BINDING_INTENT_REQUIRED', `device bind ${operation} requires <intent-id>`, 3);
  if (operation === 'status') {
    const intent = await localAdminRequest<Record<string, unknown>>(config, `/binding-intents/${encodeURIComponent(intentId)}`);
    writeSuccess({ command: 'device.bind.status', profile, data: intent, warnings: [], next_actions: [] }, mode, `${intentId}: ${String(intent.status)}`);
    return;
  }
  if (operation === 'wait') {
    const timeoutSeconds = Number(flagValue(args, '--timeout') ?? 600);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new CliError('INVALID_TIMEOUT', '--timeout must be between 1 and 3600 seconds', 3);
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let intent: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      intent = await localAdminRequest<Record<string, unknown>>(config, `/binding-intents/${encodeURIComponent(intentId)}`);
      if (['completed', 'failed', 'expired', 'canceled'].includes(String(intent.status))) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    if (intent.status !== 'completed') throw new CliError(intent.status === 'failed' ? String(intent.failure_code ?? 'BINDING_FAILED') : intent.status === 'expired' ? 'BINDING_EXPIRED' : 'BINDING_WAIT_TIMEOUT', `Binding ${intentId} ended in state ${String(intent.status ?? 'unknown')}`, 5, intent);
    writeSuccess({ command: 'device.bind.wait', profile, data: intent, warnings: [], next_actions: [] }, mode, `Device ${String(intent.device_id)} is online and binding is complete.`);
    return;
  }
  throw new CliError('UNKNOWN_DEVICE_BIND_COMMAND', `Unknown device bind command: ${operation}`, 3);
}

async function appCommand(args: string[], config: Awaited<ReturnType<typeof loadConfig>>, profile: string, mode: OutputMode): Promise<void> {
  const operation = args[1] ?? 'list';
  if (operation === 'list') {
    const applications = await localAdminRequest<unknown[]>(config, '/open-platform/applications');
    writeSuccess({ command: 'app.list', profile, data: applications, warnings: [], next_actions: [] }, mode, `${JSON.stringify(applications, null, 2)}\n`);
    return;
  }
  if (operation === 'create') {
    const name = flagValue(args, '--name'); if (!name) throw new CliError('APPLICATION_NAME_REQUIRED', 'app create requires --name', 3);
    const groupId = flagValue(args, '--group') ?? (hasFlag(args, '--dry-run') ? '<group-id>' : await selectedGroup(config, args));
    const body = { group_id: groupId, name, description: flagValue(args, '--description') ?? null, environment: flagValue(args, '--environment') ?? 'development', channels: commaList(flagValue(args, '--channels'), ['rest']), permissions: commaList(flagValue(args, '--permissions'), ['devices:read']), reason: flagValue(args, '--reason') ?? 'Created by local Voicecan CLI' };
    if (hasFlag(args, '--dry-run')) { writeSuccess({ command: 'app.create', profile, data: { request: body }, warnings: [], next_actions: [] }, mode, `Would create Application ${name}.`); return; }
    const application = await localAdminRequest<Record<string, unknown>>(config, '/open-platform/applications', { method: 'POST', body: JSON.stringify(body) });
    writeSuccess({ command: 'app.create', profile, data: application, warnings: [], next_actions: [] }, mode, `Created Application ${String(application.id)} (${name}).`);
    return;
  }
  if (operation === 'credential' && args[2] === 'create') {
    const applicationId = args[3]; if (!applicationId || applicationId.startsWith('--')) throw new CliError('APPLICATION_ID_REQUIRED', 'app credential create requires <application-id>', 3);
    const kind = flagValue(args, '--kind') ?? 'api_token';
    const requestedScopes = flagValue(args, '--scopes'); const requestedCidrs = flagValue(args, '--allowed-ip-cidrs');
    const body = { kind, name: flagValue(args, '--name') ?? `CLI ${new Date().toISOString()}`, ...(requestedScopes ? { scopes: commaList(requestedScopes) } : {}), ...(requestedCidrs ? { allowed_ip_cidrs: commaList(requestedCidrs) } : {}), reason: flagValue(args, '--reason') ?? 'Created by local Voicecan CLI' };
    if (hasFlag(args, '--dry-run')) { writeSuccess({ command: 'app.credential.create', profile, data: { application_id: applicationId, request: body, secret_output: 'owner-only file' }, warnings: [], next_actions: [] }, mode, `Would create a ${kind} credential and save it to an owner-only file.`); return; }
    const credential = await localAdminRequest<Record<string, unknown>>(config, `/open-platform/applications/${encodeURIComponent(applicationId)}/credentials`, { method: 'POST', body: JSON.stringify(body) });
    const token = String(credential.token ?? ''); if (!token.startsWith('vcd_app_')) throw new CliError('CREDENTIAL_RESPONSE_INVALID', 'Server did not return a valid one-time credential', 6);
    const secretDir = resolve(profilePaths(profile).root, 'secrets'); await mkdir(secretDir, { recursive: true, mode: 0o700 });
    const secretRef = resolve(secretDir, `${String(credential.id)}.token`); await writeFile(secretRef, `${token}\n`, { mode: 0o600, flag: 'wx' });
    const safe = { ...credential, token: undefined, secret_ref: secretRef };
    writeSuccess({ command: 'app.credential.create', profile, data: safe, warnings: [], next_actions: [] }, mode, `Created credential ${String(credential.id)}. Secret saved to ${secretRef}`);
    return;
  }
  throw new CliError('UNKNOWN_APP_COMMAND', 'Usage: app list|create|credential create', 3);
}

function mcpClientConfig(config: Awaited<ReturnType<typeof loadConfig>>, profile: string, secretRef: string): Record<string, unknown> {
  const command = resolve(profilePaths(profile).serviceDir, process.platform === 'win32' ? 'voicecan-device.cmd' : 'voicecan-device');
  return { mcpServers: { voicecan: { command, args: ['mcp', 'run', '--profile', profile, '--credential-ref', secretRef], env: { VOICECAN_DEVICE_SERVER_URL: config.publicBaseUrl } } } };
}

async function mcpCommand(args: string[], config: Awaited<ReturnType<typeof loadConfig>>, profile: string, mode: OutputMode): Promise<void> {
  const operation = args[1] ?? 'print-config';
  if (operation === 'run') {
    const secretRef = flagValue(args, '--credential-ref'); if (!secretRef) throw new CliError('CREDENTIAL_REF_REQUIRED', 'mcp run requires --credential-ref', 3);
    const token = (await readFile(resolve(secretRef), 'utf8')).trim(); if (!token.startsWith('vcd_app_')) throw new CliError('CREDENTIAL_REF_INVALID', 'Credential reference does not contain an Application token', 4);
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@voicecan/device-mcp@0.1.0-preview.0', 'stdio'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, VOICECAN_DEVICE_SERVER_URL: config.publicBaseUrl, VOICECAN_APPLICATION_TOKEN: token } });
    const exitCode = await new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code) => resolveExit(code ?? 1)); });
    if (exitCode !== 0) throw new CliError('MCP_SERVER_EXITED', `MCP server exited with code ${exitCode}`, exitCode);
    return;
  }
  if (operation === 'print-config') {
    const secretRef = flagValue(args, '--credential-ref') ?? '<owner-only-credential-file>';
    const value = mcpClientConfig(config, profile, secretRef);
    writeSuccess({ command: 'mcp.print-config', profile, data: value, warnings: secretRef.startsWith('<') ? ['Create an mcp_stdio_token credential first and pass --credential-ref.'] : [], next_actions: [] }, mode, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (operation === 'connect') {
    const applicationId = flagValue(args, '--application'); if (!applicationId) throw new CliError('APPLICATION_ID_REQUIRED', 'mcp connect requires --application', 3);
    if (hasFlag(args, '--dry-run')) { writeSuccess({ command: 'mcp.connect', profile, data: { application_id: applicationId, credential_kind: 'mcp_stdio_token', client: flagValue(args, '--client') ?? 'generic', would_store_secret: true }, warnings: [], next_actions: [] }, mode, `Would create an MCP credential for ${applicationId} and return a secret-free client config.`); return; }
    const requestedScopes = flagValue(args, '--scopes');
    const credential = await localAdminRequest<Record<string, unknown>>(config, `/open-platform/applications/${encodeURIComponent(applicationId)}/credentials`, { method: 'POST', body: JSON.stringify({ kind: 'mcp_stdio_token', name: flagValue(args, '--name') ?? 'Local AI MCP', ...(requestedScopes ? { scopes: commaList(requestedScopes) } : {}), allowed_ip_cidrs: ['127.0.0.1/32', '::1/128'], reason: flagValue(args, '--reason') ?? 'Connected by local Voicecan CLI' }) });
    const token = String(credential.token ?? ''); if (!token.startsWith('vcd_app_')) throw new CliError('CREDENTIAL_RESPONSE_INVALID', 'Server did not return a valid one-time credential', 6);
    const secretDir = resolve(profilePaths(profile).root, 'secrets'); await mkdir(secretDir, { recursive: true, mode: 0o700 }); const secretRef = resolve(secretDir, `${String(credential.id)}.token`); await writeFile(secretRef, `${token}\n`, { mode: 0o600, flag: 'wx' });
    const value = { application_id: applicationId, credential_id: credential.id, secret_ref: secretRef, client: flagValue(args, '--client') ?? 'generic', config: mcpClientConfig(config, profile, secretRef) };
    writeSuccess({ command: 'mcp.connect', profile, data: value, warnings: [], next_actions: [{ type: 'user_input', label: 'Approve adding this MCP server to your AI client', requires_user: true }] }, mode, `${JSON.stringify(value.config, null, 2)}\nCredential secret: ${secretRef}\n`);
    return;
  }
  throw new CliError('UNKNOWN_MCP_COMMAND', 'Usage: mcp connect|print-config|run', 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'serve';
  const profile = selectedProfile(args);
  const mode = outputMode(args);
  try {
    if (command === '--help' || command === '-h' || command === 'help') { process.stdout.write(usage); return; }
    if (command === 'capabilities') { writeSuccess({ command, profile, data: { cli_schema_version: 1, capabilities: CLI_CAPABILITIES }, warnings: [], next_actions: [] }, mode, `${JSON.stringify(CLI_CAPABILITIES, null, 2)}\n`); return; }
    if (command === 'config') { await configCommand(args, profile, mode); return; }
    if (command === 'service') { await serviceCommand(args, profile, mode); return; }
    if (command === 'status') { await serviceCommand(['service', 'status', ...args.slice(1)], profile, mode); return; }
    if (command === 'onboard' || command === 'init') { await onboard(args, profile, mode, command); return; }
    if (command === 'admin-mcp' && (args[1] ?? 'stdio') === 'stdio') { await runAdminMcp(profile); return; }
    await loadSelectedProfile(profile);
    if (command === 'backup' && args[1] === 'restore' && args[2] && args[3]) { await restoreBackup(args[2], args[3]); writeSuccess({ command: 'backup.restore', profile, data: { target: resolve(args[3]) }, warnings: [], next_actions: [] }, mode, `Backup restored into new data directory: ${resolve(args[3])}`); return; }
    if (command === 'migrate') { const config = await databaseMigrate(); writeSuccess({ command, profile, data: { database: config.databaseDriver === 'postgres' ? 'PostgreSQL' : config.databaseFile }, warnings: [], next_actions: [] }, mode, `Database migrated: ${config.databaseDriver === 'postgres' ? 'PostgreSQL' : config.databaseFile}`); return; }
    const config = await loadConfig();
    if (command === 'device') { await deviceCommand(args, config, profile, mode); return; }
    if (command === 'app') { await appCommand(args, config, profile, mode); return; }
    if (command === 'mcp') { await mcpCommand(args, config, profile, mode); return; }
    if (command === 'setup' && (args[1] ?? 'status') === 'status') {
      const response = await fetch(`${config.publicBaseUrl}/api/v1/setup/status`, { signal: AbortSignal.timeout(5_000) }); const payload = await response.json();
      writeSuccess({ command: 'setup.status', profile, data: payload, warnings: [], next_actions: [] }, mode, JSON.stringify(payload)); return;
    }
    if (command === 'setup' && args[1] === 'open') { const url = new URL('/admin', config.publicBaseUrl).href; openBrowser(url); writeSuccess({ command: 'setup.open', profile, data: { url, opened: true }, warnings: [], next_actions: [{ type: 'open_url', label: 'Complete trusted local setup', url, requires_user: true }] }, mode, url); return; }
    if (command === 'show-setup-token-path') { if (config.databaseDriver !== 'sqlite') throw new CliError('SETUP_TOKEN_EXTERNAL', 'PostgreSQL setup token is supplied by VOICECAN_SETUP_TOKEN and has no local file path', 5); writeSuccess({ command, profile, data: { path: `${config.dataDir}/setup-token` }, warnings: [], next_actions: [] }, mode, `${config.dataDir}/setup-token`); return; }
    if (command === 'show-setup-token') { const token = config.databaseDriver === 'postgres' ? config.bootstrapSetupToken : await readSetupToken(config); if (!token) throw new CliError('SETUP_TOKEN_UNAVAILABLE', 'Setup token is unavailable or setup is complete', 5); if (mode === 'json') throw new CliError('SECRET_OUTPUT_BLOCKED', 'Setup tokens are never returned in JSON output; use the trusted local setup page', 4); process.stdout.write(`${token}\n`); return; }
    if (command === 'doctor') {
      const [major, minor] = process.versions.node.split('.').map(Number); if (major !== 24 || (minor ?? 0) < 15) throw new CliError('NODE_VERSION_UNSUPPORTED', `Node.js >=24.15 <25 required; found ${process.version}`, 3);
      if (coreManifest.protocolAbi !== PROTOCOL_ABI || coreManifest.conformanceHash !== CONFORMANCE_HASH) throw new CliError('RUNTIME_CONTRACT_MISMATCH', 'Protocol runtime manifest does not match the server contract', 6);
      const core = await loadNodePrivateCore(); const session = await core.createSession({ exchange: async () => { throw new Error('doctor does not exchange device frames'); }, close: async () => undefined }); await session.close();
      const response = await fetch(`${config.publicBaseUrl}/health/ready`, { signal: AbortSignal.timeout(5_000) }); if (!response.ok) throw new CliError('READINESS_FAILED', `Readiness failed: HTTP ${response.status}`, 6);
      const gatewayUrl = new URL(resolveDeviceWsUrl({ ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), advertiseHost: config.deviceAdvertiseHost, port: config.port })); if (!['ws:', 'wss:'].includes(gatewayUrl.protocol)) throw new CliError('DEVICE_WS_INVALID', 'Device gateway URL must use WS or WSS', 3);
      const data = { node: process.version, protocol_abi: coreManifest.protocolAbi, conformance_hash: coreManifest.conformanceHash, readiness_url: `${config.publicBaseUrl}/health/ready`, device_ws_url: gatewayUrl.href };
      writeSuccess({ command, profile, data, warnings: [], next_actions: [] }, mode, `OK Node ${process.version}\nOK Core ${coreManifest.protocolAbi} ${coreManifest.conformanceHash}\nOK ${config.publicBaseUrl}/health/ready\nOK device WS ${gatewayUrl.href}\n`); return;
    }
    if (command === 'backup' && args[1] === 'create' && args[2]) { if (config.databaseDriver !== 'sqlite') throw new CliError('BACKUP_EXTERNAL_REQUIRED', 'Use PostgreSQL PITR plus an immutable S3 inventory for Production backups', 5); await createBackup(config, args[2]); writeSuccess({ command: 'backup.create', profile, data: { path: resolve(args[2]) }, warnings: [], next_actions: [] }, mode, `Backup created: ${resolve(args[2])}`); return; }
    if (command === 'backup' && args[1] === 'verify' && args[2]) { await verifyBackup(args[2]); writeSuccess({ command: 'backup.verify', profile, data: { path: resolve(args[2]) }, warnings: [], next_actions: [] }, mode, `Backup verified: ${resolve(args[2])}`); return; }
    if (command === 'users' && args[1] === 'set-password') { if (config.databaseDriver !== 'sqlite') throw new CliError('OFFLINE_PASSWORD_SQLITE_ONLY', 'Offline password recovery currently supports SQLite Edge only', 5); const username = flagValue(args, '--username'); if (!username || !hasFlag(args, '--password-stdin')) throw new CliError('INVALID_PASSWORD_COMMAND', 'Usage: users set-password --username <name> --password-stdin', 3); let password = ''; for await (const chunk of process.stdin) password += chunk; await setOfflinePassword(config, username, password.replace(/[\r\n]+$/, '')); writeSuccess({ command: 'users.set-password', profile, data: { username, sessions_revoked: true }, warnings: [], next_actions: [] }, mode, 'Password updated and sessions revoked.'); return; }
    if (command === 'keys' && args[1] === 'rotate') { if (config.databaseDriver !== 'sqlite' || config.externallyManagedKeys) throw new CliError('EXTERNAL_KEY_ROTATION_REQUIRED', 'Use the reviewed external-secret rewrap runbook for PostgreSQL or externally managed keys', 5); const version = await rotateMasterKey(config); writeSuccess({ command: 'keys.rotate', profile, data: { version }, warnings: [], next_actions: [] }, mode, `Master key rotated to version ${version}; retained old keys until a restore drill passes.`); return; }
    if (command === 'serve') { await serve('serve', mode, profile); return; }
    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}`, 3);
  } catch (error) {
    process.exitCode = writeFailure(error, command, profile, mode);
  }
}

await main();
