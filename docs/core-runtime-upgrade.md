# Core runtime upgrade — 2026-11-03

The platform pins `@voicecan/device-core@0.1.0-preview.21`, ABI `voicecan-v1.3`. The vendored package and `core-artifacts.lock.json` pin the tarball, conformance digest and matching Browser/Node WASM digests. Private protocol sources and fixtures remain outside this repository.

Recording results may include the firmware-reported `action`. A result for a different action cannot complete the active recording command. Results still have no unique request identifier, so concurrent operations of the same action remain ambiguous; status readback is authoritative.

Recording configuration accepts microphone modes 0–3. Replace the former `lookbackSeconds` field with `lookbackDurationIndex` (integer 0–3). The firmware specification supplies no mapping to seconds. The API rejects the old field instead of silently applying a different duration. Smart Capture requires zero or omission. Admin and BLE controls preserve the observed microphone settings.

Filesystem rejection ends the inventory attempt without dropping WSS. A filesystem-ready event after USB exit triggers a full inventory scan and status refresh, including recordings older than the previous incremental cursor.

An empty-content direct-upload result at offset zero is initial progress. Completion requires the uploaded offset and reported file size to match the expected size; intermediate progress cannot commit an unfinished object.

BLE OTA now requires the Core transport's concurrent `write` and `interact` capabilities. The Web Bluetooth implementation serializes physical writes while listening for flow control, and uses a 30-second default command timeout. Core streams OTA payloads after device approval and offset, without waiting for individual packet acknowledgements. Node prepares firmware with the same Rust validator before creating a server OTA command. OTAP containers and raw payloads are supported; CRC and metadata must match, and only payload bytes reach the device.

OTA completion no longer sends a redundant restart command through BLE or WSS. `OTA_REBOOTING` confirms the transfer/restart stage; verify running firmware after reconnect before treating an upgrade as fully validated. Physical-device verification remains pending.

Validation on Windows / Node 24.19.0:

| Check | Result |
| --- | --- |
| Core Rust workspace tests | 57 passed |
| Core Browser/Node WASM tests, including OTA/OTAP | 18 passed |
| Rust format / Clippy with warnings denied | Passed |
| Platform build / typecheck | Passed |
| Artifact checksums, conformance and public boundary | Passed; 17 artifact files inspected |
| Recording, Gateway, Web Bluetooth and maintenance regression group | 57 passed |
| Gateway group after direct-upload progress correction | 31 passed |
| Platform full suite | 243 tests: 235 passed, 4 skipped, 4 failed |

The full-suite failures are outside this protocol change: `admin-ui.test.ts` expects a `DeviceWsCandidatePicker` fragment absent from the unchanged `device-management.tsx`; `mcp-quick-connect.e2e.test.ts`, `server.e2e.test.ts` and `studio-quick-connect.e2e.test.ts` assert POSIX file modes that Windows does not report. These assertions and their production source paths were not changed to make the suite green. Physical-device verification remains pending.
