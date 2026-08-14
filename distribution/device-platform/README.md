# @voicecan/device-platform

The complete self-hosted Voicecan Device Platform: Device Server, Admin UI,
browser device binding UI, and the reviewed compiled protocol runtime.

## One-command local installation

Requirements: Node.js `>=24.15.0 <25` (Node.js 24.19.0 is recommended) and npm.

Install the CLI and create a persistent per-user Profile:

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npm install --global @voicecan/device-platform@1.0.1
voicecan-device onboard
```

The first command also replaces an older Gitea npm-scope setting, if present.

`onboard` explicitly migrates the local SQLite database, installs and starts a
current-user background service, opens `http://127.0.0.1:8787/admin`, and exits.
On a headless machine, use:

```bash
voicecan-device onboard --no-open
```

Complete trusted setup in the opened page. Do not copy setup secrets into
automation output.

## Persistent global installation

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npm install --global @voicecan/device-platform@1.0.1
voicecan-device onboard
```

The service persists after the terminal exits. Inspect it with:

```bash
voicecan-device service status --output json
voicecan-device service restart --output json
voicecan-device doctor --output json
```

Open <http://127.0.0.1:8787/admin> after the server reports ready.

## Exact instructions for an AI coding agent

An agent may install and initialize a local instance by executing:

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npm install --global @voicecan/device-platform@1.0.1
voicecan-device onboard --no-open --output json
```

It must use the returned `next_actions` to open Admin for the user. It must not
delete an existing Profile, print secrets into chat, or run a production
migration without explicit authorization.

Useful commands:

```bash
voicecan-device --help
voicecan-device capabilities --output json
voicecan-device service status --output json
voicecan-device admin-mcp stdio
```

## Configuration

The zero-config profile is a single-node SQLite Edge installation. Important
environment variables include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOICECAN_DATA_DIR` | Profile `data/` | Database, secrets, logs, and local objects |
| `VOICECAN_PORT` | `8787` | HTTP and device WebSocket port |
| `VOICECAN_PUBLIC_BASE_URL` | `http://127.0.0.1:8787` | Browser-facing URL |
| `VOICECAN_HOST` | `0.0.0.0` | Listen address |
| `VOICECAN_SIMULATOR` | `false` | Enable development simulator endpoints |

PostgreSQL, S3, TLS/reverse proxy, backup, and production multi-instance
deployment require the full operations documentation in the source repository.

## Public application SDKs

Applications integrating with a running platform normally install only:

```bash
npm install @voicecan/connector-runtime
```

That package installs `@voicecan/server-client` and `@voicecan/contracts` as
dependencies. They are separate from this server distribution package.

## License

Apache License 2.0. The license covers this distribution, including the bundled
reviewed compiled protocol runtime. See `LICENSE`, `NOTICE`, and
`THIRD_PARTY_NOTICES.md` in the npm package.
