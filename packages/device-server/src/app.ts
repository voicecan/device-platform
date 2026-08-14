import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { constants as cryptoConstants, createHash, createPublicKey, publicEncrypt, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { API_VERSION, normalizeOpenPlatformPermissions, type AuthUser, type Device, type DeviceControl, type DeviceStatusSnapshot, type RecordingFile } from '@voicecan/contracts';
import { AccessDeniedError, requireGroup, requireGroupAdmin, requireScope, requireSystemAdmin, sqlGroupGuard, type AccessContext } from '@voicecan/access-control';
import { loadNodeGatewayCore } from '@voicecan/device-core/node';
import type { ServerConfig } from './config.js';
import { DatabaseActor, type Database, type SqlStatement } from './database.js';
import { EventDispatcher, validateWebhookUrl } from './events.js';
import { decodeDeviceToken, decryptSecret, deviceTokenVerifier, encodeDeviceToken, encryptSecret, hashPassword, opaqueToken, tokenHash, verifyPassword } from './security.js';
import { FilesystemStorage } from './storage.js';
import { createS3Storage } from './s3-storage.js';
import { deviceHtml, deviceJs } from './ui.js';
import { Reconciler } from './reconcile.js';
import { Metrics } from './metrics.js';
import { DeviceGateway, parseDeviceControl } from './gateway.js';
import { PostgresDatabase } from './postgres.js';
import { deviceHttpBaseUrl, publicRequestDeviceWsUrl, resolveDeviceWsUrl } from './device-url.js';
import { OpenPlatformError, registerOpenPlatformRoutes, resolveOAuthPrincipalPermissions } from './open-platform.js';
import { registerOAuthMcpRoutes } from './oauth-mcp.js';
import { BlockList, isIP } from 'node:net';
import { mapPublicCommand, mapPublicRecording, recordingEventFacts, reviewedRecordingMedia } from './public-contract.js';
import { createServerLogger } from './logging.js';

type Row = Record<string, unknown>;
type StoragePolicyRow = {
  storage_max_bytes: number | null;
  storage_warning_ratio: number | null;
  storage_stop_ratio: number | null;
  storage_updated_at: string | null;
};
type StoragePolicy = {
  maxStorageBytes: number;
  warningRatio: number;
  stopRatio: number;
  updatedAt: string | null;
};
type FirmwareChannel = 'production' | 'developer';
type OfficialFirmware = {
  id: string | number; version: string; hw_version: string; release_channel: FirmwareChannel; release_notes: string;
  package_size: number; checksum: string; crc16: number; max_ble_chunk: number; is_required: boolean;
  published_at: string | null; up_to_date: boolean; file_url: string;
};
type LocalFirmware = OfficialFirmware & { source: 'uploaded' | 'official'; object_path: string; status: 'active' | 'archived'; created_at: string };

// DeviceGateway's transfer watchdog is capped at 45 minutes. Upload credentials
// remain valid for one additional minute so a legitimate transfer is never watched
// after the URL/ticket has already expired.
const deviceUploadCredentialTtlMs = 46 * 60_000;
const deviceUploadCredentialTtlSeconds = deviceUploadCredentialTtlMs / 1_000;
const deviceProvisioningCredentialTtlMs = 30 * 60_000;

export type DeviceServerInstance = FastifyInstance & {
  beginDrain: () => void;
};

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly data?: Readonly<Record<string, unknown>>) { super(message); }
}

function id(prefix: string): string { return `${prefix}_${randomUUID()}`; }
function now(): string { return new Date().toISOString(); }
function plus(milliseconds: number): string { return new Date(Date.now() + milliseconds).toISOString(); }
async function officialFirmware(config: ServerConfig, device: Row, channel: FirmwareChannel): Promise<OfficialFirmware> {
  const hardwareVersion = String(device.hardware_version ?? '').trim();
  if (!hardwareVersion) throw new HttpError(409, 'DEVICE_HARDWARE_VERSION_UNKNOWN', 'Refresh the online device status before checking firmware.');
  const url = new URL('latest', config.officialFirmwareBaseUrl);
  url.searchParams.set('hw_version', hardwareVersion); url.searchParams.set('channel', channel);
  if (device.firmware_version) url.searchParams.set('current_version', String(device.firmware_version));
  let response: Response;
  try { response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch (error) { throw new HttpError(502, 'OFFICIAL_FIRMWARE_UNAVAILABLE', error instanceof Error ? error.message : 'Official firmware service is unavailable'); }
  if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, response.status === 404 ? 'FIRMWARE_NOT_FOUND' : 'OFFICIAL_FIRMWARE_UNAVAILABLE', `Official firmware service returned HTTP ${response.status}`);
  let envelope: unknown; try { envelope = await response.json(); } catch { throw new HttpError(502, 'OFFICIAL_FIRMWARE_INVALID', 'Official firmware service returned invalid JSON'); }
  const value = envelope && typeof envelope === 'object' && !Array.isArray(envelope) && 'data' in envelope ? (envelope as Row).data : envelope;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, 'OFFICIAL_FIRMWARE_INVALID', 'Official firmware metadata is invalid');
  const firmware = value as Row;
  if (typeof firmware.version !== 'string' || !firmware.version || firmware.version.length > 16 || firmware.hw_version !== hardwareVersion || firmware.release_channel !== channel || !Number.isSafeInteger(firmware.package_size) || Number(firmware.package_size) <= 0 || Number(firmware.package_size) > 128 * 1024 * 1024 || !Number.isSafeInteger(firmware.crc16) || Number(firmware.crc16) < 0 || Number(firmware.crc16) > 65_535 || !Number.isSafeInteger(firmware.max_ble_chunk) || Number(firmware.max_ble_chunk) < 0 || Number(firmware.max_ble_chunk) > 1_480 || typeof firmware.checksum !== 'string' || typeof firmware.file_url !== 'string') throw new HttpError(502, 'OFFICIAL_FIRMWARE_INVALID', 'Official firmware metadata failed validation');
  return firmware as unknown as OfficialFirmware;
}

async function downloadOfficialFirmware(config: ServerConfig, firmware: OfficialFirmware): Promise<Uint8Array> {
  const base = new URL(config.officialFirmwareBaseUrl); const url = new URL(firmware.file_url, base);
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) throw new HttpError(502, 'OFFICIAL_FIRMWARE_FILE_REJECTED', 'Official firmware file URL is outside the configured official server');
  let response: Response;
  try { response = await fetch(url, { headers: { accept: 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(60_000) }); }
  catch (error) { throw new HttpError(502, 'OFFICIAL_FIRMWARE_DOWNLOAD_FAILED', error instanceof Error ? error.message : 'Firmware download failed'); }
  if (!response.ok) throw new HttpError(502, 'OFFICIAL_FIRMWARE_DOWNLOAD_FAILED', `Official firmware download returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') ?? firmware.package_size);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== firmware.package_size) throw new HttpError(502, 'OFFICIAL_FIRMWARE_SIZE_MISMATCH', 'Official firmware size does not match its metadata');
  const content = new Uint8Array(await response.arrayBuffer());
  if (content.byteLength !== firmware.package_size) throw new HttpError(502, 'OFFICIAL_FIRMWARE_SIZE_MISMATCH', 'Downloaded firmware size does not match its metadata');
  const expected = firmware.checksum.trim().toLowerCase().replace(/^sha256:/, ''); const actual = createHash('sha256').update(content).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) throw new HttpError(502, 'OFFICIAL_FIRMWARE_CHECKSUM_MISMATCH', 'Downloaded firmware checksum does not match official metadata');
  return content;
}

function mapLocalFirmware(row: Row, currentVersion?: unknown): LocalFirmware {
  return {
    id: String(row.id), version: String(row.version), hw_version: String(row.hardware_version), release_channel: String(row.release_channel) as FirmwareChannel,
    source: String(row.source) as LocalFirmware['source'], release_notes: String(row.release_notes ?? ''), package_size: Number(row.package_size), checksum: String(row.checksum), crc16: Number(row.crc16), max_ble_chunk: Number(row.max_ble_chunk),
    is_required: false, published_at: row.published_at === null || row.published_at === undefined ? null : String(row.published_at), up_to_date: String(currentVersion ?? '') === String(row.version), file_url: '', object_path: String(row.object_path), status: String(row.status) as LocalFirmware['status'], created_at: String(row.created_at),
  };
}

async function latestLocalFirmware(db: Database, hardwareVersion: string, channel: FirmwareChannel, currentVersion?: unknown): Promise<LocalFirmware> {
  const row = await db.get<Row>("SELECT * FROM firmware_packages WHERE hardware_version=? AND release_channel=? AND status='active' ORDER BY created_at DESC,id DESC LIMIT 1", [hardwareVersion, channel]);
  if (!row) throw new HttpError(404, 'FIRMWARE_NOT_FOUND', 'No local firmware is available for this hardware and channel. Upload one or import it from the configured official source.');
  return mapLocalFirmware(row, currentVersion);
}

async function readLocalFirmware(config: ServerConfig, firmware: LocalFirmware): Promise<Uint8Array> {
  if (basename(firmware.object_path) !== firmware.object_path) throw new HttpError(500, 'FIRMWARE_OBJECT_INVALID', 'Firmware object path is invalid');
  let content: Uint8Array;
  try { content = await readFile(resolve(config.firmwareDir, firmware.object_path)); }
  catch (error) { throw new HttpError(503, 'FIRMWARE_OBJECT_UNAVAILABLE', error instanceof Error ? error.message : 'Local firmware file is unavailable'); }
  if (content.byteLength !== firmware.package_size) throw new HttpError(503, 'FIRMWARE_OBJECT_SIZE_MISMATCH', 'Local firmware size no longer matches its catalog metadata');
  const checksum = createHash('sha256').update(content).digest('hex');
  if (checksum !== firmware.checksum.replace(/^sha256:/i, '').toLowerCase()) throw new HttpError(503, 'FIRMWARE_OBJECT_CHECKSUM_MISMATCH', 'Local firmware checksum no longer matches its catalog metadata');
  return content;
}

async function storeFirmwareStream(config: ServerConfig, objectId: string, stream: AsyncIterable<Uint8Array>): Promise<{ objectPath: string; packageSize: number; checksum: string }> {
  const objectPath = `${objectId}.bin`; const finalPath = resolve(config.firmwareDir, objectPath); const temporaryPath = `${finalPath}.tmp-${randomUUID()}`;
  const handle = await open(temporaryPath, 'wx', 0o600); const hash = createHash('sha256'); let packageSize = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.from(value); packageSize += chunk.byteLength;
      if (packageSize > 128 * 1024 * 1024) throw new HttpError(413, 'FIRMWARE_TOO_LARGE', 'Firmware packages cannot exceed 128 MiB');
      hash.update(chunk); await handle.write(chunk);
    }
    if (packageSize === 0) throw new HttpError(400, 'FIRMWARE_EMPTY', 'Firmware package is empty');
    await handle.sync(); await handle.close(); await rename(temporaryPath, finalPath);
    return { objectPath, packageSize, checksum: hash.digest('hex') };
  } catch (error) {
    await handle.close().catch(() => undefined); await rm(temporaryPath, { force: true }).catch(() => undefined); throw error;
  }
}
function bodyOf(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new HttpError(400, 'INVALID_REQUEST', 'JSON object required');
  return request.body as Record<string, unknown>;
}
function requiredString(body: Record<string, unknown>, key: string, maximum = 512): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, 'INVALID_REQUEST', `${key} is required`);
  return value.trim();
}
function optionalString(body: Record<string, unknown>, key: string, maximum = 512): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maximum) throw new HttpError(400, 'INVALID_REQUEST', `${key} is invalid`);
  return value.trim();
}
function requiredInteger(body: Record<string, unknown>, key: string, minimum = 0): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new HttpError(400, 'INVALID_REQUEST', `${key} must be an integer`);
  return value as number;
}
function requiredRatio(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) throw new HttpError(400, 'INVALID_STORAGE_POLICY', `${key} must be between 0 and 1`);
  return value;
}
function validatedOrigin(value: string, allowIntranetHttp = false): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new HttpError(400, 'INVALID_ORIGIN', 'Origin must be absolute'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== value || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (loopback || allowIntranetHttp)))) throw new HttpError(400, 'INVALID_ORIGIN', 'Origin must be HTTPS, loopback HTTP, or use the intranet deployment profile, without a path');
  return parsed.origin;
}

function validatedProvisioningOrigin(value: string, connectorOrigin: string | null, configuredConnectorUrl: string, allowIntranetHttp = false): string {
  try { return validatedOrigin(value, allowIntranetHttp); } catch (error) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw error; }
    const configuredOrigin = new URL(configuredConnectorUrl).origin;
    if (parsed.origin !== value || parsed.protocol !== 'http:' || !connectorOrigin || validatedOrigin(connectorOrigin, allowIntranetHttp) !== configuredOrigin) throw error;
    return parsed.origin;
  }
}
function validatedBleNamePrefix(value: string): string {
  const prefix = value.trim();
  if (!prefix || [...prefix].length > 24 || /[\u0000-\u001f\u007f]/.test(prefix)) throw new HttpError(400, 'INVALID_BLE_NAME_PREFIX', 'BLE name prefix must contain 1 to 24 visible characters');
  return prefix;
}
function constantTimeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function normalizeUsername(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('en-US'); }
function sourceAllowed(ipValue: string, rules: readonly string[]): boolean {
  if (rules.length === 0) return true;
  const ip = ipValue.startsWith('::ffff:') && isIP(ipValue.slice(7)) === 4 ? ipValue.slice(7) : ipValue; const family = isIP(ip); if (!family) return false;
  for (const rule of rules) {
    try {
      const [address, prefixValue] = rule.split('/'); const ruleFamily = isIP(address ?? ''); if (!ruleFamily) continue; const block = new BlockList();
      if (prefixValue === undefined) block.addAddress(address!, ruleFamily === 4 ? 'ipv4' : 'ipv6');
      else { const prefix = Number(prefixValue); if (!Number.isInteger(prefix) || prefix < 0 || prefix > (ruleFamily === 4 ? 32 : 128)) continue; block.addSubnet(address!, prefix, ruleFamily === 4 ? 'ipv4' : 'ipv6'); }
      if (block.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return true;
    } catch { /* an invalid stored rule never grants access */ }
  }
  return false;
}
function success<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  return reply.code(status).send({ success: true, code: '', message: 'success', data, request_id: reply.request.id });
}

type AuthRow = {
  session_id?: string; user_id?: string; username?: string; display_name?: string | null; role?: string;
  group_id?: string | null; membership_role?: string | null; csrf_hash?: string; token_id?: string;
  scopes_json?: string;
  application_id?: string; credential_id?: string; credential_kind?: string; credential_status?: string;
  app_status?: string; allowed_ip_cidrs_json?: string; not_before?: string | null; expires_at?: string;
  replaced_by_id?: string | null; grace_ends_at?: string | null; resource?: string; client_status?: string;
  application_channels_json?: string;
};

function mapDevice(row: Row): Device {
  return {
    id: String(row.id), display_name: row.display_name === null || row.display_name === undefined ? null : String(row.display_name), manufacturer: String(row.manufacturer), sn: String(row.sn),
    model: row.model === null ? null : String(row.model),
    hardware_version: row.hardware_version === null || row.hardware_version === undefined ? null : String(row.hardware_version),
    firmware_version: row.firmware_version === null ? null : String(row.firmware_version),
    group_id: String(row.group_id), ownership_epoch: Number(row.ownership_epoch),
    online: Boolean(row.online), last_seen_at: row.last_seen_at === null ? null : String(row.last_seen_at),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
function nullableBoolean(value: unknown): boolean | null { return value === null || value === undefined ? null : Boolean(value); }
function optionalInteger(value: unknown, minimum: number, maximum: number, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new HttpError(400, 'INVALID_DEVICE_STATUS', `${field} is outside its supported range`);
  return Number(value);
}
function mapDeviceStatus(row: Row | null | undefined, deviceId: string): DeviceStatusSnapshot | null {
  if (!row) return null;
  return {
    device_id: deviceId, source: String(row.source) as DeviceStatusSnapshot['source'],
    record_state: nullableNumber(row.record_state), record_mode: nullableNumber(row.record_mode), microphone_mode: nullableNumber(row.microphone_mode), microphone_gain_db: nullableNumber(row.microphone_gain_db),
    usb_state: nullableNumber(row.usb_state), wifi_state: nullableNumber(row.wifi_state), wifi_mode: nullableNumber(row.wifi_mode), relay_state: nullableNumber(row.relay_state), privacy_mode: nullableBoolean(row.privacy_mode), earphone_recording: nullableBoolean(row.earphone_recording),
    storage_total_kb: nullableNumber(row.storage_total_kb), storage_free_kb: nullableNumber(row.storage_free_kb), recording_hours: nullableNumber(row.recording_hours),
    battery_state: row.battery_state === null || row.battery_state === undefined ? null : String(row.battery_state), battery_percent: nullableNumber(row.battery_percent), battery_temperature_c: nullableNumber(row.battery_temperature_c), battery_voltage_mv: nullableNumber(row.battery_voltage_mv), work_time_seconds: nullableNumber(row.work_time_seconds), accumulated_work_time_seconds: nullableNumber(row.accumulated_work_time_seconds),
    status_updated_at: row.status_updated_at ? String(row.status_updated_at) : null, storage_updated_at: row.storage_updated_at ? String(row.storage_updated_at) : null, battery_updated_at: row.battery_updated_at ? String(row.battery_updated_at) : null, updated_at: String(row.updated_at),
  };
}

function mapFile(row: Row): RecordingFile {
  return mapPublicRecording(row);
}

function storedStringArray(value: unknown): string[] {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; }
  catch { return []; }
}

function storedNumberArray(value: unknown): number[] {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter((item): item is number => Number.isSafeInteger(item)) : []; }
  catch { return []; }
}

function cursorEncode(createdAt: string, itemId: string, scope: string): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt, itemId, scope })).toString('base64url');
}
function cursorDecode(raw: unknown, scope: string): { createdAt: string; itemId: string } | null {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(String(raw), 'base64url').toString()) as Record<string, unknown>;
    if (value.v !== 1 || value.scope !== scope || typeof value.createdAt !== 'string' || typeof value.itemId !== 'string') throw new Error();
    return { createdAt: value.createdAt, itemId: value.itemId };
  } catch { throw new HttpError(410, 'CURSOR_EXPIRED', 'Cursor is invalid or belongs to another scope'); }
}

async function ensureSetupToken(db: Database, config: ServerConfig): Promise<void> {
  const state = await db.get<{ setup_completed_at: string | null; setup_token_hash: string | null; setup_token_expires_at: string | null }>(
    'SELECT setup_completed_at, setup_token_hash, setup_token_expires_at FROM server_settings WHERE singleton=1');
  if (!state) throw new Error('Database is not migrated. Run the migrate command explicitly.');
  const tokenPath = resolve(config.dataDir, 'setup-token');
  if (state.setup_completed_at) { await rm(tokenPath, { force: true }); return; }
  if (db.multiInstance) {
    const configured = config.bootstrapSetupToken;
    if (!configured) throw new Error('VOICECAN_SETUP_TOKEN is required while PostgreSQL setup is pending');
    if (state.setup_token_hash && state.setup_token_expires_at && state.setup_token_expires_at > now()) {
      if (!constantTimeHexEqual(state.setup_token_hash, tokenHash(configured))) throw new Error('VOICECAN_SETUP_TOKEN does not match the active PostgreSQL setup grant');
      return;
    }
    await db.run('UPDATE server_settings SET setup_token_hash=?,setup_token_expires_at=? WHERE singleton=1 AND setup_completed_at IS NULL AND (setup_token_hash IS NULL OR setup_token_expires_at<=?)', [tokenHash(configured), plus(24 * 60 * 60_000), now()]);
    const active = await db.get<{ setup_token_hash: string | null }>('SELECT setup_token_hash FROM server_settings WHERE singleton=1 AND setup_completed_at IS NULL');
    if (!active?.setup_token_hash || !constantTimeHexEqual(active.setup_token_hash, tokenHash(configured))) throw new Error('VOICECAN_SETUP_TOKEN lost a concurrent initialization race');
    return;
  }
  if (state.setup_token_hash && state.setup_token_expires_at && state.setup_token_expires_at > now()) {
    try {
      const existing = (await readFile(tokenPath, 'utf8')).trim();
      if (constantTimeHexEqual(state.setup_token_hash, tokenHash(existing))) return;
    } catch { /* replace an inaccessible setup grant */ }
  }
  const token = opaqueToken();
  await db.run('UPDATE server_settings SET setup_token_hash=?, setup_token_expires_at=? WHERE singleton=1 AND setup_completed_at IS NULL', [tokenHash(token), plus(30 * 60_000)]);
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
}

export async function buildServer(config: ServerConfig, options: { database?: Database } = {}): Promise<DeviceServerInstance> {
  const db = options.database ?? (config.databaseDriver === 'postgres'
    ? new PostgresDatabase(config.databaseUrl!, { max: config.databasePoolMax })
    : new DatabaseActor(config.databaseFile));
  const storage = new FilesystemStorage(config.storageDir);
  const s3Storage = createS3Storage(config);
  const dispatcher = new EventDispatcher(db, config);
  let reconciler: Reconciler | undefined;
  await ensureSetupToken(db, config);
  const dummyPasswordHash = await hashPassword(opaqueToken());
  const ipRateLimitIdentityHash = tokenHash('voicecan-login-ip-rate-limit-v1', config.groupTokenPepper);

  const app = Fastify({ loggerInstance: createServerLogger(config), logController: new LogController({ disableRequestLogging: config.deploymentProfile !== 'development' }), trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false, requestIdHeader: 'x-request-id', bodyLimit: 1024 * 1024 }) as unknown as DeviceServerInstance;
  let draining = false;
  app.beginDrain = () => { draining = true; };
  const requestAccess = new WeakMap<FastifyRequest, AccessContext>();
  const requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  const metrics = new Metrics();
  const deviceAuthFailures = new Map<string, { failures: number; blockedUntil: number }>();
  const deviceAuthBlocked = (key: string): boolean => (deviceAuthFailures.get(key)?.blockedUntil ?? 0) > Date.now();
  const deviceAuthFailed = (key: string): void => {
    const current = deviceAuthFailures.get(key); const failures = Math.min((current?.failures ?? 0) + 1, 10);
    deviceAuthFailures.set(key, { failures, blockedUntil: Date.now() + Math.min(60_000, 250 * 2 ** failures) });
    if (deviceAuthFailures.size > 10_000) deviceAuthFailures.delete(deviceAuthFailures.keys().next().value ?? key);
  };
  await app.register(cookie);
  await app.register(websocket);
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.addHook('onRequest', async (request) => { requestStartedAt.set(request, process.hrtime.bigint()); });
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    const durationSeconds = startedAt === undefined ? 0 : Number(process.hrtime.bigint() - startedAt) / 1e9;
    metrics.request(request.method, request.routeOptions.url ?? 'unknown', reply.statusCode, durationSeconds);
    const context = requestAccess.get(request);
    if (context?.applicationId) {
      const route = request.routeOptions.url ?? 'unknown'; const channel = context.channel ?? 'rest'; const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
      await db.run('INSERT INTO application_usage_buckets(application_id,channel,bucket_start,request_count,error_count,rate_limited_count) VALUES(?,?,?,?,?,?) ON CONFLICT(application_id,channel,bucket_start) DO UPDATE SET error_count=application_usage_buckets.error_count+?,rate_limited_count=application_usage_buckets.rate_limited_count+?', [context.applicationId, channel, bucketStart, 0, reply.statusCode >= 400 ? 1 : 0, reply.statusCode === 429 ? 1 : 0, reply.statusCode >= 400 ? 1 : 0, reply.statusCode === 429 ? 1 : 0]).catch(() => undefined);
      await db.run('INSERT INTO open_platform_api_logs(id,application_id,credential_id,actor_id,channel,method,route,status_code,duration_ms,request_id,source_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id('call'), context.applicationId, context.credentialId ?? null, context.actorId, channel, request.method, route, reply.statusCode, Math.round(durationSeconds * 1_000), request.id, createHash('sha256').update(request.ip).digest('hex').slice(0, 24), now()]).catch(() => undefined);
    }
  });
  app.addHook('onClose', async () => { dispatcher.stop(); reconciler?.stop(); metrics.close(); await db.close(); });
  app.setErrorHandler(async (error, request, reply) => {
    const passwordPolicy = error instanceof Error && error.message === 'PASSWORD_POLICY_FAILED' ? new HttpError(400, 'PASSWORD_POLICY_FAILED', 'Password must contain between 12 and 256 characters') : null;
    const migrationRequired = error instanceof Error && /no such column|has no column named|column .* does not exist/i.test(error.message) ? new HttpError(503, 'SCHEMA_MIGRATION_REQUIRED', 'The database schema is out of date. Stop the server, run npm run migrate, then start it again.') : null;
    const known = error instanceof HttpError || error instanceof OpenPlatformError ? error : error instanceof AccessDeniedError ? new HttpError(404, 'NOT_FOUND', 'Resource not found') : passwordPolicy ?? migrationRequired;
    const status = known?.statusCode ?? (typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500);
    const code = known?.code ?? (status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR');
    const safeMessage = status >= 500 && !config.simulatorEnabled ? 'Internal server error' : (known?.message ?? (error instanceof Error ? error.message : 'Invalid request'));
    const context = requestAccess.get(request);
    if (status >= 500) request.log.error({ err: error, request_id: request.id, method: request.method, route: request.routeOptions.url ?? 'unknown', code }, 'request failed');
    await db.run('INSERT INTO audit_logs(id,actor_id,action,resource_type,group_id,application_id,credential_id,principal_id,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id('audit'), context?.actorId ?? 'anonymous', `${request.method} ${request.routeOptions.url ?? 'unknown'}`, 'http_request', context?.groupId ?? null, context?.applicationId ?? null, context?.credentialId ?? null, context?.principalId ?? null, request.id, 'failure', code, now()]).catch(() => undefined);
    if (status === 429) reply.header('retry-after', '60');
    void reply.code(status).send({ success: false, code, message: safeMessage, ...(known instanceof HttpError && known.data ? { data: known.data } : {}), request_id: request.id });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'bluetooth=(self)');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types voicecan lit-html sanitizer");
    const context = requestAccess.get(request);
    if (context?.applicationId) {
      const channel = context.channel ?? 'rest'; const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
      const rate = await db.get<{ request_count: number; requests_per_minute: number; mcp_calls_per_minute: number }>('SELECT b.request_count,p.requests_per_minute,p.mcp_calls_per_minute FROM application_usage_buckets b JOIN application_policies p ON p.application_id=b.application_id WHERE b.application_id=? AND b.channel=? AND b.bucket_start=?', [context.applicationId, channel, bucketStart]).catch(() => null);
      const limit = channel === 'mcp_remote' ? Number(rate?.mcp_calls_per_minute ?? 60) : Number(rate?.requests_per_minute ?? 300); const used = Number(rate?.request_count ?? 0);
      reply.header('ratelimit-limit', String(limit)).header('ratelimit-remaining', String(Math.max(0, limit - used))).header('ratelimit-reset', String(Math.max(1, 60 - new Date().getUTCSeconds())));
    }
    return payload;
  });

  const browserCookieOptions = { secure: config.publicBaseUrl.startsWith('https:'), sameSite: 'strict' as const, path: '/' };

  const audit = async (request: FastifyRequest, context: AccessContext, action: string, resourceType: string, resourceId?: string, groupId?: string, reason?: string): Promise<void> => {
    await db.run('INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,group_id,application_id,credential_id,principal_id,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id('audit'), context.actorId, action, resourceType, resourceId ?? null, groupId ?? context.groupId, context.applicationId ?? null, context.credentialId ?? null, context.principalId ?? null, request.id, 'success', reason ?? null, now()]);
  };

  const effectiveApplicationScopes = async (applicationId: string, serializedScopes: string, principalScopes?: ReadonlySet<string>): Promise<Set<string>> => {
    const maximum = new Set((await db.all<{ permission: string }>('SELECT permission FROM application_permission_grants WHERE application_id=?', [applicationId])).map((row) => row.permission));
    return new Set([...normalizeOpenPlatformPermissions(JSON.parse(serializedScopes) as string[])].filter((scope) => maximum.has(scope) && (!principalScopes || principalScopes.has(scope))));
  };

  const resolveAccess = async (request: FastifyRequest, mutation = false): Promise<AccessContext> => {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const raw = authorization.slice(7);
      if (raw.startsWith('vcd_local_')) {
        const supplied = Buffer.from(raw.slice('vcd_local_'.length), 'base64url');
        const loopback = request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';
        if (!config.localOperatorKey || !loopback || supplied.length !== config.localOperatorKey.length || !timingSafeEqual(supplied, config.localOperatorKey)) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
        const row = await db.get<AuthRow>(`SELECT u.id AS user_id,u.role
          FROM users u JOIN server_settings s ON s.singleton=1 AND s.setup_completed_at IS NOT NULL
          WHERE u.role='system_admin' AND u.disabled_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`);
        if (!row?.user_id) throw new HttpError(409, 'SETUP_REQUIRED', 'Complete trusted local setup before using local automation');
        const context: AccessContext = { actorId: row.user_id, actorType: 'user', isSystemAdmin: true, groupId: null, isGroupAdmin: false, scopes: new Set<string>(), channel: 'admin' };
        requestAccess.set(request, context);
        return context;
      }
      if (raw.startsWith('vcd_app_')) {
        const row = await db.get<AuthRow & { application_allowed_ip_cidrs_json?: string }>(`SELECT c.id AS credential_id,c.application_id,c.group_id,c.kind AS credential_kind,c.scopes_json,c.allowed_ip_cidrs_json,c.status AS credential_status,c.not_before,c.expires_at,c.replaced_by_id,c.grace_ends_at,a.status AS app_status,a.channels_json AS application_channels_json,p.allowed_ip_cidrs_json AS application_allowed_ip_cidrs_json
          FROM application_credentials c JOIN open_platform_applications a ON a.id=c.application_id JOIN application_policies p ON p.application_id=a.id
          WHERE c.token_hash=? AND c.revoked_at IS NULL AND c.status='active' AND c.expires_at>? AND (c.not_before IS NULL OR c.not_before<=?) AND (c.replaced_by_id IS NULL OR c.grace_ends_at IS NULL OR c.grace_ends_at>?)`, [tokenHash(raw, config.groupTokenPepper), now(), now(), now()]);
        if (!row || row.app_status !== 'active') throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
        const allowedSources = JSON.parse(row.allowed_ip_cidrs_json ?? '[]') as string[]; const applicationSources = JSON.parse(row.application_allowed_ip_cidrs_json ?? '[]') as string[];
        if (!sourceAllowed(request.ip, allowedSources) || !sourceAllowed(request.ip, applicationSources)) throw new HttpError(401, 'SOURCE_NOT_ALLOWED', 'Authentication source is not allowed');
        const channel = row.credential_kind === 'mcp_stdio_token' ? 'mcp_stdio' as const : 'rest' as const; const channels = JSON.parse(row.application_channels_json ?? '[]') as string[]; if (!channels.includes(channel)) throw new HttpError(401, 'CHANNEL_DISABLED', 'Application channel is disabled'); const context: AccessContext = { actorId: row.credential_id!, actorType: 'application_token', isSystemAdmin: false, groupId: row.group_id!, isGroupAdmin: false, scopes: await effectiveApplicationScopes(row.application_id!, row.scopes_json!), applicationId: row.application_id!, credentialId: row.credential_id!, channel }; requestAccess.set(request, context);
        await db.run('UPDATE application_credentials SET last_used_at=?,last_source_hash=? WHERE id=?', [now(), createHash('sha256').update(request.ip).digest('hex').slice(0, 24), row.credential_id]);
        const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(); await db.run('INSERT INTO application_usage_buckets(application_id,channel,bucket_start,request_count) VALUES(?,?,?,1) ON CONFLICT(application_id,channel,bucket_start) DO UPDATE SET request_count=application_usage_buckets.request_count+1', [row.application_id, channel, bucketStart]); const usage = await db.get<{ request_count: number; requests_per_minute: number }>('SELECT b.request_count,p.requests_per_minute FROM application_usage_buckets b JOIN application_policies p ON p.application_id=b.application_id WHERE b.application_id=? AND b.channel=? AND b.bucket_start=?', [row.application_id, channel, bucketStart]); if (Number(usage?.request_count ?? 0) > Number(usage?.requests_per_minute ?? 300)) throw new HttpError(429, 'RATE_LIMITED', 'Application rate limit exceeded'); return context;
      }
      if (raw.startsWith('vcd_oauth_')) {
        const row = await db.get<AuthRow>(`SELECT o.id AS token_id,o.application_id,o.group_id,o.user_id,o.scopes_json,o.expires_at,o.resource,a.status AS app_status,a.channels_json AS application_channels_json,c.status AS client_status FROM oauth_access_tokens o JOIN open_platform_applications a ON a.id=o.application_id JOIN oauth_clients c ON c.id=o.client_id WHERE o.access_token_hash=? AND o.revoked_at IS NULL AND o.expires_at>?`, [tokenHash(raw, config.groupTokenPepper), now()]);
        const mcpResource = new URL('/mcp', config.publicBaseUrl).href; const channels = JSON.parse(row?.application_channels_json ?? '[]') as string[]; if (!row || row.app_status !== 'active' || row.client_status !== 'active' || !channels.includes('mcp_remote') || row.resource !== mcpResource || !request.url.startsWith('/mcp')) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
        const principal = await resolveOAuthPrincipalPermissions(db, row.user_id!, row.application_id!); if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
        const context: AccessContext = { actorId: row.token_id!, actorType: 'oauth', isSystemAdmin: false, groupId: row.group_id!, isGroupAdmin: false, scopes: await effectiveApplicationScopes(row.application_id!, row.scopes_json!, principal.scopes), applicationId: row.application_id!, principalId: row.user_id!, channel: 'mcp_remote' }; requestAccess.set(request, context); await db.run('UPDATE oauth_access_tokens SET last_used_at=? WHERE id=?', [now(), row.token_id]); const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(); await db.run('INSERT INTO application_usage_buckets(application_id,channel,bucket_start,request_count) VALUES(?,?,?,1) ON CONFLICT(application_id,channel,bucket_start) DO UPDATE SET request_count=application_usage_buckets.request_count+1', [row.application_id, 'mcp_remote', bucketStart]); const usage = await db.get<{ request_count: number; mcp_calls_per_minute: number }>('SELECT b.request_count,p.mcp_calls_per_minute FROM application_usage_buckets b JOIN application_policies p ON p.application_id=b.application_id WHERE b.application_id=? AND b.channel=? AND b.bucket_start=?', [row.application_id, 'mcp_remote', bucketStart]); if (Number(usage?.request_count ?? 0) > Number(usage?.mcp_calls_per_minute ?? 60)) throw new HttpError(429, 'RATE_LIMITED', 'MCP rate limit exceeded'); return context;
      }
      const row = await db.get<AuthRow>(`
        SELECT id AS token_id, group_id, application_id, scopes_json FROM group_api_tokens
        WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`, [tokenHash(raw, config.groupTokenPepper), now()]);
      if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
      await db.run('UPDATE group_api_tokens SET last_used_at=? WHERE id=?', [now(), row.token_id]);
      const context: AccessContext = { actorId: row.token_id!, actorType: 'group_token', isSystemAdmin: false, groupId: row.group_id!, isGroupAdmin: false, scopes: normalizeOpenPlatformPermissions(JSON.parse(row.scopes_json!) as string[]), ...(row.application_id ? { applicationId: row.application_id } : {}), channel: 'rest' }; requestAccess.set(request, context); return context;
    }
    const raw = request.cookies.vc_session;
    if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
    const row = await db.get<AuthRow>(`
      SELECT s.id AS session_id, s.csrf_hash, u.id AS user_id, u.username, u.display_name, u.role,
             gm.group_id, gm.role AS membership_role
      FROM user_sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN group_memberships gm ON gm.user_id=u.id AND gm.active=1
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled_at IS NULL`, [tokenHash(raw), now()]);
    if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
    if (mutation && !constantTimeHexEqual(row.csrf_hash!, tokenHash(String(request.headers['x-csrf-token'] ?? '')))) throw new HttpError(403, 'CSRF_FAILED', 'CSRF token is invalid');
    const context: AccessContext = { actorId: row.user_id!, actorType: 'user', isSystemAdmin: row.role === 'system_admin', groupId: row.group_id ?? null, isGroupAdmin: row.membership_role === 'group_admin', scopes: new Set<string>(), channel: 'admin' }; requestAccess.set(request, context); return context;
  };

  const requireDevice = async (context: AccessContext, deviceId: string): Promise<Row> => {
    const guard = sqlGroupGuard(context);
    const row = await db.get<Row>(`SELECT d.* FROM devices d WHERE d.id=? AND d.deleted_at IS NULL AND d.claim_status='active' AND ${guard.clause}`, [deviceId, ...guard.params]);
    if (!row) throw new AccessDeniedError();
    return row;
  };

  const readStoragePolicy = async (): Promise<StoragePolicy> => {
    const stored = await db.get<StoragePolicyRow>('SELECT storage_max_bytes,storage_warning_ratio,storage_stop_ratio,storage_updated_at FROM server_settings WHERE singleton=1');
    const storedMaximum = Number(stored?.storage_max_bytes);
    const storedWarning = Number(stored?.storage_warning_ratio);
    const storedStop = Number(stored?.storage_stop_ratio);
    const validStoredWatermarks = Number.isFinite(storedWarning) && storedWarning > 0 && storedWarning < 1
      && Number.isFinite(storedStop) && storedStop > 0 && storedStop < 1 && storedWarning < storedStop;
    return {
      maxStorageBytes: Number.isSafeInteger(storedMaximum) && storedMaximum > 0 ? storedMaximum : config.maxStorageBytes,
      warningRatio: validStoredWatermarks ? storedWarning : config.diskWarningRatio,
      stopRatio: validStoredWatermarks ? storedStop : config.diskStopRatio,
      updatedAt: stored?.storage_updated_at ?? null,
    };
  };

  const readStorageState = async (): Promise<Record<string, unknown>> => {
    const [policy, active, capacity] = await Promise.all([
      readStoragePolicy(),
      db.get<Row>("SELECT COALESCE(SUM(CASE WHEN status='syncing' THEN 1 ELSE 0 END),0) AS active_transfers,COALESCE(SUM(CASE WHEN status='synced' AND deletion_status<>'object_deleted' THEN actual_size ELSE 0 END),0) AS stored_bytes FROM recording_files"),
      config.storageDriver === 's3_direct' ? Promise.resolve(null) : storage.capacity(),
    ]);
    return {
      driver: config.storageDriver,
      driver_source: 'deployment_environment',
      driver_change_requires_restart: true,
      supported_drivers: ['filesystem_http', 'server_relay', 's3_direct'],
      deployment_profile: config.deploymentProfile,
      max_file_bytes: config.maxFileBytes,
      max_storage_bytes: policy.maxStorageBytes,
      warning_ratio: policy.warningRatio,
      stop_ratio: policy.stopRatio,
      settings_updated_at: policy.updatedAt,
      active_transfers: Number(active?.active_transfers ?? 0),
      stored_bytes: Number(active?.stored_bytes ?? 0),
      capacity,
    };
  };

  const ensureUploadCapacity = async (expectedSize: number, replacingFileId?: string): Promise<void> => {
    if (expectedSize > config.maxFileBytes) throw new HttpError(413, 'FILE_TOO_LARGE', 'File exceeds the configured maximum');
    const policy = await readStoragePolicy();
    const usage = await db.get<{ used_bytes: number; reserved_bytes: number }>(`
      SELECT
        COALESCE((SELECT SUM(actual_size) FROM recording_files WHERE status='synced' AND deletion_status<>'object_deleted'),0) AS used_bytes,
        COALESCE((SELECT SUM(expected_size) FROM recording_files WHERE status IN ('pending','syncing') AND (? IS NULL OR id<>?)),0) AS reserved_bytes`, [replacingFileId ?? null, replacingFileId ?? null]);
    if (Number(usage?.used_bytes ?? 0) + Number(usage?.reserved_bytes ?? 0) + expectedSize > policy.maxStorageBytes) throw new HttpError(507, 'STORAGE_QUOTA_EXCEEDED', 'Storage quota exceeded');
    if (config.storageDriver !== 's3_direct') {
      const capacity = await storage.capacity();
      if (capacity.usedRatio >= policy.stopRatio || capacity.available < expectedSize) throw new HttpError(507, 'STORAGE_LOW_SPACE', 'Storage is above the stop watermark');
      if (capacity.usedRatio >= policy.warningRatio) app.log.warn({ used_ratio: capacity.usedRatio }, 'storage warning watermark reached');
    }
  };

  const prepareEvent = async (deviceRow: Row, type: string, payload: Record<string, unknown>): Promise<{ eventId: string; statements: SqlStatement[] }> => {
    const eventId = id('evt'); const timestamp = now();
    const eventDeviceId = deviceRow.device_id ?? deviceRow.id;
    const candidates = await db.all<{ id: string; event_types_json: string; device_ids_json: string; attributes_json: string }>(`SELECT ep.id,ep.event_types_json,ep.device_ids_json,ep.attributes_json FROM event_endpoints ep
      LEFT JOIN open_platform_applications a ON a.id=ep.application_id
      WHERE ep.group_id=? AND ep.enabled=1 AND (ep.application_id IS NULL OR (
        a.status='active' AND a.channels_json LIKE '%"webhook"%' AND EXISTS(
          SELECT 1 FROM application_permission_grants p WHERE p.application_id=a.id AND p.permission='events:read'
        )
      ))`, [deviceRow.group_id]);
    const endpoints = candidates.filter((endpoint) => {
      const eventTypes = storedStringArray(endpoint.event_types_json);
      const deviceIds = storedStringArray(endpoint.device_ids_json);
      const attributes = storedNumberArray(endpoint.attributes_json);
      return (eventTypes.length === 0 || eventTypes.includes(type))
        && (deviceIds.length === 0 || deviceIds.includes(String(eventDeviceId)))
        && (attributes.length === 0 || (typeof payload.attribute === 'number' && attributes.includes(payload.attribute)));
    });
    const statements: SqlStatement[] = [{ sql: 'INSERT INTO events(id,type,device_id,owner_group_id,ownership_epoch,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [eventId, type, eventDeviceId, deviceRow.group_id, deviceRow.ownership_epoch, JSON.stringify(payload), timestamp] }];
    for (const endpoint of endpoints) statements.push({ sql: 'INSERT INTO event_deliveries(id,event_id,endpoint_id,status,next_attempt_at,created_at) VALUES(?,?,?,?,?,?)', params: [id('delivery'), eventId, endpoint.id, 'pending', timestamp, timestamp] });
    return { eventId, statements };
  };
  const emitEvent = async (deviceRow: Row, type: string, payload: Record<string, unknown>): Promise<string> => {
    const prepared = await prepareEvent(deviceRow, type, payload); await db.batch(prepared.statements); return prepared.eventId;
  };
  const planGatewayUpload = async (device: Row, file: Row, uploadBaseUrl: string): Promise<{ fileId: string; uploadUrl: string; offset?: number } | null> => {
    const fileId = String(file.id); const expectedSize = Number(file.expected_size);
    const emitSyncStarted = async (transport: string, attemptId?: string): Promise<void> => {
      const current = await db.get<Row>('SELECT * FROM recording_files WHERE id=?', [fileId]);
      if (current) await emitEvent(device, 'recording.sync_started', { file_id: fileId, device_id: file.device_id, session_id: file.session_id, attribute: file.attribute, transport, sync_attempt_id: attemptId ?? id('sync_attempt'), ...recordingEventFacts(current) });
    };
    await ensureUploadCapacity(expectedSize, fileId);
    const supersededS3 = await db.all<{ staging_key: string }>('SELECT staging_key FROM s3_upload_attempts WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL', [fileId]);
    await db.run("UPDATE upload_tickets SET failed_at=?,failure_code='SUPERSEDED' WHERE file_id=? AND consumed_at IS NULL AND failed_at IS NULL", [now(), fileId]);
    await db.run("UPDATE s3_upload_attempts SET failed_at=?,failure_code='SUPERSEDED' WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL", [now(), fileId]);
    for (const attempt of supersededS3) await s3Storage?.deleteStaging(attempt.staging_key).catch(() => undefined);
    const relayPlan = async (): Promise<{ fileId: string; uploadUrl: string; offset: number }> => {
      const offset = await storage.relayOffset(fileId);
      if (offset > expectedSize) throw new Error('RELAY_PARTIAL_TOO_LARGE');
      await db.run("UPDATE recording_files SET status='syncing',transport='server_relay',error_code=NULL,updated_at=? WHERE id=? AND status IN ('pending','failed','syncing')", [now(), fileId]);
      await emitSyncStarted('server_relay');
      return { fileId, uploadUrl: '', offset };
    };
    if (config.storageDriver === 'server_relay' || Number(file.force_relay ?? 0) === 1) return relayPlan();
    if (s3Storage) {
      const plan = await s3Storage.prepare(fileId, expectedSize, deviceUploadCredentialTtlSeconds);
      if (new TextEncoder().encode(plan.uploadUrl).byteLength > 1_480) return relayPlan();
      await db.batch([
        { sql: 'INSERT INTO s3_upload_attempts(id,file_id,staging_key,expected_size,expires_at,created_at) VALUES(?,?,?,?,?,?)', params: [plan.attemptId, fileId, plan.stagingKey, expectedSize, plan.expiresAt, now()] },
        { sql: "UPDATE recording_files SET status='syncing',transport='s3_direct',error_code=NULL,updated_at=? WHERE id=? AND status IN ('pending','failed','syncing')", params: [now(), fileId] },
      ]);
      await emitSyncStarted('s3_direct', plan.attemptId);
      return { fileId, uploadUrl: plan.uploadUrl };
    }
    const rawTicket = opaqueToken(); const ticketId = id('upload'); const expiresAt = plus(deviceUploadCredentialTtlMs);
    await db.batch([
      { sql: 'INSERT INTO upload_tickets(id,token_hash,file_id,expected_size,expires_at,created_at) VALUES(?,?,?,?,?,?)', params: [ticketId, tokenHash(rawTicket), fileId, expectedSize, expiresAt, now()] },
      { sql: "UPDATE recording_files SET status='syncing',transport='filesystem_http',error_code=NULL,updated_at=? WHERE id=? AND status IN ('pending','failed','syncing')", params: [now(), fileId] },
    ]);
    await emitSyncStarted('filesystem_http', ticketId);
    return { fileId, uploadUrl: `${uploadBaseUrl || config.publicBaseUrl}/device-upload/v1/${rawTicket}` };
  };
  const completeGatewayUpload = async (fileId: string, reportedSize: number): Promise<void> => {
    const file = await db.get<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status IN ('syncing','synced')", [fileId]);
    if (!file || file.status === 'synced') return;
    if (reportedSize > 0 && reportedSize !== Number(file.expected_size)) throw new Error('DEVICE_REPORTED_SIZE_MISMATCH');
    if (!s3Storage || file.transport !== 's3_direct') return;
    const attempt = await db.get<{ id: string; staging_key: string; expected_size: number }>('SELECT id,staging_key,expected_size FROM s3_upload_attempts WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL ORDER BY created_at DESC LIMIT 1', [file.id]);
    if (!attempt) throw new Error('S3_ATTEMPT_MISSING');
    const committed = await s3Storage.verifyAndCommit(String(file.id), attempt.id, attempt.staging_key, attempt.expected_size); const committedAt = now();
    const completedFile = { ...file, actual_size: committed.size, sha256: committed.sha256, synced_at: committedAt, resource_version: Number(file.resource_version ?? 1) + 1 };
    const prepared = await prepareEvent(file, 'file.synced', { file_id: file.id, device_id: file.device_id, session_id: file.session_id, attribute: file.attribute, file_size: committed.size, ...(committed.sha256 ? { sha256: committed.sha256 } : {}), ...recordingEventFacts(completedFile) });
    const results = await db.batch([
      { sql: "UPDATE recording_files SET status='synced',actual_size=?,sha256=?,storage_locator=?,error_code=NULL,synced_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing' AND EXISTS(SELECT 1 FROM devices d WHERE d.id=recording_files.device_id AND d.ownership_epoch=? AND d.group_id=?)", params: [committed.size, committed.sha256, committed.locator, committedAt, committedAt, file.id, file.ownership_epoch, file.group_id], expectChanges: 1 },
      { sql: 'UPDATE s3_upload_attempts SET completed_at=?,final_locator=? WHERE id=? AND completed_at IS NULL AND failed_at IS NULL', params: [committedAt, committed.locator, attempt.id], expectChanges: 1 },
      ...prepared.statements,
    ]);
    if (results[0]?.changes !== 1 || results[1]?.changes !== 1) throw new Error('S3_ATTEMPT_RACE');
    void dispatcher.drain();
  };
  const appendGatewayRelay = async (fileId: string, offset: number, content: Uint8Array, reportedSize: number): Promise<void> => {
    const terminalBatch = offset + content.byteLength === reportedSize;
    let file = offset === 0 || terminalBatch
      ? await db.get<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status='syncing' AND f.transport='server_relay'", [fileId])
      : null;
    if ((offset === 0 || terminalBatch) && !file) throw new Error('RELAY_SESSION_MISSING');
    const stored = await storage.appendRelay(fileId, offset, content, reportedSize);
    if (!stored) return;
    file ??= await db.get<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status='syncing' AND f.transport='server_relay'", [fileId]);
    if (!file) throw new Error('RELAY_SESSION_MISSING');
    if (reportedSize !== Number(file.expected_size)) throw new Error('DEVICE_REPORTED_SIZE_MISMATCH');
    const completedAt = now(); const completedFile = { ...file, actual_size: stored.size, sha256: stored.sha256, synced_at: completedAt, resource_version: Number(file.resource_version ?? 1) + 1 }; const prepared = await prepareEvent(file, 'file.synced', { file_id: file.id, device_id: file.device_id, session_id: file.session_id, attribute: file.attribute, file_size: stored.size, sha256: stored.sha256, ...recordingEventFacts(completedFile) });
    await db.batch([
      { sql: "UPDATE recording_files SET status='synced',actual_size=?,sha256=?,storage_locator=?,error_code=NULL,synced_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='syncing' AND transport='server_relay' AND EXISTS(SELECT 1 FROM devices d WHERE d.id=recording_files.device_id AND d.ownership_epoch=? AND d.group_id=?)", params: [stored.size, stored.sha256, stored.locator, completedAt, completedAt, file.id, file.ownership_epoch, file.group_id], expectChanges: 1 },
      ...prepared.statements,
    ]);
    void dispatcher.drain();
  };
  const gateway = new DeviceGateway(db, await loadNodeGatewayCore(), emitEvent, planGatewayUpload, completeGatewayUpload, appendGatewayRelay, config.maxFileBytes, (event, details, level = 'debug') => {
    if (level === 'warn') app.log.warn(details, event);
    else if (level === 'info') app.log.info(details, event);
    else app.log.debug(details, event);
  });
  reconciler = new Reconciler(db, storage, s3Storage, config, emitEvent);
  const openPlatformService = registerOpenPlatformRoutes({ app, db, config, gateway, storage, s3Storage, resolveAccess, audit });
  registerOAuthMcpRoutes({ app, db, config, service: openPlatformService, resolveAccess, audit });

  app.get('/health/live', async (_request, reply) => success(reply, { status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (draining) return success(reply, { status: 'draining', database: true }, 503);
    const migration = await db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
    return success(reply, { status: migration ? 'ready' : 'not_ready', database: Boolean(migration) }, migration ? 200 : 503);
  });
  app.get('/metrics', async (_request, reply) => {
    const [capacity, operational] = await Promise.all([
      config.storageDriver !== 's3_direct' ? storage.capacity() : Promise.resolve(undefined),
      db.get<{
        files_pending: number; files_syncing: number; files_failed: number;
        deliveries_pending: number; deliveries_dead: number;
        commands_queued: number; commands_in_flight: number;
        oldest_pending_file_seconds: number | null; oldest_pending_delivery_seconds: number | null;
      }>(db.dialect === 'postgres' ? `SELECT
        (SELECT COUNT(*) FROM recording_files WHERE status='pending') AS files_pending,
        (SELECT COUNT(*) FROM recording_files WHERE status='syncing') AS files_syncing,
        (SELECT COUNT(*) FROM recording_files WHERE status='failed') AS files_failed,
        (SELECT COUNT(*) FROM event_deliveries WHERE status='pending') AS deliveries_pending,
        (SELECT COUNT(*) FROM event_deliveries WHERE status='dead') AS deliveries_dead,
        (SELECT COUNT(*) FROM commands WHERE status='queued') AS commands_queued,
        (SELECT COUNT(*) FROM commands WHERE status IN ('dispatched','running')) AS commands_in_flight,
        (SELECT GREATEST(0,EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-MIN(created_at::timestamptz))))::BIGINT FROM recording_files WHERE status IN ('pending','syncing')) AS oldest_pending_file_seconds,
        (SELECT GREATEST(0,EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-MIN(created_at::timestamptz))))::BIGINT FROM event_deliveries WHERE status='pending') AS oldest_pending_delivery_seconds` : `SELECT
        (SELECT COUNT(*) FROM recording_files WHERE status='pending') AS files_pending,
        (SELECT COUNT(*) FROM recording_files WHERE status='syncing') AS files_syncing,
        (SELECT COUNT(*) FROM recording_files WHERE status='failed') AS files_failed,
        (SELECT COUNT(*) FROM event_deliveries WHERE status='pending') AS deliveries_pending,
        (SELECT COUNT(*) FROM event_deliveries WHERE status='dead') AS deliveries_dead,
        (SELECT COUNT(*) FROM commands WHERE status='queued') AS commands_queued,
        (SELECT COUNT(*) FROM commands WHERE status IN ('dispatched','running')) AS commands_in_flight,
        (SELECT MAX(0,CAST((julianday('now')-julianday(MIN(created_at)))*86400 AS INTEGER)) FROM recording_files WHERE status IN ('pending','syncing')) AS oldest_pending_file_seconds,
        (SELECT MAX(0,CAST((julianday('now')-julianday(MIN(created_at)))*86400 AS INTEGER)) FROM event_deliveries WHERE status='pending') AS oldest_pending_delivery_seconds`),
    ]);
    return reply.type('text/plain; version=0.0.4').send(metrics.render({
      ...(capacity ? { storageUsedRatio: capacity.usedRatio, storageAvailableBytes: capacity.available } : {}),
      operational: {
        filesPending: Number(operational?.files_pending ?? 0), filesSyncing: Number(operational?.files_syncing ?? 0), filesFailed: Number(operational?.files_failed ?? 0),
        deliveriesPending: Number(operational?.deliveries_pending ?? 0), deliveriesDead: Number(operational?.deliveries_dead ?? 0),
        commandsQueued: Number(operational?.commands_queued ?? 0), commandsInFlight: Number(operational?.commands_in_flight ?? 0),
        oldestPendingFileSeconds: Number(operational?.oldest_pending_file_seconds ?? 0), oldestPendingDeliverySeconds: Number(operational?.oldest_pending_delivery_seconds ?? 0),
      },
    }));
  });

  app.get('/', async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').redirect('/admin');
  });
  const adminAsset = (name: 'index.html' | 'style.css' | 'app.js') => readFile(new URL(`../../admin-web/dist/${name}`, import.meta.url));
  app.get('/admin', async (_request, reply) => {
    const page = (await adminAsset('index.html')).toString('utf8').replace('__VOICECAN_CONNECT_URL__', config.deviceConnectUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'));
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(page);
  });
  app.get('/admin/style.css', async (_request, reply) => reply.type('text/css; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(await adminAsset('style.css')));
  app.get('/admin/app.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-store').send(await adminAsset('app.js')));
  const requireHumanAssetAccess = async (request: FastifyRequest): Promise<void> => {
    const context = await resolveAccess(request);
    if (context.actorType !== 'user') throw new HttpError(403, 'HUMAN_SESSION_REQUIRED', 'Human session required');
  };
  app.get('/device', async (request, reply) => { await requireHumanAssetAccess(request); return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(deviceHtml); });
  app.get('/device/app.js', async (request, reply) => { await requireHumanAssetAccess(request); return reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-store').send(deviceJs); });
  const sdkAssets = new Map<string, { path: string; type: string }>([
    ['/sdk/device-web.js', { path: '../../device-web/dist/index.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/device-ui.js', { path: '../../device-ui/dist/index.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/contracts.js', { path: '../../contracts/dist/index.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/device-core.js', { path: '../../../node_modules/@voicecan/device-core/dist/index.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/device-core-browser.js', { path: '../../../node_modules/@voicecan/device-core/dist/browser.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/device-core-manifest.js', { path: '../../../node_modules/@voicecan/device-core/dist/manifest.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/index.js', { path: '../../../node_modules/@voicecan/device-core/dist/index.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/browser.js', { path: '../../../node_modules/@voicecan/device-core/dist/browser.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/node.js', { path: '../../../node_modules/@voicecan/device-core/dist/node.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/manifest.js', { path: '../../../node_modules/@voicecan/device-core/dist/manifest.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/types.js', { path: '../../../node_modules/@voicecan/device-core/dist/types.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/private/semantic_core.js', { path: '../../../node_modules/@voicecan/device-core/private/browser/semantic_core.js', type: 'text/javascript; charset=utf-8' }],
    ['/sdk/private/protocol_core_bg.wasm', { path: '../../../node_modules/@voicecan/device-core/private/browser/protocol_core_bg.wasm', type: 'application/wasm' }],
  ]);
  for (const [route, asset] of sdkAssets) app.get(route, async (request, reply) => {
    if (route.startsWith('/sdk/private/')) await requireHumanAssetAccess(request);
    return reply.type(asset.type).header('Cache-Control', 'no-store').send(await readFile(new URL(asset.path, import.meta.url)));
  });

  app.get('/api/v1/setup/status', async (_request, reply) => {
    const state = await db.get<{ setup_completed_at: string | null }>('SELECT setup_completed_at FROM server_settings WHERE singleton=1');
    return success(reply, { status: state?.setup_completed_at ? 'ready' : 'setup_pending' });
  });

  app.post('/api/v1/setup/admin', async (request, reply) => {
    const body = bodyOf(request); const setupToken = requiredString(body, 'setup_token');
    const username = requiredString(body, 'username', 64); const password = requiredString(body, 'password', 256);
    const state = await db.get<{ setup_token_hash: string | null; setup_token_expires_at: string | null; setup_completed_at: string | null }>('SELECT setup_token_hash,setup_token_expires_at,setup_completed_at FROM server_settings WHERE singleton=1');
    if (!state || state.setup_completed_at || !state.setup_token_hash || !state.setup_token_expires_at || state.setup_token_expires_at <= now() || !constantTimeHexEqual(state.setup_token_hash, tokenHash(setupToken))) throw new HttpError(403, 'SETUP_UNAVAILABLE', 'Setup token is invalid or setup is complete');
    const userId = id('user'); const groupId = id('group'); const timestamp = now(); const passwordHash = await hashPassword(password);
    const condition = 'EXISTS(SELECT 1 FROM server_settings WHERE singleton=1 AND setup_completed_at IS NULL AND setup_token_hash=? AND setup_token_expires_at>?)';
    const results = await db.batch([
      { sql: `INSERT INTO users(id,username,normalized_username,display_name,role,password_hash,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ${condition}`, params: [userId, username, normalizeUsername(username), optionalString(body, 'display_name', 128), 'system_admin', passwordHash, timestamp, timestamp, tokenHash(setupToken), timestamp] },
      { sql: `INSERT INTO user_groups(id,name,created_at,updated_at) SELECT ?,?,?,? WHERE ${condition}`, params: [groupId, 'Default Group', timestamp, timestamp, tokenHash(setupToken), timestamp] },
      { sql: `INSERT INTO group_memberships(id,user_id,group_id,role,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE ${condition}`, params: [id('membership'), userId, groupId, 'group_admin', timestamp, timestamp, tokenHash(setupToken), timestamp] },
      { sql: 'UPDATE server_settings SET setup_completed_at=?,setup_token_hash=NULL,setup_token_expires_at=NULL WHERE singleton=1 AND setup_completed_at IS NULL AND setup_token_hash=? AND setup_token_expires_at>?', params: [timestamp, tokenHash(setupToken), timestamp] },
    ]);
    if (results[3]?.changes !== 1) throw new HttpError(409, 'SETUP_ALREADY_COMPLETED', 'Setup was completed by another request');
    await rm(resolve(config.dataDir, 'setup-token'), { force: true });
    return success(reply, { user_id: userId, group_id: groupId }, 201);
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = bodyOf(request); const username = requiredString(body, 'username', 64); const password = requiredString(body, 'password', 256);
    const identityHash = tokenHash(normalizeUsername(username), config.groupTokenPepper); const ipHash = tokenHash(request.ip, config.groupTokenPepper);
    const [attempt, ipAttempt] = await Promise.all([
      db.get<{ failures: number; blocked_until: string | null }>('SELECT failures,blocked_until FROM login_attempts WHERE identity_hash=? AND ip_hash=?', [identityHash, ipHash]),
      db.get<{ failures: number; blocked_until: string | null }>('SELECT failures,blocked_until FROM login_attempts WHERE identity_hash=? AND ip_hash=?', [ipRateLimitIdentityHash, ipHash]),
    ]);
    const blockedUntil = [attempt?.blocked_until, ipAttempt?.blocked_until].filter((value): value is string => Boolean(value)).sort().at(-1);
    if (blockedUntil && blockedUntil > now()) { reply.header('Retry-After', String(Math.max(1, Math.ceil((Date.parse(blockedUntil) - Date.now()) / 1_000)))); throw new HttpError(429, 'LOGIN_RATE_LIMITED', 'Try again later'); }
    const row = await db.get<{ id: string; password_hash: string; disabled_at: string | null }>('SELECT id,password_hash,disabled_at FROM users WHERE normalized_username=?', [normalizeUsername(username)]);
    const valid = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, dummyPasswordHash);
    if (!valid || !row || row.disabled_at) {
      const count = Number(attempt?.failures ?? 0) + 1; const identityBlockedUntil = count >= 5 ? plus(Math.min(15 * 60_000, 60_000 * 2 ** Math.floor((count - 5) / 2))) : null;
      const timestamp = now(); const windowStart = new Date(Date.now() - 5 * 60_000).toISOString(); const ipBlockedUntil = plus(15 * 60_000);
      await db.batch([
        { sql: `INSERT INTO login_attempts(identity_hash,ip_hash,failures,blocked_until,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(identity_hash,ip_hash) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at`, params: [identityHash, ipHash, count, identityBlockedUntil, timestamp] },
        { sql: `INSERT INTO login_attempts(identity_hash,ip_hash,failures,blocked_until,updated_at) VALUES(?,?,1,NULL,?)
          ON CONFLICT(identity_hash,ip_hash) DO UPDATE SET
            failures=CASE WHEN login_attempts.updated_at<? THEN 1 ELSE login_attempts.failures+1 END,
            blocked_until=CASE WHEN login_attempts.updated_at<? THEN NULL WHEN login_attempts.failures+1>=20 THEN ? ELSE login_attempts.blocked_until END,
            updated_at=excluded.updated_at`, params: [ipRateLimitIdentityHash, ipHash, timestamp, windowStart, windowStart, ipBlockedUntil] },
      ]);
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Username or password is invalid');
    }
    await db.batch([
      { sql: 'DELETE FROM login_attempts WHERE identity_hash=? AND ip_hash=?', params: [identityHash, ipHash] },
      { sql: 'DELETE FROM login_attempts WHERE identity_hash=? AND ip_hash=?', params: [ipRateLimitIdentityHash, ipHash] },
    ]);
    const sessionToken = opaqueToken(); const csrfToken = opaqueToken();
    await db.run('INSERT INTO user_sessions(id,user_id,token_hash,csrf_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)', [id('session'), row.id, tokenHash(sessionToken), tokenHash(csrfToken), plus(12 * 60 * 60_000), now()]);
    reply.setCookie('vc_session', sessionToken, { ...browserCookieOptions, httpOnly: true, maxAge: 43_200 });
    reply.setCookie('vc_csrf', csrfToken, { ...browserCookieOptions, httpOnly: false, maxAge: 43_200 });
    return success(reply, { csrf_token: csrfToken });
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const context = await resolveAccess(request); if (context.actorType !== 'user') throw new HttpError(403, 'HUMAN_SESSION_REQUIRED', 'Human session required');
    const row = await db.get<AuthUser & Row>(`SELECT u.id,u.username,u.display_name,u.role,gm.group_id,gm.role AS membership_role FROM users u LEFT JOIN group_memberships gm ON gm.user_id=u.id AND gm.active=1 WHERE u.id=?`, [context.actorId]);
    return success(reply, row);
  });

  app.get('/api/v1/auth/csrf', async (request, reply) => {
    const context = await resolveAccess(request); if (context.actorType !== 'user') throw new HttpError(403, 'HUMAN_SESSION_REQUIRED', 'Human session required');
    const raw = request.cookies.vc_session!; const csrfToken = opaqueToken();
    const updated = await db.run('UPDATE user_sessions SET csrf_hash=? WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?', [tokenHash(csrfToken), tokenHash(raw), now()]);
    if (updated.changes !== 1) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
    reply.header('Cache-Control', 'no-store');
    reply.setCookie('vc_csrf', csrfToken, { ...browserCookieOptions, httpOnly: false, maxAge: 43_200 });
    return success(reply, { csrf_token: csrfToken });
  });

  app.get('/api/v1/settings/device-access', async (request, reply) => {
    await resolveAccess(request);
    const settings = await db.get<{ ble_name_prefix: string }>('SELECT ble_name_prefix FROM server_settings WHERE singleton=1');
    const currentPublicUrl = publicRequestDeviceWsUrl({ ...(request.headers.host ? { requestHost: request.headers.host } : {}), secure: request.protocol === 'https' });
    const candidates = [...new Set([
      ...(config.deviceWssUrl ? [config.deviceWssUrl] : []),
      ...(currentPublicUrl ? [currentPublicUrl] : []),
      ...config.deviceAdvertiseHosts.map((host) => resolveDeviceWsUrl({ advertiseHost: host, port: config.port })),
    ])];
    const preferred = config.deviceWssUrl ?? currentPublicUrl ?? candidates[0] ?? resolveDeviceWsUrl({ advertiseHost: config.deviceAdvertiseHost, port: config.port });
    return success(reply, { ble_name_prefix: settings?.ble_name_prefix ?? 'CAPSO-', preferred_device_ws_url: preferred, device_ws_urls: candidates.map((url) => ({ url, preferred: url === preferred, host: new URL(url).hostname })) });
  });

  app.patch('/api/v1/settings/device-access', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context);
    const bleNamePrefix = validatedBleNamePrefix(requiredString(bodyOf(request), 'ble_name_prefix', 96));
    const changed = await db.run('UPDATE server_settings SET ble_name_prefix=? WHERE singleton=1', [bleNamePrefix]);
    if (changed.changes !== 1) throw new HttpError(409, 'SETTINGS_UPDATE_FAILED', 'Device access settings could not be updated');
    await audit(request, context, 'settings.device_access_updated', 'server_settings', '1', undefined, `ble_name_prefix=${bleNamePrefix}`);
    return success(reply, { ble_name_prefix: bleNamePrefix });
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const context = await resolveAccess(request, true); const raw = request.cookies.vc_session!;
    await db.run('UPDATE user_sessions SET revoked_at=? WHERE token_hash=?', [now(), tokenHash(raw)]);
    reply.clearCookie('vc_session', { path: '/' }); reply.clearCookie('vc_csrf', { path: '/' }); await audit(request, context, 'auth.logout', 'session'); return success(reply, {});
  });

  app.post('/api/v1/auth/change-password', async (request, reply) => {
    const context = await resolveAccess(request, true); if (context.actorType !== 'user') throw new HttpError(403, 'HUMAN_SESSION_REQUIRED', 'Human session required');
    const body = bodyOf(request); const current = requiredString(body, 'current_password', 256); const next = requiredString(body, 'new_password', 256);
    const row = await db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', [context.actorId]);
    if (!row || !await verifyPassword(current, row.password_hash)) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is invalid');
    await db.batch([{ sql: 'UPDATE users SET password_hash=?,updated_at=? WHERE id=?', params: [await hashPassword(next), now(), context.actorId] }, { sql: 'UPDATE user_sessions SET revoked_at=? WHERE user_id=?', params: [now(), context.actorId] }]);
    await audit(request, context, 'user.password_changed', 'user', context.actorId); reply.clearCookie('vc_session', { path: '/' }); reply.clearCookie('vc_csrf', { path: '/' }); return success(reply, {});
  });

  app.get('/api/v1/users', async (request, reply) => { const context = await resolveAccess(request); requireSystemAdmin(context); return success(reply, await db.all('SELECT id,username,display_name,role,disabled_at,created_at FROM users ORDER BY created_at,id')); });
  app.post('/api/v1/users', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const body = bodyOf(request); const timestamp = now(); const userId = id('user');
    await db.run('INSERT INTO users(id,username,normalized_username,display_name,role,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [userId, requiredString(body, 'username', 64), normalizeUsername(requiredString(body, 'username', 64)), optionalString(body, 'display_name', 128), body.role === 'system_admin' ? 'system_admin' : 'user', await hashPassword(requiredString(body, 'password', 256)), timestamp, timestamp]);
    await audit(request, context, 'user.created', 'user', userId); return success(reply, { id: userId }, 201);
  });
  app.patch('/api/v1/users/:id', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const userId = String((request.params as Row).id); const body = bodyOf(request); const disabled = body.disabled === true;
    const target = await db.get<{ role: string; username: string }>('SELECT role,username FROM users WHERE id=?', [userId]); if (!target) throw new AccessDeniedError();
    const nextRole = body.role === undefined ? target.role : body.role === 'system_admin' ? 'system_admin' : body.role === 'user' ? 'user' : (() => { throw new HttpError(400, 'INVALID_ROLE', 'Unsupported user role'); })();
    if (userId === context.actorId && (disabled || nextRole !== 'system_admin')) throw new HttpError(409, 'CANNOT_DEMOTE_SELF', 'Cannot disable or demote the current administrator');
    if (target.role === 'system_admin' && (disabled || nextRole !== 'system_admin')) {
      const count = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role='system_admin' AND disabled_at IS NULL");
      if (Number(count?.count ?? 0) <= 1) throw new HttpError(409, 'LAST_SYSTEM_ADMIN', 'The last active System Admin cannot be disabled or demoted');
    }
    const username = body.username === undefined ? target.username : requiredString(body, 'username', 64);
    const result = await db.run('UPDATE users SET username=?,normalized_username=?,display_name=COALESCE(?,display_name),role=?,disabled_at=?,updated_at=? WHERE id=?', [username, normalizeUsername(username), optionalString(body, 'display_name', 128), nextRole, disabled ? now() : null, now(), userId]);
    if (!result.changes) throw new AccessDeniedError(); if (disabled || nextRole !== target.role) await db.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=?', [now(), userId]);
    await audit(request, context, disabled ? 'user.disabled' : 'user.updated', 'user', userId, undefined, optionalString(body, 'reason', 256) ?? undefined); return success(reply, {});
  });
  app.delete('/api/v1/users/:id', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const userId = String((request.params as Row).id); if (userId === context.actorId) throw new HttpError(409, 'CANNOT_DELETE_SELF', 'Cannot delete the current administrator');
    const target = await db.get<{ role: string }>('SELECT role FROM users WHERE id=?', [userId]); if (!target) throw new AccessDeniedError();
    if (target.role === 'system_admin') { const count = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role='system_admin' AND disabled_at IS NULL"); if (Number(count?.count ?? 0) <= 1) throw new HttpError(409, 'LAST_SYSTEM_ADMIN', 'The last active System Admin cannot be deleted'); }
    const dependencies = await db.get<{ count: number }>(`SELECT (SELECT COUNT(*) FROM group_memberships WHERE user_id=?)+(SELECT COUNT(*) FROM group_api_tokens WHERE created_by=?) AS count`, [userId, userId]);
    if (Number(dependencies?.count ?? 0) > 0) throw new HttpError(409, 'USER_HAS_DEPENDENCIES', 'Disable users with memberships or audit dependencies instead');
    await db.batch([{ sql: 'DELETE FROM user_sessions WHERE user_id=?', params: [userId] }, { sql: 'DELETE FROM users WHERE id=?', params: [userId] }]); await audit(request, context, 'user.deleted', 'user', userId); return success(reply, {});
  });
  app.put('/api/v1/users/:id/password', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const userId = String((request.params as Row).id); const body = bodyOf(request);
    const result = await db.run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [await hashPassword(requiredString(body, 'password', 256)), now(), userId]); if (!result.changes) throw new AccessDeniedError();
    await db.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=?', [now(), userId]); await audit(request, context, 'user.password_set', 'user', userId); return success(reply, {});
  });

  app.get('/api/v1/user-groups', async (request, reply) => {
    const context = await resolveAccess(request); const rows = context.isSystemAdmin ? await db.all('SELECT * FROM user_groups ORDER BY created_at,id') : await db.all('SELECT * FROM user_groups WHERE id=?', [requireGroup(context)]); return success(reply, rows);
  });
  app.post('/api/v1/user-groups', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const groupId = id('group'); const timestamp = now(); const body = bodyOf(request); const adminUserId = requiredString(body, 'group_admin_user_id', 80);
    await db.batch([
      { sql: 'INSERT INTO user_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)', params: [groupId, requiredString(body, 'name', 128), timestamp, timestamp] },
      { sql: 'INSERT INTO group_memberships(id,user_id,group_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)', params: [id('membership'), adminUserId, groupId, 'group_admin', timestamp, timestamp] },
    ]); await audit(request, context, 'group.created', 'group', groupId); return success(reply, { id: groupId }, 201);
  });
  app.patch('/api/v1/user-groups/:id', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const groupId = String((request.params as Row).id); const body = bodyOf(request); const status = body.status === undefined ? null : body.status === 'active' || body.status === 'archived' ? body.status : (() => { throw new HttpError(400, 'INVALID_GROUP_STATUS', 'Unsupported group status'); })();
    if (status === 'archived') { const count = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM devices WHERE group_id=? AND deleted_at IS NULL', [groupId]); if (Number(count?.count ?? 0) > 0) throw new HttpError(409, 'GROUP_HAS_DEVICES', 'Move devices before archiving the group'); }
    const result = await db.run('UPDATE user_groups SET name=COALESCE(?,name),status=COALESCE(?,status),updated_at=? WHERE id=?', [optionalString(body, 'name', 128), status, now(), groupId]); if (!result.changes) throw new AccessDeniedError();
    if (status === 'archived') { const members = await db.all<{ user_id: string }>('SELECT user_id FROM group_memberships WHERE group_id=? AND active=1', [groupId]); await db.run('UPDATE group_memberships SET active=0,updated_at=? WHERE group_id=? AND active=1', [now(), groupId]); for (const member of members) await db.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=?', [now(), member.user_id]); }
    await audit(request, context, status === 'archived' ? 'group.archived' : 'group.updated', 'group', groupId); return success(reply, {});
  });
  app.get('/api/v1/user-groups/:id/members', async (request, reply) => {
    const context = await resolveAccess(request); const groupId = String((request.params as Row).id); requireGroupAdmin(context, groupId);
    return success(reply, await db.all('SELECT u.id,u.username,u.display_name,gm.role FROM group_memberships gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? AND gm.active=1 ORDER BY gm.created_at', [groupId]));
  });
  app.put('/api/v1/user-groups/:id/members', async (request, reply) => {
    const context = await resolveAccess(request, true); const groupId = String((request.params as Row).id); requireGroupAdmin(context, groupId); const userId = requiredString(bodyOf(request), 'user_id', 80);
    const membershipId = id('membership'); const timestamp = now(); await db.run('INSERT INTO group_memberships(id,user_id,group_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)', [membershipId, userId, groupId, 'member', timestamp, timestamp]);
    await audit(request, context, 'group.member_added', 'membership', membershipId, groupId); return success(reply, { id: membershipId }, 201);
  });
  app.delete('/api/v1/user-groups/:id/members/:userId', async (request, reply) => {
    const context = await resolveAccess(request, true); const params = request.params as Row; const groupId = String(params.id); requireGroupAdmin(context, groupId);
    const result = await db.run("UPDATE group_memberships SET active=0,updated_at=? WHERE group_id=? AND user_id=? AND active=1 AND role<>'group_admin'", [now(), groupId, String(params.userId)]); if (!result.changes) throw new HttpError(409, 'MEMBER_NOT_REMOVABLE', 'Member is missing or is the group administrator');
    await db.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=?', [now(), String(params.userId)]); await audit(request, context, 'group.member_removed', 'user', String(params.userId), groupId); return success(reply, {});
  });
  app.post('/api/v1/user-groups/:id/transfer-admin', async (request, reply) => {
    const context = await resolveAccess(request, true); const groupId = String((request.params as Row).id); requireGroupAdmin(context, groupId); const body = bodyOf(request); const nextUserId = requiredString(body, 'user_id', 80); const reason = requiredString(body, 'reason', 256);
    const current = await db.get<{ id: string; user_id: string }>("SELECT id,user_id FROM group_memberships WHERE group_id=? AND active=1 AND role='group_admin'", [groupId]); const next = await db.get<{ id: string }>("SELECT id FROM group_memberships WHERE group_id=? AND user_id=? AND active=1 AND role='member'", [groupId, nextUserId]); if (!current || !next) throw new HttpError(409, 'ADMIN_TRANSFER_INVALID', 'Target must be an active member of the group');
    await db.batch([{ sql: "UPDATE group_memberships SET role='member',updated_at=? WHERE id=?", params: [now(), current.id] }, { sql: "UPDATE group_memberships SET role='group_admin',updated_at=? WHERE id=?", params: [now(), next.id] }]);
    await audit(request, context, 'group.admin_transferred', 'group', groupId, groupId, reason); return success(reply, {});
  });
  app.post('/api/v1/user-groups/:id/api-tokens', async (request, reply) => {
    const context = await resolveAccess(request, true); const groupId = String((request.params as Row).id); requireGroupAdmin(context, groupId); const body = bodyOf(request);
    const requested = Array.isArray(body.scopes) ? body.scopes.map(String) : ['devices:read', 'files:read', 'events:read']; const allowed = new Set(['devices:read','files:read','events:read','sync:trigger']); if (requested.some((scope) => !allowed.has(scope))) throw new HttpError(400, 'INVALID_SCOPE', 'Unsupported scope');
    const raw = `vcd_grp_${opaqueToken()}`; const tokenId = id('token'); await db.run('INSERT INTO group_api_tokens(id,group_id,name,token_hash,scopes_json,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [tokenId, groupId, requiredString(body, 'name', 128), tokenHash(raw, config.groupTokenPepper), JSON.stringify(requested), optionalString(body, 'expires_at', 64), context.actorId, now()]);
    await audit(request, context, 'group_token.created', 'group_api_token', tokenId, groupId); return success(reply, { id: tokenId, token: raw, scopes: requested }, 201);
  });
  app.get('/api/v1/user-groups/:id/api-tokens', async (request, reply) => {
    const context = await resolveAccess(request); const groupId = String((request.params as Row).id); requireGroupAdmin(context, groupId);
    return success(reply, await db.all('SELECT id,name,scopes_json,expires_at,revoked_at,last_used_at,rotated_from_id,replaced_by_id,created_by,created_at FROM group_api_tokens WHERE group_id=? ORDER BY created_at DESC', [groupId]));
  });
  app.post('/api/v1/user-groups/:id/api-tokens/:tokenId/rotate', async (request, reply) => {
    const context = await resolveAccess(request, true); const params = request.params as Row; const groupId = String(params.id); const oldId = String(params.tokenId); requireGroupAdmin(context, groupId); const old = await db.get<{ name: string; scopes_json: string; expires_at: string | null }>('SELECT name,scopes_json,expires_at FROM group_api_tokens WHERE id=? AND group_id=? AND revoked_at IS NULL', [oldId, groupId]); if (!old) throw new AccessDeniedError(); const body = bodyOf(request); const nextId = id('token'); const raw = `vcd_grp_${opaqueToken()}`; const rotatedAt = now(); const expiresAt = optionalString(body, 'expires_at', 64) ?? old.expires_at;
    await db.batch([
      { sql: 'UPDATE group_api_tokens SET revoked_at=?,replaced_by_id=? WHERE id=? AND group_id=? AND revoked_at IS NULL', params: [rotatedAt, nextId, oldId, groupId], expectChanges: 1 },
      { sql: 'INSERT INTO group_api_tokens(id,group_id,name,token_hash,scopes_json,expires_at,rotated_from_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [nextId, groupId, optionalString(body, 'name', 128) ?? old.name, tokenHash(raw, config.groupTokenPepper), old.scopes_json, expiresAt, oldId, context.actorId, rotatedAt], expectChanges: 1 },
    ]);
    await audit(request, context, 'group_token.rotated', 'group_api_token', nextId, groupId, requiredString(body, 'reason', 256)); return success(reply, { id: nextId, token: raw, scopes: JSON.parse(old.scopes_json), expires_at: expiresAt }, 201);
  });
  app.delete('/api/v1/user-groups/:id/api-tokens/:tokenId', async (request, reply) => {
    const context = await resolveAccess(request, true); const params = request.params as Row; const groupId = String(params.id); requireGroupAdmin(context, groupId);
    const result = await db.run('UPDATE group_api_tokens SET revoked_at=? WHERE id=? AND group_id=? AND revoked_at IS NULL', [now(), String(params.tokenId), groupId]); if (!result.changes) throw new AccessDeniedError(); await audit(request, context, 'group_token.revoked', 'group_api_token', String(params.tokenId), groupId); return success(reply, {});
  });

  const bindingIntentState = async (intent: Row): Promise<Row> => {
    let status = String(intent.status); let deviceId = intent.device_id === null || intent.device_id === undefined ? null : String(intent.device_id); let failureCode = intent.failure_code === null || intent.failure_code === undefined ? null : String(intent.failure_code);
    if (String(intent.expires_at) <= now() && !['completed', 'canceled'].includes(status)) status = 'expired';
    if (intent.provisioning_session_id) {
      const session = await db.get<Row>('SELECT status,device_id,failure_code,completed_at FROM provisioning_sessions WHERE id=?', [intent.provisioning_session_id]);
      if (session) {
        deviceId = session.device_id === null || session.device_id === undefined ? deviceId : String(session.device_id);
        failureCode = session.failure_code === null || session.failure_code === undefined ? failureCode : String(session.failure_code);
        const provisioningStatus = String(session.status);
        if (provisioningStatus === 'completed') status = 'completed';
        else if (provisioningStatus === 'configured' || provisioningStatus === 'online') status = 'configured';
        else if (['reserved', 'ble_authenticated'].includes(provisioningStatus)) status = 'claimed';
        else if (provisioningStatus === 'failed') status = 'failed';
      }
    }
    if (status !== intent.status || deviceId !== intent.device_id || failureCode !== intent.failure_code) await db.run('UPDATE binding_intents SET status=?,device_id=?,failure_code=?,completed_at=CASE WHEN ?=\'completed\' THEN COALESCE(completed_at,?) ELSE completed_at END,updated_at=? WHERE id=?', [status, deviceId, failureCode, status, now(), now(), intent.id]);
    return { id: intent.id, group_id: intent.group_id, expected_sn: intent.expected_sn, display_name: intent.display_name, ble_name_prefix: intent.ble_name_prefix, device_ws_url: intent.resolved_device_ws_url, network_mode: intent.network_mode, locale: intent.locale, provisioning_session_id: intent.provisioning_session_id, device_id: deviceId, status, failure_code: failureCode, expires_at: intent.expires_at, completed_at: status === 'completed' ? (intent.completed_at ?? now()) : intent.completed_at };
  };

  app.post('/api/v1/binding-intents', async (request, reply) => {
    const context = await resolveAccess(request, true); if (context.actorType !== 'user') throw new AccessDeniedError(); const body = bodyOf(request);
    const groupId = context.isSystemAdmin ? requiredString(body, 'group_id', 80) : requireGroup(context); if (!context.isSystemAdmin) requireGroupAdmin(context, groupId);
    const allowedOrigin = validatedProvisioningOrigin(requiredString(body, 'allowed_origin', 300), optionalString(body, 'connector_origin', 300), config.deviceConnectUrl, config.deploymentProfile === 'intranet');
    const idempotencyKey = optionalString(body, 'idempotency_key', 200);
    if (idempotencyKey) {
      const existing = await db.get<Row>('SELECT * FROM binding_intents WHERE created_by=? AND idempotency_key=?', [context.actorId, idempotencyKey]);
      if (existing) return success(reply, { ...(await bindingIntentState(existing)), launch_url: null, reused: true });
    }
    const networkMode = body.network_mode === undefined || body.network_mode === 'existing' ? 'existing' : body.network_mode === 'ask' ? 'ask' : (() => { throw new HttpError(400, 'INVALID_NETWORK_MODE', 'network_mode must be existing or ask'); })();
    const locale = body.locale === 'zh-CN' ? 'zh-CN' : 'en';
    let deviceWsUrl: string;
    try { deviceWsUrl = resolveDeviceWsUrl({ requested: optionalString(body, 'device_ws_url', 1000), ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), ...(request.headers.host ? { requestHost: request.headers.host } : {}), advertiseHost: config.deviceAdvertiseHost, port: config.port }); }
    catch (error) { throw new HttpError(400, 'INVALID_DEVICE_WS_URL', error instanceof Error ? error.message : 'Device WebSocket URL is invalid'); }
    const settings = await db.get<{ ble_name_prefix: string }>('SELECT ble_name_prefix FROM server_settings WHERE singleton=1');
    const intentId = id('bind'); const launchToken = `vcd_bind_${opaqueToken()}`; const timestamp = now(); const expiresAt = plus(deviceProvisioningCredentialTtlMs);
    await db.run("INSERT INTO binding_intents(id,group_id,created_by,idempotency_key,expected_sn,display_name,ble_name_prefix,resolved_device_ws_url,network_mode,locale,allowed_origin,status,launch_token_hash,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)", [intentId, groupId, context.actorId, idempotencyKey, optionalString(body, 'expected_sn', 128), optionalString(body, 'display_name', 80), settings?.ble_name_prefix ?? 'CAPSO-', deviceWsUrl, networkMode, locale, allowedOrigin, tokenHash(launchToken), expiresAt, timestamp, timestamp]);
    const launchUrl = new URL('/admin', config.publicBaseUrl); launchUrl.searchParams.set('view', 'provision'); launchUrl.searchParams.set('binding_intent', intentId); launchUrl.hash = `launch=${encodeURIComponent(launchToken)}`;
    await audit(request, context, 'binding_intent.created', 'binding_intent', intentId, groupId);
    reply.header('cache-control', 'private, no-store'); return success(reply, { id: intentId, status: 'pending', expires_at: expiresAt, launch_url: launchUrl.href, reused: false }, 201);
  });

  app.post('/api/v1/binding-intents/exchange', async (request, reply) => {
    const launchToken = requiredString(bodyOf(request), 'launch_token', 512); const origin = String(request.headers.origin ?? ''); const browserToken = `vcd_bind_browser_${opaqueToken()}`; const timestamp = now();
    const intent = await db.get<Row>("SELECT * FROM binding_intents WHERE launch_token_hash=? AND status='pending' AND launch_consumed_at IS NULL AND expires_at>?", [tokenHash(launchToken), timestamp]);
    if (!intent || origin !== intent.allowed_origin) throw new HttpError(403, 'BINDING_LAUNCH_INVALID', 'Binding launch is invalid or expired');
    const changed = await db.run("UPDATE binding_intents SET launch_token_hash=NULL,launch_consumed_at=?,browser_session_hash=?,status='user_action',updated_at=? WHERE id=? AND launch_consumed_at IS NULL", [timestamp, tokenHash(browserToken), timestamp, intent.id]);
    if (changed.changes !== 1) throw new HttpError(409, 'BINDING_LAUNCH_USED', 'Binding launch was already used');
    reply.setCookie('vc_binding', browserToken, { ...browserCookieOptions, httpOnly: true, maxAge: 600 });
    reply.header('cache-control', 'private, no-store'); return success(reply, await bindingIntentState({ ...intent, status: 'user_action', launch_consumed_at: timestamp, browser_session_hash: tokenHash(browserToken) }));
  });

  const requireBrowserIntent = async (request: FastifyRequest, intentId: string): Promise<Row> => {
    const browserToken = request.cookies.vc_binding; if (!browserToken) throw new HttpError(401, 'BINDING_SESSION_REQUIRED', 'Binding browser session is required');
    const intent = await db.get<Row>('SELECT * FROM binding_intents WHERE id=? AND browser_session_hash=?', [intentId, tokenHash(browserToken)]);
    if (!intent) throw new HttpError(401, 'BINDING_SESSION_INVALID', 'Binding browser session is invalid');
    return intent;
  };

  app.get('/api/v1/binding-intents/:id/browser', async (request, reply) => {
    const intent = await requireBrowserIntent(request, String((request.params as Row).id)); reply.header('cache-control', 'private, no-store'); return success(reply, await bindingIntentState(intent));
  });

  app.post('/api/v1/binding-intents/:id/grant', async (request, reply) => {
    const intentId = String((request.params as Row).id); const intent = await requireBrowserIntent(request, intentId); const state = await bindingIntentState(intent);
    if (!['user_action', 'failed', 'ble_selected', 'claimed'].includes(String(state.status)) || String(intent.expires_at) <= now()) throw new HttpError(409, 'BINDING_NOT_CLAIMABLE', 'Binding intent is not ready to claim');
    const sessionId = id('provision'); const raw = `vcd_prov_${opaqueToken()}`; const timestamp = now();
    const statements: SqlStatement[] = [];
    if (intent.provisioning_session_id) statements.push({ sql: "UPDATE provisioning_sessions SET status='failed',failed_at=?,failure_code='SUPERSEDED_BY_BINDING_RESUME',updated_at=? WHERE id=? AND status IN ('pending','reserved','ble_authenticated','failed')", params: [timestamp, timestamp, intent.provisioning_session_id] });
    statements.push(
      { sql: "INSERT INTO provisioning_sessions(id,public_token_hash,allowed_origin,expected_sn,group_id,created_by,expires_at,status,updated_at,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)", params: [sessionId, tokenHash(raw), intent.allowed_origin, intent.expected_sn, intent.group_id, intent.created_by, intent.expires_at, timestamp, timestamp], expectChanges: 1 },
      { sql: "UPDATE binding_intents SET provisioning_session_id=?,status='ble_selected',failure_code=NULL,updated_at=? WHERE id=?", params: [sessionId, timestamp, intentId], expectChanges: 1 },
    );
    await db.batch(statements);
    reply.header('cache-control', 'private, no-store'); return success(reply, { id: intentId, provisioning_session_id: sessionId, provisioning_token: raw, expires_at: intent.expires_at, device_ws_url: intent.resolved_device_ws_url, network_mode: intent.network_mode });
  });

  app.get('/api/v1/binding-intents/:id', async (request, reply) => {
    const context = await resolveAccess(request); const intentId = String((request.params as Row).id); const groupId = context.isSystemAdmin ? null : requireGroup(context);
    const intent = await db.get<Row>(`SELECT * FROM binding_intents WHERE id=? ${groupId ? 'AND group_id=?' : ''}`, groupId ? [intentId, groupId] : [intentId]); if (!intent) throw new AccessDeniedError();
    return success(reply, await bindingIntentState(intent));
  });

  app.post('/api/v1/provisioning-sessions', async (request, reply) => {
    const context = await resolveAccess(request, true); const body = bodyOf(request); const groupId = context.isSystemAdmin ? requiredString(body, 'group_id', 80) : requireGroup(context); if (!context.isSystemAdmin) requireGroupAdmin(context, groupId);
    const allowedOrigin = validatedProvisioningOrigin(requiredString(body, 'allowed_origin', 300), optionalString(body, 'connector_origin', 300), config.deviceConnectUrl, config.deploymentProfile === 'intranet');
    const sessionId = id('provision'); const raw = `vcd_prov_${opaqueToken()}`; const timestamp = now(); const expiresAt = plus(deviceProvisioningCredentialTtlMs); await db.run('INSERT INTO provisioning_sessions(id,public_token_hash,allowed_origin,expected_sn,group_id,created_by,expires_at,status,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [sessionId, tokenHash(raw), allowedOrigin, optionalString(body, 'expected_sn', 128), groupId, context.actorId, expiresAt, 'pending', timestamp, timestamp]);
    await audit(request, context, 'provisioning.created', 'provisioning_session', sessionId, groupId); reply.header('Cache-Control', 'no-store'); return success(reply, { id: sessionId, provisioning_token: raw, expires_at: expiresAt }, 201);
  });
  app.get('/api/v1/provisioning-sessions/:id', async (request, reply) => {
    const context = await resolveAccess(request); const sessionId = String((request.params as Row).id); const groupId = context.isSystemAdmin ? null : requireGroup(context); const row = await db.get<Row>(`SELECT id,status,device_id,expires_at,consumed_at FROM provisioning_sessions WHERE id=? ${groupId ? 'AND group_id=?' : ''}`, groupId ? [sessionId, groupId] : [sessionId]); if (!row) throw new AccessDeniedError(); return success(reply, row);
  });
  app.post('/api/v1/provisioning-sessions/claim', async (request, reply) => {
    const body = bodyOf(request); const rawGrant = requiredString(body, 'provisioning_token'); const manufacturer = requiredString(body, 'manufacturer', 64); const sn = requiredString(body, 'serial_number', 128); const scannedBluetoothName = optionalString(body, 'bluetooth_name', 248);
    let deviceWsUrl: string;
    try { deviceWsUrl = resolveDeviceWsUrl({ requested: optionalString(body, 'device_ws_url', 1000), ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), ...(request.headers.host ? { requestHost: request.headers.host } : {}), advertiseHost: config.deviceAdvertiseHost, port: config.port }); }
    catch (error) { throw new HttpError(400, 'INVALID_DEVICE_WS_URL', error instanceof Error ? error.message : 'Device WebSocket URL is invalid'); }
    const session = await db.get<{ id: string; expected_sn: string | null; group_id: string; allowed_origin: string; expires_at: string; status: string; consumed_at: string | null }>("SELECT id,expected_sn,group_id,allowed_origin,expires_at,status,consumed_at FROM provisioning_sessions WHERE public_token_hash=? AND status IN ('pending','failed') AND expires_at>?", [tokenHash(rawGrant), now()]); if (!session || request.headers.origin !== session.allowed_origin || (session.expected_sn && session.expected_sn !== sn)) throw new HttpError(403, 'PROVISIONING_TOKEN_INVALID', 'Provisioning session is invalid');
    const bindingIntent = await db.get<{ display_name: string | null }>('SELECT display_name FROM binding_intents WHERE provisioning_session_id=?', [session.id]);
    const defaultDisplayName = bindingIntent?.display_name ?? (scannedBluetoothName ? scannedBluetoothName.slice(0, 80) : null);
    const existing = await db.get<{ id: string; display_name: string | null; group_id: string; claim_status: string; credential_id: string | null; token_ciphertext: string | null; key_version: number | null }>(`SELECT d.id,d.display_name,d.group_id,d.claim_status,c.id AS credential_id,c.token_ciphertext,c.key_version
      FROM devices d LEFT JOIN device_credentials c ON c.device_id=d.id AND c.status='temporary' AND c.revoked_at IS NULL
      WHERE d.manufacturer=? AND d.sn=? AND d.deleted_at IS NULL ORDER BY c.credential_epoch DESC LIMIT 1`, [manufacturer, sn]);
    if (existing) {
      if (existing.group_id !== session.group_id) throw new HttpError(409, 'DEVICE_ALREADY_CLAIMED', 'Device is already claimed');
      if (!existing.display_name && defaultDisplayName) {
        await db.run('UPDATE devices SET display_name=?,updated_at=? WHERE id=? AND display_name IS NULL', [defaultDisplayName, now(), existing.id]);
        existing.display_name = defaultDisplayName;
      }
      if (existing.claim_status !== 'reserved') throw new HttpError(409, 'DEVICE_ALREADY_CLAIMED', 'Device is already claimed', { device_id: existing.id });
      if (!existing.credential_id || !existing.token_ciphertext || existing.key_version === null) throw new HttpError(409, 'DEVICE_RECOVERY_UNAVAILABLE', 'The reserved device has no recoverable credential and must be reset before provisioning');
      const continuationToken = `vcd_continue_${opaqueToken()}`; const timestamp = now();
      const rawDeviceToken = decryptSecret(existing.token_ciphertext, config.masterKeys.get(existing.key_version) ?? config.masterKey, `${existing.id}:${existing.credential_id}`);
      try {
        const recovered = await db.batch([
          { sql: "UPDATE provisioning_sessions SET status='failed',failed_at=?,failure_code='SUPERSEDED_BY_RECOVERY',updated_at=? WHERE device_id=? AND id<>? AND status IN ('reserved','ble_authenticated','configured','online')", params: [timestamp, timestamp, existing.id, session.id] },
          { sql: "UPDATE provisioning_sessions SET status='reserved',consumed_at=COALESCE(consumed_at,?),device_id=?,continuation_token_hash=?,failed_at=NULL,failure_code=NULL,completed_at=NULL,updated_at=? WHERE id=? AND status IN ('pending','failed') AND expires_at>?", params: [timestamp, existing.id, tokenHash(continuationToken), timestamp, session.id, timestamp] },
          { sql: "UPDATE device_credentials SET expires_at=? WHERE id=? AND device_id=? AND status='temporary' AND revoked_at IS NULL", params: [session.expires_at, existing.credential_id, existing.id] },
        ]);
        if (recovered[1]?.changes !== 1 || recovered[2]?.changes !== 1) throw new HttpError(409, 'PROVISIONING_RECOVERY_CONFLICT', 'Device recovery was claimed concurrently');
        request.log.info({ provisioning_session_id: session.id, device_id: existing.id, device_ws_url: deviceWsUrl }, 'temporary device credential recovered for provisioning retry');
        reply.header('Cache-Control', 'no-store');
        return success(reply, { provisioning_session_id: session.id, continuation_token: continuationToken, device_id: existing.id, display_name: existing.display_name ?? defaultDisplayName, device_token: encodeDeviceToken(rawDeviceToken), wss_url: deviceWsUrl, recovered: true }, 201);
      } finally { rawDeviceToken.fill(0); }
    }
    const deviceId = id('dev'); const credentialId = id('credential'); const rawDeviceToken = randomBytes(32); const continuationToken = `vcd_continue_${opaqueToken()}`; const timestamp = now();
    const claimed = await db.batch([
      { sql: "UPDATE provisioning_sessions SET status='reserved',consumed_at=?,device_id=?,continuation_token_hash=?,updated_at=? WHERE id=? AND status='pending' AND consumed_at IS NULL", params: [timestamp, deviceId, tokenHash(continuationToken), timestamp, session.id] },
      { sql: "INSERT INTO devices(id,display_name,manufacturer,sn,model,firmware_version,group_id,claim_status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'reserved',?,? WHERE EXISTS(SELECT 1 FROM provisioning_sessions WHERE id=? AND device_id=? AND consumed_at=?)", params: [deviceId, defaultDisplayName, manufacturer, sn, optionalString(body, 'model', 64), optionalString(body, 'firmware_version', 64), session.group_id, timestamp, timestamp, session.id, deviceId, timestamp] },
      { sql: "INSERT INTO device_credentials(id,device_id,credential_epoch,token_verifier,token_ciphertext,key_version,status,expires_at,created_at) SELECT ?,?,?,?,?,?,'temporary',?,? WHERE EXISTS(SELECT 1 FROM devices WHERE id=? AND claim_status='reserved')", params: [credentialId, deviceId, 1, deviceTokenVerifier(rawDeviceToken, config.groupTokenPepper), encryptSecret(rawDeviceToken, config.masterKey, `${deviceId}:${credentialId}`), config.masterKeyVersion, session.expires_at, timestamp, deviceId] },
    ]);
    if (claimed[0]?.changes !== 1 || claimed[1]?.changes !== 1 || claimed[2]?.changes !== 1) throw new HttpError(409, 'PROVISIONING_ALREADY_CLAIMED', 'Provisioning session was claimed concurrently');
    request.log.info({ provisioning_session_id: session.id, device_id: deviceId, device_ws_url: deviceWsUrl }, 'device provisioning claim issued');
    reply.header('Cache-Control', 'no-store');
    const encodedDeviceToken = encodeDeviceToken(rawDeviceToken); rawDeviceToken.fill(0);
    return success(reply, { provisioning_session_id: session.id, continuation_token: continuationToken, device_id: deviceId, display_name: defaultDisplayName, device_token: encodedDeviceToken, wss_url: deviceWsUrl, recovered: false }, 201);
  });

  app.post('/api/v1/provisioning-sessions/:id/observe', async (request, reply) => {
    const sessionId = String((request.params as Row).id); const continuationToken = requiredString(bodyOf(request), 'continuation_token');
    const session = await db.get<Row>('SELECT p.id,p.status,p.device_id,p.expires_at,p.completed_at,p.failure_code,p.allowed_origin,d.online AS device_online FROM provisioning_sessions p LEFT JOIN devices d ON d.id=p.device_id AND d.deleted_at IS NULL WHERE p.id=? AND p.continuation_token_hash=?', [sessionId, tokenHash(continuationToken)]);
    if (!session || request.headers.origin !== session.allowed_origin) throw new HttpError(404, 'PROVISIONING_SESSION_NOT_FOUND', 'Provisioning session not found');
    reply.header('Cache-Control', 'no-store'); return success(reply, { id: session.id, status: session.status, device_id: session.device_id, expires_at: session.expires_at, completed_at: session.completed_at, failure_code: session.failure_code, online: Boolean(session.device_online) });
  });

  app.post('/api/v1/provisioning-sessions/:id/progress', async (request, reply) => {
    const sessionId = String((request.params as Row).id); const body = bodyOf(request); const continuationToken = requiredString(body, 'continuation_token'); const stage = requiredString(body, 'stage', 64);
    const session = await db.get<Row>('SELECT * FROM provisioning_sessions WHERE id=? AND continuation_token_hash=?', [sessionId, tokenHash(continuationToken)]);
    if (!session || request.headers.origin !== session.allowed_origin) throw new HttpError(404, 'PROVISIONING_SESSION_NOT_FOUND', 'Provisioning session not found');
    if (stage === 'failed') {
      const failureCode = optionalString(body, 'failure_code', 128) ?? 'PROVISIONING_CLIENT_FAILED'; const timestamp = now();
      const changed = await db.run("UPDATE provisioning_sessions SET status='failed',failed_at=?,failure_code=?,updated_at=? WHERE id=? AND status IN ('reserved','ble_authenticated','configured')", [timestamp, failureCode, timestamp, sessionId]);
      if (changed.changes !== 1) throw new HttpError(409, 'PROVISIONING_STAGE_CONFLICT', 'Provisioning session is already terminal');
      return success(reply, { status: 'failed' });
    }
    const transition = stage === 'ble_authenticated' ? { from: 'reserved', to: 'ble_authenticated' } : stage === 'configured' ? { from: 'ble_authenticated', to: 'configured' } : null;
    if (!transition) throw new HttpError(400, 'INVALID_PROVISIONING_STAGE', 'Unsupported provisioning stage');
    const changed = await db.run('UPDATE provisioning_sessions SET status=?,updated_at=? WHERE id=? AND status=? AND expires_at>?', [transition.to, now(), sessionId, transition.from, now()]);
    if (changed.changes !== 1) throw new HttpError(409, 'PROVISIONING_STAGE_CONFLICT', 'Provisioning stage is stale or expired');
    return success(reply, { status: transition.to });
  });

  app.get('/api/v1/devices', async (request, reply) => { const context = await resolveAccess(request); requireScope(context, 'devices:read'); const guard = sqlGroupGuard(context); return success(reply, (await db.all<Row>(`SELECT d.* FROM devices d WHERE d.deleted_at IS NULL AND d.claim_status='active' AND ${guard.clause} ORDER BY d.created_at DESC,d.id`, guard.params)).map(mapDevice)); });
  app.get('/api/v1/devices/:id', async (request, reply) => { const context = await resolveAccess(request); requireScope(context, 'devices:read'); return success(reply, mapDevice(await requireDevice(context, String((request.params as Row).id)))); });
  app.get('/api/v1/devices/:id/status', async (request, reply) => {
    const context = await resolveAccess(request); requireScope(context, 'devices:read'); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId);
    const status = await db.get<Row>('SELECT * FROM device_status WHERE device_id=?', [deviceId]);
    return success(reply, { device: mapDevice(device), status: mapDeviceStatus(status, deviceId), refresh_available: Boolean(device.online), polling_interval_seconds: 60 });
  });
  app.post('/api/v1/devices/:id/status/refresh', async (request, reply) => {
    const context = await resolveAccess(request, true); if (context.actorType !== 'user') throw new AccessDeniedError(); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); requireGroupAdmin(context, String(device.group_id));
    if (!gateway.requestStatus(deviceId)) throw new HttpError(409, 'DEVICE_STATUS_REFRESH_UNAVAILABLE', 'The device is offline or busy with another transfer. Try again shortly.');
    await audit(request, context, 'device.status_refresh_requested', 'device', deviceId, String(device.group_id));
    return success(reply, { device_id: deviceId, accepted: true, transport: 'ws' }, 202);
  });
  app.get('/api/v1/admin/firmware-packages', async (request, reply) => {
    const context = await resolveAccess(request); requireSystemAdmin(context);
    const rows = await db.all<Row>('SELECT * FROM firmware_packages ORDER BY created_at DESC,id DESC LIMIT 200');
    return success(reply, rows.map((row) => mapLocalFirmware(row)));
  });
  app.post('/api/v1/admin/firmware-packages/upload', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const query = request.query as Row;
    const version = requiredString(query, 'version', 16); const hardwareVersion = requiredString(query, 'hardware_version', 64); const releaseNotes = optionalString(query, 'release_notes', 2_000) ?? '';
    const channel = String(query.channel ?? 'production'); if (channel !== 'production' && channel !== 'developer') throw new HttpError(400, 'INVALID_FIRMWARE_CHANNEL', 'channel must be production or developer');
    const crc16 = Number(query.crc16); const maxBleChunk = Number(query.max_ble_chunk ?? 0);
    if (!Number.isSafeInteger(crc16) || crc16 < 0 || crc16 > 65_535) throw new HttpError(400, 'INVALID_FIRMWARE_CRC16', 'crc16 must be an integer between 0 and 65535');
    if (!Number.isSafeInteger(maxBleChunk) || maxBleChunk < 0 || maxBleChunk > 1_480) throw new HttpError(400, 'INVALID_BLE_CHUNK_SIZE', 'max_ble_chunk must be an integer between 0 and 1480');
    const duplicate = await db.get<Row>('SELECT id FROM firmware_packages WHERE hardware_version=? AND release_channel=? AND version=?', [hardwareVersion, channel, version]);
    if (duplicate) throw new HttpError(409, 'FIRMWARE_VERSION_EXISTS', 'This hardware, channel, and version already exists in the local repository.');
    const body = request.body as AsyncIterable<Uint8Array> | undefined;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new HttpError(400, 'FIRMWARE_BINARY_REQUIRED', 'Send the firmware as application/octet-stream');
    const firmwareId = id('firmware'); const stored = await storeFirmwareStream(config, firmwareId, body); const timestamp = now();
    try { await db.run('INSERT INTO firmware_packages(id,version,hardware_version,release_channel,source,release_notes,package_size,checksum,crc16,max_ble_chunk,object_path,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'active\',?,?,?)', [firmwareId, version, hardwareVersion, channel, 'uploaded', releaseNotes, stored.packageSize, stored.checksum, crc16, maxBleChunk, stored.objectPath, context.actorId, timestamp, timestamp]); }
    catch (error) { await rm(resolve(config.firmwareDir, stored.objectPath), { force: true }).catch(() => undefined); throw error; }
    const row = await db.get<Row>('SELECT * FROM firmware_packages WHERE id=?', [firmwareId]); await audit(request, context, 'firmware.uploaded', 'firmware_package', firmwareId, undefined, `Uploaded ${hardwareVersion} ${channel} ${version}`);
    return success(reply, mapLocalFirmware(row!), 201);
  });
  app.post('/api/v1/admin/firmware-packages/import-official', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const body = bodyOf(request); const hardwareVersion = requiredString(body, 'hardware_version', 64);
    const channel = String(body.channel ?? 'production'); if (channel !== 'production' && channel !== 'developer') throw new HttpError(400, 'INVALID_FIRMWARE_CHANNEL', 'channel must be production or developer');
    const official = await officialFirmware(config, { hardware_version: hardwareVersion }, channel); const existing = await db.get<Row>('SELECT * FROM firmware_packages WHERE hardware_version=? AND release_channel=? AND version=?', [hardwareVersion, channel, official.version]);
    if (existing) return success(reply, { firmware: mapLocalFirmware(existing), imported: false, source_url: config.officialFirmwareSourceUrl });
    const content = await downloadOfficialFirmware(config, official); const firmwareId = id('firmware'); const stored = await storeFirmwareStream(config, firmwareId, (async function* () { yield content; })()); const timestamp = now();
    try { await db.run('INSERT INTO firmware_packages(id,version,hardware_version,release_channel,source,release_notes,package_size,checksum,crc16,max_ble_chunk,object_path,status,published_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'active\',?,?,?,?)', [firmwareId, official.version, hardwareVersion, channel, 'official', official.release_notes ?? '', stored.packageSize, stored.checksum, official.crc16, official.max_ble_chunk, stored.objectPath, official.published_at, context.actorId, timestamp, timestamp]); }
    catch (error) { await rm(resolve(config.firmwareDir, stored.objectPath), { force: true }).catch(() => undefined); throw error; }
    const row = await db.get<Row>('SELECT * FROM firmware_packages WHERE id=?', [firmwareId]); await audit(request, context, 'firmware.official_imported', 'firmware_package', firmwareId, undefined, `Imported ${hardwareVersion} ${channel} ${official.version}`);
    return success(reply, { firmware: mapLocalFirmware(row!), imported: true, source_url: config.officialFirmwareSourceUrl }, 201);
  });
  app.post('/api/v1/admin/firmware-packages/:id/archive', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const firmwareId = String((request.params as Row).id); const changed = await db.run("UPDATE firmware_packages SET status='archived',updated_at=? WHERE id=? AND status='active'", [now(), firmwareId]);
    if (changed.changes !== 1) throw new HttpError(404, 'FIRMWARE_NOT_FOUND', 'Firmware package was not found or is already archived');
    const row = await db.get<Row>('SELECT * FROM firmware_packages WHERE id=?', [firmwareId]); await audit(request, context, 'firmware.archived', 'firmware_package', firmwareId, undefined, 'Archived local firmware package'); return success(reply, mapLocalFirmware(row!));
  });
  app.get('/api/v1/devices/:id/firmware/latest', async (request, reply) => {
    const context = await resolveAccess(request); requireScope(context, 'devices:read'); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId);
    const channel = String((request.query as Row).channel ?? 'production'); if (channel !== 'production' && channel !== 'developer') throw new HttpError(400, 'INVALID_FIRMWARE_CHANNEL', 'channel must be production or developer');
    const hardwareVersion = String(device.hardware_version ?? '').trim(); if (!hardwareVersion) throw new HttpError(409, 'DEVICE_HARDWARE_VERSION_UNKNOWN', 'Refresh the online device status before checking firmware.');
    const firmware = await latestLocalFirmware(db, hardwareVersion, channel, device.firmware_version);
    reply.header('cache-control', 'private, max-age=30'); return success(reply, { device: mapDevice(device), firmware, repository: 'local' });
  });
  app.get('/api/v1/devices/:id/firmware/package', async (request, reply) => {
    const context = await resolveAccess(request); requireSystemAdmin(context); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId);
    const channel = String((request.query as Row).channel ?? 'production'); if (channel !== 'production' && channel !== 'developer') throw new HttpError(400, 'INVALID_FIRMWARE_CHANNEL', 'channel must be production or developer');
    const hardwareVersion = String(device.hardware_version ?? '').trim(); if (!hardwareVersion) throw new HttpError(409, 'DEVICE_HARDWARE_VERSION_UNKNOWN', 'Refresh the online device status before checking firmware.');
    const firmware = await latestLocalFirmware(db, hardwareVersion, channel, device.firmware_version); const content = await readLocalFirmware(config, firmware);
    reply.header('cache-control', 'private, no-store'); reply.header('content-type', 'application/octet-stream'); reply.header('content-disposition', 'attachment; filename="voicecan-firmware.bin"');
    reply.header('x-voicecan-firmware-version', firmware.version); reply.header('x-voicecan-firmware-size', String(firmware.package_size)); reply.header('x-voicecan-firmware-crc16', String(firmware.crc16)); reply.header('x-voicecan-firmware-max-ble-chunk', String(firmware.max_ble_chunk)); reply.header('x-voicecan-firmware-channel', firmware.release_channel); reply.header('x-voicecan-firmware-sha256', firmware.checksum.replace(/^sha256:/i, ''));
    return reply.send(Buffer.from(content));
  });
  app.post('/api/v1/devices/:id/ota', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); const body = bodyOf(request); const reason = requiredString(body, 'reason', 256);
    if (!device.online) throw new HttpError(409, 'DEVICE_OFFLINE', 'The device must be online for a server OTA update.');
    const channel = String(body.channel ?? 'production'); if (channel !== 'production' && channel !== 'developer') throw new HttpError(400, 'INVALID_FIRMWARE_CHANNEL', 'channel must be production or developer');
    const hardwareVersion = String(device.hardware_version ?? '').trim(); if (!hardwareVersion) throw new HttpError(409, 'DEVICE_HARDWARE_VERSION_UNKNOWN', 'Refresh the online device status before checking firmware.');
    const force = body.force === true; const firmware = await latestLocalFirmware(db, hardwareVersion, channel, device.firmware_version); if (firmware.up_to_date && !force) throw new HttpError(409, 'FIRMWARE_ALREADY_CURRENT', 'The device already has the latest firmware in this channel.');
    const content = await readLocalFirmware(config, firmware); const idempotencyKey = String(request.headers['idempotency-key'] ?? ''); if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    const commandId = id('cmd'); const kind = 'device.ota'; const callerScope = `user:${context.actorId}:device-ota`; const payload = { firmware_id: firmware.id, version: firmware.version, hw_version: firmware.hw_version, release_channel: firmware.release_channel, package_size: firmware.package_size, checksum: firmware.checksum, crc16: firmware.crc16, force }; const requestHash = createHash('sha256').update(JSON.stringify({ deviceId, payload })).digest('hex'); const timestamp = now();
    try { await db.run('INSERT INTO commands(id,device_id,kind,status,idempotency_key,caller_scope,request_hash,payload_json,deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [commandId, deviceId, kind, 'queued', idempotencyKey, callerScope, requestHash, JSON.stringify(payload), plus(20 * 60_000), timestamp, timestamp]); }
    catch (error) { const existing = await db.get<Row>('SELECT * FROM commands WHERE caller_scope=? AND kind=? AND idempotency_key=?', [callerScope, kind, idempotencyKey]); if (!existing) throw error; if (existing.request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different OTA request'); return success(reply, mapPublicCommand(existing)); }
    const dispatched = await gateway.dispatchOta(deviceId, commandId, { version: firmware.version, size: firmware.package_size, crc16: firmware.crc16, content, force }); const command = await db.get<Row>('SELECT * FROM commands WHERE id=?', [commandId]); await audit(request, context, 'device.ota_requested', 'command', commandId, String(device.group_id), reason);
    return success(reply, { ...mapPublicCommand(command!), transport: dispatched ? 'ws' : 'unavailable', firmware }, 202);
  });
  app.post('/api/v1/devices/:id/ble-maintenance-session', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId);
    const credential = await db.get<Row>('SELECT id,token_ciphertext,key_version FROM device_credentials WHERE device_id=? AND credential_epoch=? AND status=\'active\' AND revoked_at IS NULL', [deviceId, device.credential_epoch]);
    if (!credential) throw new HttpError(409, 'DEVICE_CREDENTIAL_UNAVAILABLE', 'The active device credential cannot be used for BLE maintenance.');
    const key = config.masterKeys.get(Number(credential.key_version)); if (!key) throw new HttpError(503, 'DEVICE_CREDENTIAL_KEY_UNAVAILABLE', 'The credential encryption key is not available.');
    const plaintext = decryptSecret(String(credential.token_ciphertext), key, `${deviceId}:${String(credential.id)}`);
    try {
      const settings = await db.get<{ ble_name_prefix: string }>('SELECT ble_name_prefix FROM server_settings WHERE singleton=1');
      reply.header('cache-control', 'private, no-store'); await audit(request, context, 'device.ble_maintenance_started', 'device', deviceId, String(device.group_id), 'Short-lived browser memory handoff');
      return success(reply, { device_id: deviceId, serial_number: String(device.sn), device_token: encodeDeviceToken(plaintext), ble_name_prefix: settings?.ble_name_prefix ?? 'CAPSO-' });
    } finally { plaintext.fill(0); }
  });
  app.post('/api/v1/devices/:id/ble-status', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); const body = bodyOf(request);
    if (requiredString(body, 'serial_number', 128) !== String(device.sn)) throw new HttpError(409, 'BLE_DEVICE_MISMATCH', 'The selected Bluetooth device does not match this server device.');
    const value = body.status; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_DEVICE_STATUS', 'status must be a device status object');
    const info = body.info && typeof body.info === 'object' && !Array.isArray(body.info) ? body.info as Row : undefined;
    if (info && String(info.serialNumber ?? '') !== String(device.sn)) throw new HttpError(409, 'BLE_DEVICE_MISMATCH', 'The reported Bluetooth device information does not match this server device.');
    const status = value as Row; const operational = status.operational && typeof status.operational === 'object' && !Array.isArray(status.operational) ? status.operational as Row : {}; const storageStatus = status.storage && typeof status.storage === 'object' && !Array.isArray(status.storage) ? status.storage as Row : {}; const battery = status.battery && typeof status.battery === 'object' && !Array.isArray(status.battery) ? status.battery as Row : {}; const timestamp = now();
    const values = [
      deviceId,
      optionalInteger(operational.recordState, 0, 2, 'operational.recordState'), optionalInteger(operational.recordMode, 0, 255, 'operational.recordMode'), optionalInteger(operational.microphoneMode, 0, 2, 'operational.microphoneMode'), optionalInteger(operational.microphoneGainDb, -128, 127, 'operational.microphoneGainDb'),
      optionalInteger(operational.usbState, 0, 2, 'operational.usbState'), optionalInteger(operational.wifiState, 0, 1, 'operational.wifiState'), optionalInteger(operational.wifiMode, 0, 2, 'operational.wifiMode'), optionalInteger(operational.relayState, 0, 2, 'operational.relayState'), operational.privacyMode === undefined ? null : Number(Boolean(operational.privacyMode)), operational.earphoneRecording === undefined ? null : Number(Boolean(operational.earphoneRecording)),
      optionalInteger(storageStatus.totalKilobytes, 0, Number.MAX_SAFE_INTEGER, 'storage.totalKilobytes'), optionalInteger(storageStatus.freeKilobytes, 0, Number.MAX_SAFE_INTEGER, 'storage.freeKilobytes'), optionalInteger(storageStatus.recordingHours, 0, Number.MAX_SAFE_INTEGER, 'storage.recordingHours'),
      typeof battery.state === 'string' ? battery.state.slice(0, 32) : null, optionalInteger(battery.stateCode, 0, 255, 'battery.stateCode'), optionalInteger(battery.percent ?? status.batteryPercent, 0, 100, 'battery.percent'), optionalInteger(battery.temperatureC, -128, 255, 'battery.temperatureC'), optionalInteger(battery.voltageMillivolts, 0, 65_535, 'battery.voltageMillivolts'), optionalInteger(battery.workTimeSeconds, 0, Number.MAX_SAFE_INTEGER, 'battery.workTimeSeconds'), optionalInteger(battery.accumulatedWorkTimeSeconds, 0, Number.MAX_SAFE_INTEGER, 'battery.accumulatedWorkTimeSeconds'), timestamp, timestamp, timestamp, timestamp,
    ];
    await db.run(`INSERT INTO device_status(device_id,source,record_state,record_mode,microphone_mode,microphone_gain_db,usb_state,wifi_state,wifi_mode,relay_state,privacy_mode,earphone_recording,storage_total_kb,storage_free_kb,recording_hours,battery_state,battery_state_code,battery_percent,battery_temperature_c,battery_voltage_mv,work_time_seconds,accumulated_work_time_seconds,status_updated_at,storage_updated_at,battery_updated_at,updated_at) VALUES(?,'ble',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET source='ble',record_state=excluded.record_state,record_mode=excluded.record_mode,microphone_mode=excluded.microphone_mode,microphone_gain_db=excluded.microphone_gain_db,usb_state=excluded.usb_state,wifi_state=excluded.wifi_state,wifi_mode=excluded.wifi_mode,relay_state=excluded.relay_state,privacy_mode=excluded.privacy_mode,earphone_recording=excluded.earphone_recording,storage_total_kb=excluded.storage_total_kb,storage_free_kb=excluded.storage_free_kb,recording_hours=excluded.recording_hours,battery_state=excluded.battery_state,battery_state_code=excluded.battery_state_code,battery_percent=excluded.battery_percent,battery_temperature_c=excluded.battery_temperature_c,battery_voltage_mv=excluded.battery_voltage_mv,work_time_seconds=excluded.work_time_seconds,accumulated_work_time_seconds=excluded.accumulated_work_time_seconds,status_updated_at=excluded.status_updated_at,storage_updated_at=excluded.storage_updated_at,battery_updated_at=excluded.battery_updated_at,updated_at=excluded.updated_at`, values);
    if (info) await db.run('UPDATE devices SET manufacturer=?,model=?,hardware_version=?,firmware_version=?,updated_at=? WHERE id=? AND deleted_at IS NULL', [requiredString(info, 'manufacturer', 64), requiredString(info, 'model', 64), requiredString(info, 'hardwareVersion', 64), requiredString(info, 'firmwareVersion', 64), timestamp, deviceId]);
    await audit(request, context, 'device.ble_status_reported', 'device', deviceId, String(device.group_id));
    return success(reply, { device_id: deviceId, source: 'ble', updated_at: timestamp });
  });
  app.post('/api/v1/devices/:id/control', async (request, reply) => {
    const context = await resolveAccess(request, true); if (context.actorType !== 'user') throw new AccessDeniedError(); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); requireGroupAdmin(context, String(device.group_id)); const body = bodyOf(request); const reason = requiredString(body, 'reason', 256);
    if (!device.online) throw new HttpError(409, 'DEVICE_CONNECTION_REQUIRED', 'Connect the device through WebSocket or use a local BLE maintenance connection before sending controls.');
    const parsed = parseDeviceControl(body.control); if (!parsed) throw new HttpError(400, 'INVALID_DEVICE_CONTROL', 'control is not a supported semantic device operation'); const control = parsed as DeviceControl;
    if (control.kind === 'power' || control.kind === 'factory_reset') requireSystemAdmin(context);
    const idempotencyKey = String(request.headers['idempotency-key'] ?? ''); if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    const commandId = id('cmd'); const kind = `device.${control.kind}`; const callerScope = `user:${context.actorId}:device-control`; const requestHash = createHash('sha256').update(JSON.stringify({ deviceId, control })).digest('hex'); const timestamp = now();
    try { await db.run('INSERT INTO commands(id,device_id,kind,status,idempotency_key,caller_scope,request_hash,payload_json,deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [commandId, deviceId, kind, 'queued', idempotencyKey, callerScope, requestHash, JSON.stringify(control), plus(2 * 60_000), timestamp, timestamp]); }
    catch (error) { const existing = await db.get<Row>('SELECT * FROM commands WHERE caller_scope=? AND kind=? AND idempotency_key=?', [callerScope, kind, idempotencyKey]); if (!existing) throw error; if (existing.request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different device operation'); return success(reply, mapPublicCommand(existing)); }
    const dispatched = await gateway.dispatchControl(deviceId, commandId, control);
    if (!dispatched) { const failedAt = now(); await db.run("UPDATE commands SET status='failed',error_code='DEVICE_DISCONNECTED',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='queued'", [failedAt, failedAt, commandId]); throw new HttpError(409, 'DEVICE_CONTROL_UNAVAILABLE', 'The WebSocket connection ended before the control could be sent. Reconnect the device and try again.'); }
    const command = await db.get<Row>('SELECT * FROM commands WHERE id=?', [commandId]); await audit(request, context, 'device.control_requested', 'command', commandId, String(device.group_id), reason);
    return success(reply, { ...mapPublicCommand(command!), transport: 'ws' }, 202);
  });
  app.patch('/api/v1/devices/:id', async (request, reply) => {
    const context = await resolveAccess(request, true); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); requireGroupAdmin(context, String(device.group_id));
    const body = bodyOf(request); const rawName = body.display_name; if (rawName !== null && rawName !== undefined && typeof rawName !== 'string') throw new HttpError(400, 'INVALID_DEVICE_NAME', 'display_name must be a string or null');
    const displayName = typeof rawName === 'string' ? rawName.trim() : null; if (displayName && displayName.length > 80) throw new HttpError(400, 'INVALID_DEVICE_NAME', 'display_name must not exceed 80 characters');
    const timestamp = now(); await db.run('UPDATE devices SET display_name=?,updated_at=? WHERE id=? AND deleted_at IS NULL', [displayName || null, timestamp, deviceId]);
    await audit(request, context, 'device.updated', 'device', deviceId, String(device.group_id), optionalString(body, 'reason', 256) ?? 'Updated device display name');
    return success(reply, mapDevice((await db.get<Row>('SELECT * FROM devices WHERE id=?', [deviceId]))!));
  });
  app.post('/api/v1/devices/:id/transfer-out-sessions', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const body = bodyOf(request); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId);
    const transferCheckAt = now(); const active = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM recording_files f WHERE f.device_id=? AND (f.status='syncing' OR EXISTS(SELECT 1 FROM upload_tickets u WHERE u.file_id=f.id AND u.consumed_at IS NULL AND u.failed_at IS NULL AND u.expires_at>?) OR EXISTS(SELECT 1 FROM s3_upload_attempts s WHERE s.file_id=f.id AND s.completed_at IS NULL AND s.failed_at IS NULL AND s.expires_at>?))", [deviceId, transferCheckAt, transferCheckAt]);
    if (Number(active?.count ?? 0) > 0) throw new HttpError(409, 'DEVICE_TRANSFER_ACTIVE', 'Wait for active file transfers before releasing the device');
    const transferId = id('transfer_out'); const grant = `${transferId}.${opaqueToken()}`; const timestamp = now(); const expiresAt = plus(5 * 60_000); const reason = requiredString(body, 'reason', 256); const allowedOrigin = validatedOrigin(requiredString(body, 'allowed_origin', 300), config.deploymentProfile === 'intranet');
    await db.batch([
      { sql: "UPDATE transfer_out_sessions SET status='failed',failed_at=?,failure_code='SUPERSEDED',updated_at=? WHERE device_id=? AND status IN ('pending','claimed')", params: [timestamp, timestamp, deviceId] },
      { sql: "INSERT INTO transfer_out_sessions(id,device_id,grant_token_hash,allowed_origin,ownership_epoch,credential_epoch,status,expires_at,created_by,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?)", params: [transferId, deviceId, tokenHash(grant), allowedOrigin, device.ownership_epoch, device.credential_epoch, expiresAt, context.actorId, reason, timestamp, timestamp], expectChanges: 1 },
    ]);
    await audit(request, context, 'device.transfer_out_created', 'transfer_out_session', transferId, String(device.group_id), reason); reply.header('Cache-Control', 'no-store');
    return success(reply, { id: transferId, transfer_token: grant, expires_at: expiresAt, device: mapDevice(device) }, 201);
  });
  app.post('/api/v1/transfer-out-sessions/:id/claim', async (request, reply) => {
    const transferId = String((request.params as Row).id); const body = bodyOf(request); const grant = requiredString(body, 'transfer_token'); const publicJwk = body.public_key_jwk;
    if (!publicJwk || typeof publicJwk !== 'object' || Array.isArray(publicJwk)) throw new HttpError(400, 'INVALID_TRANSFER_PUBLIC_KEY', 'An ephemeral RSA public JWK is required');
    let key; try { key = createPublicKey({ key: publicJwk as NodeJsonWebKey, format: 'jwk' }); } catch { throw new HttpError(400, 'INVALID_TRANSFER_PUBLIC_KEY', 'The transfer public key is invalid'); }
    if (key.asymmetricKeyType !== 'rsa' || Number(key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new HttpError(400, 'INVALID_TRANSFER_PUBLIC_KEY', 'RSA-OAEP requires a key of at least 2048 bits');
    const transfer = await db.get<Row>(`SELECT t.*,d.manufacturer,d.sn,d.model,d.firmware_version,d.group_id,d.deleted_at,c.id AS credential_id,c.token_ciphertext,c.key_version,c.revoked_at
      FROM transfer_out_sessions t JOIN devices d ON d.id=t.device_id
      JOIN device_credentials c ON c.device_id=d.id AND c.credential_epoch=t.credential_epoch
      WHERE t.id=? AND t.grant_token_hash=? AND t.status='pending' AND t.expires_at>?`, [transferId, tokenHash(grant), now()]);
    if (!transfer || transfer.deleted_at || transfer.revoked_at || request.headers.origin !== transfer.allowed_origin) throw new HttpError(404, 'TRANSFER_OUT_SESSION_NOT_FOUND', 'Transfer-out session not found');
    const rawToken = decryptSecret(String(transfer.token_ciphertext), config.masterKeys.get(Number(transfer.key_version)) ?? config.masterKey, `${transfer.device_id}:${transfer.credential_id}`); const continuation = `vcd_transfer_continue_${opaqueToken()}`;
    try {
      const sealed = publicEncrypt({ key, oaepHash: 'sha256', padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING }, rawToken);
      const claimed = await db.run("UPDATE transfer_out_sessions SET status='claimed',continuation_token_hash=?,consumed_at=?,updated_at=? WHERE id=? AND status='pending' AND expires_at>?", [tokenHash(continuation), now(), now(), transferId, now()]);
      if (claimed.changes !== 1) throw new HttpError(409, 'TRANSFER_OUT_ALREADY_CLAIMED', 'Transfer-out session was claimed concurrently');
      await db.run('INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,group_id,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [id('audit'), transfer.created_by, 'device.transfer_out_claimed', 'transfer_out_session', transferId, transfer.group_id, request.id, 'success', transfer.reason, now()]);
      reply.header('Cache-Control', 'no-store'); return success(reply, { id: transferId, device_id: transfer.device_id, manufacturer: transfer.manufacturer, serial_number: transfer.sn, model: transfer.model, firmware_version: transfer.firmware_version, continuation_token: continuation, sealed_device_token: sealed.toString('base64'), algorithm: 'RSA-OAEP-256' });
    } finally { rawToken.fill(0); }
  });
  app.post('/api/v1/transfer-out-sessions/:id/complete', async (request, reply) => {
    const transferId = String((request.params as Row).id); const body = bodyOf(request); const continuation = requiredString(body, 'continuation_token'); const result = requiredString(body, 'result', 32);
    const transfer = await db.get<Row>('SELECT t.*,d.* FROM transfer_out_sessions t JOIN devices d ON d.id=t.device_id WHERE t.id=? AND t.continuation_token_hash=? AND t.status=\'claimed\' AND t.expires_at>?', [transferId, tokenHash(continuation), now()]);
    if (!transfer || request.headers.origin !== transfer.allowed_origin) throw new HttpError(404, 'TRANSFER_OUT_SESSION_NOT_FOUND', 'Transfer-out session not found');
    if (requiredString(body, 'serial_number', 128) !== transfer.sn) throw new HttpError(409, 'TRANSFER_OUT_DEVICE_MISMATCH', 'The nearby device does not match this transfer session');
    const timestamp = now();
    if (result !== 'ack') {
      const failureCode = optionalString(body, 'failure_code', 128) ?? 'DEVICE_UNBIND_NOT_CONFIRMED';
      const failed = await db.batch([
        { sql: "UPDATE transfer_out_sessions SET status='failed',failed_at=?,failure_code=?,updated_at=? WHERE id=? AND status='claimed'", params: [timestamp, failureCode, timestamp, transferId], expectChanges: 1 },
        { sql: 'INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,group_id,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', params: [id('audit'), transfer.created_by, 'device.transfer_out_failed', 'transfer_out_session', transferId, transfer.group_id, request.id, 'failure', failureCode, timestamp] },
      ]);
      if (failed[0]?.changes !== 1) throw new HttpError(409, 'TRANSFER_OUT_STATE_CONFLICT', 'Transfer-out session is already terminal');
      return success(reply, { status: 'failed', device_released: false });
    }
    const transferCheckAt = now(); const active = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM recording_files f WHERE f.device_id=? AND (f.status='syncing' OR EXISTS(SELECT 1 FROM upload_tickets u WHERE u.file_id=f.id AND u.consumed_at IS NULL AND u.failed_at IS NULL AND u.expires_at>?) OR EXISTS(SELECT 1 FROM s3_upload_attempts s WHERE s.file_id=f.id AND s.completed_at IS NULL AND s.failed_at IS NULL AND s.expires_at>?))", [transfer.device_id, transferCheckAt, transferCheckAt]);
    if (Number(active?.count ?? 0) > 0) throw new HttpError(409, 'DEVICE_TRANSFER_ACTIVE', 'A file transfer started while the device was being released');
    const prepared = await prepareEvent(transfer, 'device.released', { device_id: transfer.device_id, recordings_erased: false }); const activeCommands = await db.all<Row>("SELECT * FROM commands WHERE device_id=? AND status IN ('queued','dispatched','running')", [transfer.device_id]); const commandEvents = await Promise.all(activeCommands.map((command) => prepareEvent(transfer, 'command.failed', { command: mapPublicCommand({ ...command, status: 'failed', error_code: 'DEVICE_RELEASED', completed_at: timestamp, resource_version: Number(command.resource_version ?? 1) + 1 }) }))); const tombstoneSn = `${transfer.sn}#released#${String(transfer.device_id).slice(-8)}`;
    try {
      await db.batch([
        { sql: "UPDATE transfer_out_sessions SET status='completed',completed_at=?,updated_at=? WHERE id=? AND status='claimed' AND ownership_epoch=? AND credential_epoch=?", params: [timestamp, timestamp, transferId, transfer.ownership_epoch, transfer.credential_epoch], expectChanges: 1 },
        { sql: 'UPDATE device_credentials SET revoked_at=? WHERE device_id=? AND credential_epoch=? AND revoked_at IS NULL', params: [timestamp, transfer.device_id, transfer.credential_epoch], expectChanges: 1 },
        { sql: "UPDATE commands SET status='failed',error_code='DEVICE_RELEASED',completed_at=?,resource_version=resource_version+1,updated_at=? WHERE device_id=? AND status IN ('queued','dispatched','running')", params: [timestamp, timestamp, transfer.device_id] },
        { sql: "UPDATE event_deliveries SET status='canceled',last_error='DEVICE_RELEASED',claimed_by=NULL,claim_expires_at=NULL WHERE status='pending' AND event_id IN (SELECT id FROM events WHERE device_id=?)", params: [transfer.device_id] },
        { sql: 'UPDATE devices SET sn=?,online=0,connection_epoch=connection_epoch+1,deleted_at=?,updated_at=? WHERE id=? AND ownership_epoch=? AND credential_epoch=? AND deleted_at IS NULL', params: [tombstoneSn, timestamp, timestamp, transfer.device_id, transfer.ownership_epoch, transfer.credential_epoch], expectChanges: 1 },
        ...prepared.statements,
        ...commandEvents.flatMap((event) => event.statements),
        { sql: 'INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,group_id,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', params: [id('audit'), transfer.created_by, 'device.released', 'device', transfer.device_id, transfer.group_id, request.id, 'success', transfer.reason, timestamp] },
      ]);
    } catch (error) { if (error instanceof Error && error.message.startsWith('DATABASE_CAS_FAILED')) throw new HttpError(409, 'TRANSFER_OUT_STATE_CONFLICT', 'Device ownership or credential changed while release was committing'); throw error; }
    gateway.replace(String(transfer.device_id)); void dispatcher.drain(); reply.header('Cache-Control', 'no-store'); return success(reply, { status: 'completed', device_released: true, recordings_erased: false });
  });
  app.post('/api/v1/devices/:id/sync', async (request, reply) => {
    const context = await resolveAccess(request, true); const deviceId = String((request.params as Row).id); const key = String(request.headers['idempotency-key'] ?? ''); const result = await openPlatformService.syncDevice(context, deviceId, key); await audit(request, context, 'device.sync_requested', 'command', String(result.id)); return success(reply, result, 202);
  });
  app.get('/api/v1/devices/:id/recording-sync', async (request, reply) => {
    const context = await resolveAccess(request); requireScope(context, 'devices:read'); requireScope(context, 'recordings:read');
    const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId);
    const [summary, files, command] = await Promise.all([
      db.get<Row>(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='syncing' THEN 1 ELSE 0 END) AS syncing,
        SUM(CASE WHEN status='synced' THEN 1 ELSE 0 END) AS synced,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='identity_conflict' THEN 1 ELSE 0 END) AS identity_conflict,
        COALESCE(SUM(expected_size),0) AS discovered_bytes,
        COALESCE(SUM(CASE WHEN status='synced' THEN actual_size ELSE 0 END),0) AS synced_bytes,
        MIN(CASE WHEN status IN ('pending','syncing') THEN updated_at END) AS oldest_incomplete_at,
        MAX(synced_at) AS last_synced_at
        FROM recording_files WHERE device_id=? AND deletion_status='active'`, [deviceId]),
      db.all<Row>("SELECT * FROM recording_files WHERE device_id=? AND deletion_status='active' ORDER BY created_at DESC,id DESC LIMIT 100", [deviceId]),
      db.get<Row>('SELECT * FROM commands WHERE device_id=? AND kind=\'sync\' ORDER BY created_at DESC,id DESC LIMIT 1', [deviceId]),
    ]);
    return success(reply, {
      device: { ...mapDevice(device), connection_epoch: Number(device.connection_epoch ?? 0), claim_status: String(device.claim_status), connection_status: Boolean(device.online) ? 'online' : 'offline' },
      summary: { total: Number(summary?.total ?? 0), pending: Number(summary?.pending ?? 0), syncing: Number(summary?.syncing ?? 0), synced: Number(summary?.synced ?? 0), failed: Number(summary?.failed ?? 0), identity_conflict: Number(summary?.identity_conflict ?? 0), discovered_bytes: Number(summary?.discovered_bytes ?? 0), synced_bytes: Number(summary?.synced_bytes ?? 0), oldest_incomplete_at: summary?.oldest_incomplete_at ?? null, last_synced_at: summary?.last_synced_at ?? null },
      files: files.map(mapFile), latest_command: command ? mapPublicCommand(command) : null,
      reset_policy: { deletes_recordings: false, default_scope: 'failed', stale_after_seconds: 1_200 },
    });
  });
  app.post('/api/v1/recordings/:id/retry', async (request, reply) => {
    const context = await resolveAccess(request, true); requireScope(context, 'devices:sync'); const body = bodyOf(request); const reason = requiredString(body, 'reason', 256); const fileId = String((request.params as Row).id);
    const guard = sqlGroupGuard(context); const file = await db.get<Row>(`SELECT f.*,d.group_id,d.ownership_epoch,d.online FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.deletion_status='active' AND ${guard.clause}`, [fileId, ...guard.params]);
    if (!file) throw new AccessDeniedError();
    if (file.status !== 'failed') throw new HttpError(409, 'RECORDING_NOT_RETRYABLE', 'Only failed recording synchronization can be retried directly');
    const timestamp = now(); const s3Attempts = await db.all<{ staging_key: string }>('SELECT staging_key FROM s3_upload_attempts WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL', [fileId]);
    await db.batch([
      { sql: "UPDATE upload_tickets SET failed_at=?,failure_code='MANUAL_RETRY' WHERE file_id=? AND consumed_at IS NULL AND failed_at IS NULL", params: [timestamp, fileId] },
      { sql: "UPDATE s3_upload_attempts SET failed_at=?,failure_code='MANUAL_RETRY' WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL", params: [timestamp, fileId] },
      { sql: "UPDATE recording_files SET status='pending',transport=NULL,error_code=NULL,resource_version=resource_version+1,updated_at=? WHERE id=? AND status='failed'", params: [timestamp, fileId], expectChanges: 1 },
    ]);
    await storage.resetRelay(fileId); for (const attempt of s3Attempts) await s3Storage?.deleteStaging(attempt.staging_key).catch(() => undefined);
    const command = await openPlatformService.syncDevice(context, String(file.device_id), `recording-retry:${fileId}:${randomUUID()}`);
    await audit(request, context, 'recording.sync_retried', 'recording_file', fileId, String(file.group_id), reason);
    return success(reply, { file_id: fileId, status: 'pending', device_online: Boolean(file.online), command }, 202);
  });
  app.post('/api/v1/devices/:id/recording-sync/reset', async (request, reply) => {
    const context = await resolveAccess(request, true); requireScope(context, 'devices:sync'); const body = bodyOf(request); const reason = requiredString(body, 'reason', 256); const mode = String(body.mode ?? 'failed');
    if (!['failed', 'failed_and_stale'].includes(mode)) throw new HttpError(400, 'INVALID_RESET_MODE', 'mode must be failed or failed_and_stale');
    const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); const staleBefore = new Date(Date.now() - 20 * 60_000).toISOString();
    const allowStaleReset = mode === 'failed_and_stale' && !gateway.hasActiveTransfer(deviceId);
    const files = await db.all<Row>(`SELECT * FROM recording_files WHERE device_id=? AND deletion_status='active' AND (status='failed'${allowStaleReset ? " OR (status='syncing' AND (updated_at<? OR ?=0))" : ''}) ORDER BY created_at`, allowStaleReset ? [deviceId, staleBefore, Number(device.online)] : [deviceId]);
    const timestamp = now();
    for (const file of files) {
      const fileId = String(file.id); const s3Attempts = await db.all<{ staging_key: string }>('SELECT staging_key FROM s3_upload_attempts WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL', [fileId]);
      await db.batch([
        { sql: "UPDATE upload_tickets SET failed_at=?,failure_code='SYNC_RESET' WHERE file_id=? AND consumed_at IS NULL AND failed_at IS NULL", params: [timestamp, fileId] },
        { sql: "UPDATE s3_upload_attempts SET failed_at=?,failure_code='SYNC_RESET' WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL", params: [timestamp, fileId] },
        { sql: "UPDATE recording_files SET status='pending',transport=NULL,error_code=NULL,resource_version=resource_version+1,updated_at=? WHERE id=? AND status IN ('failed','syncing')", params: [timestamp, fileId] },
      ]);
      await storage.resetRelay(fileId); for (const attempt of s3Attempts) await s3Storage?.deleteStaging(attempt.staging_key).catch(() => undefined);
    }
    const command = await openPlatformService.syncDevice(context, deviceId, `recording-reset:${deviceId}:${randomUUID()}`);
    await audit(request, context, 'device.recording_sync_reset', 'device', deviceId, String(device.group_id), reason);
    return success(reply, { device_id: deviceId, mode, reset_count: files.length, recordings_deleted: false, device_online: Boolean(device.online), command }, 202);
  });
  app.post('/api/v1/devices/:id/commands', async (request, reply) => {
    const context = await resolveAccess(request, true); const deviceId = String((request.params as Row).id); const kind = requiredString(bodyOf(request), 'kind', 64);
    if (kind !== 'sync') throw new HttpError(400, 'COMMAND_NOT_ALLOWED', 'Only the reviewed sync command is public; raw and destructive commands are not accepted');
    const key = String(request.headers['idempotency-key'] ?? ''); const result = await openPlatformService.syncDevice(context, deviceId, key); await audit(request, context, 'device.command_requested', 'command', String(result.id)); return success(reply, result, 202);
  });
  app.get('/api/v1/commands/:id', async (request, reply) => {
    const context = await resolveAccess(request); return success(reply, await openPlatformService.getCommand(context, String((request.params as Row).id)));
  });
  app.post('/api/v1/devices/:id/transfer-preview', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); const target = requiredString(bodyOf(request), 'target_group_id', 80); const targetGroup = await db.get('SELECT id FROM user_groups WHERE id=? AND status=\'active\'', [target]); if (!targetGroup) throw new HttpError(409, 'TARGET_GROUP_UNAVAILABLE', 'Target group is missing or archived'); const transferCheckAt = now(); const stats = await db.get<Row>("SELECT COUNT(*) AS file_count,COALESCE(SUM(COALESCE(f.actual_size,f.expected_size)),0) AS total_bytes,SUM(CASE WHEN f.status='syncing' OR EXISTS(SELECT 1 FROM upload_tickets u WHERE u.file_id=f.id AND u.consumed_at IS NULL AND u.failed_at IS NULL AND u.expires_at>?) OR EXISTS(SELECT 1 FROM s3_upload_attempts s WHERE s.file_id=f.id AND s.completed_at IS NULL AND s.failed_at IS NULL AND s.expires_at>?) THEN 1 ELSE 0 END) AS active_transfers FROM recording_files f WHERE f.device_id=?", [transferCheckAt, transferCheckAt, deviceId]); const pending = await db.get<Row>("SELECT COUNT(*) AS pending_events FROM event_deliveries ed JOIN events e ON e.id=ed.event_id WHERE e.device_id=? AND ed.status='pending'", [deviceId]); const version = `${device.ownership_epoch}:${stats?.file_count}:${stats?.total_bytes}:${stats?.active_transfers}:${pending?.pending_events}`; const confirmation = tokenHash(`${deviceId}:${target}:${version}`, config.masterKey);
    return success(reply, { device_id: deviceId, source_group_id: device.group_id, target_group_id: target, resource_version: version, confirmation_token: confirmation, ...stats, ...pending, signed_url_residual_seconds: 0 });
  });
  app.put('/api/v1/devices/:id/group', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const body = bodyOf(request); const deviceId = String((request.params as Row).id); const device = await requireDevice(context, deviceId); const target = requiredString(body, 'target_group_id', 80); const targetGroup = await db.get('SELECT id FROM user_groups WHERE id=? AND status=\'active\'', [target]); if (!targetGroup) throw new HttpError(409, 'TARGET_GROUP_UNAVAILABLE', 'Target group is missing or archived'); const version = requiredString(body, 'resource_version', 200); const confirmation = requiredString(body, 'confirmation_token', 200); const transferCheckAt = now(); const stats = await db.get<Row>("SELECT COUNT(*) AS file_count,COALESCE(SUM(COALESCE(f.actual_size,f.expected_size)),0) AS total_bytes,SUM(CASE WHEN f.status='syncing' OR EXISTS(SELECT 1 FROM upload_tickets u WHERE u.file_id=f.id AND u.consumed_at IS NULL AND u.failed_at IS NULL AND u.expires_at>?) OR EXISTS(SELECT 1 FROM s3_upload_attempts s WHERE s.file_id=f.id AND s.completed_at IS NULL AND s.failed_at IS NULL AND s.expires_at>?) THEN 1 ELSE 0 END) AS active_transfers FROM recording_files f WHERE f.device_id=?", [transferCheckAt, transferCheckAt, deviceId]); const pending = await db.get<Row>("SELECT COUNT(*) AS pending_events FROM event_deliveries ed JOIN events e ON e.id=ed.event_id WHERE e.device_id=? AND ed.status='pending'", [deviceId]); const current = `${device.ownership_epoch}:${stats?.file_count}:${stats?.total_bytes}:${stats?.active_transfers}:${pending?.pending_events}`; const expected = tokenHash(`${deviceId}:${target}:${current}`, config.masterKey); if (version !== current || !constantTimeHexEqual(confirmation, expected)) throw new HttpError(409, 'TRANSFER_PREVIEW_STALE', 'Transfer preview is stale'); if (Number(stats?.active_transfers ?? 0) > 0) throw new HttpError(409, 'DEVICE_TRANSFER_ACTIVE', 'Wait for active file transfers to finish before moving the device');
    try { await db.batch([{ sql: 'UPDATE devices SET group_id=?,ownership_epoch=ownership_epoch+1,updated_at=? WHERE id=? AND ownership_epoch=?', params: [target, now(), deviceId, device.ownership_epoch], expectChanges: 1 }, { sql: "UPDATE event_deliveries SET status='canceled',last_error='DEVICE_GROUP_TRANSFERRED',claimed_by=NULL,claim_expires_at=NULL WHERE status='pending' AND event_id IN (SELECT id FROM events WHERE device_id=?)", params: [deviceId] }]); } catch (error) { if (error instanceof Error && error.message.startsWith('DATABASE_CAS_FAILED')) throw new HttpError(409, 'TRANSFER_PREVIEW_STALE', 'Device changed while transfer was committing'); throw error; } const updated = await db.get<Row>('SELECT * FROM devices WHERE id=?', [deviceId]); await emitEvent(updated!, 'device.group_transferred', { device_id: deviceId, ownership_epoch: updated!.ownership_epoch }); await audit(request, context, 'device.group_transferred', 'device', deviceId, target, requiredString(body, 'reason', 256)); return success(reply, mapDevice(updated!));
  });

  app.get('/api/v1/files', async (request, reply) => {
    const context = await resolveAccess(request); requireScope(context, 'files:read'); const guard = sqlGroupGuard(context); const query = request.query as Row; const baseScope = context.isSystemAdmin ? 'admin' : requireGroup(context); const params: unknown[] = [...guard.params]; let where = guard.clause;
    const deletionStatus = query.deletion_status === undefined ? 'active' : String(query.deletion_status); if (!['active','requested','failed','object_deleted'].includes(deletionStatus)) throw new HttpError(400, 'INVALID_DELETION_STATUS', 'Unsupported deletion status'); if (deletionStatus !== 'active' && !context.isSystemAdmin) throw new AccessDeniedError(); where += ' AND f.deletion_status=?'; params.push(deletionStatus);
    if (query.status) { const status = String(query.status); if (!['pending','syncing','synced','blocked','failed','identity_conflict','canceled'].includes(status)) throw new HttpError(400, 'INVALID_FILE_STATUS', 'Unsupported file status'); where += ' AND f.status=?'; params.push(status); }
    if (query.device_id) { where += ' AND f.device_id=?'; params.push(String(query.device_id)); }
    if (query.attribute !== undefined) { const attribute = Number(query.attribute); if (!Number.isSafeInteger(attribute) || attribute < 0 || attribute > 2) throw new HttpError(400, 'INVALID_FILE_ATTRIBUTE', 'Unsupported file attribute'); where += ' AND f.attribute=?'; params.push(attribute); }
    if (query.from) { where += ' AND f.created_at>=?'; params.push(String(query.from)); }
    if (query.to) { where += ' AND f.created_at<=?'; params.push(String(query.to)); }
    if (query.search) { const search = String(query.search).trim(); if (search.length > 128) throw new HttpError(400, 'INVALID_SEARCH', 'Search is too long'); where += " AND (d.sn LIKE ? ESCAPE '\\' OR CAST(f.session_id AS TEXT)=?)"; params.push(`%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, search); }
    const scope = `${baseScope}:${createHash('sha256').update(JSON.stringify({ status: query.status ?? null, deletion_status: deletionStatus, device_id: query.device_id ?? null, attribute: query.attribute ?? null, from: query.from ?? null, to: query.to ?? null, search: query.search ?? null })).digest('hex')}`; const cursor = cursorDecode(query.cursor, scope); const total = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE ${where}`, params); const pageParams = [...params]; let pageWhere = where;
    if (cursor) { pageWhere += ' AND (f.created_at<? OR (f.created_at=? AND f.id<?))'; pageParams.push(cursor.createdAt, cursor.createdAt, cursor.itemId); }
    const limit = query.limit === undefined ? 50 : Number(query.limit); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'INVALID_LIMIT', 'limit must be between 1 and 100'); const rows = await db.all<Row>(`SELECT f.* FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE ${pageWhere} ORDER BY f.created_at DESC,f.id DESC LIMIT ?`, [...pageParams, limit + 1]); const items = rows.slice(0, limit); const last = items.at(-1); return success(reply, { items: items.map(mapFile), count: items.length, total_count: Number(total?.count ?? 0), next_cursor: rows.length > limit && last ? cursorEncode(String(last.created_at), String(last.id), scope) : null });
  });
  app.get('/api/v1/files/:id', async (request, reply) => { const context = await resolveAccess(request); requireScope(context, 'files:read'); const guard = sqlGroupGuard(context); const row = await db.get<Row>(`SELECT f.* FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND ${guard.clause}${context.isSystemAdmin ? '' : " AND f.deletion_status='active'"}`, [String((request.params as Row).id), ...guard.params]); if (!row) throw new AccessDeniedError(); return success(reply, mapFile(row)); });
  app.get('/api/v1/files/:id/content', async (request, reply) => {
    const context = await resolveAccess(request); if (context.actorType === 'application_token' || context.actorType === 'oauth') throw new HttpError(410, 'CONTENT_ROUTE_DEPRECATED', 'Create a short-lived recording download link instead'); requireScope(context, 'recordings:read'); reply.header('deprecation', 'true').header('sunset', 'Wed, 06 Aug 2027 00:00:00 GMT').header('link', '</api/v1/recordings/{id}/download-links>; rel="successor-version"'); const guard = sqlGroupGuard(context); const row = await db.get<{ storage_locator: string; id: string; actual_size: number; sha256: string; group_id: string }>(`SELECT f.id,f.storage_locator,f.actual_size,f.sha256,d.group_id FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status='synced' AND f.deletion_status='active' AND ${guard.clause}`, [String((request.params as Row).id), ...guard.params]); if (!row?.storage_locator) throw new AccessDeniedError(); const size = Number(row.actual_size); let range: { start: number; end: number } | undefined; const requestedRange = request.headers.range;
    if (requestedRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange); if (!match || (!match[1] && !match[2])) { reply.header('content-range', `bytes */${size}`); throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'Only one valid byte range is supported'); }
      let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2])); let end = match[2] && match[1] ? Number(match[2]) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) { reply.header('content-range', `bytes */${size}`); throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'Requested range is outside the file'); }
      end = Math.min(end, size - 1); range = { start, end }; reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', String(end - start + 1));
    } else reply.header('content-length', String(size));
    reply.header('accept-ranges', 'bytes').header('content-type', 'application/octet-stream').header('cache-control', 'private, no-store').header('content-disposition', `attachment; filename="${basename(row.id)}.bin"`); if (row.sha256) reply.header('etag', `"sha256-${row.sha256}"`); const stream = row.storage_locator.startsWith('s3:') ? await s3Storage?.open(row.storage_locator, range) : createReadStream(storage.resolveLocator(row.storage_locator), range); if (!stream) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Storage driver is unavailable'); await audit(request, context, range ? 'file.range_read' : 'file.downloaded', 'recording_file', row.id, row.group_id, range ? `${range.start}-${range.end}` : undefined); return reply.send(stream);
  });

  app.put('/api/v1/files/:id/legal-hold', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const fileId = String((request.params as Row).id); const body = bodyOf(request); if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'INVALID_REQUEST', 'enabled must be boolean'); const reason = requiredString(body, 'reason', 256); const timestamp = now();
    const changed = await db.run("UPDATE recording_files SET legal_hold=?,legal_hold_reason=?,legal_hold_updated_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND deletion_status IN ('active','failed')", [body.enabled ? 1 : 0, body.enabled ? reason : null, timestamp, timestamp, fileId]);
    if (changed.changes !== 1) throw new HttpError(409, 'FILE_LIFECYCLE_CONFLICT', 'File is missing or deletion is already in progress/completed'); await audit(request, context, body.enabled ? 'file.legal_hold_set' : 'file.legal_hold_cleared', 'recording_file', fileId, undefined, reason); const row = await db.get<Row>('SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=?', [fileId]); await emitEvent(row!, 'recording.legal_hold_changed', { file_id: fileId, device_id: row!.device_id, legal_hold: body.enabled, legal_hold_reason: body.enabled ? reason : null, ...recordingEventFacts(row!) }); return success(reply, mapFile(row!));
  });
  app.post('/api/v1/files/:id/deletion-preview', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const fileId = String((request.params as Row).id); const file = await db.get<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status='synced' AND f.storage_locator IS NOT NULL AND f.deletion_status IN ('active','failed','requested')", [fileId]); if (!file) throw new AccessDeniedError(); if (Boolean(file.legal_hold)) throw new HttpError(409, 'FILE_LEGAL_HOLD', 'Legal hold blocks deletion'); const version = `${file.updated_at}:${file.sha256}:${file.storage_locator}:${file.deletion_status}`; return success(reply, { file_id: fileId, object_only: true, device_source_deleted: false, metadata_tombstone_retained: true, retrying_incomplete_request: file.deletion_status === 'requested', resource_version: version, confirmation_token: tokenHash(`${fileId}:${version}`, config.masterKey) });
  });
  app.delete('/api/v1/files/:id', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const fileId = String((request.params as Row).id); const body = bodyOf(request); const reason = requiredString(body, 'reason', 256); const version = requiredString(body, 'resource_version', 512); const confirmation = requiredString(body, 'confirmation_token', 256); const expected = tokenHash(`${fileId}:${version}`, config.masterKey); if (!constantTimeHexEqual(confirmation, expected)) throw new HttpError(409, 'FILE_DELETION_PREVIEW_STALE', 'Deletion preview is stale'); const file = await db.get<Row>("SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=? AND f.status='synced' AND f.storage_locator IS NOT NULL AND f.deletion_status IN ('active','failed','requested')", [fileId]); if (!file) throw new AccessDeniedError(); const current = `${file.updated_at}:${file.sha256}:${file.storage_locator}:${file.deletion_status}`; if (current !== version) throw new HttpError(409, 'FILE_DELETION_PREVIEW_STALE', 'Deletion preview is stale'); if (Boolean(file.legal_hold)) throw new HttpError(409, 'FILE_LEGAL_HOLD', 'Legal hold blocks deletion'); const timestamp = now();
    if (file.deletion_status !== 'requested') try { await db.batch([{ sql: "UPDATE recording_files SET deletion_status='requested',deletion_requested_at=?,deletion_requested_by=?,deletion_reason=?,deletion_error=NULL,updated_at=? WHERE id=? AND legal_hold=0 AND deletion_status IN ('active','failed') AND updated_at=?", params: [timestamp, context.actorId, reason, timestamp, fileId, file.updated_at], expectChanges: 1 }, { sql: 'INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,group_id,request_id,result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', params: [id('audit'), context.actorId, 'file.deletion_requested', 'recording_file', fileId, file.group_id, request.id, 'success', reason, timestamp] }]); } catch (error) { if (error instanceof Error && error.message.startsWith('DATABASE_CAS_FAILED')) throw new HttpError(409, 'FILE_DELETION_PREVIEW_STALE', 'File lifecycle changed while deletion was starting'); throw error; }
    try {
      const locator = String(file.storage_locator); if (locator.startsWith('s3:')) { if (!s3Storage) throw new Error('STORAGE_UNAVAILABLE'); await s3Storage.delete(locator); } else await storage.delete(locator); const deletedAt = now(); const deletedFile = { ...file, object_deleted_at: deletedAt, resource_version: Number(file.resource_version ?? 1) + 1 }; const prepared = await prepareEvent(file, 'recording.deleted', { file_id: fileId, device_id: file.device_id, object_deleted: true, device_source_deleted: false, ...recordingEventFacts(deletedFile) }); await db.batch([{ sql: "UPDATE recording_files SET deletion_status='object_deleted',storage_locator=NULL,object_deleted_at=?,deletion_error=NULL,resource_version=resource_version+1,updated_at=? WHERE id=? AND deletion_status='requested'", params: [deletedAt, deletedAt, fileId], expectChanges: 1 }, ...prepared.statements]); void dispatcher.drain(); return success(reply, { file_id: fileId, deletion_status: 'object_deleted', object_deleted: true, device_source_deleted: false, metadata_tombstone_retained: true });
    } catch (error) { const converged = await db.get<{ deletion_status: string }>('SELECT deletion_status FROM recording_files WHERE id=?', [fileId]); if (converged?.deletion_status === 'object_deleted') return success(reply, { file_id: fileId, deletion_status: 'object_deleted', object_deleted: true, device_source_deleted: false, metadata_tombstone_retained: true }); const code = error instanceof Error ? error.message.slice(0, 200) : 'OBJECT_DELETE_FAILED'; await db.run("UPDATE recording_files SET deletion_status='failed',deletion_error=?,updated_at=? WHERE id=? AND deletion_status='requested'", [code, now(), fileId]); throw new HttpError(503, 'OBJECT_DELETE_FAILED', 'Storage object deletion failed and remains retryable'); }
  });

  app.get('/api/v1/event-endpoints', async (request, reply) => { const context = await resolveAccess(request); const guard = context.isSystemAdmin ? { clause: '1=1', params: [] } : { clause: 'group_id=?', params: [requireGroup(context)] }; return success(reply, await db.all(`SELECT id,group_id,url,secret_id,next_secret_id,next_activates_at,enabled,created_at FROM event_endpoints WHERE ${guard.clause}`, guard.params)); });
  app.post('/api/v1/event-endpoints', async (request, reply) => {
    const context = await resolveAccess(request, true); const body = bodyOf(request); const groupId = context.isSystemAdmin ? requiredString(body, 'group_id', 80) : requireGroup(context); requireGroupAdmin(context, groupId); const url = await validateWebhookUrl(requiredString(body, 'url', 2000), config.allowPrivateWebhooks, config.allowHttpWebhooks); const endpointId = id('endpoint'); const secretId = id('secret'); const secret = `vce_${opaqueToken()}`; await db.run('INSERT INTO event_endpoints(id,group_id,url,secret_id,secret_ciphertext,created_at) VALUES(?,?,?,?,?,?)', [endpointId, groupId, url.href, secretId, encryptSecret(secret, config.masterKey, endpointId), now()]); await audit(request, context, 'event_endpoint.created', 'event_endpoint', endpointId, groupId); return success(reply, { id: endpointId, secret_id: secretId, secret }, 201);
  });
  app.patch('/api/v1/event-endpoints/:id', async (request, reply) => {
    const context = await resolveAccess(request, true); const endpointId = String((request.params as Row).id); const body = bodyOf(request);
    const endpoint = await db.get<{ group_id: string; url: string; enabled: number }>('SELECT group_id,url,enabled FROM event_endpoints WHERE id=?', [endpointId]); if (!endpoint) throw new AccessDeniedError(); requireGroupAdmin(context, endpoint.group_id);
    if (body.url === undefined && body.enabled === undefined) throw new HttpError(400, 'INVALID_REQUEST', 'url or enabled is required');
    const url = body.url === undefined ? endpoint.url : (await validateWebhookUrl(requiredString(body, 'url', 2000), config.allowPrivateWebhooks, config.allowHttpWebhooks)).href;
    const enabled = body.enabled === undefined ? endpoint.enabled === 1 : body.enabled === true ? true : body.enabled === false ? false : (() => { throw new HttpError(400, 'INVALID_REQUEST', 'enabled must be boolean'); })();
    const statements: SqlStatement[] = [{ sql: 'UPDATE event_endpoints SET url=?,enabled=? WHERE id=?', params: [url, enabled ? 1 : 0, endpointId], expectChanges: 1 }];
    if (!enabled) statements.push({ sql: "UPDATE event_deliveries SET status='canceled',last_error='ENDPOINT_DISABLED',claimed_by=NULL,claim_expires_at=NULL WHERE endpoint_id=? AND status='pending'", params: [endpointId] });
    await db.batch(statements); await audit(request, context, enabled ? 'event_endpoint.updated' : 'event_endpoint.disabled', 'event_endpoint', endpointId, endpoint.group_id, optionalString(body, 'reason', 256) ?? undefined);
    return success(reply, { id: endpointId, url, enabled });
  });
  app.delete('/api/v1/event-endpoints/:id', async (request, reply) => {
    const context = await resolveAccess(request, true); const endpointId = String((request.params as Row).id); const endpoint = await db.get<{ group_id: string }>('SELECT group_id FROM event_endpoints WHERE id=?', [endpointId]); if (!endpoint) throw new AccessDeniedError(); requireGroupAdmin(context, endpoint.group_id);
    await db.batch([{ sql: 'UPDATE event_endpoints SET enabled=0 WHERE id=?', params: [endpointId], expectChanges: 1 }, { sql: "UPDATE event_deliveries SET status='canceled',last_error='ENDPOINT_DISABLED',claimed_by=NULL,claim_expires_at=NULL WHERE endpoint_id=? AND status='pending'", params: [endpointId] }]);
    await audit(request, context, 'event_endpoint.disabled', 'event_endpoint', endpointId, endpoint.group_id, requiredString(bodyOf(request), 'reason', 256)); return success(reply, { id: endpointId, enabled: false });
  });
  app.post('/api/v1/event-endpoints/:id/rotate-secret', async (request, reply) => {
    const context = await resolveAccess(request, true); const endpointId = String((request.params as Row).id); const row = await db.get<{ group_id: string; next_secret_id: string | null }>('SELECT group_id,next_secret_id FROM event_endpoints WHERE id=?', [endpointId]); if (!row) throw new AccessDeniedError(); requireGroupAdmin(context, row.group_id); if (row.next_secret_id) throw new HttpError(409, 'SECRET_ROTATION_PENDING', 'A secret rotation is already pending');
    const body = bodyOf(request); const activatesAt = optionalString(body, 'activates_at', 64) ?? plus(60 * 60_000); if (!Number.isFinite(Date.parse(activatesAt)) || Date.parse(activatesAt) < Date.now() + 60_000 || Date.parse(activatesAt) > Date.now() + 7 * 24 * 60 * 60_000) throw new HttpError(400, 'INVALID_ACTIVATION_TIME', 'Activation must be between one minute and seven days from now');
    const secretId = id('secret'); const secret = `vce_${opaqueToken()}`; await db.run('UPDATE event_endpoints SET next_secret_id=?,next_secret_ciphertext=?,next_activates_at=? WHERE id=?', [secretId, encryptSecret(secret, config.masterKey, endpointId), activatesAt, endpointId]); await audit(request, context, 'event_endpoint.secret_rotation_scheduled', 'event_endpoint', endpointId, row.group_id); return success(reply, { secret_id: secretId, secret, activates_at: activatesAt });
  });
  app.get('/api/v1/event-endpoints/:id/deliveries', async (request, reply) => {
    const context = await resolveAccess(request); const endpointId = String((request.params as Row).id); const endpoint = await db.get<{ group_id: string }>('SELECT group_id FROM event_endpoints WHERE id=?', [endpointId]); if (!endpoint) throw new AccessDeniedError(); requireGroupAdmin(context, endpoint.group_id); const status = String((request.query as Row).status ?? 'dead'); if (!['pending', 'delivered', 'dead', 'canceled'].includes(status)) throw new HttpError(400, 'INVALID_DELIVERY_STATUS', 'Unsupported delivery status');
    return success(reply, await db.all(`SELECT ed.id,ed.event_id,ed.replay_namespace,ed.status,ed.attempts,ed.next_attempt_at,ed.delivered_at,ed.last_status_code,ed.last_error,ed.created_at FROM event_deliveries ed JOIN events e ON e.id=ed.event_id JOIN devices d ON d.id=e.device_id WHERE ed.endpoint_id=? AND ed.status=? AND d.group_id=? ORDER BY ed.created_at DESC,ed.id DESC LIMIT 200`, [endpointId, status, endpoint.group_id]));
  });
  app.post('/api/v1/event-deliveries/:id/replay', async (request, reply) => {
    const context = await resolveAccess(request, true); const deliveryId = String((request.params as Row).id); const delivery = await db.get<{ group_id: string; status: string }>(`SELECT ep.group_id,ed.status FROM event_deliveries ed JOIN event_endpoints ep ON ep.id=ed.endpoint_id JOIN events e ON e.id=ed.event_id JOIN devices d ON d.id=e.device_id WHERE ed.id=? AND ep.group_id=d.group_id`, [deliveryId]); if (!delivery) throw new AccessDeniedError(); requireGroupAdmin(context, delivery.group_id); if (!['dead', 'canceled'].includes(delivery.status)) throw new HttpError(409, 'DELIVERY_NOT_REPLAYABLE', 'Only dead or canceled deliveries can be replayed');
    await db.run("UPDATE event_deliveries SET status='pending',attempts=0,next_attempt_at=?,delivered_at=NULL,last_status_code=NULL,last_error=NULL,claimed_by=NULL,claim_expires_at=NULL WHERE id=?", [now(), deliveryId]); await audit(request, context, 'event_delivery.replayed', 'event_delivery', deliveryId, delivery.group_id, requiredString(bodyOf(request), 'reason', 256)); void dispatcher.drain(); return success(reply, { id: deliveryId, status: 'pending' }, 202);
  });
  app.post('/api/v1/event-endpoints/:id/backfill-preview', async (request, reply) => {
    const context = await resolveAccess(request, true); const endpointId = String((request.params as Row).id); const endpoint = await db.get<{ group_id: string }>('SELECT group_id FROM event_endpoints WHERE id=? AND enabled=1', [endpointId]); if (!endpoint) throw new AccessDeniedError(); requireGroupAdmin(context, endpoint.group_id); const body = bodyOf(request); const from = optionalString(body, 'from_created_at', 64); const to = optionalString(body, 'to_created_at', 64); const type = optionalString(body, 'event_type', 100); const params: unknown[] = [endpoint.group_id, endpoint.group_id]; let filter = ''; if (from) { filter += ' AND e.created_at>=?'; params.push(from); } if (to) { filter += ' AND e.created_at<=?'; params.push(to); } if (type) { filter += ' AND e.type=?'; params.push(type); }
    const events = await db.all<{ id: string }>(`SELECT e.id FROM events e JOIN devices d ON d.id=e.device_id WHERE d.group_id=? AND e.owner_group_id=? AND e.ownership_epoch=d.ownership_epoch${filter} ORDER BY e.created_at,e.id LIMIT 1001`, params); if (events.length > 1000) throw new HttpError(409, 'BACKFILL_TOO_LARGE', 'Backfill is limited to 1000 events'); const version = `${events.length}:${events.at(-1)?.id ?? ''}`; const confirmation = tokenHash(`${endpointId}:${from ?? ''}:${to ?? ''}:${type ?? ''}:${version}`, config.masterKey); return success(reply, { endpoint_id: endpointId, event_count: events.length, resource_version: version, confirmation_token: confirmation });
  });
  app.post('/api/v1/event-endpoints/:id/backfill', async (request, reply) => {
    const context = await resolveAccess(request, true); const endpointId = String((request.params as Row).id); const endpoint = await db.get<{ group_id: string }>('SELECT group_id FROM event_endpoints WHERE id=? AND enabled=1', [endpointId]); if (!endpoint) throw new AccessDeniedError(); requireGroupAdmin(context, endpoint.group_id); const body = bodyOf(request); const from = optionalString(body, 'from_created_at', 64); const to = optionalString(body, 'to_created_at', 64); const type = optionalString(body, 'event_type', 100); const params: unknown[] = [endpoint.group_id, endpoint.group_id]; let filter = ''; if (from) { filter += ' AND e.created_at>=?'; params.push(from); } if (to) { filter += ' AND e.created_at<=?'; params.push(to); } if (type) { filter += ' AND e.type=?'; params.push(type); } const events = await db.all<{ id: string }>(`SELECT e.id FROM events e JOIN devices d ON d.id=e.device_id WHERE d.group_id=? AND e.owner_group_id=? AND e.ownership_epoch=d.ownership_epoch${filter} ORDER BY e.created_at,e.id LIMIT 1001`, params); if (events.length > 1000) throw new HttpError(409, 'BACKFILL_TOO_LARGE', 'Backfill is limited to 1000 events'); const version = `${events.length}:${events.at(-1)?.id ?? ''}`; const expected = tokenHash(`${endpointId}:${from ?? ''}:${to ?? ''}:${type ?? ''}:${version}`, config.masterKey); if (requiredString(body, 'resource_version', 200) !== version || !constantTimeHexEqual(requiredString(body, 'confirmation_token', 200), expected)) throw new HttpError(409, 'BACKFILL_PREVIEW_STALE', 'Backfill preview is stale'); const replayId = id('replay'); const timestamp = now(); const statements: SqlStatement[] = [{ sql: 'INSERT INTO event_replays(id,group_id,endpoint_id,from_created_at,to_created_at,event_type,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [replayId, endpoint.group_id, endpointId, from, to, type, context.actorId, timestamp] }]; for (const event of events) statements.push({ sql: 'INSERT INTO event_deliveries(id,event_id,endpoint_id,replay_namespace,status,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('delivery'), event.id, endpointId, replayId, 'pending', timestamp, timestamp] }); await db.batch(statements); await audit(request, context, 'event.backfilled', 'event_replay', replayId, endpoint.group_id, requiredString(body, 'reason', 256)); void dispatcher.drain(); return success(reply, { id: replayId, event_count: events.length }, 202);
  });
  app.get('/api/v1/events', async (request, reply) => {
    return success(reply, await openPlatformService.listEvents(await resolveAccess(request), request.query as Row));
  });
  app.get('/api/v1/audit-logs', async (request, reply) => {
    const context = await resolveAccess(request); const query = request.query as Row; const params: unknown[] = []; let where = '1=1';
    if (!context.isSystemAdmin) { where += ' AND group_id=?'; params.push(requireGroup(context)); }
    if (query.action) { where += ' AND action=?'; params.push(String(query.action)); }
    if (query.resource_type) { where += ' AND resource_type=?'; params.push(String(query.resource_type)); }
    if (query.result) { where += ' AND result=?'; params.push(String(query.result)); }
    return success(reply, await db.all(`SELECT id,actor_id,action,resource_type,resource_id,group_id,request_id,result,reason,created_at FROM audit_logs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 200`, params));
  });
  app.get('/api/v1/admin/storage', async (request, reply) => {
    const context = await resolveAccess(request); requireSystemAdmin(context); return success(reply, await readStorageState());
  });
  app.patch('/api/v1/admin/storage', async (request, reply) => {
    const context = await resolveAccess(request, true); requireSystemAdmin(context); const body = bodyOf(request);
    const maxStorageBytes = requiredInteger(body, 'max_storage_bytes', config.maxFileBytes);
    const warningRatio = requiredRatio(body, 'warning_ratio');
    const stopRatio = requiredRatio(body, 'stop_ratio');
    if (warningRatio >= stopRatio) throw new HttpError(400, 'INVALID_STORAGE_POLICY', 'warning_ratio must be below stop_ratio');
    const reason = requiredString(body, 'reason', 256); const timestamp = now();
    const changed = await db.run('UPDATE server_settings SET storage_max_bytes=?,storage_warning_ratio=?,storage_stop_ratio=?,storage_updated_at=?,storage_updated_by=? WHERE singleton=1', [maxStorageBytes, warningRatio, stopRatio, timestamp, context.actorId]);
    if (changed.changes !== 1) throw new HttpError(409, 'SETTINGS_UPDATE_FAILED', 'Storage settings could not be updated');
    await audit(request, context, 'settings.storage_updated', 'server_settings', '1', undefined, reason);
    return success(reply, await readStorageState());
  });
  app.post('/api/v1/admin/reconcile', async (request, reply) => { const context = await resolveAccess(request, true); requireSystemAdmin(context); const result = await reconciler!.run(); await audit(request, context, 'system.reconciled', 'server'); return success(reply, result); });

  if (config.simulatorEnabled) {
    app.post('/api/v1/simulator/devices', async (request, reply) => {
      const context = await resolveAccess(request, true); requireSystemAdmin(context); const body = bodyOf(request); const deviceId=id('dev'); const credentialId=id('credential'); const rawToken=randomBytes(32); const timestamp=now(); await db.batch([{sql:'INSERT INTO devices(id,manufacturer,sn,model,firmware_version,group_id,online,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)',params:[deviceId,requiredString(body,'manufacturer',64),requiredString(body,'sn',128),optionalString(body,'model',64),optionalString(body,'firmware_version',64),requiredString(body,'group_id',80),timestamp,timestamp,timestamp]},{sql:'INSERT INTO device_credentials(id,device_id,credential_epoch,token_verifier,token_ciphertext,key_version,created_at) VALUES(?,?,?,?,?,?,?)',params:[credentialId,deviceId,1,deviceTokenVerifier(rawToken,config.groupTokenPepper),encryptSecret(rawToken,config.masterKey,`${deviceId}:${credentialId}`),config.masterKeyVersion,timestamp]}]); const device=await db.get<Row>('SELECT * FROM devices WHERE id=?',[deviceId]); await emitEvent(device!,'device.online',{device_id:deviceId,simulated:true}); return success(reply,{device:mapDevice(device!),device_token:encodeDeviceToken(rawToken)},201);
    });
    app.post('/api/v1/simulator/files', async (request, reply) => {
      const context = await resolveAccess(request, true);
      const body = bodyOf(request);
      const deviceId = requiredString(body, 'device_id', 80);
      const device = await requireDevice(context, deviceId);
      const sessionId = requiredInteger(body, 'session_id');
      const attribute = requiredInteger(body, 'attribute');
      const expectedSize = requiredInteger(body, 'content_length', 1);
      const media = reviewedRecordingMedia(device);
      const candidate = await db.get<Row>('SELECT * FROM recording_files WHERE device_id=? AND credential_epoch=? AND session_id=? AND attribute=? ORDER BY revision DESC LIMIT 1', [deviceId, device.credential_epoch, sessionId, attribute]);
      if (candidate && Number(candidate.expected_size) !== expectedSize) {
        const conflictId = id('file');
        await db.run("INSERT INTO recording_files(id,device_id,credential_epoch,session_id,attribute,revision,expected_size,status,error_code,media_container,media_codec,media_content_type,media_filename_extension,encoding_profile,media_metadata_source,source_firmware_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [conflictId, deviceId, device.credential_epoch, sessionId, attribute, Number(candidate.revision) + 1, expectedSize, 'identity_conflict', 'FILE_IDENTITY_CONFLICT', media.container, media.codec, media.content_type, media.filename_extension, media.encoding_profile, media.source, device.firmware_version ?? null, now(), now()]);
        throw new HttpError(409, 'FILE_IDENTITY_CONFLICT', 'A file with the same device identity has conflicting metadata');
      }
      if (candidate?.status === 'synced') return success(reply, { file_id: candidate.id, status: 'synced', already_synced: true });
      if (candidate && ['pending', 'syncing'].includes(String(candidate.status))) {
        const activeLocal = await db.get('SELECT id FROM upload_tickets WHERE file_id=? AND consumed_at IS NULL AND failed_at IS NULL AND expires_at>?', [candidate.id, now()]);
        const activeS3 = await db.get('SELECT id FROM s3_upload_attempts WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL AND expires_at>?', [candidate.id, now()]);
        if (activeLocal || activeS3) return success(reply, { file_id: candidate.id, status: candidate.status, upload_plan_active: true }, 202);
      }
      await ensureUploadCapacity(expectedSize, candidate ? String(candidate.id) : undefined);
      const fileId = candidate ? String(candidate.id) : id('file');
      if (candidate) await db.run("UPDATE recording_files SET status='pending',error_code=NULL,updated_at=? WHERE id=?", [now(), fileId]);
      else {
        await db.run("INSERT INTO recording_files(id,device_id,credential_epoch,session_id,attribute,revision,expected_size,status,media_container,media_codec,media_content_type,media_filename_extension,encoding_profile,media_metadata_source,source_firmware_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [fileId, deviceId, device.credential_epoch, sessionId, attribute, 1, expectedSize, 'pending', media.container, media.codec, media.content_type, media.filename_extension, media.encoding_profile, media.source, device.firmware_version ?? null, now(), now()]);
        const discovered = await db.get<Row>('SELECT * FROM recording_files WHERE id=?', [fileId]);
        await emitEvent(device, 'recording.discovered', { file_id: fileId, device_id: deviceId, session_id: sessionId, attribute, file_size: expectedSize, ...recordingEventFacts(discovered!) });
      }
      await db.run("UPDATE upload_tickets SET failed_at=?,failure_code='SUPERSEDED' WHERE file_id=? AND consumed_at IS NULL AND failed_at IS NULL", [now(), fileId]);
      await db.run("UPDATE s3_upload_attempts SET failed_at=?,failure_code='SUPERSEDED' WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL", [now(), fileId]);
      if (s3Storage) {
        const plan = await s3Storage.prepare(fileId, expectedSize, deviceUploadCredentialTtlSeconds);
        await db.batch([
          { sql: 'INSERT INTO s3_upload_attempts(id,file_id,staging_key,expected_size,expires_at,created_at) VALUES(?,?,?,?,?,?)', params: [plan.attemptId, fileId, plan.stagingKey, expectedSize, plan.expiresAt, now()] },
          { sql: "UPDATE recording_files SET status='syncing',transport='s3_direct',updated_at=? WHERE id=?", params: [now(), fileId] },
        ]);
        const syncing = await db.get<Row>('SELECT * FROM recording_files WHERE id=?', [fileId]); await emitEvent(device, 'recording.sync_started', { file_id: fileId, device_id: deviceId, session_id: sessionId, attribute, transport: 's3_direct', sync_attempt_id: plan.attemptId, ...recordingEventFacts(syncing!) });
        return success(reply, { file_id: fileId, transport: 's3_direct', upload_url: plan.uploadUrl, attempt_id: plan.attemptId, complete_url: `${config.publicBaseUrl}/api/v1/simulator/files/${fileId}/complete`, expires_at: plan.expiresAt }, 201);
      }
      const rawTicket = opaqueToken(); const ticketId = id('upload'); const expiresAt = plus(deviceUploadCredentialTtlMs);
      await db.run('INSERT INTO upload_tickets(id,token_hash,file_id,expected_size,expires_at,created_at) VALUES(?,?,?,?,?,?)', [ticketId, tokenHash(rawTicket), fileId, expectedSize, expiresAt, now()]);
      return success(reply, { file_id: fileId, transport: 'filesystem_http', upload_url: `${config.publicBaseUrl}/device-upload/v1/${rawTicket}`, expires_at: expiresAt }, 201);
    });
    app.post('/api/v1/simulator/files/:id/complete', async (request, reply) => {
      const context=await resolveAccess(request,true); if(!s3Storage)throw new HttpError(409,'S3_NOT_CONFIGURED','S3 direct is not configured'); const fileId=String((request.params as Row).id); const file=await db.get<Row>('SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=?',[fileId]); if(!file)throw new AccessDeniedError(); await requireDevice(context,String(file.device_id)); const attempt=await db.get<{id:string;staging_key:string;expected_size:number;expires_at:string}>('SELECT id,staging_key,expected_size,expires_at FROM s3_upload_attempts WHERE file_id=? AND completed_at IS NULL AND failed_at IS NULL ORDER BY created_at DESC LIMIT 1',[fileId]); if(!attempt||attempt.expires_at<=now())throw new HttpError(409,'S3_ATTEMPT_EXPIRED','S3 upload attempt expired'); try { const committed=await s3Storage.verifyAndCommit(fileId,attempt.id,attempt.staging_key,attempt.expected_size); const timestamp=now(); const completedFile={...file,actual_size:committed.size,sha256:committed.sha256,synced_at:timestamp,resource_version:Number(file.resource_version??1)+1}; const prepared=await prepareEvent(file,'file.synced',{file_id:fileId,device_id:file.device_id,session_id:file.session_id,attribute:file.attribute,file_size:committed.size,...(committed.sha256?{sha256:committed.sha256}:{}),...recordingEventFacts(completedFile)}); const results=await db.batch([{sql:"UPDATE recording_files SET status='synced',actual_size=?,sha256=?,storage_locator=?,error_code=NULL,synced_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM s3_upload_attempts WHERE id=? AND completed_at IS NULL AND failed_at IS NULL)",params:[committed.size,committed.sha256,committed.locator,timestamp,timestamp,fileId,attempt.id]},{sql:'UPDATE s3_upload_attempts SET completed_at=?,final_locator=? WHERE id=? AND completed_at IS NULL AND failed_at IS NULL',params:[timestamp,committed.locator,attempt.id]},...prepared.statements]); if(results[1]?.changes!==1)throw new Error('S3_ATTEMPT_RACE'); void dispatcher.drain(); return success(reply,{file_id:fileId,size:committed.size,sha256:committed.sha256}); } catch(error) { const code=error instanceof Error?error.message:'S3_COMMIT_FAILED'; const failedAt=now(); await db.batch([{sql:'UPDATE s3_upload_attempts SET failed_at=?,failure_code=? WHERE id=? AND completed_at IS NULL',params:[failedAt,code,attempt.id]},{sql:"UPDATE recording_files SET status='failed',error_code=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status<>'synced'",params:[code,failedAt,fileId]}]); await emitEvent(file,'recording.sync_failed',{file_id:fileId,device_id:file.device_id,session_id:file.session_id,attribute:file.attribute,error_code:code,...recordingEventFacts({...file,resource_version:Number(file.resource_version??1)+1})}); throw error; }
    });
  }

  app.put('/device-upload/v1/:ticket', async (request, reply) => {
    const rawTicket = String((request.params as Row).ticket);
    const ticket = await db.get<{ id: string; file_id: string; expected_size: number; expires_at: string; consumed_at: string | null }>('SELECT id,file_id,expected_size,expires_at,consumed_at FROM upload_tickets WHERE token_hash=? AND failed_at IS NULL', [tokenHash(rawTicket)]);
    if (!ticket || ticket.consumed_at || ticket.expires_at <= now()) throw new HttpError(404, 'UPLOAD_TICKET_INVALID', 'Upload ticket is invalid');
    const contentLength = Number(request.headers['content-length']);
    if (contentLength !== ticket.expected_size) {
      await db.batch([
        { sql: "UPDATE upload_tickets SET failed_at=?,failure_code='CONTENT_LENGTH_MISMATCH' WHERE id=?", params: [now(), ticket.id] },
        { sql: "UPDATE recording_files SET status='failed',error_code='CONTENT_LENGTH_MISMATCH',updated_at=? WHERE id=? AND status<>'synced'", params: [now(), ticket.file_id] },
      ]);
      throw new HttpError(400, 'CONTENT_LENGTH_MISMATCH', 'Content-Length does not match expected file size');
    }
    const file = await db.get<Row>('SELECT f.*,d.group_id,d.ownership_epoch FROM recording_files f JOIN devices d ON d.id=f.device_id WHERE f.id=?', [ticket.file_id]);
    if (!file) throw new HttpError(404, 'UPLOAD_TICKET_INVALID', 'Upload ticket is invalid');
    const syncStartedAt = now(); const syncStarted = await db.run("UPDATE recording_files SET status='syncing',transport='filesystem_http',updated_at=? WHERE id=? AND status IN ('pending','failed')", [syncStartedAt, ticket.file_id]);
    if (syncStarted.changes === 1) await emitEvent(file, 'recording.sync_started', { file_id: ticket.file_id, device_id: file.device_id, session_id: file.session_id, attribute: file.attribute, transport: 'filesystem_http', sync_attempt_id: ticket.id, ...recordingEventFacts(file) });
    try {
      const stored = await storage.receive(ticket.file_id, request.body as Readable, ticket.expected_size);
      const timestamp = now();
      const completedFile = { ...file, actual_size: stored.size, sha256: stored.sha256, synced_at: timestamp, resource_version: Number(file.resource_version ?? 1) + 1 }; const prepared = await prepareEvent(file, 'file.synced', { file_id: ticket.file_id, device_id: file.device_id, session_id: file.session_id, attribute: file.attribute, file_size: stored.size, sha256: stored.sha256, ...recordingEventFacts(completedFile) });
      const committed = await db.batch([
        { sql: "UPDATE recording_files SET status='synced',actual_size=?,sha256=?,storage_locator=?,error_code=NULL,synced_at=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM upload_tickets WHERE id=? AND consumed_at IS NULL AND failed_at IS NULL) AND EXISTS(SELECT 1 FROM devices d WHERE d.id=recording_files.device_id AND d.ownership_epoch=? AND d.group_id=?)", params: [stored.size, stored.sha256, stored.locator, timestamp, timestamp, ticket.file_id, ticket.id, file.ownership_epoch, file.group_id], expectChanges: 1 },
        { sql: 'UPDATE upload_tickets SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND failed_at IS NULL', params: [timestamp, ticket.id], expectChanges: 1 },
        ...prepared.statements,
      ]);
      if (committed[1]?.changes !== 1) throw new Error('UPLOAD_TICKET_RACE');
      void dispatcher.drain();
      return success(reply, { file_id: ticket.file_id, size: stored.size, sha256: stored.sha256 });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UPLOAD_FAILED';
      await db.batch([
        { sql: 'UPDATE upload_tickets SET failed_at=?,failure_code=? WHERE id=? AND consumed_at IS NULL', params: [now(), code, ticket.id] },
        { sql: "UPDATE recording_files SET status='failed',error_code=?,resource_version=resource_version+1,updated_at=? WHERE id=? AND status<>'synced'", params: [code, now(), ticket.file_id] },
      ]);
      await emitEvent(file, 'recording.sync_failed', { file_id: ticket.file_id, device_id: file.device_id, session_id: file.session_id, attribute: file.attribute, error_code: code, ...recordingEventFacts({ ...file, resource_version: Number(file.resource_version ?? 1) + 1 }) });
      throw error;
    }
  });

  app.get('/device/v1/ws', { websocket: true }, (socket, request) => {
    void (async () => {
      const deviceIdentity = String(request.headers.deviceid ?? request.headers['x-device-id'] ?? ''); const authKey = `${request.ip}:${deviceIdentity}`;
      if (deviceAuthBlocked(authKey)) { request.log.debug({ device_identity: deviceIdentity, remote_ip: request.ip, failure_reason: 'rate_limited' }, 'device websocket authentication rejected'); socket.close(1013, 'authentication temporarily limited'); return; }
      const authorization = request.headers.authorization; const encoded = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      request.log.debug({ device_identity: deviceIdentity, remote_ip: request.ip }, 'device websocket connection received');
      let rawToken: Buffer;
      try { rawToken = decodeDeviceToken(encoded); } catch { deviceAuthFailed(authKey); request.log.debug({ device_identity: deviceIdentity, remote_ip: request.ip, failure_reason: 'token_format_invalid' }, 'device websocket authentication rejected'); socket.close(1008, 'authentication failed'); return; }
      const credentials = await db.all<{ id: string; device_id: string; token_verifier: string; token_ciphertext: string; key_version: number; expires_at: string | null }>(`SELECT c.id,c.device_id,c.token_verifier,c.token_ciphertext,c.key_version,c.expires_at
        FROM device_credentials c JOIN devices d ON d.id=c.device_id
        WHERE (d.sn=? OR d.id=?) AND d.deleted_at IS NULL AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?)
        ORDER BY c.credential_epoch DESC LIMIT 2`, [deviceIdentity, deviceIdentity, now()]);
      const credential = credentials.length === 1 ? credentials[0]! : undefined;
      if (!credential) { rawToken.fill(0); deviceAuthFailed(authKey); request.log.debug({ device_identity: deviceIdentity, remote_ip: request.ip, matched_credentials: credentials.length, failure_reason: credentials.length > 1 ? 'device_identity_ambiguous' : 'credential_not_found' }, 'device websocket authentication rejected'); socket.close(1008, 'authentication failed'); return; }
      const deviceId = credential.device_id;
      if (!constantTimeHexEqual(credential.token_verifier, deviceTokenVerifier(rawToken, config.groupTokenPepper))) { rawToken.fill(0); deviceAuthFailed(authKey); request.log.debug({ device_identity: deviceIdentity, device_id: deviceId, remote_ip: request.ip, credential_id: credential.id, failure_reason: 'token_verifier_mismatch' }, 'device websocket authentication rejected'); socket.close(1008, 'authentication failed'); return; }
      let storedToken: Buffer;
      try { storedToken = decryptSecret(credential.token_ciphertext, config.masterKeys.get(credential.key_version) ?? config.masterKey, `${deviceId}:${credential.id}`); }
      catch (error) { rawToken.fill(0); deviceAuthFailed(authKey); request.log.warn({ device_identity: deviceIdentity, device_id: deviceId, credential_id: credential.id, key_version: credential.key_version, failure_reason: 'credential_decrypt_failed', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 'device websocket authentication rejected'); socket.close(1008, 'authentication failed'); return; }
      if (storedToken.byteLength !== rawToken.byteLength || !timingSafeEqual(storedToken, rawToken)) { rawToken.fill(0); storedToken.fill(0); deviceAuthFailed(authKey); request.log.debug({ device_identity: deviceIdentity, device_id: deviceId, remote_ip: request.ip, credential_id: credential.id, failure_reason: 'token_ciphertext_mismatch' }, 'device websocket authentication rejected'); socket.close(1008, 'authentication failed'); return; }
      const deviceWsUrl = resolveDeviceWsUrl({ ...(config.deviceWssUrl ? { configured: config.deviceWssUrl } : {}), ...(request.headers.host ? { requestHost: request.headers.host } : {}), advertiseHost: config.deviceAdvertiseHost, port: config.port });
      rawToken.fill(0); deviceAuthFailures.delete(authKey); const connectionEpoch = await gateway.attach(socket, deviceId, storedToken, deviceHttpBaseUrl(deviceWsUrl)); request.log.info({ device_id: deviceId, connection_epoch: connectionEpoch, upload_origin: deviceHttpBaseUrl(deviceWsUrl) }, 'device websocket authenticated'); metrics.connectionOpened(); socket.on('close', () => { request.log.info({ device_id: deviceId, connection_epoch: connectionEpoch }, 'device websocket closed'); metrics.connectionClosed(); });
    })().catch((error) => { request.log.warn({ device_identity: String(request.headers.deviceid ?? request.headers['x-device-id'] ?? ''), error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 'device websocket gateway error'); socket.close(1011,'gateway error'); });
  });

  dispatcher.start();
  reconciler.start();
  return app;
}

export async function readSetupToken(config: ServerConfig): Promise<string> {
  if (config.databaseDriver === 'postgres') throw new Error('PostgreSQL setup uses VOICECAN_SETUP_TOKEN; no local setup-token file exists');
  return (await readFile(resolve(config.dataDir, 'setup-token'), 'utf8')).trim();
}
