# Operations, TLS, backup, and release runbook

## Network and TLS

Use separate, explicit public URLs for the application/API and device WSS endpoint. Public production deployments require HTTPS/WSS. A trusted private network may instead set `VOICECAN_DEPLOYMENT_PROFILE=intranet`; that explicit mode permits private-address HTTP service, connector, firmware-source, provisioning/OAuth origins, and Webhook URLs. It does not add encryption, so do not expose that listener to the Internet.

For public deployments:

1. Terminate TLS with TLS 1.2+ at a reviewed reverse proxy.
2. Preserve WebSocket Upgrade on `/device/v1/ws` and streaming request bodies on `/device-upload/v1/*`.
3. Disable proxy buffering for large uploads/downloads and set timeouts above the configured device transfer window.
4. Keep `/metrics`, setup, and offline-maintenance access on loopback, private network, or VPN.
5. Verify the certificate chain, hostname/SAN, SNI, device clock, renewal, and rollback on every declared firmware.

## Backup and restore

The complete data classification, backup-set contents, candidate RPO/RTO, and restore evidence gate are defined in [Privacy, retention, and disaster recovery](privacy-retention-and-disaster-recovery.md). A database-only copy is not a valid backup.

Create and verify a backup regularly:

```sh
node packages/device-server/dist/cli.js backup create /secure/backups/voicecan-YYYYMMDD
node packages/device-server/dist/cli.js backup verify /secure/backups/voicecan-YYYYMMDD
```

Restore only into a new, empty target while the Server is stopped:

```sh
node packages/device-server/dist/cli.js backup restore /secure/backups/voicecan-YYYYMMDD /srv/voicecan-restored
```

Point a disposable Server at the restored directory, run readiness/setup smoke, read a sampled immutable file, and verify a Webhook signature before declaring the backup usable.

## Upgrade and rollback

1. Drain or stop the Server; do not run two SQLite Edge instances against one data directory.
2. Create and verify a backup.
3. Record image/package checksum, protocol-runtime ABI, conformance hash, and migration version.
4. Run the explicit migration using the new release.
5. Start one instance and verify readiness, Admin login, WSS Upgrade, range download, and a fixture event.
6. Roll back application code only when the old release explicitly supports the resulting schema. Otherwise restore the pre-upgrade backup into a new directory.

Never edit migration history, generated protocol-runtime artifacts, encrypted credentials, or audit rows by hand.

On `SIGTERM`/`SIGINT`, the Server marks readiness as `draining`, waits `VOICECAN_DRAIN_MS` (default 5000 ms) for load balancers to remove it, then closes Fastify and its database worker. Set the orchestrator termination grace period above the drain interval plus the longest accepted in-flight HTTP request. SQLite Edge remains single-instance even with graceful drain.

## Local rolling logs

The Server writes the configured redacted log stream to `VOICECAN_DATA_DIR/logs/device-server.log` by default, while stdout emits only `warn` and higher operational logs plus the human-readable startup/shutdown summary. Size-based rotation retains 10 files including the active file, with a 10 MiB limit per file. Configure `VOICECAN_LOG_DIR`, `VOICECAN_LOG_MAX_BYTES`, and `VOICECAN_LOG_MAX_FILES`; set `VOICECAN_LOG_FILE=false` only when the deployment runtime already provides durable log collection. Credentials, cookies, device tokens, and secrets remain redacted in structured logs. While first-time setup is pending, the startup summary prints only the owner-readable token file path (or external-secret source) and this explicit reveal command:

```sh
node packages/device-server/dist/cli.js show-setup-token
```

## Credential and incident operations

- Rotate deployment keys offline with `keys rotate`; retain old versions until a restore drill succeeds.
- Reset a local password through stdin while stopped; all sessions for the user are revoked.
- Revoke Group API Tokens and disable/remove users through the API/Admin Console; access is fail-closed immediately.
- Cross-deployment device release requires a five-minute transfer-out grant, exact Origin, nearby BLE old-token proof, and a successful non-erasing ACK. Timeout or disconnect does not release the source claim.
- Do not place setup, provisioning, transfer, Group API, device, or Webhook secrets in command arguments, URLs, tickets, logs, traces, or backups without encryption.

## Release checklist

Generate the unsigned local evidence bundle only on the supported Node release and after `npm run ci`:

```sh
npm run release:evidence -- --output /secure/release-evidence/voicecan-device-VERSION
```

The command writes a CycloneDX SBOM, deterministic SHA-256 inventory, and release manifest without reading or producing signing keys. It refuses unsupported Node versions and existing output files. Sign and attest these files only in the authorized release environment; the local bundle is not release approval.

Maintain a private copy of `docs/release-dossier.example.json`, add every required gate for the target stage, and reference immutable evidence rather than pasting secrets. The final fail-closed decision is:

```sh
npm run release:check -- --stage preview --dossier /secure/release-dossier.json --evidence-dir /secure/release-evidence/voicecan-device-VERSION
```

Use `--stage beta` or `--stage ga` to include all preceding gates. The checker requires the dossier and manifest commit/version to match the current checkout, the exact release Node 24.19.0 baseline, approved LICENSE/NOTICE files, an eligible manifest, checksums, SBOM, evidence references, approvers, and approval timestamps. It does not verify signatures cryptographically; the authorized release system must do that before calling the gate.

- Node 24.19.0 full CI and protocol fuzz CI pass.
- OCI amd64/arm64 image is pinned by digest and starts from a clean volume with explicit migration.
- Real firmware BLE/WSS/inventory and filesystem/S3/relay recovery matrix passes.
- TLS and optional private-CA/IP matrix passes only for combinations declared supported.
- Backup/restore and upgrade/rollback drills pass.
- Public-boundary scan, dependency/secret scan, SBOM, provenance, checksum, and signatures pass.
- Independent security review has no unaccepted P0/P1.
- Release notes list exact firmware/browser/storage support and remaining protocol risks.
- Capacity evidence and alert rules meet [the SLO and capacity gate](slo-capacity-and-alerting.md).
- Privacy/retention owners approve the data-class record, deletion/legal-hold behavior, and a restore drill as required by [the privacy and disaster-recovery gate](privacy-retention-and-disaster-recovery.md).
