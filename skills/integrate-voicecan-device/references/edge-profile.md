# Edge profile

Use one pinned Server image and one persistent data volume. Run `migrate` explicitly before `serve`. Keep Admin/setup on loopback or a controlled private ingress; expose device WSS/upload through a stable trusted-domain TLS route. Back up the database, objects, configuration, master key, and token pepper together. Restore must preserve the public device URL and must not reopen setup.

This preview supports the local filesystem upload path and simulator end to end. The private Rust Core, Browser/Node WASM loaders, WebBluetooth transport, and Gateway Actor are included and conformance-gated. Treat physical V1.2 results, S3 direct integration, full relay orchestration, private CA/IP, SEA, and multi-instance PostgreSQL as blocked until their named validation artifacts are present.
