# Connectors and demos

The connector runtime consumes signed `file.synced` Webhooks and fans one event out to one or more targets. It does not depend on VoiceCan business services, ASR, LLMs, or a specific messaging vendor.

## Delivery guarantees

- Verify `VoiceCan-Timestamp`, `VoiceCan-Delivery-Id`, and `VoiceCan-Signature` against the unmodified body before parsing.
- Reject bodies above 256 KiB and reject unknown API versions.
- Persist one ledger record per event ID with a canonical event hash and per-target status.
- Coalesce concurrent duplicates in one process. Repeated events skip successful targets and retry only failed targets.
- Reject reuse of an event ID with different content as `EVENT_ID_COLLISION`.
- Give every Demo its own least-privilege Application Token and Application Webhook secret. Persist only delivery state, a bounded/redacted error, and an optional target reference; never persist credentials or authorization headers.

`FileDeliveryLedger` remains the minimal file implementation. `SqliteConnectorStore` is the recommended single-process durable implementation and provides WAL/FULL-synchronous delivery state, Event Inbox, Recording tombstones, outbox retry state, and metrics. A Production multi-instance profile must replace it with a PostgreSQL-backed implementation using unique event/target claims and cross-process leases before multiple replicas are enabled.

`reconcileRecordings` performs a complete authorized Recording listing and invokes application callbacks for newly visible and authorization-lost recordings. Cleanup begins only after the listing completes successfully, so a partial Platform response cannot erase application data.

These capabilities are published as `@voicecan/connector-runtime`; applications install the package from the VoiceCan npm registry instead of importing this repository or another Demo's source tree.

## Included demos

| Demo | Port | Result |
| --- | ---: | --- |
| Meeting assistant | 8791 | Streams the recording to `audio/` and creates a durable JSON job in `queue/` for a downstream meeting processor |
| Voice worklog | 8792 | Streams an attachment and creates a local Markdown worklog entry |
| Voice router | 8793 | Routes streamed recordings by `attribute` into configured directories and writes a receipt |

Each demo requires a distinct least-privilege Group API Token and Webhook secret. Copy its `.env.example` to an ignored secret file, build the monorepo, then run the compiled `dist/index.js`. Configure its `/events` URL as a Webhook endpoint in Device Server.

The demos intentionally stop at local durable outputs. Publishing to Slack, Teams, Feishu, WeCom, or another provider remains a separate adapter with provider sandbox credentials, rate-limit behavior, content-size policy, and contract tests. Do not claim a provider integration from the local file targets.

## Verification

Run `npm test`. The suite verifies partial failure, retry-only-failed behavior, concurrent duplicate coalescing, event-ID collision rejection, and each demo's output. Use fixture events before enabling a real Webhook, then inspect the connector ledger and the Device Server delivery record together.
