import type { McpEntry } from './mcp-local-install.js';
export const quickMcpClients = ['openclaw', 'codex', 'claude', 'workbuddy', 'generic'] as const;
export type QuickMcpClient = typeof quickMcpClients[number];
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
/** The entry contains a local credential file reference, never the credential itself. */
export function clientConfiguration(client: QuickMcpClient, entry: McpEntry, name = 'voicecan_elio') {
  // OpenClaw stdio servers are command plus args. `openclaw mcp add` does not
  // write transport, and some released validators reject transport: "stdio".
  const openclawServer = { command: entry.command, args: entry.args, enabled: true };
  const configuration = client === 'codex'
    ? `[mcp_servers.${name}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`
    : JSON.stringify(client === 'openclaw' ? { mcp: { servers: { [name]: openclawServer } } } : { mcpServers: { [name]: entry } }, null, 2);
  const command = client === 'codex' ? ['codex', 'mcp', 'add', name, '--', entry.command, ...entry.args]
    : client === 'openclaw' ? ['openclaw', 'mcp', 'add', name, '--command', entry.command, ...entry.args.map((arg) => `--arg=${arg}`)] : null;
  return { configuration, install_command: command?.map(quote).join(' ') ?? null,
    verify_command: client === 'openclaw' ? ['openclaw', 'mcp', 'doctor', name, '--probe'].map(quote).join(' ') : null,
    server_name: name };
}

/** Remote HTTP instructions. Scopes are explicit so clients do not request every advertised permission. */
export function remoteClientConfiguration(client: QuickMcpClient, url: string, scopes: readonly string[], name = 'voicecan') {
  const scopeList = scopes.join(' ');
  if (client === 'codex') {
    return {
      configuration: `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nscopes = ${JSON.stringify([...scopes])}\n`,
      install_command: null,
      login_command: ['codex', 'mcp', 'login', name, '--scopes', scopes.join(',')].map(quote).join(' '),
      verify_command: null,
      server_name: name,
    };
  }
  if (client === 'openclaw') {
    const install = ['openclaw', 'mcp', 'add', name, '--url', url, '--transport', 'streamable-http', '--auth', 'oauth', '--oauth-scope', scopeList];
    return {
      configuration: JSON.stringify({ mcp: { servers: { [name]: { url, transport: 'streamable-http', auth: 'oauth', enabled: true, oauth: { scope: scopeList } } } } }, null, 2),
      install_command: install.map(quote).join(' '),
      login_command: ['openclaw', 'mcp', 'login', name].map(quote).join(' '),
      verify_command: ['openclaw', 'mcp', 'doctor', name, '--probe'].map(quote).join(' '),
      server_name: name,
    };
  }
  return {
    configuration: JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }, null, 2),
    install_command: null,
    login_command: null,
    verify_command: null,
    server_name: name,
  };
}
