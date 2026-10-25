# Recording synchronization operations

The Device Server treats discovery, transfer, storage commit, and recovery as separate states. A device inventory may discover many recordings, but each device has exactly one active transfer lane. The next recording is requested only after the current transfer reaches a terminal success or failure result.

## Transfer flow

1. After reverse WebSocket Token binding, the Server synchronizes UTC time and the local timezone offset with the Device.
2. The Server claims the file-command lane and requests the paginated recording inventory before starting low-priority status polling. Each inventory page has a 60-second response timeout; a silent Device produces `FILE_LIST_TIMEOUT` and releases the lane instead of blocking future transfers. The longer deadline covers the Device's ~30-second housekeeping tick plus transport, so a page that arrives just after a tick is accepted instead of being discarded.
3. New identities are stored as `pending` and emit `recording.discovered`.
4. One upload plan is created for the head of the device queue. Filesystem uploads use the HTTP(S) origin derived from the Device-reachable WebSocket URL, not the Admin browser's loopback URL. A size-aware watchdog bounds a silent transfer between 2 and 45 minutes and is refreshed by each relay frame; upload URLs and tickets remain valid for 46 minutes so the watchdog always expires first.
5. The file becomes `syncing` and emits `recording.sync_started`.
6. A successful immutable storage commit becomes `synced` and emits `file.synced`. A terminal device/storage error becomes `failed` and emits `recording.sync_failed`.

Device status queries are sent one at a time and advance only after the matching response. Inventory, transfer, control and OTA work always take priority over this best-effort status lane. Concurrent manual synchronization requests for the same Device reuse the active command instead of creating duplicate inventories.

An in-flight status query is re-sent immediately after the next Device heartbeat ACK, because that ACK has just woken the Device RX path. The original status-query deadline is not extended; the retry is best-effort and is skipped while inventory, transfer, control, or OTA work is active. This avoids adding a separate keepalive for status queries.

Debug logs contain semantic transfer metadata (`session_id`, result code, size, offset, content byte count, queue depth and file ID). They never contain recording bytes, device credentials, upload tickets, Wi-Fi passwords, or raw protocol frames.

A direct S3 upload reports progress as an empty-content `file_transfer` event whose `offset` is greater than zero and smaller than the expected size. The Gateway feeds that offset into the same in-memory progress surface used by filesystem and relay transfers, so the Admin current-transfer bar and transfer speed update while the Device is uploading directly to the object store. The terminal event (`offset` 0 or `offset` equal to the expected size) commits the S3 object. Progress is cleared when the attempt commits or fails; it is not persisted across a Server restart.

During a resumable WebSocket relay, the Server applies transport backpressure at the inbound queue high watermark and resumes reads after the queue drains. A large recording therefore slows to the Server's durable-write rate instead of disconnecting at the normal queue watermark. A separate hard limit remains as protection against transports that ignore paused reads.

A queued inventory or status query never displaces a non-empty transfer queue. `#startNextInventory` yields while transfers are queued, and the transfer lane only blocks on an *active* inventory/status/control/OTA command. This keeps a batch from losing a full Device command tick to a background scan between files.

## `DEVICE_TRANSFER_RESULT_05`

Firmware returns `0x05` when it rejects a file-transfer command because another transfer is already in progress. This commonly happens after a WebSocket reconnect: the Device keeps draining an HTTP upload that started on the previous connection while the Server, which cannot see the Device's HTTP state, requests the next file on the new connection.

`0x05` is transient backpressure, not a failed recording. The Server keeps the existing upload plan and ticket, re-sends the same file-transfer request after a 30-second backoff (up to 4 attempts), and deliberately does **not** advance the transfer queue or emit `recording.sync_failed`. Re-planning on every busy result would supersede the ticket of the upload that is still running on the Device and reset the Admin current-transfer progress, so the Server only retries the request. A busy result that persists beyond the retry budget falls through to the normal failure path for operator inspection.

After a reconnect that found a `syncing` row or a recent `DEVICE_TRANSFER_CONNECTION_CLOSED`/`DEVICE_TRANSFER_PROCESS_RESTARTED` row, the Server arms a 30-second transfer resume grace before requesting the first file. This lets the Device finish the HTTP body that was already in flight and avoids the initial `0x05` burst.

## `DEVICE_TRANSFER_RESULT_0C`

Firmware reports `0x0C` when its direct upload was aborted. First verify that the upload origin is reachable from the Device network. For a local edge deployment, a URL using `127.0.0.1` points back to the Device and cannot reach the Server. Also confirm that no older Server version is dispatching several file transfers to the same Device concurrently.

When a direct or filesystem HTTP transfer returns `0x0C`, the Server records the failure and immediately replans **that recording** through the resumable `server_relay` lane. It deliberately does not pin the rest of the batch to relay: a transient failure on one file must not force every later file onto the slow relay path after the Device moves back to Wi-Fi. If the HTTP origin is genuinely unreachable, each later file fails its direct attempt quickly and falls back to relay individually. A second `0x0C` from the relay path remains a terminal failure and requires operator inspection.

An interrupted direct transfer follows the same per-file relay fallback. If the Server process restarts before its WebSocket close handler can run, the next Device connection recovers orphaned `syncing` rows to `pending`, preserves resumable relay offsets, and pins only the interrupted direct file to relay. Sibling files keep their direct transport.

A relay pin is scoped to one connection epoch. On a fresh authenticated connection the Server clears `force_relay` for `pending` rows whose own `error_code` is empty. Rows that failed on their own keep their pin. Because fallback is per-file, a sibling is never pinned merely because another file failed.

## Expected transfer cadence

The Server requests the next file about 200 ms after the terminal transfer result. The info-level `device file transfer lane released` entry reports `duration_ms` and `bytes_per_second`, and `device file transfer requested` reports `idle_ms` plus `socket_buffered_bytes`. The matching `device file transfer request flushed` entry reports `buffered_before`, `buffered_after` and `flush_ms`: a near-zero `flush_ms` with zero buffered bytes means the frame reached the Server socket immediately, so any remaining delay is on the network/Device side. A large `buffered_before` or `flush_ms` points at Server outbound backpressure.

The protocol does not carry which radio link the Device used. Use `bytes_per_second` only as a rough link hint: roughly 130–150 KB/s is typical of BT PAN, while Wi-Fi can range from a few hundred KB/s to above 1 MB/s, so a mid-range value is ambiguous. `link_hint` uses the same rough thresholds. A 4 MB recording at 130 KB/s takes about 30 seconds on the link itself; switching between `filesystem_http` and `server_relay` does not change that, and neither the Server nor the Device protocol can select the link. If the Device reports a completed send after a few seconds but `file.synced` follows ~30 seconds later, the remaining time is the Device TCP send buffer draining over PAN, not an idle transfer lane.

`device heartbeat acknowledged` includes `queue_wait_ms`, the time the heartbeat frame waited behind earlier frames in the Server's serialized inbound lane. A 0–1 ms value means the Server answered immediately. A large Device-measured heartbeat RTT while the transfer itself is healthy points at the Device/link side; a large `queue_wait_ms` points at Server inbound processing. Relay traffic shares the Device WebSocket with heartbeats, so a busy relay lane can inflate RTT even when the Server ACK is immediate; direct HTTP/S3 uploads keep the control WebSocket free.

When each 30-second Device housekeeping tick advances one queued file, `device file transfer requested` entries can still be ~30 seconds apart even though the Server requested the next file ~200 ms after the previous terminal result. The `flush_ms` entry separates that Device-side scheduling from Server outbound backpressure.

## Recovery APIs

- `POST /api/v1/recordings/{id}/retry` resets one `failed` recording and requests a fresh inventory. A non-empty `reason` is required.
- `POST /api/v1/devices/{id}/recording-sync/reset` accepts `mode: "failed"` or `mode: "failed_and_stale"`, invalidates unfinished upload attempts, removes only relay partial data, returns affected counts, and requests a fresh inventory.
- `GET /api/v1/devices/{id}/recording-sync` returns connection state, aggregate synchronization health, the active transfer's byte progress and speed, queued pending/syncing bytes, the current round's completed/queued file counts, recordings newest first, failure codes and the latest semantic sync command.
- `GET /api/v1/devices/{id}/recording-progress` is the lightweight polling surface for the Admin workspace. It returns only the connection snapshot, aggregate counts, round counters and the active transfer bytes/speed. The workspace polls it every 250 ms while visible, refreshes the full recording list every 2 seconds (or immediately when file counts change), and pauses both when the page is hidden.
- The first bind, every rebind, and the first scan after upgrading an existing deployment perform a full device inventory. Later reconnects request only session IDs above the highest known session ID.
- A rebind reconciles files already synchronized under the same physical device's released binding. Matching synced rows are moved to the new device identity instead of being downloaded again, which also avoids firmware failures for files it no longer retains.
- After a scan completes, incomplete files are queued newest first. A `new_file` notification inserts the new file at the front of the queue. The overall round counter uses completed files divided by the files queued at scan start; new files increase the round total and are reflected immediately.

Neither retry nor reset deletes synchronized recording objects or asks the Device to erase source recordings. `failed_and_stale` only includes a `syncing` item when it has not changed for 20 minutes or the Device is offline.

## Operator sequence

1. Confirm WebSocket state is `online` and check `last_seen_at` and `connection_epoch`.
2. Use **Sync now** once. The action shows **Synchronization in progress** and remains disabled while the active command is queued, dispatched or running.
3. Inspect the recording's failure detail and the Server debug log.
4. Use the single-recording **Retry** action for an isolated failure.
5. Use **Reset failed** for a batch of known failures. Use **Reset failed and stale** only after confirming an interrupted/offline transfer.
