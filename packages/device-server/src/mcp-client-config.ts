import type { McpEntry } from './mcp-local-install.js';
export const quickMcpClients = ['openclaw', 'codex', 'claude', 'workbuddy', 'generic'] as const;
export type QuickMcpClient = typeof quickMcpClients[number];
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
/** The entry contains a local credential file reference, never the credential itself. */
export function clientConfiguration(client: QuickMcpClient, entry: McpEntry, name = 'voicecan_elio') {
  const configuration = client === 'codex'
    ? `[mcp_servers.${name}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`
    : JSON.stringify(client === 'openclaw' ? { mcp: { servers: { [name]: { ...entry, transport: 'stdio', enabled: true } } } } : { mcpServers: { [name]: entry } }, null, 2);
  const command = client === 'codex' ? ['codex', 'mcp', 'add', name, '--', entry.command, ...entry.args]
    : client === 'openclaw' ? ['openclaw', 'mcp', 'add', name, '--command', entry.command, ...entry.args.map((arg) => `--arg=${arg}`)] : null;
  return { configuration, install_command: command?.map(quote).join(' ') ?? null,
    verify_command: client === 'openclaw' ? ['openclaw', 'mcp', 'doctor', name, '--probe'].map(quote).join(' ') : null,
    server_name: name };
}
