# Public error codes

All API failures use `{ success:false, code, message, request_id }`. Callers branch on `code`, not English text. Unauthorized object lookup is deliberately indistinguishable from absence and normally returns `404 NOT_FOUND`.

| Code | HTTP | Meaning / action |
| --- | ---: | --- |
| `UNAUTHENTICATED` | 401 | Session or Group API Token is missing, expired, disabled, or revoked. Reauthenticate; do not retry blindly. |
| `CSRF_FAILED` | 403 | Human-session mutation omitted the current CSRF token. |
| `NOT_FOUND` | 404 | Missing or outside the caller's current Device group. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Supply a stable key for a retryable command. |
| `IDEMPOTENCY_CONFLICT` | 409 | The same caller/key was previously used with another request digest. |
| `COMMAND_NOT_ALLOWED` | 400 | Raw, destructive, OTA, certificate, and factory commands are not public. |
| `CURSOR_EXPIRED` | 410 | Cursor is malformed, from another scope/filter, or no longer valid. Restart the list. |
| `RANGE_NOT_SATISFIABLE` | 416 | Use a single valid byte range within the immutable object. |
| `PROVISIONING_TOKEN_INVALID` | 403 | Grant is wrong-origin, expired, replayed, or does not match the expected serial. |
| `PROVISIONING_STAGE_CONFLICT` | 409 | Stage is stale, expired, or terminal. Read the authoritative session state. |
| `SERVER_ONLINE_TIMEOUT` | client | Device did not complete WSS reverse binding; provisioning is failed and the reservation is cleaned. |
| `DEVICE_ALREADY_CLAIMED` | 409 | The hardware identity has an active claim. When it already belongs to the binding grant's target group, `data.device_id` is returned so Admin can open that accessible device directly; cross-group conflicts never disclose the existing ID. |
| `TRANSFER_OUT_SESSION_NOT_FOUND` | 404 | Transfer grant/continuation is invalid, consumed, expired, or wrong-origin. |
| `TRANSFER_OUT_DEVICE_MISMATCH` | 409 | Nearby BLE device serial does not match the source Server session. Do not release. |
| `TRANSFER_OUT_STATE_CONFLICT` | 409 | Ownership, credential, session, or transfer state changed before commit. Start a new session. |
| `DEVICE_TRANSFER_ACTIVE` | 409 | Wait for active recording upload/relay before group transfer or release. |
| `TRANSFER_PREVIEW_STALE` | 409 | File/byte/transfer/event counts or ownership epoch changed; preview again. |
| `FILE_IDENTITY_CONFLICT` | 409 | Same device identity tuple reappeared with different metadata; operator review is required. |
| `UPLOAD_TICKET_INVALID` | 404 | Ticket is expired, failed, consumed, or unknown. Rediscover/replan the file. |
| `FILE_LIST_TIMEOUT` | sync command | Device did not return the requested recording inventory page within 30 seconds. The command lane is released; keep the Device online and retry. |
| `DEVICE_TRANSFER_RESULT_0C` | file state | Device aborted its direct upload. The Server automatically retries once through `server_relay`; a relay-path recurrence is terminal and requires connectivity inspection. |
| `DEVICE_TRANSFER_TIMEOUT` | file state | Device produced no transfer result before the size-aware watchdog expired. Direct work falls back to relay; a silent relay transfer becomes failed and can be reset explicitly. |
| `DEVICE_TRANSFER_CONNECTION_CLOSED` | file state | The Device WebSocket ended during transfer. The file returns to pending and resumes on the next inventory; interrupted direct work is pinned to relay. |
| `DEVICE_TRANSFER_PROCESS_RESTARTED` | file state | A new gateway process recovered an orphaned `syncing` row left by restart/crash. Relay partials resume; direct work is replanned through relay. |
| `DEVICE_CONNECTION_REQUIRED` | 409 | Device controls require an active Server WebSocket. The Admin UI may alternatively execute the reviewed operation directly through an authenticated local BLE maintenance session. |
| `DEVICE_CONTROL_UNAVAILABLE` | 409 | The Server WebSocket ended before dispatch. The command is failed instead of being left queued; reconnect and explicitly retry. |
| `RECORDING_NOT_RETRYABLE` | 409 | Direct retry is limited to `failed` recordings; use the reviewed reset flow for stale synchronization. |
| `FIRMWARE_NOT_FOUND` | 404 | Upload a matching local package or explicitly import one from the configured official source. |
| `FIRMWARE_VERSION_EXISTS` | 409 | Publish a new version; hardware/channel/version tuples are immutable. |
| `FIRMWARE_OBJECT_UNAVAILABLE` | 503 | Restore the local firmware file together with its database catalog entry before retrying OTA. |
| `FIRMWARE_OBJECT_SIZE_MISMATCH` / `FIRMWARE_OBJECT_CHECKSUM_MISMATCH` | 503 | The local package no longer matches its catalog; quarantine it and restore or import a verified copy. |
| `OFFICIAL_FIRMWARE_UNAVAILABLE` / `OFFICIAL_FIRMWARE_DOWNLOAD_FAILED` | 502 | Check the configured official source and outbound connectivity, then retry the explicit import. Existing local OTA remains available. |
| `INVALID_RESET_MODE` | 400 | Use `failed` or `failed_and_stale`; reset never deletes synchronized recording objects. |
| `CONTENT_LENGTH_MISMATCH` | 400 | Device body length differs from the immutable plan. |
| `S3_ATTEMPT_EXPIRED` | 409 | Create a new staging attempt; never reuse the expired PUT URL. |
| `STORAGE_QUOTA_EXCEEDED` | 507 | Configured total quota would be exceeded. |
| `STORAGE_LOW_SPACE` | 507 | Local/relay disk reached the stop watermark. Free space and reconcile. |
| `FILE_TOO_LARGE` | 413 | Recording exceeds `VOICECAN_MAX_FILE_BYTES`. |
| `BACKFILL_PREVIEW_STALE` | 409 | Event selection changed; preview and confirm again. |
| `BACKFILL_TOO_LARGE` | 409 | Narrow the requested time/type window below 1,000 events. |
| `INTERNAL_ERROR` | 500 | Use `request_id` to correlate redacted logs and failure audit; secrets must not be included in support material. |

Device/SDK failures additionally preserve their original cause. Important stable codes include `WEB_BLUETOOTH_UNSUPPORTED`, `DEVICE_SELECTION_CANCELED`, `COMMAND_TIMEOUT`, `COMMAND_ABORTED`, `DEVICE_DISCONNECTED`, `FIRMWARE_BLOCKED`, `SERVER_ONLINE_TIMEOUT`, `TRANSFER_TOKEN_ENVELOPE_INVALID`, and `TRANSFER_OUT_FAILED`.
