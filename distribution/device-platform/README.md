# @voicecan/device-platform

The self-hosted Voicecan Device Platform package includes the Device Server, Admin UI, browser device-connection UI, and the `voicecan-device` CLI.

## Install

Requirements: Node.js `>=24.15.0 <25` and npm.

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npm install --global @voicecan/device-platform@1.0.1
voicecan-device onboard
```

Onboarding creates a persistent per-user Profile, starts the service, waits for readiness, and opens Admin at `http://127.0.0.1:8787/admin`. On a headless machine, use:

```bash
voicecan-device onboard --no-open
```

Complete setup in the trusted Admin page. Keep setup secrets out of shell history, logs, automation output, and source control.

## Operate the service

```bash
voicecan-device service status --output json
voicecan-device service restart --output json
voicecan-device service logs
voicecan-device doctor --output json
```

The default installation uses a local SQLite data store. Profiles keep the service, database, local objects, and configuration together. Use `--profile <name>` when you need isolated installations.

## Configuration

| Variable | Purpose |
| --- | --- |
| `VOICECAN_DATA_DIR` | Data directory for the database, local objects, and runtime state |
| `VOICECAN_PORT` | HTTP and device WebSocket port; default `8787` |
| `VOICECAN_PUBLIC_BASE_URL` | Browser-facing service URL |
| `VOICECAN_HOST` | Listen address |

For Docker, PostgreSQL, object storage, TLS, backup, and multi-instance deployments, see the [deployment documentation](../../deploy/README.md) and [operations runbook](../../docs/operations-runbook.md).

## Application SDKs

Applications connecting to a running platform normally install:

```bash
npm install @voicecan/connector-runtime
```

This package provides the connector runtime and installs the public contracts and server client it uses. See the [server client](../../packages/server-client/README.md) and [connector runtime](../../packages/connector-runtime/README.md) documentation for integration details.

## License

Apache License 2.0. See `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` in the package.
