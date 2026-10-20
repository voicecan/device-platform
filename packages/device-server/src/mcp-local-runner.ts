import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Loads an owner-only Application token into this process and speaks MCP on stdio. */
export async function runLocalCredentialMcp(secretRef: string, serverUrl: string): Promise<void> {
  if (!secretRef || !serverUrl) throw new Error('MCP configuration is incomplete');
  const info = await stat(secretRef);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('MCP credential file must be owner-only');
  const token = (await readFile(secretRef, 'utf8')).trim();
  if (!token.startsWith('vcd_app_')) throw new Error('MCP credential file is invalid');
  process.env.VOICECAN_DEVICE_SERVER_URL = serverUrl;
  process.env.VOICECAN_APPLICATION_TOKEN = token;
  const runtime = await import(new URL('../../device-mcp/dist/index.js', import.meta.url).href) as { runStdio(): Promise<void> };
  await runtime.runStdio();
}

async function main(): Promise<void> {
  const args = process.argv;
  const secretRef = args[args.indexOf('--credential-ref') + 1];
  const serverUrl = args[args.indexOf('--server-url') + 1];
  if (!args.includes('--credential-ref') || !secretRef || !args.includes('--server-url') || !serverUrl) throw new Error('MCP configuration is incomplete');
  await runLocalCredentialMcp(secretRef, serverUrl);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main().catch(() => { process.stderr.write('Voicecan MCP could not start. Check the local service and credential in Applications.\n'); process.exitCode = 1; });
}
