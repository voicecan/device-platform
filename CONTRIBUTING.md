# Contributing

Contributions to the public API, Device Server, Web SDK/UI, clients, simulator, documentation, and deployment tooling are welcome.

Before opening a change:

```powershell
npm ci
npm run ci
docker compose -f deploy/docker-compose.yml config --quiet
```

Do not submit Rust protocol code, schemas, Golden Fixtures, raw frames, SID/CID constants, fuzz corpora, raw-command APIs, source maps, credentials, or recordings. Protocol changes must be made and reviewed in the separate private Device Core repository, then imported here only as a versioned, reviewed release artifact with an updated `core-artifacts.lock.json` and lockfile.

Keep public APIs semantic and transport-neutral. Preserve group-derived authorization, immutable file semantics, explicit migrations, streaming I/O, and the separation from VoiceCan business services.
