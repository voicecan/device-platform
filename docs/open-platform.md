# Voicecan Device Open Platform

The Open Platform exposes the reviewed device capability surface through REST and MCP while keeping one authorization and audit model.

## Learning applications and optional AI clients

These are independent integrations; connecting MCP is not a prerequisite for a learning application.

- **Learning application (REST):** create a Group-scoped Application with the `rest` channel and a least-privilege `api_token`. Use `devices:read` and `recordings:read` for metadata; explicitly authorize `recordings:download_link:create` when the application needs audio. Keep the token on the application's server. Model API configuration and course materials belong to the learning application, not Device Platform. A recording is downloaded/transcribed once; course work consumes saved transcript revisions.
- **Codex or another AI client (MCP, optional):** quick setup uses a separate `mcp_stdio` Application and the `metadata_reader` permissions: `devices:read`, `recordings:read`, and `events:read`. It can list server recordings but cannot obtain audio by default. Explicitly authorize content access before enabling or using recording download tools. The client must honor user consent; a tool's `reason` argument is audit context, not proof of human consent.

The local Elio preview links to the student application at `http://127.0.0.1:8811/study` and an illustrative test-data demo at `http://127.0.0.1:18915/study`. Opening either link does not create credentials or grant recording access. Real model generation requires the student's own API settings and an explicit generation action in the learning application.

The existing one-click **Local Full Studio** connection is separate: it targets `http://127.0.0.1:8815`, requires the `local-full` runtime, and uses embedded local models. Its confirmation grants the selected Group's recording metadata/download access through REST. It does not configure the own-API student application.

## Recording, device, and synchronization capabilities

- Recording responses include immutable `media` (`recording.media.v1`), objective `timing`, discovery firmware, and `resource_version`. Unknown historical facts remain `null`, `application/octet-stream`, or `bin`; the server never guesses from a requested filename.
- `GET /api/v1/devices/{id}/capabilities` and `voicecan.devices.get_capabilities` expose only reviewed semantic abilities. No opcode, frame, raw payload, ASR, or LLM concept is part of this contract.
- The only public command is `recording.sync`, with idempotent creation, queued/dispatched/running/terminal state, timestamps, stable errors, and terminal events.
- Sync commands for one Device are serialized in creation order. A `succeeded` command means the reviewed inventory and immutable upload planning pass completed; each recording transfer then reports its own `recording.sync_started`, `file.synced`, or `recording.sync_failed` lifecycle. Disconnects and a new fenced connection after Server restart requeue non-terminal commands, and deadline expiry is terminal.
- Application Webhooks can narrow delivery by event type, device, and recording attribute, and support signed tests, delivery inspection, replay with a new delivery ID, and confirmed bounded backfill.

Canonical schemas live in `docs/schemas/open-platform-foundation.schema.json` and `docs/openapi.yaml`.
Repository verification and the additive compatibility matrix are recorded in [Open Platform foundation release evidence](open-platform-foundation-release-evidence.md).

Stable public errors used by the new surfaces include `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `COMMAND_NOT_ALLOWED`, `SYNC_COMMAND_RATE_LIMITED`, `COMMAND_DEADLINE_EXCEEDED`, `DEVICE_RELEASED`, `DOWNLOAD_GRANT_INVALID`, `DOWNLOAD_GRANT_LIMIT`, `DOWNLOAD_GRANT_RATE_LIMITED`, `EXTERNAL_STORAGE_REQUIRED`, `RANGE_NOT_SUPPORTED`, `BACKFILL_PREVIEW_STALE`, and `DELIVERY_NOT_REPLAYABLE`. SDK-local wait/download failures use `COMMAND_WAIT_TIMEOUT`, `COMMAND_WAIT_CANCELED`, `TEMPORARY_DOWNLOAD_EXPIRED`, `DOWNLOAD_LENGTH_MISMATCH`, and `DOWNLOAD_SHA256_MISMATCH`.

## Identity model

An `Application` belongs to one Group and owns its enabled REST/MCP/Webhook channels, maximum permissions, owner/developer/viewer collaborators, credentials, OAuth clients, quotas, IP allowlists, recording-link policy, usage, and audit history.

Credentials can only select a subset of the Application permissions. Secrets are shown once and stored as peppered hashes. Production credentials require an expiry. Suspending an Application or revoking a credential is checked on every request and every temporary recording-link consumption.

| Permission | Capability |
| --- | --- |
| `devices:read` | Device metadata |
| `devices:sync` | Reviewed synchronization command |
| `commands:read` | Command status |
| `recordings:read` | Recording metadata only |
| `recordings:download_link:create` | One-use temporary URL |
| `recordings:download_link:revoke` | Revoke the Application's grant |
| `events:read` | Event metadata |

Legacy `files:read` and `sync:trigger` are accepted only as migration aliases. New credentials use the canonical names.

## Administration

The Admin Console's Open Platform section includes overview, Applications, Permission Catalog, OAuth/MCP clients, call logs, temporary grants, and security alerts. An Application workspace centralizes permissions, credentials, collaborators, owner transfer, download policy, OAuth clients, Webhooks, usage, and audit.

System Admins can manage all Groups. Group Admins can manage Applications in their active Group. Collaborators are limited by their owner/developer/viewer role. Mutations use the local session and CSRF token and record a reason in the immutable audit ledger.

Remote MCP supports administrator-created and dynamically registered public OAuth clients. Authorization Server Metadata publishes `/oauth/register`; a dynamic client remains unprivileged until consent binds it to an accessible MCP-enabled Application. The flow uses Authorization Code with S256 PKCE, exact redirect matching, RFC 8707 resource binding, issuer identification, rotating refresh tokens, and family-wide revocation on refresh-token reuse. The implementation supports MCP `2026-07-28` and its `server/discover` flow while retaining `2025-11-25` compatibility.

## REST setup

1. Run `npm run migrate` explicitly.
2. Sign in to `/admin` and create an Application.
3. Enable `rest`, choose least-privilege permissions, and set quotas/download policy.
4. Create an `api_token`; copy the `vcd_app_...` value immediately.
5. Call `GET /api/v1/capabilities` before enabling an integration.

Application responses never reveal an existing secret. Call logs contain IDs, route templates, status, duration, and a source hash; they do not contain authorization headers or temporary URL tokens.

## Compatibility

Explicit migration creates a synthetic `Legacy integrations` Application for existing Group Tokens and preserves their hashes, expiry, rotation lineage, and last-used state. Legacy `/files` remains during the compatibility window. New integrations use `/recordings`, and Application Tokens receive `410 CONTENT_ROUTE_DEPRECATED` from `/files/{id}/content`.
