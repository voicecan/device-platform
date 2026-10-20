# Codex and OpenClaw MCP audit

Date: 2026-10-20. Tree: `/Users/elio/Desktop/voice/new-device-platform` at `16cab94` on `cursor/codex-openclaw-mcp-audit-88e6`.

Official references checked the same day:

- https://docs.openclaw.ai/tools/mcp
- https://docs.openclaw.ai/cli/mcp/registry
- https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli
- https://developers.openai.com/codex/cli/reference
- OpenClaw `mcp add` (command, repeatable `--arg`, `--url`, `--transport streamable-http`, `--auth oauth`, `--oauth-scope`)
- Codex `codex mcp add` / `login` / `list --json` / `get --json`

No tokens, passwords, or credential file contents are included.

The branch is pushed. Opening the pull request from this worker failed: `Git enterprise instance not found for hostname: git.voice-can.com`. Create it from the forge compare page:

https://git.voice-can.com/VoiceCan/new-device-platform/pulls/new/cursor/codex-openclaw-mcp-audit-88e6

## High

### 1. `mcp connect --client` ignored the client

`voicecan-device mcp connect --client openclaw|codex` stored the client name and still returned generic `mcpServers` JSON. OpenClaw reads `mcp.servers`. Codex reads `[mcp_servers.<name>]` in `config.toml`. The skill advertised those clients.

Fix: `mcp connect` and `mcp print-config` call `clientConfiguration`. OpenClaw gets `mcp.servers` plus `openclaw mcp add`. Codex gets TOML plus `codex mcp add --`.

### 2. OpenClaw stdio JSON set `transport: "stdio"`

Current `openclaw mcp add --command` writes `command` and `args` and does not set `transport`. The configuration reference shows the same shape. Some released builds reject `transport: "stdio"` during `openclaw config validate` even when a command is present (openclaw/openclaw#95082). Current main accepts the literal again.

Fix: generated OpenClaw stdio config is `{ command, args, enabled: true }` only. `--arg=<value>` is unchanged so values that start with `-` stay attached to `--arg`.

### 3. Remote setup described the wrong consent object and the wrong transport

The remote panel said to pick a device group. The consent page selects an Application whose channel is `mcp_remote` and whose permissions cover every requested scope. It also did not emit a client command, so a remote OpenClaw or Codex install had no Streamable HTTP OAuth entry. Copying the local stdio command would point at a loopback-only credential file on the platform computer.

Fix: the remote panel tells the operator to prepare that Application, forbids copying stdio files, and generates:

- OpenClaw: `openclaw mcp add <name> --url <mcp> --transport streamable-http --auth oauth --oauth-scope '<scopes>'`, then `openclaw mcp login <name>`, then `openclaw mcp doctor <name> --probe`
- Codex: a `[mcp_servers.<name>]` table with `url` and `scopes`, then `codex mcp login <name> --scopes a,b,c`

When local stdio is unavailable, the heading says so instead of pretending the operator chose another computer.

### 4. `codex mcp add --url` requests every advertised scope

Current Codex starts OAuth inside `mcp add` when the URL looks like an OAuth MCP server. With no configured `scopes`, it uses discovered `scopes_supported`. This server advertises every open-platform permission. Consent then fails unless one Application has all of them, because missing scopes are rejected rather than reduced.

Fix: remote Codex instructions do not use `codex mcp add --url`. They set `scopes` before `codex mcp login --scopes`.

### 5. Do not duplicate Codex `oauth_resource`

Current Codex already sends RFC 8707 `resource` from the MCP URL. Setting `oauth_resource` to that same URL sends `resource` twice and strict providers reject the authorize request. The remote snippet does not set `oauth_resource`.

### 6. Dynamic registration with no scope registered every permission

`POST /oauth/register` without `scope` stored `scopes_supported` from the authorization server, including sync and download scopes.

Fix: an omitted scope registers only `devices:read`, `recordings:read`, and `events:read`. Clients that send an explicit scope are unchanged.

### 7. `mcp run` used `npx` and skipped the owner-only check

`voicecan-device mcp run` spawned `npx --yes @voicecan/device-mcp@0.1.0-preview.0`. npx can write to stdout and break stdio MCP. The wrapper also did not require mode `0600`, unlike the quick-connect runner.

Fix: `mcp run` calls `runLocalCredentialMcp`, which checks the owner-only file and loads the local `device-mcp` build in-process. Failure text does not include the token. Importing the runner does not start the server.

## Medium

### 8. OpenClaw Gateway must be stopped for `add`, `login`, and `doctor --probe`

The registry doc says those commands take an exclusive state lock and refuse while the Gateway owns the state directory. `list`, `show`, `status`, and `doctor` without `--probe` stay available. The UI previously only said to update OpenClaw if `mcp` was unrecognized.

Fix: local verification copy and the remote OpenClaw steps say to stop the Gateway first and start it again after the check.

### 9. Remote download tools did not require `reason`

`POST /api/v1/recordings/:id/download-links` and the stdio server require `reason`. The OAuth `/mcp` tool called `createDownloadLink` and `revokeDownloadLink` without it, so a remote client could mint or revoke a grant without the field the schema marks required.

Fix: remote `create_download_link`, `revoke_download_link`, and `devices.sync` reject a missing `reason` before the service call.

### 10. Local quick setup only exists for a loopback public URL

`available` is false unless `VOICECAN_PUBLIC_BASE_URL` is loopback and the local runner exists. A production HTTPS install therefore cannot emit the local Codex/OpenClaw stdio command, even from the platform computer. That matches the loopback credential CIDR. The UI now states that limitation instead of offering a copyable local command.

## Low, left as-is

### 11. Local server names stay `voicecan_elio` and `voicecan_elio_recordings`

Those names are already what a verified Codex install looks up. Renaming would add a second server and leave the old entry. Remote instructions use `voicecan` and `voicecan_recordings`.

### 12. OAuth consent stays all-or-nothing

If the Application lacks any requested scope, authorize returns `INVALID_SCOPE`. The existing viewer test depends on that. Downscoping was not changed. Remote copy says the Application must include the whole scope list.

### 13. Codex list JSON still matches the installer

`codex mcp list --json` and `mcp get --json` emit `transport.type = "stdio"` with `command` and `args`. `env: null` and `cwd: null` still pass `matching()`. No installer change.

### 14. Credential path is visible; the token is not

Quick-connect responses include the credential file path because the stdio command needs `--credential-ref`. Tests still assert the body does not contain `vcd_app_`. CLI text now says “Credential file”, not “Credential secret”.

## Verification

Node 24.19.0 (checksum from `node-runtime.lock`):

- `packages/device-server/test/mcp-client-config.test.ts`
- `packages/device-server/test/mcp-local-install.test.ts`
- `packages/device-server/test/mcp-quick-connect.e2e.test.ts`
- `packages/device-server/test/open-platform.e2e.test.ts`

8 passed, 0 failed. Admin web `tsc --noEmit` passed. The built runner, started with no arguments, exits 1, writes one generic stderr line, and writes nothing to stdout.
