# AI automation contract

The `voicecan-device` CLI is the baseline automation surface. Every bounded command supports a stable JSON envelope; logs and long-running process output do not share JSON stdout.

```bash
voicecan-device capabilities --output json
voicecan-device config list --output json
voicecan-device service status --output json
```

Exit codes and `error.code` distinguish invalid input, authorization/user action, unavailable state, and runtime failure. Use `--dry-run` before supported writes and keep one `--profile` throughout a workflow.

## Local Admin MCP

Configure a local AI Host with:

```json
{
  "mcpServers": {
    "voicecan-admin": {
      "command": "voicecan-device",
      "args": ["admin-mcp", "stdio"]
    }
  }
}
```

Admin MCP exposes read, safe-write, and user-action tools generated from the CLI capability surface. It delegates to a loopback-only local operator channel authenticated by an owner-only key. The key is never printed, accepted as a Tool argument, or exposed remotely. Destructive commands are not registered.

## Device binding

```bash
voicecan-device device bind prepare \
  --group <group-id> \
  --display-name "Meeting room" \
  --expected-sn <serial> \
  --server-url auto \
  --network existing \
  --output json
```

The CLI opens the single-use launch URL itself and removes it from JSON. The user only selects the Bluetooth device. The Binding Intent and Provisioning Session remain server-authoritative, so refresh, a closed page, a missing callback, or delayed WSS authentication can still complete. Observe with `device bind status` or `device bind wait`.

## Applications and MCP

```bash
voicecan-device app create --group <group-id> --name <name> \
  --channels rest,mcp_stdio --permissions devices:read --output json
voicecan-device mcp connect --application <application-id> \
  --client generic --output json
```

Credential creation stores the one-time token in an owner-only Secret Reference. Generated MCP configuration calls `voicecan-device mcp run --credential-ref <path>` and therefore contains no plaintext token.

Local Admin MCP controls the installation. Application MCP is a least-privilege data plane for devices, recordings, commands, and events. Remote MCP uses browser OAuth/PKCE and never accepts the local operator credential.
