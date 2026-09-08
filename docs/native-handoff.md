# Native binding handoff v1 (development preview)

Implemented 2026-09-08. This is the server/Web part of the native app plan (T07 and part of T08). Android/iOS now implement administrator-verified self-hosted HTTPS origin registration, signed exchange/observe/cancel, separate secure task recovery and QR/paste task screens. Android also accepts explicit system text sharing. Web generates QR codes locally. Verified App/Universal Links and BLE task execution remain pending; no native claim is enabled. No production deployment or device acceptance is implied.

## Authorization flow

1. An authorized Web user creates a `binding_intent`, then posts `{}` to `/api/v1/binding-intents/:id/native-handoffs`. The response contains an HTTPS deployment link of the form `/native/connect?v=1&handoff=<id>#ticket=<opaque>`. The ticket expires in five minutes or at the binding root expiry, whichever is earlier. The development test origin uses HTTP loopback only.
2. The app must already trust the exact platform origin. Users register it separately after verifying the HTTPS address with their deployment administrator through an independent trusted channel; the deployment host is not hard-coded. A scanned link must never establish trust or supply a new API/callback origin. Persist a temporary P-256 private key, handoff ID and exchange request ID in task-only secure storage before exchange; do not put them in the local device credential store. Do not send user cookies or an Origin header.
3. The app signs `POST /api/v1/native-handoffs/exchange` with `{handoff_id,ticket,client_public_key,request_id}`. The public key is canonical unpadded base64url SPKI DER, curve prime256v1. The server stores the ticket hash and public key, never the raw ticket or private key. This only establishes a pending execution request; it does not release a device Token.
4. Both screens display `client_fingerprint`: first 24 lowercase hex characters of SHA-256 of the public-key DER. The user compares it before pressing Web **Approve this app**. Web approval posts `{expected_execution_epoch}` to `/api/v1/native-handoffs/:id/approve`. The original binding browser needs its cookie plus exact allowed Origin; a signed-in user needs its session, CSRF and current group administrator authority. Approval does not accept native proof in place of Web authority.
5. The app calls signed `observe` to discover the approved epoch, including when its last known epoch was zero. `observe` is read-only and does not renew the lease. `resume` renews a still-valid two-minute lease using the current epoch. An expired lease requires explicit Web reapproval, advancing the epoch; the same handoff can recover its original Token. Clients should renew while executing, before lease expiry.
6. Only after verifying nearby device identity may the app call `claim`. Bind-only scope, expected SN, group authority, active executor, epoch and lease are enforced server-side. All task configuration comes from the response: `expected_identity`, `network_mode`, `resolved_device_ws_url`, scan-config v1 and same-origin callback registration. App-supplied override fields are rejected. An actual App must also enforce its Core credential persistence/recovery gates before writing a device.
7. Signed `progress` accepts only `ble_authenticated` followed by `configured`. Repeated or older stages are idempotent. Only Gateway persistence can result in `binding_status=completed`. Web continues observing the same binding root; a callback is never completion evidence.

## Signed requests

All app routes use POST without query parameters. Bodies are closed objects containing only strings and safe integers. Sort top-level keys lexicographically, serialize compact JSON as UTF-8 (JSON.stringify-compatible escaping; no whitespace or Unicode normalization), then SHA-256 the bytes to lowercase hex. Sign the following seven lines, with LF separators and **no final LF**:

```text
voicecan.native-proof.v1
<exact configured API origin>
POST
<exact /api/v1/native-handoffs/... path>
<Unix milliseconds, 13 decimal digits>
<nonce>
<canonical body SHA-256 hex>
```

Use ECDSA P-256/SHA-256 with DER signature encoding, sent as unpadded base64url in `X-VC-Signature`. `X-VC-Timestamp` allows ±60 seconds; `X-VC-Nonce` is 22–80 base64url characters (24 random bytes recommended). Nonces cannot be replayed. The test exports `nativeProofMessage` as the executable reference for cross-language vectors.

After exchange each body includes `request_id` and nonnegative integer `execution_epoch`. Claim also requires `manufacturer` (max 64) and `serial_number` (max 16), with optional `model`/`firmware_version` (max 64). Progress also requires `stage`. Cancel, resume and observe accept no further fields. Unknown fields are rejected. Endpoint schemas are in [OpenAPI](openapi.yaml).

For a lost response, resend the same operation/body/request ID with a **fresh nonce, timestamp and signature**. Reusing an ID for a different body/operation returns `NATIVE_IDEMPOTENCY_CONFLICT`. Exchange retry also requires the same key and ticket; another key cannot take over the ticket. Claim retries recover the same encrypted temporary credential, never mint a replacement. The device Token uses the platform's existing padded standard Base64 encoding, not base64url. Native responses never expose browser continuation grants.

Each handoff is limited to 2,048 request IDs and 512 recent nonces, with at most 20 handoffs per intent. The binding root's existing 30-minute lifetime remains the outer deadline. A replay cannot extend it. `instance_id` is `instance_` followed by the first 32 hex characters of SHA-256 of the configured API origin; it is an identifier, not a trust certificate.

## Execution and recovery limits

An intent has one executor row. Approval atomically increments its epoch and sets the handoff/session; stale approval fails. Repeating a successful approval with its original expected epoch returns the current approval without advancing it again. Before credential issuance, Web may approve another exchanged handoff and fence out the previous one. After issuance, switching to another handoff returns `EXECUTOR_ALREADY_STARTED`; reauthorize the original app instead. Other binding tasks cannot silently supersede an active native credential owner.

`cancel` stops future native mutations but leaves the provisioning session and device credential intact: a write may already have reached the device. Subsequent Gateway confirmation still wins. The response reports `stopped_pending_device_confirmation`, not device rollback. A cancelled task can still observe while its outer lifetime is valid. `owns_execution` is false for cancelled, superseded or lease-expired handoffs. The app now restores a saved task key after restart; recovery after losing that key and a user-facing rebind after cancelled/expired tasks remain part of T08; never infer a safe device reset or generate a replacement Token.

## Storage and verification

Schema version 19 adds handoff, executor, nonce and request-key tables. Use the existing explicit `npm run migrate` workflow on an intended deployment; startup does not migrate. This implementation was tested only against disposable local databases. No deployed database was changed. PostgreSQL derives the same table declarations, but live PostgreSQL integration still needs its configured test service.

`npm run ci` covers the public Core boundary, pinned artifact, TypeScript, production Web builds and the platform test suite. `packages/device-server/test/native-handoff.e2e.test.ts` exercises signed exchange, replay/substitution, original Web Origin/CSRF, approval races/takeover, claim races/recovery, epoch/lease expiry, scope/identity rejection, cross-group 404, cross-task custody and cancellation with Gateway-state persistence. Logging tests assert ticket/Token/proof redaction. This is API integration evidence, not phone/BLE, public-domain linking, Web UI visual or production security acceptance.
