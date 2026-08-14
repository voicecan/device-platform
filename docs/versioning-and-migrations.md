# Versioning, compatibility, deprecation, and migrations

This policy applies when the first stable release is cut. Preview versions may change, but every preview release must still publish its exact protocol-runtime ABI, API version, schema version, and migration prerequisites.

## Versioned surfaces

- Public TypeScript/Python SDKs, Connector runtime, UI components, and Device Server use SemVer. A documented public API break requires a major release.
- REST and Webhook contracts carry a calendar API version. Additive fields are allowed within a version; removal, type changes, semantic changes, or new required input require a new API version.
- The compiled protocol-runtime package uses SemVer plus an explicit `protocol_abi`, supported firmware range, conformance hash, and Browser/Node WASM digests. Device Server and Browser SDK accept only the pinned reviewed artifact bundled with the release.
- Database schema versions are monotonically increasing integers. Migrations are immutable, ordered, explicit, and never run at service startup.

## Compatibility window

- Each stable Device Server supports its bundled SDK/UI and the immediately preceding stable SDK minor line for at least 90 days, unless a security issue requires a shorter emergency window.
- A new protocol-runtime artifact may be introduced only when both Browser and Node artifacts pass the same conformance set. The previous reviewed artifact remains a rollback option for one stable Server minor line when the database/API contract remains compatible.
- Webhook consumers must ignore unknown additive fields. The Server retains the previous Webhook API version for at least 180 days after announcing a replacement.
- Firmware/model/storage support is exactly the published compatibility matrix; unlisted combinations fail closed or remain explicitly experimental.

## Deprecation

Deprecation requires release notes, a replacement path, first/last supported versions, and a removal date. Stable API removal occurs only in a major release or a new calendar API version. Security removals may be accelerated, but must include impact, mitigation, and rollback guidance.

## Migration and rollback

1. Stop or drain the instance, verify a fresh backup, and record application version, image/package digest, protocol-runtime ABI/hash, and current schema version.
2. Run the new release's explicit migration exactly once. Migration ownership must be serialized; application replicas never compete to migrate.
3. Start one canary and validate readiness, authentication, WSS Upgrade, Range download, one fixture event, and one connector retry.
4. Expand only after the canary passes. Never edit migration history or database metadata by hand.
5. Code rollback is allowed only when the previous release declares the resulting schema readable. Otherwise restore the pre-upgrade backup into a new data directory/database and verify it before traffic cutback.

Every release must include a migration guide containing source/target versions, downtime expectation, irreversible steps, backup/restore commands, canary evidence, and the last safe rollback point.
