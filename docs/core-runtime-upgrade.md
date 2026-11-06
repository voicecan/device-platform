# Core runtime upgrade — 2026-11-06

The platform pins `@voicecan/device-core@0.1.0-preview.22`, ABI `voicecan-v1.3`. The vendored package and `core-artifacts.lock.json` pin the tarball, conformance digest and matching Browser/Node WASM digests. Private protocol sources and fixtures remain outside this repository.

Core preview.22 adds optional `maxDurationMinutes` to recording start through `gateway.requestDeviceControl`, `session.controlRecording('start', options?, signal?)`, and `session.startRecording(options?, signal?)`. Values must be integers from 0 to 255; 0 or omission keeps the existing no-segmentation behavior. Non-start actions reject the duration field, including 0. Existing BLE signatures that pass an AbortSignal directly remain supported.

The recording segment selector is enabled with Unlimited (0), 15, 30, 45, and 60 minutes. Start forwards the selected minutes over WSS and BLE; Stop and Resume do not carry a duration. `parseDeviceControl` validates and preserves the start-only integer field, and the command payload retains it for polling, queued dispatch, and idempotency checks. Public TypeScript contracts and OpenAPI expose the same limits. Both transports call semantic Core APIs. Firmware logs and actual timed segmentation still require physical-device validation.

Recording results may include the firmware-reported `action`. A result for a different action cannot complete the active recording command. Results still have no unique request identifier, so concurrent operations of the same action remain ambiguous; status readback is authoritative.

Recording configuration accepts microphone modes 0–3. Replace the former `lookbackSeconds` field with `lookbackDurationIndex` (integer 0–3). The firmware specification supplies no mapping to seconds. The API rejects the old field instead of silently applying a different duration. Smart Capture requires zero or omission. Admin and BLE controls preserve the observed microphone settings.

Filesystem rejection ends the inventory attempt without dropping WSS. A filesystem-ready event after USB exit triggers a full inventory scan and status refresh, including recordings older than the previous incremental cursor.

An empty-content direct-upload result at offset zero is initial progress. Completion requires the uploaded offset and reported file size to match the expected size; intermediate progress cannot commit an unfinished object.

BLE OTA now requires the Core transport's concurrent `write` and `interact` capabilities. The Web Bluetooth implementation serializes physical writes while listening for flow control, and uses a 30-second default command timeout. Core streams OTA payloads after device approval and offset, without waiting for individual packet acknowledgements. Node prepares firmware with the same Rust validator before creating a server OTA command. OTAP containers and raw payloads are supported; CRC and metadata must match, and only payload bytes reach the device.

OTA completion no longer sends a redundant restart command through BLE or WSS. `OTA_REBOOTING` confirms the transfer/restart stage; verify running firmware after reconnect before treating an upgrade as fully validated. Physical-device verification remains pending.

Validation covers the packaged Browser/Node runtime, start-only duration types and validation, default/zero compatibility, cancellation, command persistence/idempotency, and forwarding through WSS and BLE. Public artifact checks verify tarball checksums, the conformance hash, matching WASM digests, and the absence of private protocol sources. Physical-device validation remains pending.
