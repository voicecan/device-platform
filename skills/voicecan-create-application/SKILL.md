---
name: voicecan-create-application
description: Create and inspect least-privilege Voicecan Open Platform Applications and owner-only credentials. Use when an AI or external application needs REST, stdio MCP, remote MCP, Webhook, device, recording, command, or event access.
---

# Create a Voicecan Application

1. List Applications with `voicecan-device app list --output json` and identify the target Group.
2. Select only required channels and permissions. Preview with:
   `voicecan-device app create --group <id> --name <name> --channels rest,mcp_stdio --permissions devices:read --dry-run --output json`
3. Apply the same command without `--dry-run`.
4. Create credentials only when needed: `voicecan-device app credential create <app-id> --kind api_token --scopes devices:read --output json`.

Credential JSON returns a `secret_ref`, never the token. Keep that file owner-only and out of repositories, logs, prompts, and client configuration. Prefer separate Applications per integration and expand permissions only after a concrete need.
