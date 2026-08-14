import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './cli-contract.js';
import type { ProfileConfig, ProfilePaths } from './profile.js';

export type ServiceStatus = {
  manager: 'systemd-user' | 'launchd' | 'windows-task';
  installed: boolean;
  running: boolean;
  degraded: boolean;
  definition_path: string;
  wrapper_path: string;
  detail?: string;
};

function serviceIdentity(profile: string): string { return profile === 'default' ? 'voicecan-device-platform' : `voicecan-device-platform-${profile}`; }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

function manager(): ServiceStatus['manager'] {
  if (process.platform === 'linux') return 'systemd-user';
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'win32') return 'windows-task';
  throw new CliError('SERVICE_MANAGER_UNSUPPORTED', `Background service installation is unsupported on ${process.platform}`, 3);
}

function run(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
}

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }

async function packageRoot(entry: string): Promise<{ root: string; version: string } | undefined> {
  let cursor = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(resolve(cursor, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (manifest.name === '@voicecan/device-platform' && manifest.version) return { root: cursor, version: manifest.version };
    } catch { /* Keep walking. */ }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

async function stableEntrypoint(paths: ProfilePaths): Promise<{ node: string; cli: string }> {
  const currentEntry = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  const published = await packageRoot(currentEntry);
  if (!published) return { node: process.execPath, cli: currentEntry };
  const versionRoot = resolve(paths.runtimeDir, published.version);
  const targetRoot = resolve(versionRoot, 'package');
  if (!await exists(targetRoot)) {
    await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const temporary = `${versionRoot}.${process.pid}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    await cp(published.root, resolve(temporary, 'package'), { recursive: true, force: true });
    await rename(temporary, versionRoot);
  }
  return { node: process.execPath, cli: resolve(targetRoot, 'runtime', 'device-server', 'dist', 'cli.js') };
}

async function writeWrapper(paths: ProfilePaths, config: ProfileConfig): Promise<string> {
  await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });
  const entry = await stableEntrypoint(paths);
  const wrapper = resolve(paths.serviceDir, process.platform === 'win32' ? 'run.cmd' : 'run.sh');
  const content = process.platform === 'win32'
    ? `@echo off\r\n"${entry.node}" "${entry.cli}" serve --profile "${config.profile}"\r\n`
    : `#!/bin/sh\nexec "${entry.node.replaceAll('"', '\\"')}" "${entry.cli.replaceAll('"', '\\"')}" serve --profile "${config.profile}"\n`;
  const temporary = `${wrapper}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o700 });
  await rename(temporary, wrapper);
  if (process.platform !== 'win32') await chmod(wrapper, 0o700);
  const cliWrapper = resolve(paths.serviceDir, process.platform === 'win32' ? 'voicecan-device.cmd' : 'voicecan-device');
  const cliContent = process.platform === 'win32'
    ? `@echo off\r\n"${entry.node}" "${entry.cli}" %*\r\n`
    : `#!/bin/sh\nexec "${entry.node.replaceAll('"', '\\"')}" "${entry.cli.replaceAll('"', '\\"')}" "$@"\n`;
  const cliTemporary = `${cliWrapper}.${process.pid}.tmp`;
  await writeFile(cliTemporary, cliContent, { mode: 0o700 });
  await rename(cliTemporary, cliWrapper);
  if (process.platform !== 'win32') await chmod(cliWrapper, 0o700);
  return wrapper;
}

function definitionPath(paths: ProfilePaths): string {
  const identity = serviceIdentity(paths.profile);
  if (process.platform === 'linux') return resolve(process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? '', '.config'), 'systemd', 'user', `${identity}.service`);
  if (process.platform === 'darwin') return resolve(process.env.HOME ?? '', 'Library', 'LaunchAgents', `com.voicecan.${identity}.plist`);
  return resolve(paths.serviceDir, `${identity}.task.json`);
}

export async function installService(paths: ProfilePaths, config: ProfileConfig, dryRun = false): Promise<ServiceStatus> {
  const kind = manager();
  const wrapper = dryRun ? resolve(paths.serviceDir, process.platform === 'win32' ? 'run.cmd' : 'run.sh') : await writeWrapper(paths, config);
  const definition = definitionPath(paths);
  if (dryRun) return { manager: kind, installed: false, running: false, degraded: false, definition_path: definition, wrapper_path: wrapper, detail: 'dry-run' };
  await mkdir(dirname(definition), { recursive: true, mode: 0o700 });
  const identity = serviceIdentity(paths.profile);
  if (kind === 'systemd-user') {
    const unit = `[Unit]\nDescription=Voicecan Device Platform (${paths.profile})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart="${wrapper.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(definition, unit, { mode: 0o600 });
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    if (reload.status !== 0) return { manager: kind, installed: true, running: false, degraded: true, definition_path: definition, wrapper_path: wrapper, detail: reload.stderr.trim() || 'systemd user bus unavailable' };
    const enabled = run('systemctl', ['--user', 'enable', identity]);
    if (enabled.status !== 0) throw new CliError('SERVICE_INSTALL_FAILED', enabled.stderr.trim() || 'Unable to enable systemd user service', 6);
  } else if (kind === 'launchd') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.voicecan.${identity}</string><key>ProgramArguments</key><array><string>${xml(wrapper)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>StandardOutPath</key><string>${xml(resolve(paths.logDir, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(resolve(paths.logDir, 'service.log'))}</string></dict></plist>\n`;
    await mkdir(paths.logDir, { recursive: true, mode: 0o700 });
    await writeFile(definition, plist, { mode: 0o600 });
  } else {
    const taskName = `Voicecan Device Platform (${paths.profile})`;
    const result = run('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName, '/TR', `"${wrapper}"`]);
    if (result.status !== 0) throw new CliError('SERVICE_INSTALL_FAILED', result.stderr.trim() || result.stdout.trim() || 'Unable to create Windows scheduled task', 6);
    await writeFile(definition, `${JSON.stringify({ task_name: taskName, wrapper }, null, 2)}\n`, { mode: 0o600 });
  }
  return await serviceStatus(paths);
}

export async function serviceStatus(paths: ProfilePaths): Promise<ServiceStatus> {
  const kind = manager(); const definition = definitionPath(paths); const wrapper = resolve(paths.serviceDir, process.platform === 'win32' ? 'run.cmd' : 'run.sh');
  const installed = await exists(definition);
  if (!installed) return { manager: kind, installed: false, running: false, degraded: false, definition_path: definition, wrapper_path: wrapper };
  if (kind === 'systemd-user') {
    const result = run('systemctl', ['--user', 'is-active', serviceIdentity(paths.profile)]);
    return { manager: kind, installed, running: result.status === 0 && result.stdout.trim() === 'active', degraded: result.status > 1, definition_path: definition, wrapper_path: wrapper, ...(result.status > 1 ? { detail: result.stderr.trim() } : {}) };
  }
  if (kind === 'launchd') {
    const result = run('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/com.voicecan.${serviceIdentity(paths.profile)}`]);
    return { manager: kind, installed, running: result.status === 0, degraded: false, definition_path: definition, wrapper_path: wrapper };
  }
  const task = JSON.parse(await readFile(definition, 'utf8')) as { task_name: string };
  const result = run('schtasks.exe', ['/Query', '/TN', task.task_name]);
  return { manager: kind, installed, running: result.status === 0 && /Running/i.test(result.stdout), degraded: false, definition_path: definition, wrapper_path: wrapper };
}

export async function startService(paths: ProfilePaths): Promise<ServiceStatus> {
  const status = await serviceStatus(paths);
  if (!status.installed) throw new CliError('SERVICE_NOT_INSTALLED', 'Install the background service first', 5);
  let result;
  if (status.manager === 'systemd-user') result = run('systemctl', ['--user', 'start', serviceIdentity(paths.profile)]);
  else if (status.manager === 'launchd') result = run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, status.definition_path]);
  else { const task = JSON.parse(await readFile(status.definition_path, 'utf8')) as { task_name: string }; result = run('schtasks.exe', ['/Run', '/TN', task.task_name]); }
  if (result.status !== 0 && !(status.manager === 'launchd' && /already bootstrapped|service already loaded/i.test(result.stderr))) throw new CliError('SERVICE_START_FAILED', result.stderr.trim() || result.stdout.trim() || 'Unable to start service', 6);
  return await serviceStatus(paths);
}

export async function stopService(paths: ProfilePaths): Promise<ServiceStatus> {
  const status = await serviceStatus(paths);
  if (!status.installed) return status;
  let result;
  if (status.manager === 'systemd-user') result = run('systemctl', ['--user', 'stop', serviceIdentity(paths.profile)]);
  else if (status.manager === 'launchd') result = run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, status.definition_path]);
  else { const task = JSON.parse(await readFile(status.definition_path, 'utf8')) as { task_name: string }; result = run('schtasks.exe', ['/End', '/TN', task.task_name]); }
  if (result.status !== 0 && !/not loaded|not running|no instance|cannot find/i.test(`${result.stdout}\n${result.stderr}`)) throw new CliError('SERVICE_STOP_FAILED', result.stderr.trim() || result.stdout.trim() || 'Unable to stop service', 6);
  return await serviceStatus(paths);
}

export async function uninstallService(paths: ProfilePaths, dryRun = false): Promise<ServiceStatus> {
  const status = await serviceStatus(paths);
  if (dryRun) return { ...status, detail: 'dry-run' };
  if (!status.installed) return status;
  await stopService(paths);
  if (status.manager === 'systemd-user') { run('systemctl', ['--user', 'disable', serviceIdentity(paths.profile)]); await rm(status.definition_path, { force: true }); run('systemctl', ['--user', 'daemon-reload']); }
  else if (status.manager === 'launchd') await rm(status.definition_path, { force: true });
  else { const task = JSON.parse(await readFile(status.definition_path, 'utf8')) as { task_name: string }; run('schtasks.exe', ['/Delete', '/F', '/TN', task.task_name]); await rm(status.definition_path, { force: true }); }
  return await serviceStatus(paths);
}

export function serviceLogCommand(paths: ProfilePaths): { command: string; path?: string } {
  const kind = manager();
  if (kind === 'systemd-user') return { command: `journalctl --user -u ${serviceIdentity(paths.profile)} --follow` };
  if (kind === 'launchd') return { command: `tail -f "${resolve(paths.logDir, 'service.log')}"`, path: resolve(paths.logDir, 'service.log') };
  return { command: `Get-ScheduledTaskInfo -TaskName "Voicecan Device Platform (${paths.profile})"`, path: resolve(paths.logDir, 'device-server.log') };
}
