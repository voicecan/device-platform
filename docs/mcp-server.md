# VoiceCan Device MCP Server

VoiceCan supports local stdio MCP and remote stateless Streamable HTTP MCP. Both expose the same bounded service methods as REST and derive available tools from the authenticated scope set.

## stdio

Create an Application credential with kind `mcp_stdio_token`, then configure the Host's secret environment:

```json
{
  "mcpServers": {
    "voicecan-device": {
      "command": "voicecan-device-mcp",
      "args": ["stdio"],
      "env": {
        "VOICECAN_DEVICE_SERVER_URL": "https://device.example.com",
        "VOICECAN_APPLICATION_TOKEN": "${secret:VOICECAN_APPLICATION_TOKEN}"
      }
    }
  }
}
```

Optional variables are `VOICECAN_MCP_MAX_ITEMS` (1–50), `VOICECAN_MCP_REQUEST_TIMEOUT_MS`, and `VOICECAN_MCP_LOG_LEVEL`. The credential is never accepted as a Tool argument and is never written to stdout.

## Remote MCP

The canonical resource is `https://device.example.com/mcp`. Discovery endpoints are `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, and `/.well-known/oauth-authorization-server`. Authorization Server Metadata publishes `registration_endpoint=https://device.example.com/oauth/register`.

Remote MCP supports both administrator-created clients and RFC 7591 Dynamic Client Registration. A Host can register by posting JSON client metadata to the published `registration_endpoint`; only public clients (`token_endpoint_auth_method=none`), Authorization Code, optional Refresh Token, the `code` response type, and HTTPS or loopback HTTP redirect URIs are accepted. Registrations are rate-limited and expire after one hour if authorization is not completed.

Dynamic registration does not grant Application or Device access. On the consent page, the signed-in user selects an accessible Application whose `mcp_remote` channel and permissions cover every requested scope. Approval atomically binds the client to that Application. All clients then require Authorization Code + S256 PKCE, explicit consent, exact registered redirect matching, and `resource=<canonical MCP URL>`. Access tokens are short-lived and audience-bound. Refresh tokens rotate on every use; reuse revokes the entire family and raises a security alert. `vcd_app_` API Tokens are deliberately rejected by `/mcp`.

The endpoint is stateless: `POST /mcp` carries one JSON-RPC request per HTTP request, `Origin` is validated when present, and no bearer token passthrough is implemented. It supports the current `2026-07-28` per-request metadata model and the transitional `2025-11-25` initialization model.

For `2026-07-28`, every request includes `params._meta` with protocol version, client identity, and client capabilities. HTTP clients must also send matching `MCP-Protocol-Version` and `Mcp-Method` headers, plus `Mcp-Name` for `tools/call` and `resources/read`. Header/body mismatches fail with `HeaderMismatch` (`-32020`). `server/discover` advertises both supported versions. The older `2025-11-25` path remains available for clients that still initialize first.

OAuth authorization and token requests both carry `resource=<canonical MCP URL>`. Authorization responses include the issuer identifier, access tokens are checked against that exact audience, and unauthenticated `/mcp` responses advertise Protected Resource Metadata through `WWW-Authenticate`.

## Tools

- `voicecan.devices.list`
- `voicecan.devices.get`
- `voicecan.devices.get_capabilities`
- `voicecan.devices.sync`
- `voicecan.commands.get`
- `voicecan.recordings.search`
- `voicecan.recordings.get`
- `voicecan.recordings.create_download_link`
- `voicecan.recordings.revoke_download_link`
- `voicecan.events.list`

`tools/list` is filtered by scope. Recording search/get returns metadata only. The download-link Tool returns structured JSON with an external temporary URL; it never returns MCP audio, blobs, embedded resources, Base64, or a ResourceLink that a Host might automatically dereference.

Capability discovery shares the REST service, `devices:read` permission, quota, and audit model. It exposes stable semantic names only.

Metadata resources are re-authorized on every read. Temporary download URLs are not persistent MCP Resources.
