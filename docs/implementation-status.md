# Implementation status

Status date: 2026-08-10. This is the repository-local summary; the cross-repository release gate is maintained in [`IMPLEMENTATION-STATUS-AND-RELEASE-ROADMAP.md`](../../docs/2026-08-03-device-developer-platform-plan/IMPLEMENTATION-STATUS-AND-RELEASE-ROADMAP.md).

## Code-complete in this repository

| Area | Evidence |
| --- | --- |
| Public/private boundary | `check:public` scans source and the reviewed Core tarball; private Rust, Cargo, fixtures, fuzz corpus, source maps, and raw commands are rejected |
| Reviewed Core | Pins `@voicecan/device-core@0.1.0-preview.18`, ABI `voicecan-v1.2`, conformance hash, tarball SHA-256, and equal Browser/Node WASM digests; the artifact publishes only bundled semantic entry points rather than standalone raw-command glue, and the semantic API includes reviewed battery/storage telemetry, controls, post-bind time synchronization, and bounded BLE/WS OTA semantics |
| Atomic provisioning | Reserved device + temporary credential, BLE/configured progress, failure/expiry cleanup, authoritative online completion |
| Device WSS | Resolves the protocol-defined DeviceID SN header to the platform device ID before canonical Base64 token verification; includes constant-time checks, encrypted-token confirmation, redacted debug failure reasons, rate limit/backoff, Core reverse bind, and connection epoch fencing |
| Gateway | Bounded serial device actor, periodic status polling, semantic controls, command dispatch/requeue, new-file and paginated inventory discovery, identity conflicts, automatic upload plans, and mutually exclusive offset-driven OTA |
| Firmware repository | Streamed custom uploads plus explicit same-origin official import (configurable source, default `https://api.voice-can.com/`), immutable hardware/channel/version catalog, local size/SHA-256 re-verification, production/developer lanes, BLE progress, and WS reboot request after validation |
| Storage | Immutable filesystem upload, S3 staging/final/version flow, resumable relay, quota/watermarks, cleanup/reconcile |
| Data/event atomicity | Successful local/S3/relay completion fences ownership and commits file state with `file.synced` outbox in one transaction |
| Authorization | File/event/command/content access derives from the Device's current group; cross-group and transfer E2E |
| Public API | Filters/count/cursor, Range 200/206/416, command status, token rotation lineage, webhook rotation/replay/backfill, audit/storage status, and field-level OpenAPI models for critical SDK/provisioning/transfer contracts |
| Audit | Success/failure records plus database triggers that reject audit UPDATE/DELETE |
| SDK/UI | Fragment-aware Web Bluetooth SDK and App-aligned binding order (connect/read identity → claim token → secure BLE handshake → network configuration), compatibility gate, authoritative provisioning wait, battery/charging and free/total storage telemetry, Lit Provisioner/Console/Transfer Web Components with preserved public tags/events, self-hosted `/device`, and independently deployable `device-connect-web` reused by Admin with secure-context auto-selection, non-root nginx image, and amd64 Gitea build/push/Kubernetes deployment workflow |
| Transfer-out | Five-minute exact-Origin grant, ephemeral RSA-OAEP credential envelope, old-token BLE proof, non-erasing ACK, atomic source release, retained recordings |
| Clients | TypeScript and Python filtering, command status, retries, Range/resume, events, and dual-secret verification |
| Edge operations | Explicit SQLite migration, backup/restore, deployment-key rotation, metrics, reconcile, graceful readiness drain, Compose migration service, Skill preflight/doctor/smoke |
| Connectors/demos | Durable per-event/per-target ledger, concurrent deduplication, retry-only-failed fan-out, signed Webhook ingress, meeting assistant, voice worklog, and attribute router examples |
| Admin tools | React/Vite application served by Fastify, with dedicated User/Group/Token/Webhook lifecycle forms, integrated local/public provisioning selection, state-bound callback plus authoritative Server verification, release, DLQ replay, read-only permission-bound API Explorer, and development-only Device/File Simulator forms |
| Supply-chain preparation | Local release evidence command emits CycloneDX SBOM, SHA-256 inventory, Core/commit manifest, and fails closed outside Node 24.15 unless explicitly marked ineligible; exact Node 24.19.0 local generation produced an eligible manifest |
| Multi-instance server | PostgreSQL 16 adapter, advisory-locked explicit migration, injectable Database interface, connection/command epoch fencing, schema-v6 outbox CAS lease, external setup/key secrets, lifecycle-safe claim cleanup, and a real two-pool PostgreSQL integration test |
| Retention safety | System Admin legal hold, separate audited clear, preview/resource-version confirmation, immediate download freeze, retryable filesystem/exact-S3-version deletion, absence verification, metadata tombstone, and explicit non-deletion of the physical-device source |
| Production deployment | Two-instance PostgreSQL/S3 Compose profile plus digest-pinned Helm chart with migration hook, two replicas, drain probes, anti-affinity, Service, PDB, optional TLS Ingress, and external Secret contract |
| Lifecycle policy | Stable-channel SemVer/API/Core compatibility windows, deprecation rules, explicit migration/canary/rollback policy, and an explicit unresolved licensing decision gate |

## Current automated evidence

- `npm run ci`: public-boundary check, Core artifact verification, strict typecheck, local tests, and build; the PostgreSQL integration remains environment-gated.
- Recording synchronization uses one active transfer lane per Device, a Device-reachable upload origin, semantic time synchronization, observable failure details, individual retry, and non-destructive failed/stale reset. See [recording synchronization operations](recording-sync-operations.md).
- `VOICECAN_POSTGRES_TEST_URL=... npm run test:postgres`: PostgreSQL 16 migration/idempotency, two-pool outbox/command CAS, transaction rollback, and immutable-audit test passes locally.
- `helm lint` and `helm template`: Production chart passes with an immutable digest; `docker-compose ... config --quiet` passes for the Production Compose profile.
- The repository has a manual multi-architecture release-candidate workflow, but the local Podman VM exits immediately after startup; no OCI runtime pass is claimed from this machine.
- `python -m compileall -q clients/python/src`: pass.
- `git diff --check`: pass.
- Native installation uses the repository-pinned private Node 24.19.0 archive after verifying its official SHA-256; Docker and release CI use the same exact runtime baseline. Release CI must still archive its own pass and approvals.

## Release gates still open

| Priority | Gate |
| --- | --- |
| Preview P0 | Physical firmware BLE/WSS/bind/inventory/direct/relay test matrix |
| Preview P0 | Trusted-domain TLS and private-CA/IP positive/negative matrix |
| Preview P0 | Real MinIO/target-S3 integration and failure/recovery matrix |
| Preview P0 | Pinned Node 24.19.0 CI archive/approval and built Linux amd64/arm64 OCI smoke tests |
| Preview P0 | Physical transfer-out ACK/ disconnect validation and remaining real streaming/Webhook concurrency tests |
| Preview P0 | Long-running Core fuzz CI (frame plus all semantic/Gateway parsers), independent security review, SBOM/provenance/signing |
| Beta | Deployed PostgreSQL/S3 multi-instance mixed-load and failover evidence, signed Windows/macOS SEA |
| Beta | Full Admin CRUD, external provider adapters, and real production/SEA/browser Skill workflows |
| GA | License-owner decision and NOTICE inventory, partner grey release, production-equivalent capacity/SLO observation, approved retention/legal-hold deletion workflow, and privacy/disaster-recovery review |

Blocked gates must remain explicit. Simulator, unit, or fixture evidence does not authorize claims of physical-device, TLS, cloud-storage, multi-instance, or signed-release support.

The service now exports stable-route HTTP latency histograms plus file, Webhook, command, event-loop, connection, and local-storage saturation metrics. The repository also contains executable SLO/capacity and privacy/retention/restore evidence specifications, plus a tested manual legal-hold/object-deletion lifecycle. These close the repository portion of GA-04/GA-05, but do not replace approved retention durations/consent language, production-equivalent load observation, privacy/legal review, automatic bounded retention jobs, or a restore drill.
