---
name: voicecan-connect-mcp
description: Connect Voicecan MCP to an AI host without exposing credentials. Use for local Admin MCP, scoped Application stdio MCP, OAuth remote MCP, Codex, Claude, OpenClaw, generic MCP clients, MCP configuration generation, or MCP permission troubleshooting.
---

# Connect Voicecan MCP

Choose the permission plane first:

- Local administration: configure the Host to run `voicecan-device admin-mcp stdio`. It uses the owner-only local channel and exposes no destructive tools.
- Application data access: ensure the Application has `mcp_stdio`, then preview and run `voicecan-device mcp connect --application <id> --client <generic|codex|claude|openclaw> --output json`.
- Remote access: use the server's `/mcp` OAuth/PKCE discovery flow. Never use a local operator key or stdio Application token remotely.

For stdio, the generated Host config invokes `voicecan-device mcp run --credential-ref <path>`. The token remains in the owner-only file and is loaded only into the child process environment. Ask the user to approve changing an AI Host configuration; do not silently overwrite it.

Verify Application tools through MCP discovery. Tool availability must match the credential's scope set.
