# Native binding handoff v1 (development preview)

Implemented from 2026-09-08 and extended on 2026-09-09. Android/iOS now auto-register the origin carried by a structurally valid task link, then perform signed exchange/observe/cancel/claim with separate secure task recovery. HTTPS keeps the operating system's certificate validation; restricted private-network HTTP is accepted for local self-hosted deployments. Android also accepts explicit system text sharing. Web generates task QR codes locally and reserves App Store, Google Play, and APK download positions while release URLs are unavailable. Verified App/Universal Links and production device acceptance remain pending; no production deployment is implied.

## Authorization flow

1. An authorized Web user creates a `binding_intent`, then posts `{}` to `/api/v1/binding-intents/:id/native-handoffs`. The server derives the native API origin from that intent's selected `resolved_device_ws_url` (`ws` → `http`, `wss` → `https`, retaining host and port) instead of the global browser-facing public URL. The response contains a deployment link of the form `/native/connect?v=1&handoff=<id>#ticket=<opaque>`. HTTPS is preferred; restricted private-network HTTP is supported for self-hosted intranet deployments. The ticket expires in five minutes or at the binding root expiry, whichever is earlier.
2. Scanning, pasting, or sharing a structurally valid task link registers its platform origin in the app and immediately starts exchange; no separate manual registration is required. Mobile clients accept public origins only over HTTPS and limit cleartext HTTP to loopback, private/link-local IPv4, IPv6 ULA/link-local, single-label LAN hosts, and `.local`. Persist a temporary P-256 private key, handoff ID and exchange request ID in task-only secure storage before exchange; do not put them in the local device credential store. Do not send user cookies or an Origin header, follow redirects, or accept response audience/callback substitution.
3. The app signs `POST /api/v1/native-handoffs/exchange` with `{handoff_id,ticket,client_public_key,request_id}`. The public key is canonical unpadded base64url SPKI DER, curve prime256v1. The server stores the ticket hash and public key, never the raw ticket or private key. This only establishes a pending execution request; it does not release a device Token.
4. Both screens display `client_fingerprint`: first 24 lowercase hex characters of SHA-256 of the public-key DER. The user compares it before pressing Web **Approve this app**. Web approval posts `{expected_execution_epoch}` to `/api/v1/native-handoffs/:id/approve`. The original binding browser needs its cookie plus exact allowed Origin; a signed-in user needs its session, CSRF and current group administrator authority. Approval does not accept native proof in place of Web authority.
5. The app calls signed `observe` to discover the approved epoch, including when its last known epoch was zero. `observe` is read-only and does not renew the lease. `resume` renews a still-valid two-minute lease using the current epoch. An expired lease requires explicit Web reapproval, advancing the epoch; the same handoff can recover its original Token. Clients should renew while executing, before lease expiry.
6. Only after verifying nearby device identity may the app call `claim`. Bind-only scope, expected SN, group authority, active executor, epoch and lease are enforced server-side. All task configuration comes from the response: `expected_identity`, `network_mode`, `resolved_device_ws_url`, scan-config v1 and same-origin callback registration. App-supplied override fields are rejected. An actual App must also enforce its Core credential persistence/recovery gates before writing a device.
7. Signed `progress` accepts only `ble_authenticated` followed by `configured`. Repeated or older stages are idempotent. Only Gateway persistence can result in `binding_status=completed`. Web continues observing the same binding root; a callback is never completion evidence.

## Signed requests

All app routes use POST without query parameters. Bodies are closed objects containing only strings and safe integers. Sort top-level keys lexicographically, serialize compact JSON as UTF-8 (JSON.stringify-compatible escaping; no whitespace or Unicode normalization), then SHA-256 the bytes to lowercase hex. Sign the following seven lines, with LF separators and **no final LF**:

```text
voicecan.native-proof.v1
<exact API origin derived from the task's resolved Device WebSocket URL>
POST
<exact /api/v1/native-handoffs/... path>
<Unix milliseconds, 13 decimal digits>
<nonce>
<canonical body SHA-256 hex>
```

Use ECDSA P-256/SHA-256 with DER signature encoding, sent as unpadded base64url in `X-VC-Signature`. `X-VC-Timestamp` allows ±60 seconds; `X-VC-Nonce` is 22–80 base64url characters (24 random bytes recommended). Nonces cannot be replayed. The test exports `nativeProofMessage` as the executable reference for cross-language vectors.

After exchange each body includes `request_id` and nonnegative integer `execution_epoch`. Claim also requires `manufacturer` (max 64) and `serial_number` (max 16), with optional `model`/`firmware_version` (max 64). `recover_only: 1` requires an existing credential in this exact session and cannot create one. Progress also requires `stage`. Cancel, resume and observe accept no further fields. Unknown fields are rejected. Endpoint schemas are in [OpenAPI](openapi.yaml).

For a lost response, resend the same operation/body/request ID with a **fresh nonce, timestamp and signature**. Reusing an ID for a different body/operation returns `NATIVE_IDEMPOTENCY_CONFLICT`. Exchange retry also requires the same key and ticket; another key cannot take over the ticket. Claim retries recover the same encrypted temporary credential, never mint a replacement. The device Token uses the platform's existing padded standard Base64 encoding, not base64url. Native responses never expose browser continuation grants.

Each handoff authorization window is limited to 2,048 request IDs and 512 recent nonces, with at most 20 handoffs per intent. The binding root's 30-minute lifetime remains the deadline for device mutations. A replay cannot extend it; explicit Web reauthorization of the original task can open a new 30-minute window and resets its request-ID budget. `instance_id` is `instance_` followed by the first 32 hex characters of SHA-256 of the task API origin derived from `resolved_device_ws_url`; it is an identifier, not a trust certificate.

## Execution and recovery limits

An intent has one executor row. Approval atomically increments its epoch and sets the handoff/session; stale approval fails. Repeating a successful approval with its original expected epoch returns the current approval without advancing it again. Before credential issuance, Web may approve another exchanged handoff and fence out the previous one. After issuance, switching to another handoff returns `EXECUTOR_ALREADY_STARTED`; reauthorize the original app instead. Other binding tasks cannot silently supersede an active native credential owner.

`cancel` stops future native mutations but leaves the provisioning session and device credential intact: a write may already have reached the device. Subsequent Gateway confirmation still wins. The response reports `stopped_pending_device_confirmation`, not device rollback. A cancelled or expired task can still observe with its original client proof, without receiving device credentials or renewing authorization. `owns_execution` is false for cancelled, superseded or lease-expired handoffs. The app now restores a saved task key after restart; recovery after losing that key or cancelling the task remains outside this recovery path; never infer a safe device reset or generate a replacement Token.

## Storage and verification

Schema version 19 adds handoff, executor, nonce and request-key tables. Use the existing explicit `npm run migrate` workflow on an intended deployment; startup does not migrate. This implementation was tested only against disposable local databases. No deployed database was changed. PostgreSQL derives the same table declarations, but live PostgreSQL integration still needs its configured test service.

`npm run ci` covers the public Core boundary, pinned artifact, TypeScript, production Web builds and the platform test suite. `packages/device-server/test/native-handoff.e2e.test.ts` exercises signed exchange, replay/substitution, original Web Origin/CSRF, approval races/takeover, claim races/recovery, epoch/lease expiry, scope/identity rejection, cross-group 404, cross-task custody and cancellation with Gateway-state persistence. Logging tests assert ticket/Token/proof redaction. This is API integration evidence, not phone/BLE, public-domain linking, Web UI visual or production security acceptance.

## Interrupted Wi-Fi setup and expiry recovery (2026-09-14)

The mobile vault persists the selected serial and `recoveryStage` before platform authentication and each subsequent Wi-Fi/server mutation. It stores `failureCode` and a pending-report flag on failure, without device Tokens, SSIDs or passwords. After restart it observes the original handoff, replays acknowledged milestones and pending failures, then allows the user to explicitly retry. A bound device belonging to that task uses `claim` with `recover_only: 1`, authenticates with the original Token, and continues configuration; it is never locally unbound by this recovery path. Old app records with a pinned serial and a claimed platform state remain recoverable.

`POST /native-handoffs/:id/failure` accepts `stage` (`binding`, `ble_authenticated`, `wifi`, `server`, `configured`) and one allowlisted error code (see OpenAPI). It updates existing failure metadata while preserving the provisioning status. Summaries and the Web handoff list expose `provisioning_stage` and `failure_code`. Successful advancement clears the reported error. These reports cannot complete binding or override Gateway completion.

`POST /native-handoffs/:id/reauthorize` requires original Web authorization, `expected_execution_epoch`, and user confirmation of the original app fingerprint in the UI. The transaction renews the same handoff, intent, provisioning session and unrevoked temporary credential, advances the executor epoch and grants a two-minute lease. Reconciler-expired sessions resume from `reserved`; the phone reauthenticates before continuing or replays its durable acknowledged milestones. Another executor, superseded session, cancelled intent/handoff, revoked credential or active/completed device is rejected. No Token is minted or rotated. Expired tasks remain visible in the Web UI and proof-bound observation continues on the phone; only a newer approved epoch may extend the phone's saved deadline, bounded to 31 minutes including clock allowance.

The original task URL can be reopened by a logged-in group administrator after the short browser continuation cookie expires. Deploy the server/Web changes and rebuild both mobile apps. No schema migration is added by this change; tests use disposable databases. Real-device Wi-Fi failure, process termination, authorization renewal and Gateway completion still require acceptance testing.

## Binding history (2026-09-14)

The provisioning workspace lists server-persisted task history (`GET /binding-intents`, `filter=unfinished|all`, bounded `limit`/`offset`). Switching modules can clear the current URL without losing the task: select Resume task in history to reopen its original ID and original app/browser path. New browser bindings now create a durable binding intent before issuing a device credential too. Completed/cancelled tasks remain available under All tasks; expired tasks remain under Unfinished tasks until resolved.

`POST /binding-intents/:id/reopen` requires a signed-in group administrator, CSRF, and the original allowed Origin. It restores an HttpOnly browser continuation cookie, invalidates any unused launch ticket, and leaves the provisioning session, device credential, executor and deadlines unchanged. Expired native tasks then use the existing fingerprint-confirmed reauthorization path. History returns whitelisted metadata, never tickets, browser hashes, private keys or device Tokens. Cross-group access is denied. Historical standalone provisioning sessions created before this change do not have a binding-intent root and are not retroactively fabricated into history.
