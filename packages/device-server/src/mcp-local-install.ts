import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenPlatformError } from './open-platform.js';
const execute = promisify(execFile);
export type McpEntry = { command: string; args: string[] };
function localEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'USER', 'TMPDIR', 'SystemRoot', 'APPDATA'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
}
async function codex(args: string[]): Promise<string> {
  try { return (await execute('codex', args, { timeout: 15_000, maxBuffer: 1_048_576, env: localEnvironment() })).stdout; }
  catch (error) { throw new OpenPlatformError(409, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'CODEX_CLI_NOT_FOUND' : 'CODEX_CONFIGURATION_FAILED', 'Codex setup failed. Check that the Codex CLI is installed and its configuration is writable.'); }
}
function matching(value: any, entry: McpEntry): boolean {
  return value?.enabled !== false && value?.transport?.type === 'stdio' && value.transport.command === entry.command && JSON.stringify(value.transport.args) === JSON.stringify(entry.args) && !Object.keys(value.transport.env ?? {}).length && !(value.transport.env_vars?.length) && !value.transport.cwd;
}
let installationQueue: Promise<unknown> = Promise.resolve();
export function installCodexMcp(entry: McpEntry, run = codex, name = 'voicecan_elio'): Promise<'installed' | 'already_installed'> {
  const result = installationQueue.then(() => performInstall(entry, run, name), () => performInstall(entry, run, name));
  installationQueue = result.catch(() => undefined);
  return result;
}
async function performInstall(entry: McpEntry, run: (args: string[]) => Promise<string>, name: string): Promise<'installed' | 'already_installed'> {
  let existing: any;
  try { const list = JSON.parse(await run(['mcp', 'list', '--json'])); if (!Array.isArray(list)) throw new Error(); existing = list.find((item: any) => item.name === name); }
  catch (error) { if (error instanceof OpenPlatformError) throw error; throw new OpenPlatformError(409, 'CODEX_CONFIGURATION_FAILED', 'Could not inspect existing Codex MCP configuration.'); }
  if (existing) {
    if (!matching(existing, entry)) throw new OpenPlatformError(409, 'MCP_NAME_CONFLICT', `MCP server ${name} already exists with a different configuration. It was not overwritten.`);
    return 'already_installed';
  }
  await run(['mcp', 'add', name, '--', entry.command, ...entry.args]);
  let saved: unknown;
  try { saved = JSON.parse(await run(['mcp', 'get', name, '--json'])); } catch { /* Report only a safe error code below. */ }
  if (!matching(saved, entry)) throw new OpenPlatformError(409, 'MCP_INSTALL_VERIFICATION_FAILED', 'Codex did not confirm the expected MCP configuration.');
  return 'installed';
}
/** Exercises the generated runner and its authenticated API access, without recording content. */
export async function verifyLocalMcp(entry: McpEntry): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, { env: localEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = ''; let finished = false; let initialized = false; let toolCount = 0;
    const finish = (count?: number): void => { if (finished) return; finished = true; clearTimeout(timer); child.stdin.end(); child.kill(); if (count !== undefined) resolve(count); else reject(new OpenPlatformError(409, 'MCP_HEALTH_CHECK_FAILED', 'MCP did not complete its startup and authorized tool check. Verify the local service and credential.')); };
    const timer = setTimeout(() => finish(), 15_000);
    child.once('error', () => finish()); child.once('exit', () => finish()); child.stdin.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString(); if (buffer.length > 262_144) { finish(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (response.error) { finish(); return; }
          if (response.id === 1 && response.result?.serverInfo?.name === '@voicecan/device-mcp') {
            initialized = true;
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          } else if (response.id === 2 && initialized && Array.isArray(response.result?.tools) && response.result.tools.length) {
            toolCount=response.result.tools.length;
            child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'voicecan.recordings.search',arguments:{status:'synced',limit:1}}})+'\n');
          } else if(response.id===3 && toolCount){
            if(response.result?.isError){finish();return;}
            const data=response.result?.structuredContent ?? (response.result?.content?.[0]?.text ? JSON.parse(response.result.content[0].text) : undefined);
            if(Array.isArray(data?.items))finish(toolCount);else finish();
          }
        } catch { finish(); return; }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'voicecan-setup-check', version: '1' } } }) + '\n');
  });
}
