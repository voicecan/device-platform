# Privacy, retention, and disaster-recovery gate

This is the operator and reviewer checklist for GA-05. It defines safe current behavior and the evidence required before a deployment can make a retention or recovery commitment. It is not legal advice and does not replace jurisdiction-specific review.

## Current safe behavior

- The independent deployment keeps device metadata, credentials, recordings, events, audit data, and secrets inside the operator's deployment. There is no VoiceCan Cloud fallback or product telemetry path.
- Releasing a device is non-erasing: it revokes the source credential and tombstones the device but retains historical recordings under the source authorization anchor.
- A RecordingFile row, its immutable storage object, and the source file still on the physical device are separate resources. The reviewed deletion API deletes only the exact immutable storage object, retains a metadata/audit tombstone, and explicitly reports that the device source was not deleted.
- The Server does not automatically purge completed recordings. This avoids silent data loss, but it is not a finished privacy-retention policy. A public release must disclose this behavior and provide an approved operator process.
- Audit rows are append-only at the database layer. A backup may contain data already deleted from the live service and therefore needs its own expiry and access policy.

## Data inventory and authority

| Data | Purpose | Access boundary | Deletion authority / constraint |
| --- | --- | --- | --- |
| Device and ownership tombstone | authorization, transfer, audit | current group plus System Admin | Do not hard-delete while files/events require the anchor. |
| RecordingFile metadata | discovery, integrity, download | current Device group | Metadata deletion must not precede object disposition evidence and an audit tombstone. |
| Recording object | user audio | current Device group; storage-admin access | Immutable during active life. Delete only by a reviewed lifecycle job or explicit privileged workflow; honor object lock/versioning. |
| Physical-device source file | device-local retry source | physical possession and reviewed protocol command | Separate destructive action. The current public API intentionally exposes no raw/delete command. |
| Events and deliveries | integration and replay | current group and endpoint rules | Retention must preserve enough tombstone/idempotency data to prevent an old event being recreated or misrouted. |
| Audit log | security and administrative evidence | System Admin / security operator | Append-only online. Archive/purge only under an approved audit-retention policy and external evidence chain. |
| Sessions, API tokens, Webhook secrets, device credentials | authentication | deployment operators and scoped actors | Revoke immediately; encrypted backups remain until backup expiry. Never log plaintext. |
| Backup set | recovery | restricted offline recovery role | Encrypt, inventory, test, expire, and destroy independently of the live dataset. |

## Mandatory retention decision record

Before production, the operator must approve a versioned record for each data class containing: controller/owner, jurisdiction and lawful basis, notice/consent text and withdrawal behavior, default retention, tenant/group override range, legal-hold authority, deletion SLA, backup expiry, export/access workflow, incident contact, and reviewer/date.

Until that record exists, use `retain until explicit operator action`; do not advertise automatic expiry or complete erasure. Legal hold always wins over scheduled deletion. Clearing a hold and deleting data must be two separately audited actions by authorized roles.

The implemented manual deletion design is two-phase:

1. Freeze new download URLs and mark a deletion request with group, reason, actor, scope, hold evaluation, and a stable resource version.
2. Cancel/finish active transfer work, delete the exact versioned object, verify absence, then replace live metadata with the minimum audit/idempotency tombstone. Failed deletion remains retryable and visible; it must never be reported as completed.

The manual lifecycle has System Admin legal-hold permissions, separately audited hold clearing, preview/confirmation, CAS download freeze, exact-version filesystem/S3 deletion, absence verification, retry state, and a retained tombstone. Automatic retention must not be added as an unreviewed timer; it still needs approved durations, bounded batch scheduling, dedicated metrics, backup-expiry semantics, and restore behavior.

## Recording consent and product disclosure

The integrating product—not the Server alone—must provide an appropriate visible/audible recording notice, collect any required participant consent, record the applicable policy version, and support withdrawal/export/deletion requests. The device protocol's ability to start recording is not proof of consent. Logs, support bundles, demos, and fixtures must contain no real recordings or production credentials.

## Backup set and recovery objectives

A complete Edge backup contains the SQLite online backup, filesystem objects (or a verified immutable object inventory), configuration without plaintext secrets, the deployment master-key keyring, token pepper, Webhook/device-secret recovery material, and a manifest with release/Core/schema/storage versions and checksums. A database without its keys is not a recoverable backup.

Candidate objectives, subject to owner approval and drills:

| Profile | Candidate RPO | Candidate RTO | Minimum backup policy |
| --- | --- | --- | --- |
| Edge / single-instance SQLite | 24 hours | 4 hours | Daily encrypted backup, 30 daily copies, one offline copy; quarterly restore drill. |
| Production / PostgreSQL + object storage | 15 minutes | 1 hour | Continuous database recovery plus daily immutable manifest, 35-day recovery window, cross-zone copy; monthly restore drill. The adapter exists, but this target remains unclaimed until a managed PITR/restore drill passes. |

## Restore drill

Restore only into a new empty target and preserve the source backup:

1. Select the backup by immutable manifest and verify signature/checksums before decrypting.
2. Restore database, objects, configuration, keyring, token pepper, and required secret material to isolated infrastructure.
3. Start the exact recorded release, verify schema, then follow the documented compatible upgrade path. Never downgrade a schema ad hoc.
4. Confirm setup remains closed, users/groups/devices retain the same authorization boundary, credentials decrypt, sampled objects match size/hash, range download works, and Webhook verification uses the expected secret version.
5. Reuse or deliberately migrate the device WSS DNS/TLS identity; otherwise devices cannot reconnect. Verify reconnect fencing and queued-command behavior.
6. Prove deleted/expired data is not resurrected outside the approved backup policy. Record any restored-but-expired item and complete post-restore deletion.
7. Capture achieved RPO/RTO, missing items, manual steps, screenshots/logs without secrets, approvers, and corrective actions.

## Deployment-key loss and incident handling

- Keep old key versions until every encrypted record is rewrapped and a restore drill succeeds. Losing all key copies permanently loses device control and encrypted Webhook/device secrets.
- Store recovery keys separately from data backups with least privilege, access logging, rotation, and a tested break-glass procedure. Never pass them in command-line arguments.
- A suspected recording, token, Webhook secret, deployment-key, or backup exposure starts the security incident runbook. Preserve audit evidence, revoke/rotate scoped material, assess affected groups and backup copies, and follow the approved notification timeline.

GA-05 remains closed until privacy/legal, security, operations, and product owners approve the retention record and consent language; any required automatic retention is implemented; and a production-equivalent restore drill meets the adopted RPO/RTO. The manual deletion/legal-hold path is implemented and tested but is not legal approval.
