import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  API_VERSION, VoicecanApiError,
  type ApiFailure, type ApiSuccess, type CursorPage, type Device, type DeviceCapabilityManifest,
  type DeviceEvent, type PublicCommand, type RecordingDownloadLink, type RecordingFile, type RecordingMediaDescriptor,
} from '@voicecan/contracts';

type ClientOptions = {
  baseUrl: string;
  applicationToken?: string;
  /** @deprecated Create an Application credential and use applicationToken. */
  groupToken?: string;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
};
type FileListQuery = { status?: string; deviceId?: string; attribute?: number; from?: string; to?: string; search?: string; cursor?: string; limit?: number };
type RecordingDownloadOptions = { signal?: AbortSignal; onProgress?: (progress: { received: number; total: number }) => void; idempotencyKey?: string; ttlSeconds?: number; reason?: string };
type EventListQuery = { cursor?: string; eventType?: string; deviceId?: string; from?: string; to?: string; limit?: number };

export const KNOWN_RECORDING_CONTENT_TYPES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/lc3',
]);

export type RecordingMediaAssessment =
  | { usable: true; reason: null }
  | { usable: false; reason: 'MEDIA_SOURCE_UNKNOWN' | 'MEDIA_BINARY_FALLBACK' | 'MEDIA_DECLARATION_INCOMPLETE' };

export function assessRecordingMedia(media: RecordingMediaDescriptor): RecordingMediaAssessment {
  if (media.source === 'unknown') return { usable: false, reason: 'MEDIA_SOURCE_UNKNOWN' };
  if (media.filename_extension.toLowerCase() === 'bin' || media.content_type.toLowerCase() === 'application/octet-stream') {
    return { usable: false, reason: 'MEDIA_BINARY_FALLBACK' };
  }
  if (KNOWN_RECORDING_CONTENT_TYPES.has(media.content_type.toLowerCase()) || Boolean(media.codec && media.container)) {
    return { usable: true, reason: null };
  }
  return { usable: false, reason: 'MEDIA_DECLARATION_INCOMPLETE' };
}

export function isKnownRecordingMedia(media: RecordingMediaDescriptor): boolean {
  return assessRecordingMedia(media).usable;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class VoicecanDeviceServer {
  readonly files: {
    list: (query?: FileListQuery) => AsyncGenerator<RecordingFile>;
    downloadToFile: (fileId: string, destination: string) => Promise<void>;
    open: (fileId: string, range?: { start: number; end?: number }) => Promise<ReadableStream<Uint8Array>>;
  };
  readonly recordings: {
    list: (query?: FileListQuery) => AsyncGenerator<RecordingFile>;
    get: (recordingId: string) => Promise<RecordingFile>;
    createDownloadLink: (recordingId: string, options?: { ttlSeconds?: number; purpose?: 'download'; reason?: string; idempotencyKey?: string }) => Promise<RecordingDownloadLink>;
    revokeDownloadLink: (grantId: string, reason?: string) => Promise<{ grant_id: string; revoked: true }>;
    getDownloadGrant: (grantId: string) => Promise<Record<string, unknown>>;
    downloadToFile: (recordingId: string, destination: string, options?: RecordingDownloadOptions) => Promise<void>;
    retry: (recordingId: string, reason?: string) => Promise<Record<string, unknown>>;
  };
  readonly devices: { list: () => Promise<Device[]>; get: (deviceId: string) => Promise<Device>; getCapabilities: (deviceId: string) => Promise<DeviceCapabilityManifest>; getRecordingSync: (deviceId: string) => Promise<Record<string, unknown>>; resetRecordingSync: (deviceId: string, options?: { mode?: 'failed' | 'failed_and_stale'; reason?: string }) => Promise<Record<string, unknown>>; sync: (deviceId: string, idempotencyKey?: string) => Promise<PublicCommand>; command: (deviceId: string, kind: 'sync', idempotencyKey?: string) => Promise<PublicCommand>; commandStatus: (commandId: string) => Promise<PublicCommand>; waitForCommand: (commandId: string, options?: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal }) => Promise<PublicCommand> };
  readonly events: { list: (query?: EventListQuery) => Promise<CursorPage<DeviceEvent>>; iterate: (query?: EventListQuery) => AsyncGenerator<DeviceEvent> };
  #fetch: typeof globalThis.fetch;
  #baseUrl: string;
  #token: string;
  #maxRetries: number;

  constructor(options: ClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    const credential = options.applicationToken ?? options.groupToken;
    if (!credential) throw new Error('applicationToken is required');
    this.#token = credential;
    this.#maxRetries = options.maxRetries ?? 3;
    this.files = {
      list: (query) => this.#listFiles(query),
      downloadToFile: (fileId, destination) => this.#download(fileId, destination),
      open: (fileId, range) => this.#open(fileId, range),
    };
    this.recordings = {
      list: (query) => this.#listRecordings(query),
      get: (recordingId) => this.#request(`/recordings/${encodeURIComponent(recordingId)}`),
      createDownloadLink: (recordingId, linkOptions = {}) => this.#request(`/recordings/${encodeURIComponent(recordingId)}/download-links`, { method: 'POST', headers: { 'Idempotency-Key': linkOptions.idempotencyKey ?? crypto.randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify({ purpose: linkOptions.purpose ?? 'download', ...(linkOptions.ttlSeconds === undefined ? {} : { ttl_seconds: linkOptions.ttlSeconds }), reason: linkOptions.reason ?? 'SDK requested recording download' }) }),
      revokeDownloadLink: (grantId, reason = 'SDK revoked recording download') => this.#request(`/recording-download-grants/${encodeURIComponent(grantId)}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }),
      getDownloadGrant: (grantId) => this.#request(`/recording-download-grants/${encodeURIComponent(grantId)}`),
      downloadToFile: (recordingId, destination, downloadOptions) => this.#downloadViaGrant(recordingId, destination, downloadOptions),
      retry: (recordingId, reason = 'SDK retried recording synchronization') => this.#request(`/recordings/${encodeURIComponent(recordingId)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }),
    };
    this.devices = {
      list: () => this.#request<Device[]>('/devices'),
      get: (deviceId) => this.#request<Device>(`/devices/${encodeURIComponent(deviceId)}`),
      getCapabilities: (deviceId) => this.#request<DeviceCapabilityManifest>(`/devices/${encodeURIComponent(deviceId)}/capabilities`),
      getRecordingSync: (deviceId) => this.#request(`/devices/${encodeURIComponent(deviceId)}/recording-sync`),
      resetRecordingSync: (deviceId, resetOptions = {}) => this.#request(`/devices/${encodeURIComponent(deviceId)}/recording-sync/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: resetOptions.mode ?? 'failed', reason: resetOptions.reason ?? 'SDK reset recording synchronization' }) }),
      sync: (deviceId, key = crypto.randomUUID()) => this.#request<PublicCommand>(`/devices/${encodeURIComponent(deviceId)}/sync`, {
        method: 'POST', headers: { 'Idempotency-Key': key },
      }),
      command: (deviceId, kind, key = crypto.randomUUID()) => this.#request<PublicCommand>(`/devices/${encodeURIComponent(deviceId)}/commands`, { method: 'POST', headers: { 'Idempotency-Key': key, 'content-type': 'application/json' }, body: JSON.stringify({ kind }) }),
      commandStatus: (commandId) => this.#request<PublicCommand>(`/commands/${encodeURIComponent(commandId)}`),
      waitForCommand: (commandId, waitOptions) => this.#waitForCommand(commandId, waitOptions),
    };
    this.events = {
      list: (query = {}) => this.#listEventsPage(query),
      iterate: (query = {}) => this.#iterateEvents(query),
    };
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let attempt = 0;
    while (true) {
      const response = await this.#fetch(`${this.#baseUrl}/api/v1${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json', ...init.headers },
      });
      if ((response.status === 429 || response.status >= 500) && attempt < this.#maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 0);
        await sleep(retryAfter > 0 ? retryAfter * 1_000 : 100 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      const payload = await response.json() as ApiSuccess<T> | ApiFailure;
      if (!response.ok || !payload.success) {
        const failure = payload as ApiFailure;
        throw new VoicecanApiError(response.status, failure.code, failure.message, failure.request_id);
      }
      return payload.data;
    }
  }

  async *#listFiles(query: FileListQuery = {}): AsyncGenerator<RecordingFile> {
    let cursor: string | undefined = query.cursor;
    do {
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      if (query.deviceId) params.set('device_id', query.deviceId);
      if (query.attribute !== undefined) params.set('attribute', String(query.attribute));
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      if (query.search) params.set('search', query.search);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (cursor) params.set('cursor', cursor);
      const page = await this.#request<CursorPage<RecordingFile>>(`/files?${params.toString()}`);
      yield* page.items;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  async *#listRecordings(query: FileListQuery = {}): AsyncGenerator<RecordingFile> {
    let cursor: string | undefined = query.cursor;
    do {
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      if (query.deviceId) params.set('device_id', query.deviceId);
      if (query.attribute !== undefined) params.set('attribute', String(query.attribute));
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      if (query.search) params.set('search', query.search);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (cursor) params.set('cursor', cursor);
      const page = await this.#request<CursorPage<RecordingFile>>(`/recordings?${params.toString()}`);
      yield* page.items;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  async #open(fileId: string, range?: { start: number; end?: number }): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#fetch(`${this.#baseUrl}/api/v1/files/${encodeURIComponent(fileId)}/content`, {
      headers: { authorization: `Bearer ${this.#token}`, ...(range ? { range: `bytes=${range.start}-${range.end ?? ''}` } : {}) },
    });
    if (!response.ok || !response.body) throw new VoicecanApiError(response.status, 'DOWNLOAD_FAILED', 'File download failed');
    return response.body;
  }

  async #download(fileId: string, destination: string): Promise<void> {
    if (this.#token.startsWith('vcd_app_')) return this.#downloadViaGrant(fileId, destination);
    const body = await this.#open(fileId);
    await pipeline(Readable.from(body as unknown as AsyncIterable<Uint8Array>), createWriteStream(destination, { flags: 'wx' }));
  }

  async #downloadViaGrant(recordingId: string, destination: string, options: RecordingDownloadOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const grant = await this.recordings.createDownloadLink(recordingId, {
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      ...(options.reason ? { reason: options.reason } : {}),
    });
    const response = await this.#fetch(grant.download_url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) });
    if ([401, 403, 404, 410].includes(response.status)) throw new VoicecanApiError(response.status, 'TEMPORARY_DOWNLOAD_EXPIRED', 'Temporary recording URL is invalid or expired; create a new Grant with a new idempotency key');
    if (!response.ok || !response.body) throw new VoicecanApiError(response.status, 'DOWNLOAD_FAILED', 'Temporary recording download failed');
    const temporary = `${destination}.voicecan-${randomUUID()}.tmp`;
    const digest = createHash('sha256'); let bytes = 0;
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.byteLength; digest.update(chunk); options.onProgress?.({ received: bytes, total: grant.content_length }); callback(null, chunk); } });
    try {
      await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const actualSha256 = digest.digest('hex');
      if (bytes !== grant.content_length) throw new VoicecanApiError(422, 'DOWNLOAD_LENGTH_MISMATCH', `Expected ${grant.content_length} bytes but received ${bytes}`);
      if (grant.sha256 && actualSha256 !== grant.sha256) throw new VoicecanApiError(422, 'DOWNLOAD_SHA256_MISMATCH', 'Downloaded recording checksum does not match');
      await link(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }

  #listEventsPage(query: EventListQuery): Promise<CursorPage<DeviceEvent>> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor); if (query.eventType) params.set('event_type', query.eventType);
    if (query.deviceId) params.set('device_id', query.deviceId); if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to); if (query.limit !== undefined) params.set('limit', String(query.limit));
    return this.#request(`/events${params.size ? `?${params}` : ''}`);
  }

  async *#iterateEvents(query: EventListQuery): AsyncGenerator<DeviceEvent> {
    let cursor = query.cursor;
    do {
      const page = await this.#listEventsPage({ ...query, ...(cursor ? { cursor } : {}) });
      yield* page.items;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  async #waitForCommand(commandId: string, options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {}): Promise<PublicCommand> {
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    while (true) {
      options.signal?.throwIfAborted();
      const command = await this.devices.commandStatus(commandId);
      if (['succeeded', 'failed', 'expired'].includes(command.status)) return command;
      if (Date.now() >= deadline) throw new VoicecanApiError(408, 'COMMAND_WAIT_TIMEOUT', 'Timed out waiting for command completion');
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, options.pollIntervalMs ?? 1_000); options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal!.reason); }, { once: true }); });
    }
  }
}

export function verifyEventSignature(input: {
  rawBody: Uint8Array;
  timestamp: string;
  deliveryId: string;
  signature: string;
  secret: string;
  now?: number;
  toleranceSeconds?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const timestampMs = Number(input.timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > (input.toleranceSeconds ?? 300) * 1_000) return false;
  const expected = createHmac('sha256', input.secret)
    .update(input.timestamp).update('.').update(input.deliveryId).update('.').update(input.rawBody).digest('hex');
  const supplied = input.signature.replace(/^v1=/, '');
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(supplied, 'ascii'));
}

export function verifyEventSignatureWithSecrets(input: Omit<Parameters<typeof verifyEventSignature>[0], 'secret'> & { secrets: readonly string[] }): boolean {
  return input.secrets.some((secret) => verifyEventSignature({ ...input, secret }));
}

export class VoicecanWebhookError extends Error {
  readonly code: 'WEBHOOK_SIGNATURE_INVALID' | 'EVENT_JSON_INVALID' | 'EVENT_SCHEMA_INVALID';
  readonly status: 400 | 401;

  constructor(code: VoicecanWebhookError['code']) {
    super(code);
    this.name = 'VoicecanWebhookError';
    this.code = code;
    this.status = code === 'WEBHOOK_SIGNATURE_INVALID' ? 401 : 400;
  }
}

type WebhookHeaders = Headers | Readonly<Record<string, string | string[] | number | undefined>>;

function webhookHeader(headers: WebhookHeaders, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(entry) ? String(entry[0] ?? '') : String(entry ?? '');
}

export function parseVerifiedDeviceEvent(input: {
  rawBody: Uint8Array;
  headers: WebhookHeaders;
  secrets: readonly string[];
  now?: number;
  toleranceSeconds?: number;
}): DeviceEvent {
  const secrets = input.secrets.filter(Boolean);
  const verified = secrets.length > 0 && verifyEventSignatureWithSecrets({
    rawBody: input.rawBody,
    timestamp: webhookHeader(input.headers, 'voicecan-timestamp'),
    deliveryId: webhookHeader(input.headers, 'voicecan-delivery-id'),
    signature: webhookHeader(input.headers, 'voicecan-signature'),
    secrets,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.toleranceSeconds === undefined ? {} : { toleranceSeconds: input.toleranceSeconds }),
  });
  if (!verified) throw new VoicecanWebhookError('WEBHOOK_SIGNATURE_INVALID');

  let value: unknown;
  try { value = JSON.parse(Buffer.from(input.rawBody).toString('utf8')) as unknown; }
  catch { throw new VoicecanWebhookError('EVENT_JSON_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VoicecanWebhookError('EVENT_SCHEMA_INVALID');
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 200
    || typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 200
    || event.api_version !== API_VERSION
    || typeof event.created_at !== 'string' || Number.isNaN(Date.parse(event.created_at))
    || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new VoicecanWebhookError('EVENT_SCHEMA_INVALID');
  }
  return value as DeviceEvent;
}
