# Independent Server quickstart

This guide installs the Edge/SQLite profile. It does not prove physical-device, TLS, S3, or production multi-instance readiness.

Before selecting a decoder or issuing synchronization, read `/devices/{id}/capabilities` and the Recording `media` object. Treat unknown values as unknown. Application integrations should use SDK Download Grants so length and SHA-256 are verified before an atomic destination commit.

## Requirements

- Node.js `>=24.15.0 <25` and npm.
- A private persistent data directory.
- HTTPS for every non-loopback browser deployment; Web Bluetooth requires a secure context.
- A provisioning client that meets the [Device Connect Web system requirements](device-connect-web.md#客户端系统要求).
- A device-reachable LAN address for Edge `ws://` provisioning. Production still requires a WSS hostname and certificate trusted by the target firmware.

## Install and start

Choose npm, Docker + Compose v2, the private Node.js runtime, or a source
installation. Confirm the choice before installing; do not combine methods in
the same installation directory.

### One-command npm install

Run these commands from the directory that should retain the local `data/`
directory:

```sh
npm config set @voicecan:registry https://registry.npmjs.org/
npx --yes @voicecan/device-platform@1.0.0 init
```

The registry command replaces any older Gitea setting for the `@voicecan`
scope. `init` explicitly runs the idempotent SQLite migration, starts the
Server, and opens `http://127.0.0.1:8787/admin`. Use `--no-open` on a headless
host. Installation itself has no migration or other mutating `postinstall`
hook; later starts remain explicit:

```sh
npm install --global @voicecan/device-platform@1.0.0
voicecan-device migrate
voicecan-device serve
```

### One-command Docker install

The public `main` branch is the release channel. On a host with curl, Git,
Docker Engine, and Docker Compose v2:

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh | bash
```

This installs the single-instance SQLite Edge profile without root privileges,
binds HTTP to `127.0.0.1:8787`, verifies the reviewed protocol-runtime artifact, runs the
explicit migration, and waits for `/health/ready`. Source and `.env` are stored
under `${XDG_DATA_HOME:-$HOME/.local/share}/voicecan-device-platform`; recording
data stays in the Compose volume. Use `--install-dir`, `--port`, `--public-url`,
`--repository`, `--ref`, or `--project` to override defaults (`--help` lists the
matching environment variables).

The installer is deliberately install-only. It records the exact Git commit in
the image tag and refuses to overwrite an existing directory. Existing
installations must follow the backup, migration, canary, and rollback procedure
in [versioning and migrations](versioning-and-migrations.md).

### One-command private Node.js install

On a macOS or Linux host with curl, Git, `tar`, and a SHA-256 utility:

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install-node.sh | bash
```

This follows the same public `main` release channel without requiring Docker or
a user-installed Node.js/npm. It selects the macOS/Linux x64/arm64 archive from
`node-runtime.lock`, downloads the exact Node.js 24.19.0 runtime, verifies its
locked SHA-256, and uses only that private runtime for dependency installation,
verification, build, migration, pruning, and service execution. Runtime and data
stay under the installation directory; HTTP defaults to `127.0.0.1:8787`.

On Linux it uses a user-level systemd unit when a user manager is available; on
macOS it uses a per-user launchd agent. It does not request root access. If no
supported service manager can be started, the installation still completes and
prints a foreground start command. Use `--no-service` to deliberately skip
service installation.

### Manual source install

```sh
cp .env.example .env
npm ci --ignore-scripts
npm run check:public
npm run verify:core
npm run build
npm run migrate
npm start
```

Migrations are explicit and are never run by `serve`. Open `http://127.0.0.1:8787/admin`; the startup summary prints the initial setup-token path and `node packages/device-server/dist/cli.js show-setup-token` to reveal it on demand. Create the first System Admin; the token file is removed after setup.

Create a group and an origin-bound provisioning grant in `/admin`. Admin now keeps the provisioning flow in one workspace: when the current secure context exposes Web Bluetooth it embeds the local connector; otherwise it opens the independently deployed public connector configured by `VOICECAN_CONNECT_WEB_URL`. The public page performs BLE on the user's computer while the original Admin page proxies the narrow API operations to the local/NAS Server. Provisioning grants are never placed in a URL, browser storage, log, or support bundle.

The Wi-Fi selected during provisioning must put the Device on the same network as the Voicecan Platform Server so the first reverse connection can be confirmed. The Bind Device form lists the reviewed WebSocket URL candidates and allows one-click selection. An explicit `VOICECAN_DEVICE_WSS_URL` remains authoritative; otherwise, when Admin is opened through a public IP, that current `ws://` or `wss://` address is preferred over detected LAN IPv4 addresses. Loopback, private, shared, link-local, documentation, and other non-public request addresses are not preferred. Set `VOICECAN_DEVICE_ADVERTISE_HOST` when automatic interface selection is wrong, or enter another Device WebSocket URL in Admin for a one-off override. Production profile startup requires an explicit `wss://` `VOICECAN_DEVICE_WSS_URL`; request-Host derivation is limited to development and Edge deployments. See [independent Device Connect Web](device-connect-web.md).

OTA reads only from the local firmware repository. System Admins can upload a custom binary in Device Management or click **Import official** to fetch, verify, and retain a local copy. Configure `VOICECAN_OFFICIAL_FIRMWARE_SOURCE_URL` when using an internal mirror; it defaults to `https://api.voice-can.com/`. See [local firmware repository and OTA](firmware-repository.md).

## Compose

```sh
cp .env.example .env
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml run --rm migrate
docker compose -f deploy/docker-compose.yml up -d device-server
```

The checked-in Compose binds the Server to loopback. Put an audited TLS reverse proxy in front of it for browser/device access. Do not expose setup or metrics directly to the public Internet.

## Reset the Edge data and initialize again

There is no `reset` CLI command. A complete Edge reset means removing the whole data directory while the Server is stopped, not only `device-platform.sqlite`. The directory also contains the SQLite WAL/SHM files, immutable recording objects, the setup token (while setup is pending), the deployment keyring, and the Group Token pepper. This operation is irreversible; create and verify a backup first if any data may be needed later.

For the default local configuration (`VOICECAN_DATA_DIR=./data`), stop `npm start` or `npm run dev`, verify that the current directory is the repository root, and run:

```powershell
Get-Item -Force .\data
Remove-Item -LiteralPath .\data -Recurse -Force
npm run migrate
npm start
```

On POSIX shells, the equivalent is:

```sh
ls -ld -- ./data
rm -rf -- ./data
npm run migrate
npm start
```

The next Server start creates a new owner-only `data/setup-token`; use it to create the new first System Admin. Deleting only the SQLite file is not supported as a full reset because it leaves old objects and secrets behind.

If `VOICECAN_DATA_DIR`, `VOICECAN_DATABASE_FILE`, or `VOICECAN_STORAGE_DIR` is overridden, resolve and inspect every configured path before deleting it. The database or object directory can live outside `VOICECAN_DATA_DIR`, so removing `./data` alone may be incomplete. Never point a recursive deletion command at an unresolved environment variable, the repository root, or a shared directory.

For the checked-in SQLite Compose profile, stop the stack and remove its named data volume, then migrate and start it again:

```sh
docker compose -f deploy/docker-compose.yml down --volumes
docker compose -f deploy/docker-compose.yml run --rm migrate
docker compose -f deploy/docker-compose.yml up -d device-server
```

`down --volumes` permanently deletes the Compose project's `voicecan-device-data` volume. This procedure does not apply when `VOICECAN_DATABASE_URL` selects PostgreSQL or when object storage is external (for example, S3). A PostgreSQL/S3 reset must be an operator-approved, environment-specific operation that clears both metadata and exact object versions; removing only the database or a Compose volume can orphan the other half.

## Verify

```sh
npm run ci
node packages/device-server/dist/cli.js doctor
node skills/integrate-voicecan-device/scripts/doctor.mjs --url http://127.0.0.1:8787
npm run smoke -- --url http://127.0.0.1:8787
```

Before enabling real devices, complete the release gates in [implementation status](implementation-status.md).
