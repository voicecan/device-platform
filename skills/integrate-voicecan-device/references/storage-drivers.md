# Storage drivers

- `filesystem_http`: preview default. The Server issues a one-time ticket, streams to a generated `.part` path, verifies exact size and SHA-256, fsyncs, and atomically renames to an immutable locator.
- `s3_direct`: planned production path. Require attempt-specific staging keys, size verification, and promotion to an immutable final key or pinned object version. Do not let a signed PUT address an already-published final object.
- `server_relay`: planned fallback. Require private-Core protocol integration, device-level serialization, offsets, backpressure, and persistent transfer state.

Do not advertise a driver as available merely because configuration fields or interfaces exist. Verify it with its integration matrix first.

