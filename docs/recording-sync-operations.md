# Recording synchronization operations

The Device Server treats discovery, transfer, storage commit, and recovery as separate states. A device inventory may discover many recordings, but each device has exactly one active transfer lane. The next recording is requested only after the current transfer reaches a terminal success or failure result.

## Transfer flow

1. After reverse WebSocket Token binding, the Server synchronizes UTC time and the local timezone offset with the Device.
2. The Server claims the file-command lane and requests the paginated recording inventory before starting low-priority status polling. Each inventory page has a 30-second response timeout; a silent Device produces `FILE_LIST_TIMEOUT` and releases the lane instead of blocking future transfers.
3. New identities are stored as `pending` and emit `recording.discovered`.
4. One upload plan is created for the head of the device queue. Filesystem uploads use the HTTP(S) origin derived from the Device-reachable WebSocket URL, not the Admin browser's loopback URL. A size-aware watchdog bounds a silent transfer between 2 and 45 minutes and is refreshed by each relay frame; upload URLs and tickets remain valid for 46 minutes so the watchdog always expires first.
5. The file becomes `syncing` and emits `recording.sync_started`.
6. A successful immutable storage commit becomes `synced` and emits `file.synced`. A terminal device/storage error becomes `failed` and emits `recording.sync_failed`.

Device status queries are sent one at a time and advance only after the matching response. Inventory, transfer, control and OTA work always take priority over this best-effort status lane. Concurrent manual synchronization requests for the same Device reuse the active command instead of creating duplicate inventories.

Debug logs contain semantic transfer metadata (`session_id`, result code, size, offset, content byte count, queue depth and file ID). They never contain recording bytes, device credentials, upload tickets, Wi-Fi passwords, or raw protocol frames.

During a resumable WebSocket relay, the Server applies transport backpressure at the inbound queue high watermark and resumes reads after the queue drains. A large recording therefore slows to the Server's durable-write rate instead of disconnecting at the normal queue watermark. A separate hard limit remains as protection against transports that ignore paused reads.

## `DEVICE_TRANSFER_RESULT_0C`

Firmware reports `0x0C` when its direct upload was aborted. First verify that the upload origin is reachable from the Device network. For a local edge deployment, a URL using `127.0.0.1` points back to the Device and cannot reach the Server. Also confirm that no older Server version is dispatching several file transfers to the same Device concurrently.

When a direct or filesystem HTTP transfer returns `0x0C`, the Server now records the failure and immediately replans that recording through the resumable `server_relay` lane. The remaining pending files in the same synchronization batch are also pinned to relay so each file does not repeat the same unreachable HTTP attempt. A second `0x0C` from the relay path remains a terminal failure and requires operator inspection; this guard prevents an infinite retry loop.

An interrupted direct transfer follows the same relay fallback. If the Server process restarts before its WebSocket close handler can run, the next Device connection recovers orphaned `syncing` rows to `pending`, preserves resumable relay offsets, and pins orphaned direct work to relay. This keeps a crash or development hot reload from leaving the per-device transfer lane blocked.

## Recovery APIs

- `POST /api/v1/recordings/{id}/retry` resets one `failed` recording and requests a fresh inventory. A non-empty `reason` is required.
- `POST /api/v1/devices/{id}/recording-sync/reset` accepts `mode: "failed"` or `mode: "failed_and_stale"`, invalidates unfinished upload attempts, removes only relay partial data, returns affected counts, and requests a fresh inventory.
- `GET /api/v1/devices/{id}/recording-sync` returns connection state, aggregate synchronization health, recent recordings, failure codes and the latest semantic sync command.

Neither retry nor reset deletes synchronized recording objects or asks the Device to erase source recordings. `failed_and_stale` only includes a `syncing` item when it has not changed for 20 minutes or the Device is offline.

## Operator sequence

1. Confirm WebSocket state is `online` and check `last_seen_at` and `connection_epoch`.
2. Use **Sync now** once. The action shows **Synchronization in progress** and remains disabled while the active command is queued, dispatched or running.
3. Inspect the recording's failure detail and the Server debug log.
4. Use the single-recording **Retry** action for an isolated failure.
5. Use **Reset failed** for a batch of known failures. Use **Reset failed and stale** only after confirming an interrupted/offline transfer.
