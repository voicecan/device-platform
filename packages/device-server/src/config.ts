import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { accessSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { validateDeviceWsUrl } from './device-url.js';

export type ServerConfig = {
  deploymentProfile: 'development' | 'edge' | 'intranet' | 'production';
  host: string;
  port: number;
  publicBaseUrl: string;
  deviceWssUrl?: string;
  deviceAdvertiseHost: string;
  deviceAdvertiseHosts: readonly string[];
  deviceConnectUrl: string;
  officialFirmwareSourceUrl: string;
  officialFirmwareBaseUrl: string;
  dataDir: string;
  firmwareDir: string;
  databaseFile: string;
  databaseDriver: 'sqlite' | 'postgres';
  databaseUrl?: string;
  databasePoolMax: number;
  bootstrapSetupToken?: string;
  storageDir: string;
  masterKey: Buffer;
  masterKeyVersion: number;
  masterKeys: ReadonlyMap<number, Buffer>;
  externallyManagedKeys: boolean;
  groupTokenPepper: Buffer;
  allowPrivateWebhooks: boolean;
  allowHttpWebhooks: boolean;
  simulatorEnabled: boolean;
  storageDriver: 'filesystem_http' | 's3_direct' | 'server_relay';
  maxFileBytes: number;
  maxStorageBytes: number;
  diskWarningRatio: number;
  diskStopRatio: number;
  reconcileIntervalMs: number;
  drainMs: number;
  logLevel: string;
  logFileEnabled: boolean;
  logDirectory: string;
  logMaxBytes: number;
  logMaxFiles: number;
  trustedProxies: string[];
  downloadGrantDefaultTtlSeconds: number;
  downloadGrantMinTtlSeconds: number;
  downloadGrantMaxTtlSeconds: number;
  s3DownloadRedirectTtlSeconds: number;
  downloadDeliveryMode: 'gateway' | 'external_object_only';
  oauthAccessTokenTtlSeconds: number;
  oauthRefreshTokenTtlSeconds: number;
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
};

async function loadOrCreateSecret(path: string, bytes: number): Promise<Buffer> {
  try {
    accessSync(path, constants.R_OK);
    return Buffer.from((await readFile(path, 'utf8')).trim(), 'base64url');
  } catch {
    const value = randomBytes(bytes);
    await writeFile(path, `${value.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    return value;
  }
}

function parseSecret(value: string, name: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32) throw new Error(`${name} must be a base64url-encoded 32-byte secret`);
  return decoded;
}

async function loadMasterKeyring(dataDir: string, serialized?: string): Promise<{ currentVersion: number; keys: Map<number, Buffer>; external: boolean }> {
  if (serialized) {
    let parsed: { current_version: number; keys: Record<string, string> };
    try { parsed = JSON.parse(serialized) as typeof parsed; } catch { throw new Error('VOICECAN_MASTER_KEYRING_JSON must be valid JSON'); }
    const keys = new Map(Object.entries(parsed.keys ?? {}).map(([version, value]) => [Number(version), parseSecret(value, `VOICECAN_MASTER_KEYRING_JSON key ${version}`)]));
    if (!Number.isSafeInteger(parsed.current_version) || parsed.current_version < 1 || !keys.has(parsed.current_version)) throw new Error('VOICECAN_MASTER_KEYRING_JSON has an invalid current_version');
    return { currentVersion: parsed.current_version, keys, external: true };
  }
  const keyringPath = resolve(dataDir, 'master-keyring.json');
  try {
    const parsed = JSON.parse(await readFile(keyringPath, 'utf8')) as { current_version: number; keys: Record<string, string> };
    const keys = new Map(Object.entries(parsed.keys).map(([version, value]) => [Number(version), Buffer.from(value, 'base64url')]));
    if (!Number.isSafeInteger(parsed.current_version) || !keys.has(parsed.current_version) || [...keys.values()].some((key) => key.length !== 32)) throw new Error('INVALID_MASTER_KEYRING');
    return { currentVersion: parsed.current_version, keys, external: false };
  } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
    const legacy = await loadOrCreateSecret(resolve(dataDir, 'master.key'), 32);
    const temporary = `${keyringPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({ current_version: 1, keys: { '1': legacy.toString('base64url') } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, keyringPath);
    return { currentVersion: 1, keys: new Map([[1, legacy]]), external: false };
  }
}

export function detectedAdvertiseHosts(): string[] {
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
    .map((entry) => entry.address);
  const priority = (address: string): number => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : /^172\.(?:1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3;
  return [...new Set(addresses)].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}

export async function loadConfig(environment: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const dataDir = resolve(environment.VOICECAN_DATA_DIR ?? './data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const storageDir = resolve(environment.VOICECAN_STORAGE_DIR ?? `${dataDir}/objects`);
  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  const firmwareDir = resolve(environment.VOICECAN_FIRMWARE_DIR ?? `${dataDir}/firmware`);
  await mkdir(firmwareDir, { recursive: true, mode: 0o700 });
  const port = Number(environment.VOICECAN_PORT ?? 8787);
  const deploymentProfile = environment.VOICECAN_DEPLOYMENT_PROFILE ?? 'development';
  if (!['development', 'edge', 'intranet', 'production'].includes(deploymentProfile)) throw new Error('VOICECAN_DEPLOYMENT_PROFILE must be development, edge, intranet, or production');
  const intranetHttpAllowed = deploymentProfile === 'intranet';
  const configuredDeviceWsUrl = environment.VOICECAN_DEVICE_WSS_URL?.trim();
  const deviceWssUrl = configuredDeviceWsUrl ? validateDeviceWsUrl(configuredDeviceWsUrl) : undefined;
  const configuredAdvertiseHost = environment.VOICECAN_DEVICE_ADVERTISE_HOST?.trim();
  const detectedHosts = detectedAdvertiseHosts();
  const deviceAdvertiseHost = configuredAdvertiseHost || detectedHosts[0] || '127.0.0.1';
  const deviceAdvertiseHosts = [...new Set([deviceAdvertiseHost, ...detectedHosts])];
  const deviceConnectUrl = environment.VOICECAN_CONNECT_WEB_URL?.trim() || 'https://connect.voice-can.com/';
  const officialFirmwareSourceUrl = environment.VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL?.trim() || environment.VOICECAN_OFFICIAL_FIRMWARE_BASE_URL?.trim() || 'https://api.voice-can.com/';
  let parsedConnectUrl: URL;
  try { parsedConnectUrl = new URL(deviceConnectUrl); } catch { throw new Error('VOICECAN_CONNECT_WEB_URL must be an absolute URL'); }
  const connectLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsedConnectUrl.hostname);
  if (parsedConnectUrl.protocol !== 'https:' && !(parsedConnectUrl.protocol === 'http:' && (connectLoopback || intranetHttpAllowed))) throw new Error('VOICECAN_CONNECT_WEB_URL must use HTTPS, loopback HTTP, or the intranet deployment profile');
  if (parsedConnectUrl.username || parsedConnectUrl.password || parsedConnectUrl.search || parsedConnectUrl.hash) throw new Error('VOICECAN_CONNECT_WEB_URL must not contain credentials, query, or fragment');
  let parsedOfficialFirmwareUrl: URL;
  try { parsedOfficialFirmwareUrl = new URL(officialFirmwareSourceUrl); } catch { throw new Error('VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL must be an absolute URL'); }
  const officialLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsedOfficialFirmwareUrl.hostname);
  if (parsedOfficialFirmwareUrl.protocol !== 'https:' && !(parsedOfficialFirmwareUrl.protocol === 'http:' && (officialLoopback || intranetHttpAllowed))) throw new Error('VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL must use HTTPS, loopback HTTP, or the intranet deployment profile');
  if (parsedOfficialFirmwareUrl.username || parsedOfficialFirmwareUrl.password || parsedOfficialFirmwareUrl.search || parsedOfficialFirmwareUrl.hash) throw new Error('VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL must not contain credentials, query, or fragment');
  const normalizedOfficialSource = new URL(parsedOfficialFirmwareUrl.pathname.endsWith('/') ? parsedOfficialFirmwareUrl.href : `${parsedOfficialFirmwareUrl.href}/`);
  const officialFirmwareBaseUrl = normalizedOfficialSource.pathname.endsWith('/api/v1/public/device-firmware/')
    ? normalizedOfficialSource.href
    : new URL('api/v1/public/device-firmware/', normalizedOfficialSource).href;
  const storageDriver = environment.VOICECAN_STORAGE_DRIVER === 's3_direct' ? 's3_direct' : environment.VOICECAN_STORAGE_DRIVER === 'server_relay' ? 'server_relay' : 'filesystem_http';
  const s3 = storageDriver === 's3_direct' ? {
    ...(environment.VOICECAN_S3_ENDPOINT ? { endpoint: environment.VOICECAN_S3_ENDPOINT } : {}),
    region: environment.VOICECAN_S3_REGION ?? 'us-east-1',
    bucket: environment.VOICECAN_S3_BUCKET ?? '',
    accessKeyId: environment.VOICECAN_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: environment.VOICECAN_S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: environment.VOICECAN_S3_FORCE_PATH_STYLE !== 'false',
  } : undefined;
  if (s3 && (!s3.bucket || !s3.accessKeyId || !s3.secretAccessKey)) throw new Error('S3 direct requires bucket and credentials');
  const integer = (name: string, fallback: number): number => {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const ratio = (name: string, fallback: number): number => {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error(`${name} must be between 0 and 1`);
    return value;
  };
  const diskWarningRatio = ratio('VOICECAN_DISK_WARNING_RATIO', 0.70);
  const diskStopRatio = ratio('VOICECAN_DISK_STOP_RATIO', 0.85);
  if (diskWarningRatio >= diskStopRatio) throw new Error('Disk warning ratio must be below stop ratio');
  const logMaxBytes = integer('VOICECAN_LOG_MAX_BYTES', 10 * 1024 * 1024);
  const logMaxFiles = integer('VOICECAN_LOG_MAX_FILES', 10);
  if (logMaxFiles > 100) throw new Error('VOICECAN_LOG_MAX_FILES cannot exceed 100');
  const keyring = await loadMasterKeyring(dataDir, environment.VOICECAN_MASTER_KEYRING_JSON?.trim());
  const databaseUrl = environment.VOICECAN_DATABASE_URL?.trim();
  if (databaseUrl) {
    let parsed: URL;
    try { parsed = new URL(databaseUrl); } catch { throw new Error('VOICECAN_DATABASE_URL must be an absolute PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('VOICECAN_DATABASE_URL must use postgres:// or postgresql://');
  }
  const bootstrapSetupToken = environment.VOICECAN_SETUP_TOKEN?.trim();
  if (bootstrapSetupToken !== undefined && bootstrapSetupToken.length < 32) throw new Error('VOICECAN_SETUP_TOKEN must contain at least 32 characters');
  const downloadGrantDefaultTtlSeconds = integer('VOICECAN_DOWNLOAD_GRANT_DEFAULT_TTL_SECONDS', 300);
  const downloadGrantMinTtlSeconds = integer('VOICECAN_DOWNLOAD_GRANT_MIN_TTL_SECONDS', 60);
  const downloadGrantMaxTtlSeconds = integer('VOICECAN_DOWNLOAD_GRANT_MAX_TTL_SECONDS', 900);
  if (downloadGrantMinTtlSeconds < 60 || downloadGrantMaxTtlSeconds > 900) throw new Error('Download Grant TTL must stay between 60 and 900 seconds');
  if (downloadGrantMinTtlSeconds > downloadGrantDefaultTtlSeconds || downloadGrantDefaultTtlSeconds > downloadGrantMaxTtlSeconds) throw new Error('Download Grant TTL must satisfy minimum <= default <= maximum');
  const s3DownloadRedirectTtlSeconds = integer('VOICECAN_S3_DOWNLOAD_REDIRECT_TTL_SECONDS', 45);
  if (s3DownloadRedirectTtlSeconds > 45 || s3DownloadRedirectTtlSeconds > downloadGrantMaxTtlSeconds) throw new Error('S3 redirect TTL cannot exceed 45 seconds or the Download Grant maximum TTL');
  const oauthAccessTokenTtlSeconds = integer('VOICECAN_OAUTH_ACCESS_TOKEN_TTL_SECONDS', 900); if (oauthAccessTokenTtlSeconds < 60 || oauthAccessTokenTtlSeconds > 3_600) throw new Error('OAuth access token TTL must be between 60 and 3600 seconds');
  const oauthRefreshTokenTtlSeconds = integer('VOICECAN_OAUTH_REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60); if (oauthRefreshTokenTtlSeconds < 3_600 || oauthRefreshTokenTtlSeconds > 365 * 24 * 60 * 60) throw new Error('OAuth refresh token TTL must be between one hour and one year');
  const downloadDeliveryMode = environment.VOICECAN_DOWNLOAD_DELIVERY_MODE === 'external_object_only' ? 'external_object_only' : 'gateway';
  if (downloadDeliveryMode === 'external_object_only' && storageDriver !== 's3_direct') throw new Error('external_object_only recording delivery requires VOICECAN_STORAGE_DRIVER=s3_direct');
  if (deploymentProfile === 'production' && (storageDriver !== 's3_direct' || downloadDeliveryMode !== 'external_object_only')) throw new Error('Production profile requires VOICECAN_STORAGE_DRIVER=s3_direct and VOICECAN_DOWNLOAD_DELIVERY_MODE=external_object_only');
  if (deploymentProfile === 'production' && (!deviceWssUrl || new URL(deviceWssUrl).protocol !== 'wss:')) throw new Error('Production profile requires an explicit wss:// VOICECAN_DEVICE_WSS_URL');
  const publicBaseUrl = environment.VOICECAN_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;
  let parsedPublicBaseUrl: URL;
  try { parsedPublicBaseUrl = new URL(publicBaseUrl); } catch { throw new Error('VOICECAN_PUBLIC_BASE_URL must be an absolute URL'); }
  const publicLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsedPublicBaseUrl.hostname);
  if (!['http:', 'https:'].includes(parsedPublicBaseUrl.protocol)) throw new Error('VOICECAN_PUBLIC_BASE_URL must use HTTP or HTTPS');
  if (parsedPublicBaseUrl.protocol !== 'https:' && !(publicLoopback || intranetHttpAllowed)) throw new Error('VOICECAN_PUBLIC_BASE_URL must use HTTPS, loopback HTTP, or the intranet deployment profile');
  if (parsedPublicBaseUrl.username || parsedPublicBaseUrl.password || parsedPublicBaseUrl.search || parsedPublicBaseUrl.hash) throw new Error('VOICECAN_PUBLIC_BASE_URL must not contain credentials, query, or fragment');
  const allowPrivateWebhooks = intranetHttpAllowed || environment.VOICECAN_ALLOW_PRIVATE_WEBHOOKS === 'true';
  const allowHttpWebhooks = intranetHttpAllowed || environment.VOICECAN_ALLOW_HTTP_WEBHOOKS === 'true';
  if (deploymentProfile === 'production' && (allowPrivateWebhooks || allowHttpWebhooks)) throw new Error('Production profile cannot allow private-address or HTTP webhooks');
  const trustedProxyAliases = new Set(['loopback', 'linklocal', 'uniquelocal']);
  const trustedProxies = (environment.VOICECAN_TRUST_PROXY ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  for (const rule of trustedProxies) {
    const [address, prefixValue, extra] = rule.split('/');
    const family = isIP(address ?? '');
    const prefix = prefixValue === undefined ? undefined : Number(prefixValue);
    if (!trustedProxyAliases.has(rule) && (extra !== undefined || !family || (prefix !== undefined && (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128))))) throw new Error(`VOICECAN_TRUST_PROXY contains an invalid trusted proxy rule: ${rule}`);
  }
  return {
    deploymentProfile: deploymentProfile as ServerConfig['deploymentProfile'],
    host: environment.VOICECAN_HOST ?? '0.0.0.0',
    port,
    publicBaseUrl: parsedPublicBaseUrl.href.replace(/\/$/, ''),
    ...(deviceWssUrl ? { deviceWssUrl } : {}),
    deviceAdvertiseHost,
    deviceAdvertiseHosts,
    deviceConnectUrl: parsedConnectUrl.href,
    officialFirmwareSourceUrl: normalizedOfficialSource.href,
    officialFirmwareBaseUrl,
    dataDir,
    firmwareDir,
    databaseFile: resolve(environment.VOICECAN_DATABASE_FILE ?? `${dataDir}/device-platform.sqlite`),
    databaseDriver: databaseUrl ? 'postgres' : 'sqlite',
    ...(databaseUrl ? { databaseUrl } : {}),
    databasePoolMax: integer('VOICECAN_DATABASE_POOL_MAX', 20),
    ...(bootstrapSetupToken ? { bootstrapSetupToken } : {}),
    storageDir,
    masterKey: keyring.keys.get(keyring.currentVersion)!,
    masterKeyVersion: keyring.currentVersion,
    masterKeys: keyring.keys,
    externallyManagedKeys: keyring.external,
    groupTokenPepper: environment.VOICECAN_GROUP_TOKEN_PEPPER
      ? parseSecret(environment.VOICECAN_GROUP_TOKEN_PEPPER.trim(), 'VOICECAN_GROUP_TOKEN_PEPPER')
      : await loadOrCreateSecret(resolve(dataDir, 'token-pepper.key'), 32),
    allowPrivateWebhooks,
    allowHttpWebhooks,
    simulatorEnabled: environment.VOICECAN_SIMULATOR === 'true',
    storageDriver,
    maxFileBytes: integer('VOICECAN_MAX_FILE_BYTES', 2 * 1024 * 1024 * 1024),
    maxStorageBytes: integer('VOICECAN_MAX_STORAGE_BYTES', 100 * 1024 * 1024 * 1024),
    diskWarningRatio,
    diskStopRatio,
    reconcileIntervalMs: integer('VOICECAN_RECONCILE_INTERVAL_MS', 60_000),
    drainMs: integer('VOICECAN_DRAIN_MS', 5_000),
    logLevel: environment.VOICECAN_LOG_LEVEL ?? 'info',
    logFileEnabled: environment.VOICECAN_LOG_FILE !== 'false',
    logDirectory: resolve(environment.VOICECAN_LOG_DIR ?? `${dataDir}/logs`),
    logMaxBytes,
    logMaxFiles,
    trustedProxies,
    downloadGrantDefaultTtlSeconds,
    downloadGrantMinTtlSeconds,
    downloadGrantMaxTtlSeconds,
    s3DownloadRedirectTtlSeconds,
    downloadDeliveryMode,
    oauthAccessTokenTtlSeconds,
    oauthRefreshTokenTtlSeconds,
    ...(s3 ? { s3 } : {}),
  };
}
