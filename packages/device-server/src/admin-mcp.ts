import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CLI_CAPABILITIES } from './cli-contract.js';

type Row = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Row; annotations: Row; command: (args: Row) => string[] };

const objectSchema = (properties: Row, required: string[] = []): Row => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const string = { type: 'string' };

const TOOLS: readonly Tool[] = [
  { name: 'voicecan.admin.runtime.status', description: 'Read the background service status.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, destructiveHint: false }, command: () => ['service', 'status'] },
  { name: 'voicecan.admin.doctor', description: 'Run installation and runtime diagnostics.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, destructiveHint: false }, command: () => ['doctor'] },
  { name: 'voicecan.admin.config.list', description: 'Read the sanitized active Profile configuration.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, destructiveHint: false }, command: () => ['config', 'list'] },
  { name: 'voicecan.admin.config.set', description: 'Atomically set one supported Profile configuration value.', inputSchema: objectSchema({ key: string, value: string, dry_run: { type: 'boolean' } }, ['key', 'value']), annotations: { readOnlyHint: false, destructiveHint: false }, command: (args) => compact(['config', 'set', args.key, args.value, ...(args.dry_run === true ? ['--dry-run'] : [])]) },
  { name: 'voicecan.admin.devices.list', description: 'List devices visible to the local operator.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, destructiveHint: false }, command: () => ['device', 'list'] },
  { name: 'voicecan.admin.devices.get', description: 'Read one device.', inputSchema: objectSchema({ device_id: string }, ['device_id']), annotations: { readOnlyHint: true, destructiveHint: false }, command: (args) => ['device', 'get', String(args.device_id)] },
  { name: 'voicecan.admin.devices.status', description: 'Read the latest server-side device status.', inputSchema: objectSchema({ device_id: string }, ['device_id']), annotations: { readOnlyHint: true, destructiveHint: false }, command: (args) => ['device', 'status', String(args.device_id)] },
  { name: 'voicecan.admin.devices.sync', description: 'Request idempotent recording synchronization.', inputSchema: objectSchema({ device_id: string, idempotency_key: string }, ['device_id', 'idempotency_key']), annotations: { readOnlyHint: false, destructiveHint: false }, command: (args) => ['device', 'sync', String(args.device_id), '--idempotency-key', String(args.idempotency_key)] },
  { name: 'voicecan.admin.devices.bind_prepare', description: 'Prepare device binding and open the browser for the user-only Bluetooth selection.', inputSchema: objectSchema({ group_id: string, expected_sn: string, display_name: string, server_url: string, network: { type: 'string', enum: ['existing', 'ask'] }, locale: { type: 'string', enum: ['en', 'zh-CN'] }, idempotency_key: string }, ['group_id']), annotations: { readOnlyHint: false, destructiveHint: false }, command: (args) => compact(['device', 'bind', 'prepare', '--group', args.group_id, '--expected-sn', args.expected_sn, '--display-name', args.display_name, '--server-url', args.server_url, '--network', args.network, '--locale', args.locale, '--idempotency-key', args.idempotency_key]) },
  { name: 'voicecan.admin.devices.bind_status', description: 'Read an authoritative binding intent state.', inputSchema: objectSchema({ binding_id: string }, ['binding_id']), annotations: { readOnlyHint: true, destructiveHint: false }, command: (args) => ['device', 'bind', 'status', String(args.binding_id)] },
  { name: 'voicecan.admin.devices.bind_wait', description: 'Wait until a prepared device binding completes or fails.', inputSchema: objectSchema({ binding_id: string, timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600 } }, ['binding_id']), annotations: { readOnlyHint: true, destructiveHint: false }, command: (args) => compact(['device', 'bind', 'wait', args.binding_id, '--timeout', args.timeout_seconds]) },
  { name: 'voicecan.admin.applications.list', description: 'List Applications visible to the local operator.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, destructiveHint: false }, command: () => ['app', 'list'] },
  { name: 'voicecan.admin.applications.create', description: 'Create a least-privilege Application.', inputSchema: objectSchema({ group_id: string, name: string, description: string, environment: { type: 'string', enum: ['development', 'staging', 'production'] }, channels: { type: 'array', items: string }, permissions: { type: 'array', items: string }, reason: string }, ['group_id', 'name']), annotations: { readOnlyHint: false, destructiveHint: false }, command: (args) => compact(['app', 'create', '--group', args.group_id, '--name', args.name, '--description', args.description, '--environment', args.environment, '--channels', csv(args.channels), '--permissions', csv(args.permissions), '--reason', args.reason]) },
  { name: 'voicecan.admin.mcp.connect', description: 'Create an owner-only MCP credential reference and return a secret-free Host configuration.', inputSchema: objectSchema({ application_id: string, client: { type: 'string', enum: ['generic', 'codex', 'claude', 'openclaw'] }, scopes: { type: 'array', items: string }, reason: string }, ['application_id']), annotations: { readOnlyHint: false, destructiveHint: false }, command: (args) => compact(['mcp', 'connect', '--application', args.application_id, '--client', args.client, '--scopes', csv(args.scopes), '--reason', args.reason]) },
];

function csv(value: unknown): string | undefined { return Array.isArray(value) ? value.map(String).join(',') : undefined; }
function compact(values: unknown[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value === 'string' && value.startsWith('--') && (values[index + 1] === undefined || values[index + 1] === null || values[index + 1] === '')) { index += 1; continue; }
    if (value !== undefined && value !== null && value !== '') result.push(String(value));
  }
  return result;
}

async function invokeCli(profile: string, args: string[]): Promise<Row> {
  const entry = process.argv[1]; if (!entry) throw new Error('CLI entrypoint is unavailable');
  const child = spawn(process.execPath, [entry, ...args, '--profile', profile, '--output', 'json', '--non-interactive'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('exit', (value) => resolveExit(value ?? 1)); });
  let envelope: Row;
  try { envelope = JSON.parse(stdout.trim()) as Row; }
  catch { throw new Error(stderr.trim() || `CLI returned invalid JSON (exit ${code})`); }
  return envelope;
}

export async function runAdminMcp(profile: string): Promise<void> {
  const registeredCapabilities = new Set(CLI_CAPABILITIES.map((item) => item.name));
  if (!registeredCapabilities.has('device.bind.prepare') || !registeredCapabilities.has('app.create')) throw new Error('Admin MCP capability catalog is incomplete');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let initialized = false;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Row;
    try { request = JSON.parse(line) as Row; }
    catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue; }
    const rpcId = request.id ?? null;
    try {
      if (request.method === 'notifications/initialized') { initialized = true; continue; }
      let result: unknown;
      if (request.method === 'initialize') { initialized = true; result = { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: '@voicecan/device-platform-admin', version: '1.0.0' }, instructions: 'Local owner-only administration. Bluetooth selection is always performed by the user in the browser.' }; }
      else {
        if (!initialized) throw new Error('MCP is not initialized');
        if (request.method === 'tools/list') result = { tools: TOOLS.map(({ command: _command, ...tool }) => tool) };
        else if (request.method === 'tools/call') {
          const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params as Row : {};
          const tool = TOOLS.find((candidate) => candidate.name === params.name); if (!tool) throw new Error('Tool not found');
          const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Row : {};
          const envelope = await invokeCli(profile, tool.command(args));
          result = { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: envelope.ok !== true };
        } else throw new Error('Method not found');
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
    }
  }
}
