# Protocol runtime dependency boundary

This public repository uses the pinned `@voicecan/device-core` package only as a compiled protocol runtime. The reviewed tarball is committed under `vendor/`, referenced by the root `package.json`, and integrity-pinned by `core-artifacts.lock.json` and `package-lock.json`.

For a normal source installation, no additional repository or protocol source is needed:

```bash
npm install
npm run verify:core
npm run build
```

`npm install` resolves the committed tarball. `npm run verify:core` checks its SHA-256, public ABI/conformance manifest, Browser/Node WASM digests, package contents, and Node loader. Docker builds use the same committed artifact and lockfiles.

Protocol source, private fixtures, raw-command tooling, source maps, Cargo files, and fuzz corpora are intentionally absent from this repository and must not be added or reconstructed. Application code should use the public semantic APIs exposed by the packages in this repository rather than importing `@voicecan/device-core` directly.

Runtime artifact updates are maintainer-only. A reviewed update must change the vendored tarball, `core-artifacts.lock.json`, the root dependency, and `package-lock.json` together, then pass `npm run ci`. Ordinary contributors and AI coding agents should not replace or regenerate this artifact.
