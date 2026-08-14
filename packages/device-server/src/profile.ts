import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { CliError } from './cli-contract.js';

export type ProfileConfig = {
  schema_version: 1;
  profile: string;
  server: {
    host: string;
    port: number;
    public_base_url: string;
    device_ws_url?: string;
  };
  data_dir: string;
  connect?: { public_connector_url?: string };
  deployment_profile?: 'development' | 'edge' | 'intranet' | 'production';
};

export type ProfilePaths = {
  profile: string;
  root: string;
  configFile: string;
  dataDir: string;
  runtimeDir: string;
  serviceDir: string;
  logDir: string;
};

function safeProfile(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new CliError('INVALID_PROFILE', 'Profile names may contain letters, numbers, underscore and hyphen', 3);
  return value;
}

export function selectedProfile(args: readonly string[]): string {
  const index = args.indexOf('--profile');
  const value = index >= 0 ? args[index + 1] : process.env.VOICECAN_PROFILE;
  if (index >= 0 && (!value || value.startsWith('--'))) throw new CliError('MISSING_FLAG_VALUE', '--profile requires a value', 3);
  return safeProfile(value ?? 'default');
}

function defaultRoot(): string {
  if (process.env.VOICECAN_HOME) return resolve(process.env.VOICECAN_HOME);
  if (process.platform === 'win32') return resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local'), 'Voicecan', 'DevicePlatform');
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'Application Support', 'Voicecan', 'DevicePlatform');
  return resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local', 'share'), 'voicecan-device-platform');
}

export function profilePaths(profile: string): ProfilePaths {
  const root = resolve(defaultRoot(), safeProfile(profile));
  return {
    profile,
    root,
    configFile: resolve(root, 'config.json'),
    dataDir: resolve(root, 'data'),
    runtimeDir: resolve(root, 'runtime'),
    serviceDir: resolve(root, 'service'),
    logDir: resolve(root, 'logs'),
  };
}

export function defaultProfileConfig(profile: string, port = 8787): ProfileConfig {
  const paths = profilePaths(profile);
  return {
    schema_version: 1,
    profile,
    server: { host: '127.0.0.1', port, public_base_url: `http://127.0.0.1:${port}` },
    data_dir: paths.dataDir,
    connect: { public_connector_url: 'https://connect.voice-can.com/' },
    deployment_profile: 'edge',
  };
}

export function initialProfileConfig(profile: string, port = 8787, environment: NodeJS.ProcessEnv = process.env): ProfileConfig {
  const config = defaultProfileConfig(profile, environment.VOICECAN_PORT ? Number(environment.VOICECAN_PORT) : port);
  if (environment.VOICECAN_HOST) config.server.host = environment.VOICECAN_HOST;
  if (environment.VOICECAN_PUBLIC_BASE_URL) config.server.public_base_url = environment.VOICECAN_PUBLIC_BASE_URL;
  if (environment.VOICECAN_DEVICE_WSS_URL) config.server.device_ws_url = environment.VOICECAN_DEVICE_WSS_URL;
  if (environment.VOICECAN_DATA_DIR) config.data_dir = resolve(environment.VOICECAN_DATA_DIR);
  if (environment.VOICECAN_CONNECT_WEB_URL) config.connect = { ...config.connect, public_connector_url: environment.VOICECAN_CONNECT_WEB_URL };
  if (environment.VOICECAN_DEPLOYMENT_PROFILE) config.deployment_profile = environment.VOICECAN_DEPLOYMENT_PROFILE as NonNullable<ProfileConfig['deployment_profile']>;
  return validateProfileConfig(config, profile);
}

export function validateProfileConfig(value: unknown, expectedProfile?: string): ProfileConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('INVALID_CONFIG', 'Profile configuration must be an object', 3);
  const input = value as Partial<ProfileConfig>;
  if (input.schema_version !== 1 || typeof input.profile !== 'string' || !input.server || typeof input.server !== 'object') throw new CliError('INVALID_CONFIG', 'Unsupported or incomplete profile configuration', 3);
  safeProfile(input.profile);
  if (expectedProfile && input.profile !== expectedProfile) throw new CliError('PROFILE_MISMATCH', `Configuration belongs to profile ${input.profile}, expected ${expectedProfile}`, 3);
  const server = input.server as ProfileConfig['server'];
  if (typeof server.host !== 'string' || !server.host || !Number.isSafeInteger(server.port) || server.port < 1 || server.port > 65535) throw new CliError('INVALID_CONFIG', 'server.host and server.port are invalid', 3);
  for (const [name, raw, protocols] of [
    ['server.public_base_url', server.public_base_url, ['http:', 'https:']],
    ['server.device_ws_url', server.device_ws_url, ['ws:', 'wss:']],
    ['connect.public_connector_url', input.connect?.public_connector_url, ['http:', 'https:']],
  ] as const) {
    if (raw === undefined) continue;
    let url: URL;
    try { url = new URL(raw); } catch { throw new CliError('INVALID_CONFIG', `${name} must be an absolute URL`, 3); }
    if (!(protocols as readonly string[]).includes(url.protocol)) throw new CliError('INVALID_CONFIG', `${name} uses an unsupported protocol`, 3);
    if (url.username || url.password) throw new CliError('INVALID_CONFIG', `${name} must not contain credentials`, 3);
  }
  if (typeof input.data_dir !== 'string' || !input.data_dir) throw new CliError('INVALID_CONFIG', 'data_dir is required', 3);
  if (input.deployment_profile && !['development', 'edge', 'intranet', 'production'].includes(input.deployment_profile)) throw new CliError('INVALID_CONFIG', 'deployment_profile is invalid', 3);
  return input as ProfileConfig;
}

export async function readProfileConfig(profile: string): Promise<ProfileConfig | undefined> {
  const path = profilePaths(profile).configFile;
  try { return validateProfileConfig(JSON.parse(await readFile(path, 'utf8')), profile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new CliError('INVALID_CONFIG_JSON', `Configuration is not valid JSON: ${path}`, 3);
    throw error;
  }
}

export async function writeProfileConfig(config: ProfileConfig): Promise<void> {
  validateProfileConfig(config, config.profile);
  const path = profilePaths(config.profile).configFile;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function ensureProfileConfig(profile: string, port?: number): Promise<{ config: ProfileConfig; created: boolean }> {
  const existing = await readProfileConfig(profile);
  if (existing) return { config: existing, created: false };
  const config = initialProfileConfig(profile, port);
  await writeProfileConfig(config);
  await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
  return { config, created: true };
}

export function applyProfileEnvironment(config: ProfileConfig): void {
  const values: Record<string, string | undefined> = {
    VOICECAN_HOST: config.server.host,
    VOICECAN_PORT: String(config.server.port),
    VOICECAN_PUBLIC_BASE_URL: config.server.public_base_url,
    VOICECAN_DEVICE_WSS_URL: config.server.device_ws_url,
    VOICECAN_DATA_DIR: config.data_dir,
    VOICECAN_CONNECT_WEB_URL: config.connect?.public_connector_url,
    VOICECAN_DEPLOYMENT_PROFILE: config.deployment_profile,
  };
  for (const [key, value] of Object.entries(values)) if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
}

export function sanitizedProfileConfig(config: ProfileConfig): ProfileConfig { return structuredClone(config); }

export function getConfigValue(config: ProfileConfig, key: string): unknown {
  const supported: Record<string, unknown> = {
    'server.host': config.server.host,
    'server.port': config.server.port,
    'server.public_base_url': config.server.public_base_url,
    'server.device_ws_url': config.server.device_ws_url,
    'data_dir': config.data_dir,
    'connect.public_connector_url': config.connect?.public_connector_url,
    'deployment_profile': config.deployment_profile,
  };
  if (!(key in supported)) throw new CliError('UNKNOWN_CONFIG_KEY', `Unknown configuration key: ${key}`, 3);
  return supported[key];
}

export function setConfigValue(config: ProfileConfig, key: string, rawValue: string): ProfileConfig {
  const next = structuredClone(config);
  if (key === 'server.host') next.server.host = rawValue;
  else if (key === 'server.port') next.server.port = Number(rawValue);
  else if (key === 'server.public_base_url') next.server.public_base_url = rawValue;
  else if (key === 'server.device_ws_url') next.server.device_ws_url = rawValue;
  else if (key === 'data_dir') next.data_dir = resolve(rawValue);
  else if (key === 'connect.public_connector_url') next.connect = { ...next.connect, public_connector_url: rawValue };
  else if (key === 'deployment_profile') next.deployment_profile = rawValue as NonNullable<ProfileConfig['deployment_profile']>;
  else throw new CliError('UNKNOWN_CONFIG_KEY', `Unknown configuration key: ${key}`, 3);
  return validateProfileConfig(next, config.profile);
}

export function unsetConfigValue(config: ProfileConfig, key: string): ProfileConfig {
  const next = structuredClone(config);
  if (key === 'server.device_ws_url') delete next.server.device_ws_url;
  else if (key === 'connect.public_connector_url') {
    if (next.connect) delete next.connect.public_connector_url;
  } else throw new CliError('CONFIG_KEY_REQUIRED', `Configuration key ${key} cannot be unset; assign an explicit value instead`, 3);
  return validateProfileConfig(next, config.profile);
}
