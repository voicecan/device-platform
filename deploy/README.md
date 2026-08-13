# Deployment profiles

`docker-compose.yml` is the single-instance SQLite Edge profile. It runs the explicit migration service before the application, binds the public port to loopback by default, and must never be horizontally scaled or placed on a shared SQLite/NFS database file.

For a clean host, the repository-root `install.sh` clones the public `main`
release, builds a commit-tagged local image, runs the migration service, starts
only the application service after migration succeeds, and waits for the
Compose health check. It is an initial-install convenience, not an upgrade
mechanism; it refuses to replace an existing source/config directory.

`install-node.sh` provides the equivalent initial installation without using a
host Node.js/npm. It downloads the exact macOS/Linux x64/arm64 runtime pinned in
`node-runtime.lock`, enforces its SHA-256, and keeps both the runtime and SQLite
data in the private installation directory. It uses a user-level systemd unit or
launchd agent when available and never escalates privileges.

The manually dispatched `device-platform-release-candidate` workflow runs the complete Node 24.19.0 gate, emits the unsigned release-evidence bundle, and builds one multi-platform OCI layout for Linux amd64/arm64. It deliberately does not log in, push, sign, or assign a stable tag. Download the workflow artifacts and run clean-volume migration/readiness/WSS/stream/backup tests on both architectures before promotion.

`production-compose.yml` is the two-instance acceptance profile: PostgreSQL 16, an explicit advisory-locked migration, two stateless Server containers, immutable S3 storage, and an internal nginx gateway. Pin the Server image by digest and put a reviewed TLS proxy in front of the loopback gateway. It is not a substitute for managed PostgreSQL PITR or managed object storage.

`helm/voicecan-device-platform` is the Production Kubernetes profile. It includes a PostgreSQL migration hook, two-replica Deployment, graceful probes/drain, anti-affinity, Service, PDB, optional TLS Ingress, immutable image requirement, and external Secret contract. The chart does not install PostgreSQL or S3; those stateful services, backups, identities, and recovery objectives stay operator-owned.

The browser-only connector is deployed separately from the Server: build `packages/device-connect-web`, publish it on public HTTPS, and configure the Server with `VOICECAN_CONNECT_WEB_URL`. Its dedicated multi-stage image is built with `docker build -f packages/device-connect-web/Dockerfile .`; the container listens on HTTP 8080 behind operator-owned TLS termination. A reviewed nginx response-header baseline is provided at `packages/device-connect-web/deploy/nginx.conf`; do not enable `Cross-Origin-Opener-Policy: same-origin`, because the connector deliberately establishes a transferred `MessageChannel` with the originating Admin page. The `device-connect-web-image` Gitea workflow verifies the connector, builds and pushes a single `linux/amd64` image, renders `packages/device-connect-web/deploy/deploy.template`, and deploys it to Kubernetes over SSH. See `docs/device-connect-web-deployment.md` for the CI contract and acceptance steps.
