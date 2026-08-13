# VoiceCan Device Platform

Public source repository for independent device connectivity and immutable recording-file synchronization, with no dependency on VoiceCan accounts, families, memberships, model services, or the existing business API.

The private wire-protocol source has been split into the sibling `device-core` repository. This repository consumes only a reviewed, checksummed `@voicecan/device-core` release artifact; see [repository boundary](docs/repository-boundary.md).

## Implemented preview

- Node.js 24/TypeScript monorepo and explicit SQLite migrations.
- SQLite access isolated in a worker; the HTTP/WSS event loop does not execute synchronous database calls.
- One-time owner-only setup token, Argon2id passwords, HttpOnly sessions, CSRF, local users, one active group per user, Group API Tokens, and audit records.
- Device claims with random 32-byte credentials, HMAC verifiers, AES-256-GCM envelope encryption, credential epochs, and authenticated WSS connection fencing.
- Group-scoped device, file, event, command, provisioning, and transfer APIs. File and event access always derives from the Device's current group.
- Application-first Open Platform with one Permission Catalog across REST, stdio MCP, OAuth-protected remote MCP, and Webhooks; complete credential, collaborator, quota, usage, call-log, and security-alert control plane.
- Recording APIs return metadata or one-use temporary URLs only. S3 delivery redirects to a very short presigned GET; local delivery is isolated behind the dedicated Download Grant gateway and can be disabled with `external_object_only`.
- Streamed local upload tickets with exact length checks, SHA-256, fsync, temporary files, atomic rename, and immutable final locators.
- `file.synced` outbox and signed at-least-once webhook delivery with ownership-epoch checks and SSRF protections.
- Device transfer preview/CAS confirmation; historical recordings move with the Device and pending old-group deliveries are canceled.
- Persistent login throttling, last-admin protection, group-admin transfer/archive rules, offline password recovery, backup/restore verification, deployment-key rotation, quotas, disk watermarks, reconciliation, graceful readiness drain, metrics, and structured/redacted logs.
- Webhook DNS/IP pinning, current/next secret rotation, schema-v6 CAS delivery leases, dead-letter inspection/replay, and preview-confirmed historical backfill namespaces.
- System Admin legal hold plus preview/CAS-confirmed, retryable, exact-version storage-object deletion; metadata/audit tombstones remain and the physical-device source is explicitly untouched.
- TypeScript and Python clients, event verification, WebBluetooth transport, headless command queue, Lit-based standard provisioner/console Web Components, a React/Vite Admin application, an independently deployable public Device Connect Web with Admin reuse and cross-origin callback verification, fixture consumer, unified durable Connector runtime, three local-output demos, simulator, Docker image, Compose, and integration Skill.
- A single private Rust Core release supplies Browser and Node WASM artifacts. The public repository pins its package digest, ABI and conformance hash and does not contain its source or fixtures.
- Bound-device management combines periodic WebSocket status polling with authenticated nearby BLE status/control. OTA uses a local firmware repository: System Admins can stream custom packages or explicitly import and verify a package from the configurable official source (default `https://api.voice-can.com/`), then install the local copy over WebSocket or BLE.

Open Platform documentation:

- [Applications, permissions, credentials, REST, and administration](docs/open-platform.md)
- [stdio and remote MCP](docs/mcp-server.md)
- [Recording Download Grants](docs/recording-download-links.md)

## Deliberately blocked

The repository does not pretend that hardware-only or external-infrastructure work has passed. Provisioning, reverse binding, inventory discovery, command recovery, filesystem/S3/relay orchestration, PostgreSQL multi-instance fencing, and Production deployment templates are implemented, but the real V1.2 device matrix still requires physical firmware/hardware evidence. Real MinIO/S3 integration, `private_ca_ip`, signed OCI/SEA releases, deployed multi-instance mixed-load validation, external messaging-provider adapters, and downstream AI processing remain gated. Simulator and local integration tests are engineering evidence, not proof of production readiness.

## Local quickstart

Requirements: Node.js `>=24.15.0 <25`, npm, and a private local data directory.

For a local Edge/SQLite installation from the official npm registry, run:

```sh
npx --yes @voicecan/device-platform@1.0.0 init
```

This explicitly migrates SQLite, starts the Server, and opens
`http://127.0.0.1:8787/admin`. It stores persistent state in `./data`; run it
from the directory that should own that data. Use `--no-open` on a headless
host. The npm package has no mutating `postinstall` hook, and ordinary `serve`
never runs migrations.

Choose exactly one installation method for an installation. The npm, Docker,
private-Node, and source methods have separate lifecycle boundaries; do not
overlay them on one data directory without following the migration runbook.

For a one-command Edge/SQLite install from the public `main` release channel,
install curl, Git, Docker Engine, and Docker Compose v2, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh | bash
```

The installer clones `main` into
`${XDG_DATA_HOME:-$HOME/.local/share}/voicecan-device-platform`, builds a
commit-tagged image, verifies the public/Core boundary during the image build,
runs the migration explicitly, starts the loopback-only Compose profile, and
waits for readiness. It never overwrites an existing installation. Override
settings through flags or environment variables; for example:

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh \
  | bash -s -- --install-dir /srv/voicecan-device-platform --port 8788
```

The `main` branch is the release channel for this installer. The exact installed
commit and image tag are printed at completion. Review
[`docs/versioning-and-migrations.md`](docs/versioning-and-migrations.md) before
upgrading an existing installation; rerunning the installer intentionally does
not perform an in-place upgrade.

For a native installation without Docker, install curl, Git, `tar`, and a
SHA-256 utility (`sha256sum`, `shasum`, or OpenSSL), then run:

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install-node.sh | bash
```

The Node.js installer does not use the user's Node.js, npm, nvm, Homebrew, or
system PATH. It downloads the exact runtime in `node-runtime.lock`, verifies the
platform-specific SHA-256, and keeps that private runtime under the installation
directory. It then performs the same source/Core verification, builds the
release, explicitly migrates SQLite, and attempts to install a user-level
systemd service on Linux or launchd agent on macOS. It never uses `sudo`. Pass
`--no-service` when only build and migration are desired.

```powershell
Copy-Item .env.example .env
npm install
npm run verify:core
npm run build
npm run migrate
npm start
```

The service never migrates on startup. On first start it writes a high-entropy setup token to `data/setup-token` with owner-only permissions and logs only the path. Reveal it explicitly with `node packages/device-server/dist/cli.js show-setup-token`, then submit it through the trusted local setup client; never copy it into source control or shell history.

To discard an existing local Edge installation and initialize it again, stop the Server, remove the complete `data/` directory (not only the SQLite file), run `npm run migrate`, and start the Server. This also removes stored recording objects and local deployment secrets and cannot be undone. Compose volumes, custom data/database/storage paths, and the PostgreSQL/S3 boundary are covered in [Reset the Edge data and initialize again](docs/quickstart.md#reset-the-edge-data-and-initialize-again).

For fixture development, set `VOICECAN_SIMULATOR=true`. This exposes authenticated simulator endpoints; it must remain false in production.

Open `/admin` for setup, identities, resources, and origin-bound provisioning grants. Device provisioning stays inside Admin when its secure context supports Web Bluetooth; otherwise Admin opens the public connector configured by `VOICECAN_CONNECT_WEB_URL`. The standalone static package and deployment rules are documented in [Device Connect Web](docs/device-connect-web.md). `/device` remains available as the direct same-origin compatibility provisioner and console.

The UI boundary is deliberate: `packages/admin-web` is the authenticated management surface, `packages/device-connect-web` is the reusable and independently deployable browser connector, `packages/device-ui` is a framework-neutral Lit Custom Element library, and `packages/device-web` remains the pure TypeScript headless SDK. `npm run build` emits all three frontend artifacts. For frontend development, run the API with `npm run dev`, Admin with `npm run dev:admin`, and the standalone connector with `npm run dev --workspace @voicecan/device-connect-web` (default `http://127.0.0.1:5175/`).

## Open Platform npm packages

The complete local Server distribution and the three application SDKs are
published to the official npm registry under the `@voicecan` scope:

- `@voicecan/device-platform`: self-contained Server, Admin and device UI,
  reviewed compiled Core runtime, and the `voicecan-device` CLI;

- `@voicecan/contracts`: public contracts and constants only;
- `@voicecan/server-client`: Application REST client, Event cursor, secure Recording Grant download, Webhook verification/parsing, and media assessment;
- `@voicecan/connector-runtime`: durable Webhook dispatch, SQLite Inbox/tombstone/outbox/metrics, and authorization-aware Recording reconciliation.

```bash
npm install @voicecan/contracts @voicecan/server-client @voicecan/connector-runtime
```

Application code should not depend on `@voicecan/device-platform`; install it
only when deploying the Server. Run `npm run npm:pack:check` before publishing.
The release checks verify that the Server tarball contains its Admin/UI and
reviewed Core JS/WASM assets without publishing private protocol sources.

Offline operations must run while the server is stopped:

```powershell
node packages/device-server/dist/cli.js backup create D:\backups\voicecan-2026-08-03
node packages/device-server/dist/cli.js backup verify D:\backups\voicecan-2026-08-03
node packages/device-server/dist/cli.js backup restore D:\backups\voicecan-2026-08-03 D:\voicecan-restored
"new passphrase" | node packages/device-server/dist/cli.js users set-password --username admin --password-stdin
node packages/device-server/dist/cli.js keys rotate
```

## Verification

Operational release gates are documented in [the operations runbook](docs/operations-runbook.md), [SLO/capacity/alerting](docs/slo-capacity-and-alerting.md), and [privacy/retention/disaster recovery](docs/privacy-retention-and-disaster-recovery.md). `/metrics` exposes stable-route HTTP latency, event-loop health, device connections, storage capacity, and file/Webhook/command queue saturation; keep it on a private monitoring network.

```powershell
npm run typecheck
npm test
npm run check:public
npm run verify:core
npm run build
```

The automated suite covers setup/claim replay rejection, origin binding, persistent rate limiting, lifecycle guards, immutable upload recovery, backup/restore, key rotation, SSRF address classes, group isolation, transfer authorization, Connector fan-out, Skill forward fixtures, WASM conformance, Gateway event parsing, React Admin build/asset delivery, and Lit Custom Element contract preservation. Admin includes dedicated User/Group/Token/Webhook lifecycle forms plus guarded API, delivery, and simulator tools. Physical BLE permission and device results remain a hardware release gate.

See [quickstart](docs/quickstart.md), [local firmware repository and OTA](docs/firmware-repository.md), [Device Connect Web deployment](docs/device-connect-web-deployment.md), [OpenAPI](docs/openapi.yaml), [error codes](docs/error-codes.md), [connectors and demos](docs/connectors-and-demos.md), [operations runbook](docs/operations-runbook.md), [versioning and migrations](docs/versioning-and-migrations.md), [licensing gate](docs/licensing-decision.md), [security model](docs/security.md), [repository boundary](docs/repository-boundary.md), and [implementation status](docs/implementation-status.md).
