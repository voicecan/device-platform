#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { OPEN_PLATFORM_PERMISSIONS } from '@voicecan/contracts';

type Row = Record<string, unknown>;
type CapabilityResponse = { scopes: string[]; api_version: string; channel: string; features: Row };

export function assertStdioCapabilityChannel(capabilities: Pick<CapabilityResponse, 'channel'>): void {
  if (capabilities.channel !== 'mcp_stdio') throw new Error('VOICECAN_APPLICATION_TOKEN must be an mcp_stdio_token credential');
}

const serverUrl = process.env.VOICECAN_DEVICE_SERVER_URL?.replace(/\/$/, '');
const token = process.env.VOICECAN_APPLICATION_TOKEN;
const maxItems = boundedEnvironmentInteger('VOICECAN_MCP_MAX_ITEMS', 20, 1, 50);
const timeoutMs = boundedEnvironmentInteger('VOICECAN_MCP_REQUEST_TIMEOUT_MS', 10_000, 100, 120_000);
const logLevel = process.env.VOICECAN_MCP_LOG_LEVEL ?? 'warn';
const MODERN_MCP_VERSION = '2026-07-28';
const LEGACY_MCP_VERSION = '2025-11-25';
const SUPPORTED_MCP_VERSIONS = [MODERN_MCP_VERSION, LEGACY_MCP_VERSION] as const;

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`); return value;
}
function log(message: string): void { if (logLevel !== 'silent') process.stderr.write(`[voicecan-device-mcp] ${message}\n`); }
function required(value: Row, key: string): string { const candidate = value[key]; if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${key} is required`); return candidate.trim(); }

class ApiClient {
  constructor(private readonly baseUrl: string, private readonly bearer: string) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${this.bearer}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
    const payload = await response.json() as { success?: boolean; code?: string; message?: string; data?: T };
    if (!response.ok || !payload.success) throw new Error(`${payload.code ?? 'REQUEST_FAILED'}: ${payload.message ?? `HTTP ${response.status}`}`);
    return payload.data as T;
  }
}

const TOOL_DEFINITIONS = [
  ['voicecan.devices.list', 'devices:read', 'List authorized device metadata.', true, false, { type: 'object', properties: {}, additionalProperties: false }],
  ['voicecan.devices.get', 'devices:read', 'Get authorized device metadata.', true, false, { type: 'object', properties: { device_id: { type: 'string' } }, required: ['device_id'], additionalProperties: false }],
  ['voicecan.devices.get_capabilities', 'devices:read', 'Get the reviewed public capability manifest for a device.', true, false, { type: 'object', properties: { device_id: { type: 'string' } }, required: ['device_id'], additionalProperties: false }],
  ['voicecan.devices.sync', 'devices:sync', 'Request an idempotent device synchronization.', false, false, { type: 'object', properties: { device_id: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['device_id', 'idempotency_key', 'reason'], additionalProperties: false }],
  ['voicecan.commands.get', 'commands:read', 'Get command state.', true, false, { type: 'object', properties: { command_id: { type: 'string' } }, required: ['command_id'], additionalProperties: false }],
  ['voicecan.recordings.search', 'recordings:read', 'Search recording metadata without bytes or URLs.', true, false, { type: 'object', properties: { device_id: { type: 'string' }, status: { type: 'string' }, attribute: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' }, search: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false }],
  ['voicecan.recordings.get', 'recordings:read', 'Get recording metadata without bytes or a URL.', true, false, { type: 'object', properties: { recording_id: { type: 'string' } }, required: ['recording_id'], additionalProperties: false }],
  ['voicecan.recordings.create_download_link', 'recordings:download_link:create', 'Create a sensitive short-lived external recording URL.', false, false, { type: 'object', properties: { recording_id: { type: 'string' }, ttl_seconds: { type: 'integer', minimum: 60, maximum: 900 }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['recording_id', 'idempotency_key', 'reason'], additionalProperties: false }],
  ['voicecan.recordings.revoke_download_link', 'recordings:download_link:revoke', 'Revoke an Application download grant.', false, true, { type: 'object', properties: { grant_id: { type: 'string' }, reason: { type: 'string' } }, required: ['grant_id', 'reason'], additionalProperties: false }],
  ['voicecan.events.list', 'events:read', 'List authorized event metadata.', true, false, { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, event_type: { type: 'string' }, device_id: { type: 'string' }, from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } }, additionalProperties: false }],
] as const;

export function toolList(scopes: ReadonlySet<string>) {
  return TOOL_DEFINITIONS.filter((definition) => scopes.has(definition[1])).map(([name, _scope, description, readOnlyHint, destructiveHint, inputSchema]) => ({ name, description, inputSchema, annotations: { title: name, readOnlyHint, destructiveHint, idempotentHint: !readOnlyHint, openWorldHint: name.includes('download_link') } }));
}

function modernRequest(params: Row): boolean {
  const meta = params._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const metadata = meta as Row;
  return metadata['io.modelcontextprotocol/protocolVersion'] === MODERN_MCP_VERSION
    && typeof metadata['io.modelcontextprotocol/clientCapabilities'] === 'object'
    && typeof metadata['io.modelcontextprotocol/clientInfo'] === 'object';
}

function complete(modern: boolean, value: Row): Row { return modern ? { resultType: 'complete', ...value } : value; }

function queryString(args: Row): string {
  const query = new URLSearchParams(); for (const key of ['device_id', 'status', 'attribute', 'from', 'to', 'search', 'cursor', 'limit']) if (args[key] !== undefined) query.set(key, String(args[key])); if (!query.has('limit')) query.set('limit', String(maxItems)); return query.toString();
}

async function callTool(client: ApiClient, name: string, args: Row): Promise<unknown> {
  if (name === 'voicecan.devices.list') return client.request('/devices');
  if (name === 'voicecan.devices.get') return client.request(`/devices/${encodeURIComponent(required(args, 'device_id'))}`);
  if (name === 'voicecan.devices.get_capabilities') return client.request(`/devices/${encodeURIComponent(required(args, 'device_id'))}/capabilities`);
  if (name === 'voicecan.devices.sync') return client.request(`/devices/${encodeURIComponent(required(args, 'device_id'))}/sync`, { method: 'POST', headers: { 'idempotency-key': required(args, 'idempotency_key') }, body: '{}' });
  if (name === 'voicecan.commands.get') return client.request(`/commands/${encodeURIComponent(required(args, 'command_id'))}`);
  if (name === 'voicecan.recordings.search') return client.request(`/recordings?${queryString(args)}`);
  if (name === 'voicecan.recordings.get') return client.request(`/recordings/${encodeURIComponent(required(args, 'recording_id'))}`);
  if (name === 'voicecan.recordings.create_download_link') return client.request(`/recordings/${encodeURIComponent(required(args, 'recording_id'))}/download-links`, { method: 'POST', headers: { 'idempotency-key': required(args, 'idempotency_key') }, body: JSON.stringify({ purpose: 'download', ...(args.ttl_seconds === undefined ? {} : { ttl_seconds: Number(args.ttl_seconds) }), reason: required(args, 'reason') }) });
  if (name === 'voicecan.recordings.revoke_download_link') return client.request(`/recording-download-grants/${encodeURIComponent(required(args, 'grant_id'))}/revoke`, { method: 'POST', body: JSON.stringify({ reason: required(args, 'reason') }) });
  if (name === 'voicecan.events.list') return client.request(`/events?${queryString(args)}`);
  throw new Error('Tool not found');
}

export async function runStdio(): Promise<void> {
  if ((process.argv[2] ?? 'stdio') !== 'stdio') throw new Error('Usage: voicecan-device-mcp stdio');
  if (!serverUrl || !/^https?:\/\//.test(serverUrl)) throw new Error('VOICECAN_DEVICE_SERVER_URL is required');
  if (!token || !token.startsWith('vcd_app_')) throw new Error('VOICECAN_APPLICATION_TOKEN is required');
  const client = new ApiClient(serverUrl, token); const capabilities = await client.request<CapabilityResponse>('/capabilities'); assertStdioCapabilityChannel(capabilities); const scopes = new Set(capabilities.scopes); const catalog = new Set(OPEN_PLATFORM_PERMISSIONS.map((permission) => permission.code)); if ([...scopes].some((scope) => !catalog.has(scope as never))) log('Server returned an unknown permission; it will not register a tool.');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false }); let legacyInitialized = false;
  for await (const line of lines) {
    if (!line.trim()) continue; let request: Row;
    try { request = JSON.parse(line) as Row; } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue; }
    const rpcId = request.id; const method = request.method; const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params as Row : {};
    try {
      let result: unknown;
      if (method === 'initialize') { legacyInitialized = true; result = { protocolVersion: LEGACY_MCP_VERSION, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: '@voicecan/device-mcp', version: '0.1.0-preview.0' } }; }
      else if (method === 'notifications/initialized') { if (!legacyInitialized) throw new Error('Legacy MCP is not initialized'); continue; }
      else {
        const modern = modernRequest(params);
        const meta = params._meta as Row | undefined; const requestedVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
        if (!modern && !legacyInitialized) {
          result = undefined;
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpcId ?? null, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [...SUPPORTED_MCP_VERSIONS], requested: requestedVersion ?? null } } })}\n`);
          continue;
        }
        if (method === 'server/discover') result = complete(true, { supportedVersions: [...SUPPORTED_MCP_VERSIONS], capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: '@voicecan/device-mcp', version: '0.1.0-preview.0' } }, instructions: 'Voicecan device and recording metadata; recording bytes are exposed only through short-lived external links.', ttlMs: 300_000, cacheScope: 'private' });
        else if (method === 'tools/list') result = complete(modern, { tools: toolList(scopes), ...(modern ? { ttlMs: 60_000, cacheScope: 'private' } : {}) });
        else if (method === 'tools/call') { const name = required(params, 'name'); const definition = TOOL_DEFINITIONS.find((candidate) => candidate[0] === name); if (!definition || !scopes.has(definition[1])) throw new Error('Tool not found'); const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Row : {}; const value = await callTool(client, name, args); result = complete(modern, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Row, isError: false }); }
        else if (method === 'resources/list') result = complete(modern, { resources: [{ uri: 'voicecan://platform/capabilities', name: 'Voicecan platform capabilities', mimeType: 'application/json' }, ...(scopes.has('devices:read') ? [{ uri: 'voicecan://devices', name: 'Authorized devices', mimeType: 'application/json' }] : []), ...(scopes.has('recordings:read') ? [{ uri: 'voicecan://recordings', name: 'Authorized recording metadata', mimeType: 'application/json' }] : [])], ...(modern ? { ttlMs: 60_000, cacheScope: 'private' } : {}) });
        else if (method === 'resources/read') { const uri = required(params, 'uri'); let value: unknown; if (uri === 'voicecan://platform/capabilities') value = capabilities; else if (uri === 'voicecan://devices') value = await client.request('/devices'); else if (uri === 'voicecan://recordings') value = await client.request(`/recordings?limit=${maxItems}`); else if (uri.startsWith('voicecan://devices/')) value = await client.request(`/devices/${encodeURIComponent(uri.slice('voicecan://devices/'.length))}`); else if (uri.startsWith('voicecan://recordings/')) value = await client.request(`/recordings/${encodeURIComponent(uri.slice('voicecan://recordings/'.length))}`); else throw new Error('Resource not found'); result = complete(modern, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] }); }
        else throw new Error('Method not found');
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result })}\n`);
    } catch (error) { const message = error instanceof Error ? error.message : 'Request failed'; process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpcId ?? null, error: { code: method === 'tools/call' ? -32000 : -32601, message } })}\n`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runStdio().catch((error) => { log(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
