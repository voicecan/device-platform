# Public Platform / Private Core boundary

The workspace now contains two independent repositories:

| Repository | Visibility | Owns |
| --- | --- | --- |
| `device-core` | Private | Rust protocol implementation, private fixtures, WASM build, conformance tests, release packaging |
| `device-platform` | Public | Server, public contracts, Web SDK/UI, clients, simulator, deployments, documentation, reviewed Core artifact |

The public repository never builds the wire protocol. It installs the pinned `@voicecan/device-core` tarball from `vendor/`, checks the tarball SHA-256 in `core-artifacts.lock.json`, checks the public ABI/conformance manifest, and performs the Node loader self-check. Docker builds use the same committed artifact and lockfile.

## Core release import

1. In the private repository, run all Rust, WASM, TypeScript, fixture, and loader tests.
2. Run `npm pack` and inspect the complete tar listing. It may contain only compiled JS/declarations, Browser/Node WASM, loaders, the manifest, package metadata, and public documentation.
3. Copy the exact tarball into `device-platform/vendor/`.
4. Update the version, filename, SHA-256, ABI, conformance hash, and WASM digests in `core-artifacts.lock.json`.
5. Update the root dependency and run `npm install` to regenerate `package-lock.json`.
6. Run `npm run ci`; do not merge if the public-boundary or Core verification gate fails.

Artifact signing and provenance attestations remain release-hardening work. The current Preview gate provides deterministic content inspection, npm lock integrity, an explicit SHA-256 lock, and runtime conformance verification; it does not claim a signed release.
