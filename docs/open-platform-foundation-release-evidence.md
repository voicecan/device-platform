# Open Platform compatibility reference

This document summarizes the public Open Platform resource model and compatibility behavior for integrations.

## Public capabilities

| Area | Capability |
| --- | --- |
| Recording facts | `RecordingMediaDescriptor`, `RecordingTiming`, immutable source firmware and resource versions are shared by REST, MCP, events and SDKs. Unknown values remain explicit. |
| Database | Explicit SQLite and PostgreSQL migration paths add recording, capability, command, Webhook filter and delivery-inspection columns. Server startup still does not migrate. |
| External delivery | Production profile validation requires `s3_direct` plus `external_object_only`; Helm and Production Compose set both. Grant state/revoke and short S3 redirect semantics are documented. |
| Device/Command | Stable capability manifests, semantic `recording.sync`, idempotency, serialized per-device execution, disconnect recovery, public terminal state and events are implemented. |
| Events | Recording/device/command lifecycle events, Application filters, signed tests, delivery health/status, replay and bounded confirmed backfill are implemented. |
| Developer surfaces | REST, MCP, Admin, TypeScript SDK, Python SDK and all built-in examples use the same Application authorization model and recording metadata. |

## Compatibility matrix

| Existing consumer | Compatibility behavior |
| --- | --- |
| `file.synced` Webhook consumer | Event name remains; media/timing/source/version are additive. Consumers must ignore unknown fields and event types. |
| Historical recording row | Reads as `application/octet-stream`, `bin`, null numeric/time facts and `source: unknown`; no format is guessed. |
| Legacy Group Token and `/files` | Retained for the existing migration window. Application Tokens receive `410` from the legacy content route and use `/recordings` Grants. |
| Existing Download Grant gateway | Retained only for development/Edge/legacy policy. It is never reported as production external-only delivery. |
| Existing command row | Migration defaults resource version and nullable timestamps/result; public reads normalize only reviewed sync commands. |
| Existing Webhook endpoint | Empty filter arrays preserve subscribe-all behavior within its current Group and ownership epoch. |
