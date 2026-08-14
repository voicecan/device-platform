# SLO, capacity, and alerting gate

This document turns the GA capacity requirement into an executable evidence gate. The numbers below are candidate objectives, not a production claim. They become commitments only after the service passes the declared workload on production-equivalent infrastructure for the observation window.

## Metrics contract

Scrape `GET /metrics` only from a private monitoring network. The endpoint exports no recording contents or credentials.

| Signal | Metric | Candidate objective / alert |
| --- | --- | --- |
| API availability | `voicecan_http_requests_total` | Production monthly non-5xx availability >= 99.9%; page when 5xx ratio exceeds 1% for 10 minutes. Exclude `/health/live`, `/health/ready`, and operator-caused 4xx. |
| API latency | `voicecan_http_request_duration_seconds` | Read API P95 <= 500 ms; mutating API P95 <= 1 s over 15 minutes. Page at 2x objective for 15 minutes. |
| Event-loop health | `voicecan_event_loop_delay_max_seconds` | Warn above 250 ms for 5 minutes; page above 1 s for 5 minutes. |
| Device connections | `voicecan_device_connections` | Compare against the declared test capacity; alert on a 30% drop without a planned drain. |
| File pipeline | `voicecan_files_pending`, `voicecan_files_syncing`, `voicecan_files_failed`, `voicecan_oldest_pending_file_age_seconds` | 99% of eligible files reach `synced` within 5 minutes; page if oldest eligible work exceeds 15 minutes or failed count grows for 10 minutes. |
| Webhook pipeline | `voicecan_event_deliveries_pending`, `voicecan_event_deliveries_dead`, `voicecan_oldest_pending_delivery_age_seconds` | First-attempt P95 <= 30 seconds and 24-hour final delivery >= 99.9%; page on any new dead delivery or oldest pending above 15 minutes. |
| Commands | `voicecan_commands_queued`, `voicecan_commands_in_flight` | Page when oldest command exceeds its deadline; use queue growth as a saturation signal. |
| Local storage | `voicecan_storage_used_ratio`, `voicecan_storage_available_bytes` | Warn at the configured 70% watermark; stop new uploads at 85%. Forecast exhaustion before it reaches the stop watermark. |

Histograms use stable Fastify route templates rather than raw URLs, so device IDs and file IDs do not create high-cardinality labels. Alert rules must preserve that property.

## Required capacity matrix

Each capacity result must record all of the following; a single requests-per-second number is not sufficient:

- release commit, protocol-runtime version/ABI/conformance hash, database schema, storage driver, and image digest;
- CPU architecture/count, memory, disk type/size, filesystem, network latency/bandwidth, Node version, database and object-store versions;
- total registered devices, concurrently connected devices, reconnects/second, heartbeats/second, commands/second, and Webhook endpoints per group;
- file-size distribution (P50/P95/max), new files/minute, filesystem/direct-S3/relay percentage, Range-download concurrency, and slow-consumer percentage;
- injected duplicate notifications, lost acknowledgements, Server restarts, object-store slow visibility, Webhook 429/5xx/timeouts, and downstream recovery time;
- CPU/memory/disk/network time series, event-loop delay, API latency/errors, queue ages, data-integrity assertions, and the first violated limit.

Edge SQLite must be tested as exactly one Server instance. The PostgreSQL adapter and two-pool fencing test exist, but Production multi-instance capacity cannot be claimed until the full PostgreSQL/S3 mixed workload and failover matrix passes on production-equivalent infrastructure.

## Test sequence and exit criteria

1. Run a 30-minute warm-up and verify the fixture/device population and scrape continuity.
2. Run the expected peak workload for at least 4 hours with the declared failure mix.
3. Run a step test until the first SLO or safety limit fails; publish the safe operating point with at least 30% headroom.
4. Restart and upgrade during load, then verify no duplicate RecordingFile identity, no unauthorized cross-group access, no lost terminal event, and convergence within 15 minutes.
5. Run a 24-hour soak at the safe operating point. Any P0/P1 correctness issue invalidates the run.
6. Observe the selected Beta deployment for 30 consecutive days. Reset the window after a P0/P1, an unplanned data restore, or a material architecture/storage change.

The evidence bundle must include the load generator configuration, sanitized time series/export, exact alert rules, failures, remediations, and reviewer sign-off. Simulator-only results are engineering evidence, not a physical-device capacity claim.

## Dashboard minimum

A release dashboard must show availability/error budget, latency by route and status class, event-loop delay, live devices, file and delivery queue count/age, failed/dead totals, command queue, storage utilization, deploy annotations, and backup/restore drill age. Every page alert needs an owner, severity, response runbook link, and tested silence/escalation path.
