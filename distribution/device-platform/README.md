# @voicecan/device-platform

The complete self-hosted Voicecan Device Platform: Device Server, Admin UI,
browser device binding UI, and the reviewed compiled protocol runtime.

## One-command local installation

Requirements: Node.js `>=24.15.0 <25` (Node.js 24.19.0 is recommended) and npm.

Run this command in the directory where you want to keep the local `data/`
directory:

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npx --yes @voicecan/device-platform@1.0.0 init
```

The first command also replaces an older Gitea npm-scope setting, if present.

The command installs the package, explicitly migrates the local SQLite database,
starts the server, and opens `http://127.0.0.1:8787/admin`. Keep the terminal
running. On a headless machine, use:

```bash
npx --yes @voicecan/device-platform@1.0.0 init --no-open
```

The terminal prints the setup-token file and the command for reading it. Enter
that temporary token in the opened page and create the first administrator.

## Persistent global installation

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npm install --global @voicecan/device-platform@1.0.0
voicecan-device init
```

Later starts do not run migrations automatically:

```bash
voicecan-device migrate
voicecan-device serve
```

Open <http://127.0.0.1:8787/admin> after the server reports ready.

## Exact instructions for an AI coding agent

An agent may install and initialize a local development instance by executing:

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npx --yes @voicecan/device-platform@1.0.0 init --no-open
```

It must wait for `Voicecan Device Server is ready`, then open
`http://127.0.0.1:8787/admin` for the user. It must not delete an existing
`data/` directory, print secrets into chat, or run a production migration
without explicit authorization.

Useful commands:

```bash
voicecan-device --help
voicecan-device show-setup-token
voicecan-device doctor
```

## Configuration

The zero-config profile is a single-node SQLite Edge installation. Important
environment variables include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOICECAN_DATA_DIR` | `./data` | Database, secrets, logs, and local objects |
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
